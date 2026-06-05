# node-pty

## What it is (1-2 lines)
Microsoft's native Node.js library for forking processes attached to a pseudoterminal (PTY). It is the layer underneath VS Code's integrated terminal and xterm.js: it spawns a shell, gives you a bidirectional byte stream (the master fd), and lets you resize/kill it. It does NOT emulate a terminal (no ANSI parsing, no grid) — it is the transport that feeds a terminal emulator.

## Architecture (how the pieces fit; key files with paths)
Platform-split design behind a single `spawn()` factory.

- `src/index.ts` — public API. At require time picks `WindowsTerminal` or `UnixTerminal` based on `process.platform`. `spawn/fork/createTerminal` just `new` the ctor; `open()` calls the static `open()` (openpty, unix-only).
- `src/terminal.ts` — abstract `Terminal` base. Holds the master `net.Socket`, `_pid/_fd/_cols/_rows`, the typed `onData`/`onExit` events, and flow-control logic. Defines abstract `_write`, `resize`, `kill`, `destroy`. It is essentially an EventEmitter-shaped wrapper over a socket.
- `src/unixTerminal.ts` — POSIX impl. Calls native `pty.fork(...)`, wraps the returned fd in a `tty.ReadStream` (reads) and a hand-rolled `CustomWriteStream` (writes).
- `src/unix/pty.cc` — N-API native addon. `PtyFork` (forkpty/posix_spawn), `PtyOpen` (openpty), `PtyResize` (TIOCSWINSZ ioctl), `PtyGetProc` (foreground proc name). Exit reaping on a dedicated `std::thread`.
- `src/unix/spawn-helper.cc` — tiny exec stub used only on macOS to acquire the controlling tty before exec.
- `src/windowsTerminal.ts` — Windows impl. Delegates to `WindowsPtyAgent`; uses a deferred-call queue because the pty isn't usable until the first data event.
- `src/windowsPtyAgent.ts` — orchestrates ConPTY: builds the Win32 command line, creates named pipes, manages conin/conout sockets, deferred connect, kill/flush lifecycle. Contains `argsToCommandLine` (Win32 quoting).
- `src/win/conpty.cc` — N-API addon over the Win32 PseudoConsole API (`CreatePseudoConsole`, `ResizePseudoConsole`, `ClosePseudoConsole`, `CreateProcessW` with `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`).
- `src/windowsConoutConnection.ts` + `src/worker/conoutSocketWorker.ts` + `src/shared/conout.ts` — a `worker_thread` that drains the conout pipe off the main thread to avoid ConPTY deadlocks.
- `src/eventEmitter2.ts` — VS Code-style typed event (`onX` getter returns a subscribe fn returning an `IDisposable`).

Data flow (unix): child stdio ⇄ slave pty ⇄ kernel line discipline ⇄ master fd ⇄ `tty.ReadStream` → `onData`; user `write()` → `CustomWriteStream` → `fs.write(fd)` → master fd.

Data flow (windows): child ⇄ ConPTY ⇄ named pipes (`-in`/`-out`) ⇄ worker thread pipes conout → main-thread `outSocket` → `onData`; `write()` → `inSocket` → conin pipe.

## Core techniques (the actual engineering)

**1. forkpty + signal-safe fork (unix/pty.cc:429-491).** The classic dance: `sigfillset` + `pthread_sigmask(SIG_SETMASK)` to block ALL signals around `forkpty()`. This closes a race in openpty and prevents the child from running inherited signal handlers before `exec`. In the child it resets every signal (`SIG_DFL` for `0..NSIG`), restores the mask, optionally `chdir`/`setgid`/`setuid`, closes inherited fds, then `execvp`. Parent sets master fd non-blocking (`O_NONBLOCK`).

**2. termios is configured explicitly (pty.cc:349-385).** Rather than inherit, it sets canonical defaults: `c_iflag = ICRNL|IXON|IXANY|IMAXBEL|BRKINT` (+`IUTF8` when utf8), `c_oflag = OPOST|ONLCR`, `c_cflag = CREAD|CS8|HUPCL`, full `c_lflag` (ICANON, ISIG, ECHO...), and the standard control chars (VINTR=3, VEOF=4, VERASE=0x7f, VSUSP=26, VSTART/VSTOP for XON/XOFF). Baud set to B38400. This is the canonical "what a sane terminal looks like" reference table.

