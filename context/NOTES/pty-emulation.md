# pty-emulation

How to spawn a pseudo-terminal, parse the byte stream it produces into a screen
grid, hold that grid (plus scrollback) in memory, handle resize, and drive a real
TUI through all of it for testing. Three reference codebases, three layers of the
same stack:

- **node-pty** (`context/node-pty/`) — the *host* side. forkpty/posix_spawn/ConPTY,
  termios, resize-via-ioctl, exit reaping. Pure transport: no ANSI parsing.
- **xterm.js** (`context/xterm/`) — the *emulator*. Table-driven VT500 parser,
  bit-packed cell buffer, scrollback, reflow. The byte stream becomes a grid here.
- **terminal-control** (`context/terminal-control/`, Rust `termctrl`) — the *driver/
  harness*. Wraps a PTY + the `vt100` crate to launch a TUI, send keys, wait for the
  screen to settle, and snapshot it. The testing side.

---

## TL;DR (the mental model in 3-5 bullets)

- A PTY is a kernel object with two ends: a **master** fd you (the host) read/write,
  and a **slave** that the child process sees as `stdin/stdout/stderr` (its
  controlling tty). Bytes you write to master appear on the child's stdin (through
  the kernel **line discipline**); bytes the child prints come out the master fd.
  The host is dumb plumbing — it does **no** ANSI parsing.
- The **terminal emulator** is a separate component that *consumes* the master byte
  stream. Its core is a **VT500 state machine** that turns a flat byte stream into
  print/execute/CSI/OSC/DCS dispatches, which mutate a **2-D cell grid + scrollback**.
- **Resize is two independent things.** (1) Tell the kernel the new window size with
  one `ioctl(TIOCSWINSZ)` / `ResizePseudoConsole` — the kernel then raises `SIGWINCH`
  in the child. (2) Re-layout the emulator's grid (reflow, or just re-parse). These
  live in different layers and must both happen.
- **Driving a real TUI for testing** = spawn it in a PTY, feed it keystrokes encoded
  as escape sequences, feed its output into an emulator, then **wait for the screen
  to be quiet before asserting** (the "settle" loop). Bonus: you must *answer the
  app's capability probes* or it hangs waiting for a reply that never comes.
- node-pty and termctrl agree almost exactly on the host mechanics (forkpty, bounded
  reader channel, ioctl resize, process-group kill); xterm.js is the canonical
  emulator the other two only stub. termctrl's contribution is the **settle / host-
  responder** discipline that makes capture deterministic.

---

## How it actually works (step by step, with file:line refs)

### 1. Spawning the PTY (host side)

**POSIX (the common case).** node-pty's native addon calls `forkpty(3)` and does the
classic signal-safe fork dance — `context/node-pty/src/unix/pty.cc:435-451`:

```cpp
sigfillset(&newmask);
pthread_sigmask(SIG_SETMASK, &newmask, &oldmask);   // block ALL signals
pid = forkpty(&master, nullptr, term, &winp);       // allocates master+slave, forks
if (!pid) {                                          // child
  sig_action.sa_handler = SIG_DFL;
  for (int i = 0; i < NSIG; i++) sigaction(i, &sig_action, NULL); // reset handlers
}
pthread_sigmask(SIG_SETMASK, &oldmask, NULL);        // re-enable
```

Why block signals around the fork: there is a race in openpty, and you must not let
the child run inherited signal handlers before `exec`. `forkpty` returns the master
fd; the child has already had the slave dup'd to fd 0/1/2 and set as its controlling
terminal.

The **termios** struct passed to `forkpty` is the canonical "sane terminal"
reference table (`pty.cc:351-385`): input `ICRNL|IXON|IXANY|IMAXBEL|BRKINT` (+`IUTF8`),
output `OPOST|ONLCR`, control `CREAD|CS8|HUPCL`, and the full local-flag set
`ICANON|ISIG|IEXTEN|ECHO|ECHOE|ECHOK|ECHOKE|ECHOCTL`. The control chars matter for
input: `VINTR=3` (Ctrl-C→SIGINT), `VEOF=4`, `VERASE=0x7f`, `VSUSP=26`. These flags
are what decides whether the *kernel* handles line editing/echo/signals or whether
the app reads raw bytes (a TUI flips most of this off via `tcsetattr`, but the host
provides sane defaults).