**3. macOS uses posix_spawn instead of forkpty (pty.cc:737-861).** Because fork+exec is fragned on macOS, it manually does `posix_openpt`/`grantpt`/`unlockpt`, gets the slave name via `ioctl(TIOCPTYGNAME)` (thread-safe, vs racy `ptsname()`), `tcsetattr`/`TIOCSWINSZ` on the slave, then `posix_spawn` with `dup2` of slave→0/1/2 and flags `POSIX_SPAWN_CLOEXEC_DEFAULT|SETSID|SETSIGDEF|SETSIGMASK`. A trick at the top opens 3 dummy ptys (`low_fds`) to force the real master fd to land at >= STDERR_FILENO. The spawn-helper binary (`spawn-helper.cc`) is the actual exec target: it `open(ttyname(stdin))` to acquire the controlling terminal (relying on implicit-ctty-on-open since no O_NOCTTY), then chdir + execvp.

**4. Exit reaping on a dedicated thread, not the uv threadpool (pty.cc:149-249, conpty.cc:74-124).** Comment is explicit: "Don't use Napi::AsyncWorker which is limited by UV_THREADPOOL_SIZE." Each pty gets its own `std::thread` that blocks in `waitpid` (or `WaitForSingleObject` on Windows / `kqueue` `EVFILT_PROC NOTE_EXIT` on macOS) and then marshals the exit code back via a `Napi::ThreadSafeFunction` (`BlockingCall`). macOS also handles the "zombie death race" where the proc is no longer kqueueable but not yet waitable (pty.cc:178-205).

**5. Resize = a single ioctl (pty.cc:545-581).** `ioctl(fd, TIOCSWINSZ, &winsize{ws_col, ws_row, ws_xpixel, ws_ypixel})`. That's the whole story for unix resize — the kernel then sends SIGWINCH to the foreground process group. JS validates positive/finite cols & rows first (unixTerminal.ts:271). Pixel size is plumbed through but optional.

**6. CustomWriteStream: backpressure-aware fd writer (unixTerminal.ts:304-390).** Instead of `tty.WriteStream` (which "swallows and masks errors like EAGAIN and can cause the thread to block indefinitely"), it maintains a queue of `{buffer, offset}` tasks and calls `fs.write(fd, buf, offset, cb)` directly. On `EAGAIN` it re-schedules via `setImmediate` (yield to event loop, retry); on success it advances offset, shifts when done, and recursively drains until EAGAIN or empty. This is the key to handling large pastes without event-loop exhaustion.