**macOS uses `posix_spawn`, not `forkpty`** (`pty.cc:738-861`) because fork+exec is
fragile there. It manually `posix_openpt`/`grantpt`/`unlockpt`, gets the slave name
via `ioctl(*master, TIOCPTYGNAME, ...)` — *thread-safe*, unlike racy `ptsname()`
(`pty.cc:787-788`), sets winsize on the slave, then `posix_spawn`s `dup2`-ing slave
→ 0/1/2. A trick at `pty.cc:744-755` opens 3 dummy ptys (`low_fds`) so the real
master fd lands at ≥ `STDERR_FILENO`. A tiny `spawn-helper.cc` is the exec target; it
`open`s the slave tty (no `O_NOCTTY`) to *acquire* it as controlling terminal.

**Windows: ConPTY, two-phase.** There is no fork, no fd, no real master. node-pty
calls `CreatePseudoConsole` + two named pipes (`conin`/`conout`), and attaches the
child via `STARTUPINFOEXW` + `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_
PSEUDOCONSOLE, hpc)` (digest node-pty §9, `src/win/conpty.cc`). Critical ordering: a
reader must be connected to conout *before* `ConnectNamedPipe`, or it blocks the
event loop — node-pty drains conout on a **worker thread** to avoid the deadlock
that `ClosePseudoConsole` (which blocks until conout is drained) would otherwise cause
(digest §7-8, `windowsConoutConnection.ts:19-30`).

**Rust / portable-pty.** termctrl is much simpler because `portable-pty` abstracts
forkpty/ConPTY. `context/terminal-control/src/shot.rs:99` opens a pair:

```rust
let pair = native_pty_system().openpty(PtySize {
    rows, cols, pixel_width: cell_width, pixel_height: cell_height,
})?;
// spawn child against pair.slave; drop slave; read pair.master on a thread
```

Note PTY size carries **pixel dimensions** too (`ws_xpixel/ws_ypixel`), needed for
graphics protocols (sixel/kitty) that ask "how many pixels per cell."

### 2. Reading the master stream without deadlocking

The child can produce output faster than you consume it. Both node-pty and termctrl
use a **bounded queue drained on a dedicated reader thread**, never blocking the
main loop. termctrl, `shot.rs:121` / `session.rs:208`:

```rust
let (send, receive) = mpsc::sync_channel::<Option<Vec<u8>>>(32);   // bounded
thread::spawn(move || {
    let mut buf = [0u8; 16*1024];
    loop { match reader.read(&mut buf) {
        Ok(0) | Err(_) => break,
        Ok(n) => if send.send(Some(buf[..n].to_vec())).is_err() { return },
    }}
    let _ = send.send(None);  // EOF sentinel
});
```

The **write** path matters just as much. node-pty rejected `tty.WriteStream` because
it "masks errors like EAGAIN and can cause the thread to block indefinitely"
(`unixTerminal.ts:358`). Its hand-rolled `CustomWriteStream` (`unixTerminal.ts:316-
390`) does `fs.write(fd, buf, offset)` directly and, on `EAGAIN`, yields and retries:

```js
fs.write(this._fd, task.buffer, task.offset, (err, written) => {
  if (err && err.code === 'EAGAIN') {              // kernel buffer full
    this._writeImmediate = setImmediate(() => this._processWriteQueue());
    return;                                         // yield to event loop, retry
  }
  task.offset += written;                           // advance, drain until empty
  ...
});
```

This is what lets a large paste not exhaust the event loop.

### 3. The VT parser state machine (emulator core)

This is the heart of an emulator and the thing the host *doesn't* do. xterm.js
implements the VT500 state machine (Paul Williams' diagram) as a **flat
`Uint16Array` transition table** — `context/xterm/src/common/parser/
EscapeSequenceParser.ts`. The index packs `(state, byte)` and the value packs
`(action, nextState)` (`:35`, `:71`):

```ts
// build:  table[state << INDEX_STATE_SHIFT | code] = action << ACTION_SHIFT | next
// lookup (:749):
transition = this._transitions.table[
  this.currentState << TableAccess.INDEX_STATE_SHIFT |
  (code < NON_ASCII_PRINTABLE ? code : NON_ASCII_PRINTABLE)
];
switch (transition >> TableAccess.TRANSITION_ACTION_SHIFT) { /* PRINT/CSI/OSC/... */ }
this.currentState = transition & TableAccess.TRANSITION_STATE_MASK;
```

Two design tricks worth internalizing:

- **`NON_ASCII_PRINTABLE = 0xA0`** (`:90`): all non-ASCII printables fold to one
  pseudo-byte so the table is only 256 columns per state. The state machine never
  sees real Unicode codepoints — that happens in the PRINT handler, not the table.
- **Hot-path read-ahead loops bypass the table.** For PRINT (`:759`, 4-way unrolled),
  PARAM, and OSC/DCS/APC payload, the loop scans forward over a run of same-class
  bytes and calls the handler *once* over the whole slice, so it doesn't pay a table
  lookup per byte. The comment at `:531` warns these must be kept in sync with the
  table by hand.
- **Resumable / async handlers** (`:620`, `:677`): a handler may return a `Promise`
  (e.g. slow image decode). The parser saves a stack (`_preserveStack`, `:515`) —
  handler list, index, transition, chunk position — returns the promise, and on
  resolve replays from the saved index. This blocks the byte stream *in-band*
  without freezing the UI.

termctrl does **not** write its own parser — it delegates to the `vt100` crate:
`Parser::new(rows, cols, scrollback)` then `parser.process(&bytes)`, and reads cells
back via `parser.screen()` (`shot.rs:380`, `session.rs`). This is the right call for
a *test harness*: you want a battle-tested emulator, not your own.

### 4. The buffer / scrollback model

xterm.js stores the grid with **zero per-cell objects**. `BufferLine` is one
`Uint32Array`, 3 × `uint32` per cell (`BufferLine.ts:15`, `:89`):

- `[0] content` = `width(2) | combinedFlag(1) | codepoint(21)`
- `[1] fg`, `[2] bg` = mode/flags + 24-bit color (`AttributeData.ts`)

Combining glyphs (emoji ZWJ) and extended (truecolor underline) attrs live in
**sparse side maps** `_combined` / `_extendedAttrs` (`BufferLine.ts:77-79`), only
consulted when a flag bit is set. Cells are read into a *reused* `CellData` object
via `loadCell(index, cell)` (`:101`) to avoid GC churn in hot loops.

Scrollback is a circular list of `BufferLine`s; normal vs alternate screen is a
`BufferSet`; **reflow** (rewrapping long lines when columns change) is `BufferReflow.ts`.

The `Terminal.write()` pipeline is **back-pressure aware and time-sliced**: chunks
queue in `WriteBuffer.ts`, and `_innerWrite` processes until it has spent
`WRITE_TIMEOUT_MS = 12` ms (`WriteBuffer.ts:27`), then yields with a `setTimeout`
to keep the frame budget. First write after a keystroke is parsed synchronously for
latency (digest xterm §gotchas).

termctrl keeps a far simpler model for a harness: the `vt100::Screen` *is* the buffer,
and it keeps the **raw ANSI byte stream** in a bounded ring (`retain_recent`,
`session.rs:591`) so it can re-parse on resize. It flattens the screen into a sparse,
serializable `Frame { cols, rows, cells }` (`frame.rs:106`), handling wide chars by
skipping `is_wide_continuation()` and clearing the cell to the right of a width-2
glyph when rasterizing to text (`frame.rs:85`).

### 5. Resize handling

Two layers, both required:

**Kernel layer.** One ioctl. node-pty, `pty.cc:545-581`:

```cpp
struct winsize winp = { ws_row, ws_col, ws_xpixel, ws_ypixel };
if (ioctl(fd, TIOCSWINSZ, &winp) == -1) { /* EBADF/EINVAL/ENOTTY */ }
```

That's the whole story on Unix — the kernel then sends `SIGWINCH` to the child's
foreground process group, which is how the TUI learns to re-render. JS validates
positive finite cols/rows first (`unixTerminal.ts`). Windows: `ResizePseudoConsole`
(`conpty.cc:486-492`), dynamically resolved as `ConptyResizePseudoConsole` or
`ResizePseudoConsole` depending on whether the bundled DLL is used.

**Emulator layer.** The grid must re-layout. xterm.js *reflows* — and avoids realloc
when the underlying `ArrayBuffer` still fits, just re-viewing/subarraying
(`BufferReflow.ts`, digest §gotchas). termctrl takes the brute-force-but-correct
route: throw the parser away and **re-parse the retained stream** at the new size
(`session.rs:447`):

```rust
self.master.resize(PtySize { rows, cols, pixel_width, pixel_height })?;
self.host.resize(cols, rows, cell_width, cell_height);   // update probe replies
self.parser = session_terminal(rows, cols);              // fresh vt100 parser
self.parser.process(&self.ansi);                         // replay retained bytes
```

It explicitly refuses resize if the ring buffer truncated (`session.rs:434`) — you
can't faithfully reflow output you've thrown away. Reflow-via-replay is simple and
exact but O(stream); xterm's in-place reflow is the production approach.

### 6. Driving a real TUI for testing (the harness)

This is termctrl's whole reason to exist, and the part the others don't do.

**Encode input as escape sequences** (`driver.rs:478` `key_bytes`): `ArrowUp` →
`\x1b[A`, `ShiftTab` → `\x1b[Z`, `Delete` → `\x1b[3~`, `Backspace` → `\x7f`, `Enter`
→ `\r`. Control letters are arithmetic: `Ctrl-C = b'c' - b'a' + 1 = \x03`. Typed
text can be split into per-char bursts so recordings look like real keystrokes.

**Wait for the screen to settle — never assert on raw scrollback.** The capture loop
(`shot.rs:467-490`) keeps reading; after each chunk it stamps `last_output = now`,
and returns once `last_output.elapsed() >= settle` (default 250 ms,
`shot.rs:48`) or a deadline/EOF hits. Crucially it *reports why* it stopped, so the
caller knows if the frame is trustworthy (`session.rs:84`):

```rust
pub enum CaptureReason { Idle, Deadline, Exited, OutputClosed }
```

The TS client throws `IncompleteCaptureError` on Deadline/OutputClosed unless you opt
into `allowIncomplete`. This "settle as an explicit, reported condition" discipline is
the single most important idea for reliable TUI tests.

**Answer the app's capability probes or it hangs.** A modern TUI (OpenTUI, kitty
graphics) emits queries on startup and *waits* for a real terminal to reply. termctrl
impersonates a terminal via `Host` (`shot.rs:502-600`): it keeps a rolling 64-byte
`probe` buffer, scans for known query byte-sequences, and writes synthetic replies
back into the PTY. The OpenTUI probe gets a fat reply advertising fg/bg color, mouse/
paste/sync modes, and pixel geometry via `\x1b[4;{h};{w}t`; a kitty graphics probe
gets `\x1b_Gi=31337;EINVAL:graphics unavailable\x1b\\` so the app falls back instead
of blocking forever (`shot.rs:585`).