**7. Windows ConPTY two-phase startup (windowsPtyAgent.ts + conpty.cc).** `startProcess` creates the pseudoconsole + two named pipes but does NOT spawn the child yet. The order matters: you must have a reader connected to the conout pipe before calling `ConnectNamedPipe`, otherwise `ConnectNamedPipe` blocks the event loop (issue #763). So: spin up the conout worker thread → wait for its READY message → connect the outSocket → THEN call `connect()` which does `ConnectNamedPipe` + `CreateProcessW`. A 5s timeout completes the connection even if the worker never signals (avoids zombie state).

**8. The conout worker thread (conoutSocketWorker.ts).** A `worker_thread` connects to the conout named pipe, stands up its OWN named-pipe server (`<name>-worker`), and `conoutSocket.pipe(workerSocket)`. The main thread connects to that worker pipe. Reason (windowsConoutConnection.ts:19-30): ConPTY's `ClosePseudoConsole` blocks until conout is drained; if you drain on the main thread you deadlock. Draining on a separate thread breaks the cycle.

**9. ConPTY process attachment (conpty.cc:388-427).** `STARTUPINFOEXW` + `InitializeProcThreadAttributeList` + `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc)` ties the new process to the pseudoconsole. `CreateProcessW` is called with `bInheritHandles=FALSE` ("VERY IMPORTANT") and `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT`. Env is a double-null-terminated wchar block.

**10. Win32 command-line quoting (windowsPtyAgent.ts:231-281).** Implements the inverse of `CommandLineToArgvW`: quote args containing spaces/tabs, and the backslash-before-quote rule (`\` count doubled + 1 before a `"`, doubled before a closing quote). Copied from the winpty project. This is a frequently-needed, easy-to-get-wrong algorithm.

## Code patterns worth stealing

Typed event with disposable subscription (eventEmitter2.ts) — the VS Code pattern:
```ts
private _onData = new EventEmitter2<string>();
public get onData(): IEvent<string> { return this._onData.event; }
// consumer: const d = term.onData(s => ...); d.dispose();
// fire() snapshots listeners into a queue first, so a listener can unsubscribe mid-fire safely.
```

Backpressure write loop (don't fight the kernel buffer):
```ts
fs.write(fd, task.buffer, task.offset, (err, written) => {
  if (err?.code === 'EAGAIN') { this._writeImmediate = setImmediate(() => this._drain()); return; }
  task.offset += written;
  if (task.offset >= task.buffer.byteLength) this._writeQueue.shift();
  this._drain(); // keep going until EAGAIN
});
```

Deferred-call queue while a resource is still initializing (windowsTerminal.ts:176-200): every public method routes through `_defer(fn, arg)` which runs immediately if `_isReady` else pushes `{run}` onto `_deferreds`, flushed on the first `data` event.

Native exit reaping off the uv pool:
```cpp
auto tsfn = Napi::ThreadSafeFunction::New(env, cb, "name", 0, 1, finalizer);
*th = std::thread([tsfn = std::move(tsfn), pid]{ waitpid(pid, &st, 0); tsfn.BlockingCall(evt, cb); tsfn.Release(); });
```

Signal-masked fork:
```cpp
sigfillset(&newmask); pthread_sigmask(SIG_SETMASK, &newmask, &oldmask);
pid = forkpty(&master, nullptr, &term, &winp);
if (!pid) for (i=0;i<NSIG;i++) sigaction(i, &SIG_DFL_action, NULL);
pthread_sigmask(SIG_SETMASK, &oldmask, NULL);
```

## Gotchas / non-obvious decisions
- **node-pty does NOT parse ANSI / maintain a grid.** It is pure transport. The emulator (xterm.js) lives downstream. Resize here only means "tell the kernel the new winsize so SIGWINCH fires."
- **Data can arrive after exit.** `onexit` defers emitting `exit` until the socket actually closes; a 200ms `DESTROY_SOCKET_TIMEOUT_MS` force-destroys the socket because macOS 10.13.2+ sometimes never closes it (unixTerminal.ts:78-103).
- **EAGAIN/EIO are expected, not errors.** The socket error handler swallows EAGAIN (fires twice initially) and treats EIO/"errno 5" as normal close (child died) rather than throwing (unixTerminal.ts:115-145).
- **`destroy()` must close the read stream before SIGHUP** so node stops reading a dead fd, then kills on the socket `close` event (unixTerminal.ts:236-247).
- **Env sanitization:** when inheriting `process.env`, it strips tmux/screen vars (`TMUX`, `STY`, `WINDOW`, `WINDOWID`, `TERMCAP`, `COLUMNS`, `LINES`) so the child doesn't think it's inside a multiplexer (unixTerminal.ts:286-301). Always sets `TERM` and `PWD`.
- **Old bash data corruption is accepted, not worked around** (macOS bash 3.2 readline bug) — they chose paste speed over the workaround (unixTerminal.ts:381-386).
- **Flow control is handled in JS, not the kernel.** `handleFlowControl` intercepts XOFF/XON (configurable to avoid oh-my-zsh rebinding conflicts) and translates to socket `pause()`/`resume()` instead of forwarding (terminal.ts:79-93).
- **Foreground process name** is read from `/proc/<pgrp>/cmdline` on Linux, `sysctl KERN_PROC_PID` on macOS, via `tcgetpgrp(fd)` — lifted from tmux (pty.cc:655-728).
- **Windows has no real fd, master, or signals.** `fd` is -1, `master`/`slave` getters throw, `kill(signal)` throws. Kill on non-DLL ConPTY enumerates the console process list via a forked helper and kills each PID.
- **Two ConPTY backends:** in-box `kernel32!CreatePseudoConsole` vs a bundled `conpty.dll` (`useConptyDll`) for newer features like `ClearPseudoConsole` and `ReleasePseudoConsole`; behavior diverges throughout the agent.

## Relevance (which advanced-TUI topics this teaches)
- **pty-emulation** — the definitive reference for the host side: forkpty/openpty, ConPTY, termios setup, controlling-tty acquisition, SIGWINCH-via-ioctl resize, exit reaping. This is the substrate every terminal emulator/multiplexer sits on.
- **input-keyboard-mouse** — how keystrokes become bytes to the slave (write path), flow-control (XON/XOFF) interception, and the line-discipline (ICANON/ECHO/ISIG) that decides whether the app or the kernel handles editing/signals.
- **app-architecture** — platform-split factory, abstract base + concrete impls, typed disposable events, deferred-call queue for async-ready resources, off-thread draining to avoid deadlocks, native↔JS exit marshaling without starving the uv threadpool.