**Teardown: kill the whole process group.** The child is a session leader; helper
descendants can hold the slave open. Both files do `libc::kill(-process_group,
SIGKILL)` (`shot.rs:185`, `session.rs`) and grace-kill only if output stays open >50ms
after exit.

---

## Cross-repo comparison

| Concern | node-pty | xterm.js | terminal-control (termctrl) |
|---|---|---|---|
| Layer | Host transport | Emulator | Test harness (host + emulator) |
| Lang | TS + N-API C++ | TS | Rust |
| PTY spawn | Direct: `forkpty` / `posix_spawn` (macOS) / ConPTY (Win) | none (consumes a stream) | `portable-pty` (abstracts all three) |
| ANSI parsing | **none** — pure bytes | Hand-written table-driven VT500 SM | `vt100` crate (delegated) |
| Buffer model | none | Bit-packed `Uint32Array` cells + sparse side maps + reflow scrollback | `vt100::Screen` + retained raw-ANSI ring → sparse `Frame` |
| Read strategy | reader → `onData` event; XON/XOFF flow control in JS | back-pressure `WriteBuffer`, 12ms time-slice | reader thread → bounded `sync_channel` → settle loop |
| Write/EAGAIN | custom `fs.write` loop, `setImmediate` retry | n/a (it's a sink) | `portable-pty` writer |
| Resize (kernel) | `ioctl(TIOCSWINSZ)` / `ResizePseudoConsole` | n/a | `master.resize(PtySize)` |
| Resize (grid) | n/a | in-place reflow, avoids realloc | **re-parse retained stream** |
| Exit handling | per-pty `std::thread` `waitpid`/`kqueue`, `ThreadSafeFunction` | n/a | `kill(-pgid, SIGKILL)`, reason reported |
| Killer feature | signal-safe fork, ConPTY worker-thread drain | the parser + GC-free buffer | settle loop + capability-probe responder |

**Where they agree:** bounded reader queue off the main thread; resize = ioctl that
triggers SIGWINCH; process-group kill on teardown; PTY size carries pixel dims.

**Where they differ & who's "better":**
- *Parser ownership.* xterm.js owns a hyper-optimized parser; termctrl delegates to
  `vt100`. For a test harness, delegating is correct (less surface to be wrong). For a
  user-facing emulator, owning it (and the GC-free buffer) is worth the cost — that's
  the difference between a 60fps terminal and a janky one.
- *Resize reflow.* termctrl's re-parse is dead simple and always correct but scales
  with total output; xterm's in-place reflow is the production answer but is intricate
  (must fix up wide-char halves, copy sparse maps, trim on shrink). Use re-parse for
  tests, in-place for a real emulator.
- *Spawning.* node-pty's raw forkpty/ConPTY is the gold-standard reference for what
  actually has to happen; portable-pty is what you'd actually depend on unless you're
  Microsoft.

---

## Pitfalls & hard parts

- **Forgetting that the host does no parsing.** "Resize" in node-pty means *only*
  "tell the kernel the new winsize." It does not move text. The emulator is a separate
  thing. People conflate them constantly.
- **ConPTY ordering deadlock.** You must connect a conout reader before
  `ConnectNamedPipe`, and you must drain conout off the main thread or
  `ClosePseudoConsole` deadlocks (node-pty digest §7-8).
- **EAGAIN/EIO are normal, not errors.** The read stream gets `EAGAIN` twice at start
  (`unixTerminal.ts:116`); `EIO`/errno 5 means the child died and is treated as a
  clean close. Throwing on these is a classic bug.
- **Data arrives after exit.** node-pty defers the `exit` event until the socket
  closes, with a 200ms force-destroy timeout because macOS sometimes never closes it.
- **Asserting before settle.** The #1 flaky-TUI-test cause. Always wait for quiet and
  *check why* you stopped waiting (Idle vs Deadline). Never grep raw scrollback bytes.
- **Apps that hang on capability probes.** If your harness doesn't answer OSC/DCS/
  kitty queries, modern TUIs block forever waiting for a reply. You must impersonate a
  terminal (termctrl `Host`).
- **Env leakage making the child think it's multiplexed.** node-pty strips `TMUX`,
  `STY`, `TERMCAP`, `COLUMNS`, `LINES` (`unixTerminal.ts:288-298`); termctrl spoofs
  `TERM=xterm-truecolor`, `COLORTERM=truecolor`. Wrong env → wrong rendering.
- **Wide-character bookkeeping.** A width-2 glyph occupies two cells; the second is a
  continuation (width 0). Insert/delete/scroll/resize and text-flattening must all
  handle a dangling half (`BufferLine` insert/delete, `frame.rs:85`).
- **Pipe vs PTY mode.** A non-TTY child emits bare `\n`; feed that to a vt100 parser
  and column tracking breaks. termctrl injects a `LinefeedNormalizer` (`\n`→`\r\n`) in
  pipe mode (`shot.rs:310`).
- **Process-group reaping.** Killing only the direct child leaks grandchildren holding
  the slave open. Kill the group.

---

## If you were building this from scratch

Layer it exactly as these three repos do; don't merge the host and emulator.

**Host (or just depend on node-pty / portable-pty):**
```
open_pty(rows, cols, pixel_w, pixel_h) -> { master_fd, child_pid }
  # POSIX: block signals; forkpty(); in child reset handlers + exec
  # set sane termios (ICRNL|IXON, OPOST|ONLCR, ICANON|ISIG|ECHO, VINTR=3, VERASE=0x7f)
  # Windows: CreatePseudoConsole + attach via PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE

read loop  : dedicated thread -> bounded queue -> on_data(bytes)   # never block main
write(buf) : fs.write in a loop; on EAGAIN, setImmediate + retry
resize(c,r): ioctl(TIOCSWINSZ) / ResizePseudoConsole   # kernel raises SIGWINCH
on_exit    : own thread waitpid()/kqueue -> marshal exit code; kill(-pgid) on teardown
```

**Emulator:**
```
parser: flat table[state<<8 | byte] = action<<8 | nextState
  loop: t = table[state<<8 | min(byte,0xA0)]; dispatch(t>>8); state = t & 0xFF
  + hot read-ahead loops for PRINT/PARAM/OSC payload (don't lookup per byte)
buffer: Uint32Array, 3 u32/cell (content|width|cp, fg, bg); sparse maps for combining
        + truecolor; reused CellData for reads; circular scrollback; alt screen
write : queue chunks; process ~12ms then yield (time-slice to hold frame budget)
resize: reflow in place if ArrayBuffer fits, else realloc; fix wide-char halves
```

**Harness (for testing TUIs):**
```
spawn TUI in pty; feed emulator; respond to capability probes (impersonate a terminal)
send_key(k)        : map to escape seq (ArrowUp=\x1b[A, Ctrl-C=\x03, Enter=\r)
wait_for_idle()    : read until last_output.elapsed() >= settle (e.g. 250ms)
capture()          : return (frame, reason in {Idle,Deadline,Exited,OutputClosed})
                     # assert ONLY when reason == Idle; never grep raw bytes
resize()           : master.resize(); rebuild parser; replay retained stream
teardown()         : kill(-pgid, SIGKILL)
```

Recommended dependencies if you're not Microsoft: **portable-pty** (Rust) or
**node-pty** (Node) for the host; a vetted emulator (`vt100` crate, or xterm.js
headless `@xterm/headless`) for the grid. Only hand-write the parser/buffer if you're
shipping a user-facing 60fps emulator — then steal xterm.js's table + bit-packed
cells wholesale.

---

## Source map

**node-pty (`context/node-pty/`) — host:**
- `src/unix/pty.cc:435-451` signal-safe forkpty; `:351-385` termios table; `:738-861`
  macOS posix_spawn + TIOCPTYGNAME + low_fds; `:545-581` `PtyResize` (ioctl); `:152-
  246` exit reaping thread (waitpid/kqueue + ThreadSafeFunction).
- `src/unix/spawn-helper.cc` — controlling-tty acquisition on macOS.
- `src/unixTerminal.ts:316-390` `CustomWriteStream` (EAGAIN loop); `:116` EAGAIN/EIO
  handling; `:288-298` env sanitization.
- `src/win/conpty.cc:461-492` `ResizePseudoConsole`; process attachment near `:388`.
- `src/windowsPtyAgent.ts`, `windowsConoutConnection.ts:19-30`, `worker/
  conoutSocketWorker.ts` — ConPTY two-phase startup + worker-thread drain.
- `src/eventEmitter2.ts` — typed disposable events; `src/terminal.ts:79-93` flow control.

**xterm.js (`context/xterm/`) — emulator:**
- `src/common/parser/EscapeSequenceParser.ts:35,71,749` table build+lookup; `:90`
  NON_ASCII_PRINTABLE; `:531,759` hot loops; `:515,620,677` resumable async handlers.
- `src/common/parser/{Osc,Dcs,Apc}Parser.ts`, `Params.ts` — string subparsers, params.
- `src/common/buffer/BufferLine.ts:15,89,101` cell layout + loadCell; `AttributeData.ts`
  bit masks; `Buffer.ts`/`BufferSet.ts` scrollback + alt screen; `BufferReflow.ts` resize.
- `src/common/input/WriteBuffer.ts:27` 12ms time-slice; `TextDecoder.ts` UTF8→UTF32;
  `Keyboard.ts`/`KittyKeyboard.ts` input encoding.

**terminal-control (`context/terminal-control/`) — harness:**
- `src/shot.rs:99` openpty; `:121` reader thread + bounded channel; `:467-490` settle
  loop; `:502-600` `Host` capability-probe responder; `:185` process-group kill;
  `:310` pipe-mode linefeed normalizer.
- `src/session.rs:84` `CaptureReason`; `:340` `capture`; `:434-460` resize-via-reparse;
  `:591` `retain_recent` ring buffer; `:309` `wait_for_idle`.
- `src/frame.rs:85` text rasterization + wide-char clear; `:106` `from_screen`; `:168`
  color resolution (256-cube/grayscale).
- `src/driver.rs:478` `key_bytes` input encoding; `:462` paced typing.
- `packages/test/src/index.ts` — TS JSONL client (AsyncDisposable, settle assertions).
