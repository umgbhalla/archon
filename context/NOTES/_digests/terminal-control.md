# terminal-control

## What it is (1-2 lines)
A Rust tool (`termctrl`) plus a TypeScript test client for driving and capturing **real** terminal applications through a PTY: launch a TUI, send exact keystrokes, wait for visible text, snapshot the screen as a structured frame / text / SVG / PNG, record a timeline, and export MP4. The TUI here is a *vt100 emulator harness*, not a TUI framework — it is the testing/observability side of advanced terminal UIs.

## Architecture (how the pieces fit; key files with paths)
Rust library (`src/lib.rs` re-exports modules); the CLI binary `termctrl` is built on it. Crate deps that matter: `portable-pty` (PTY), `vt100` (terminal emulation/parser), `resvg`+`tiny-skia` (SVG→PNG), `ffmpeg` shelled out for video.

- `src/shot.rs` — one-shot capture. Opens a PTY, spawns the command, drains output on a reader thread through a bounded `sync_channel`, feeds bytes into a `vt100::Parser`, and waits for the screen to *settle*. Also holds `Options`, environment policy, the `Host` terminal-emulation responder, and `LinefeedNormalizer` for pipe mode.
- `src/frame.rs` — the stable data structure. `Frame { cols, rows, fg, bg, cursor, cells: Vec<Cell> }`; `from_screen(&vt100::Screen) -> Frame` converts emulator state into serializable cells; `Frame::text()` rasterizes cells back to a plain-text grid. Color resolution (truecolor / 256-cube / 16-ANSI) lives here.
- `src/session.rs` — long-lived `Session` owning a PTY + parser + scrollback. Exposes `send_all`, `wait_for_text`, `wait_for_idle`, `wait_for_exit`, `capture`, `status`, `logs`, `resize`, `mark`, `stop`. The `#[cfg(unix)] mod implementation` adds **named daemon sessions** over Unix domain sockets with a flock start-lock and a private `0o700` runtime dir.
- `src/driver.rs` — versioned **JSON Lines stdio protocol** (`termctrl driver`). `serve()` reads one JSON request per line, dispatches to embedded `Session`s held in a `HashMap`, runs each session on a background pump thread, writes `hello`/`response`/`error` lines. This is what the TS client speaks.
- `src/recording.rs` — `.termctrl` = JSON Lines timeline (`Header`, `Output`, `Input`, `Resize`, `Marker`). `replay()` rebuilds frames by re-feeding bytes into a fresh parser; `video()` samples frames at a target FPS, dedupes identical frames, renders each to PNG, and pipes a numbered PNG sequence to `ffmpeg`.
- `src/render.rs` — `Frame -> SVG`, plus `PngRenderer` (resvg). Notable: it draws block/box-drawing/Braille/geometric glyphs as **vector geometry** rather than trusting fonts.
- `packages/test/src/index.ts` — TS `TerminalControl`/`Session`/`Screen`/`Keyboard` classes that spawn `termctrl driver` and talk the JSONL protocol; built for vitest-style TUI assertions with failure artifacts.

## Core techniques (the actual engineering)

**PTY-backed capture with a settle loop.** `shot.rs:93 from_command` opens a `portable_pty` pair at `PtySize { rows, cols, pixel_width=cell_width, pixel_height=cell_height }`, spawns the child against the slave, drops the slave, and reads the master on a dedicated thread into a bounded channel. The main thread runs a state machine (`Chunk::{Output,Timeout,Closed}`, `consume_until_ready` → `consume_until_settled`) that returns the frame once **no output has arrived for `settle`** (default 250ms) or a deadline/EOF hits. `Session::capture` (`session.rs:340`) returns a `CaptureReason` (`Idle | Deadline | Exited | OutputClosed`) so callers know whether the frame is *trustworthy* — the central idea of the whole tool: assert on stable visible state, never on raw scrollback.

**vt100 as the screen model.** All emulation is delegated to the `vt100` crate. A `Parser::new(rows, cols, scrollback)` is fed raw bytes via `parser.process(&bytes)`; `parser.screen()` gives cells, colors, attributes, cursor, wide-char continuation. The project never parses ANSI itself except to *answer* device queries (see Host).

**Frame extraction & wide chars** (`frame.rs:106 from_screen`): iterate `screen.cell(y,x)`, skip `cell.is_wide_continuation()`, swap fg/bg on `cell.inverse()`, mark `width=2` for `cell.is_wide()`. Cells are emitted only when non-empty / non-default-bg / styled (sparse representation). `Frame::text()` (`frame.rs:85`) rebuilds a `rows × cols` space grid, places each cell, and **clears the cell to the right of a width-2 glyph** so wide chars don't double-print — a concrete unicode-width gotcha handled correctly.

**Color resolution** (`frame.rs:168`): `Default → theme default`, `Rgb → as-is`, `Idx → indexed_color`. `indexed_color` implements the full xterm map: 0–15 hard-coded ANSI palette, 16–231 = 6×6×6 cube with `channel = if c==0 {0} else {55 + c*40}`, 232–255 = grayscale ramp `8 + (i-232)*10`.

**Input encoding** (`driver.rs:478 key_bytes`): named keys → escape sequences (`ArrowUp=\x1b[A`, `ShiftTab=\x1b[Z`, `Delete=\x1b[3~`, `Backspace=\x7f`, `Enter=\r`). Control letters map to `byte = letter.to_lowercase() - b'a' + 1` (`Ctrl-C=\x03`). Paced typing splits a text string into per-char byte bursts so recorded demos look like real keystrokes (`driver.rs:462`).

**Terminal *emulation as a host* (the clever part).** `Host` in `shot.rs:502` makes termctrl impersonate a real terminal so apps that probe capabilities (OpenTUI, kitty graphics) don't hang. It scans a rolling 64-byte `probe` buffer for query sequences and synthesizes replies:
- OSC 10/11 (`\x1b]10;?\x07` `\x1b]11;?\x07`) → reports fg/bg colors **plus** a fat reply advertising mouse/paste/sync modes and the pixel geometry via `\x1b[4;<h>;<w>t` (`shot.rs:553`).
- OSC 4 palette query → returns a color.
- Kitty graphics probe (`\x1b_Gi=31337`) → `EINVAL:graphics unavailable` so the app falls back instead of waiting forever.
Replies are written back into the PTY (and recorded with `InputOrigin::Host`).

**Settle/idle/deadline timing model** is shared across embedded session and one-shot: poll every 10ms, track `last_output: Instant`, compare `elapsed() >= settle`. `wait_for_text` greps `parser.screen().contents()`; `wait_for_idle` waits for quiet; `capture` combines all exit conditions.

**Retain-recent ring buffer** (`session.rs:591 retain_recent`): keeps only the last `max_bytes` of the ANSI stream, draining the front and setting a `truncated` flag — bounded memory for infinite-output apps, while still allowing `resize` reflow as long as nothing was truncated (`session.rs:434`).

**Resize = reparse** (`session.rs:447`): rebuild a fresh `vt100::Parser` at the new size and replay the retained ANSI stream into it. Same trick drives recording replay/video.

**SVG rendering with synthetic glyphs** (`render.rs:30 svg`, `:111 graphic`): background rects first, then text. Block elements (`█ ▀ ▄ ▌` … eighth blocks), box quadrants, geometric shapes (`◆ ● ○ ◉`…), and the entire **Braille range `U+2800..U+28FF`** are drawn as `<rect>/<circle>/<polygon>` geometry computed from cell fractions (`braille_dots` maps the 8 dot bits to positions) — because monospace fonts render these inconsistently. Shade chars `░▒▓` are deliberately left as real glyphs. Text decorations, bold weight, italic, faint (opacity 0.55) are emitted as SVG attributes. `PngRenderer` (`:76`) parses the SVG with resvg + system fonts and rasterizes via tiny-skia at a `pixel_ratio`.

**Recording → video pipeline** (`recording.rs`): `replay()` (`:336`) reconstructs `VideoFrame`s by feeding `Output` bytes into a parser and **dropping consecutive identical frames** (`previous.frame == frame`). `samples()` (`:585`) walks a real-time timeline and picks, for each `1000/fps` tick, the state active at that instant — converting variable-rate terminal output into fixed-FPS frames. `render_video_frames()` (`:619`) caches PNGs by `Frame` content (`HashMap<Frame, PathBuf>` → only unique screens are rendered, identical frames are hard-linked) then runs `ffmpeg -framerate <fps> -i frame-%06d.png -vf format=yuv420p -movflags +faststart`. `edited_states()` supports a JSON edit list: clip by markers, per-clip `speed`, `hold_ms`, and captions (inline extra row or footer band).

## Code patterns worth stealing

PTY reader thread → bounded channel → settle loop:
```rust
let (send, receive) = mpsc::sync_channel::<Option<Vec<u8>>>(32);
thread::spawn(move || {
    let mut buf = [0u8; 16*1024];
    loop { match reader.read(&mut buf) {
        Ok(0) | Err(_) => break,
        Ok(n) => if send.send(Some(buf[..n].to_vec())).is_err() { return },
    }}
    let _ = send.send(None); // EOF sentinel
});
// main: recv_timeout(min(deadline_left, 20ms)); after each byte, last_output = now;
// done when last_output.elapsed() >= settle  (or deadline / EOF)
```

Settle as an explicit, *reported* condition (don't lie about a frame):
```rust
enum CaptureReason { Idle, Deadline, Exited, OutputClosed }
// TS side throws IncompleteCaptureError on deadline/outputclosed unless allowIncomplete
```

Width-2 glyph handling when flattening cells to text:
```rust
rows[y][x] = cell.text.clone();
if cell.width == 2 && x + 1 < cols { rows[y][x+1].clear(); }
```

xterm 256-color cube without a lookup table:
```rust
let channel = |c: u8| if c == 0 { 0 } else { 55 + c*40 };
Color { r: channel(v/36), g: channel((v%36)/6), b: channel(v%6) } // v = idx-16
```

Answer capability probes instead of hanging (scan a rolling probe buffer for query bytes, write the synthetic reply back into the PTY).

Frame-content-keyed render cache → only encode unique screens:
```rust
let mut rendered = HashMap::<Frame, PathBuf>::new();
// if key already rendered, hard-link; else render PNG once
```

TS JSONL client: line-delimited request/response over a child process's stdio with an id→Promise pending map, `hello` handshake with `protocolVersion` check, and `AsyncDisposable` (`await using session`).

## Gotchas / non-obvious decisions
- **Process-group kill on teardown.** `portable-pty` spawns the app as a session leader; both `shot.rs` and `session.rs` `kill(-pgid, SIGKILL)` to reap helper descendants that keep the slave PTY open (`shot.rs:181`, `session.rs:519`). `finish_exited_output` grace-kills the group only if output stays open >50ms after exit.
- **Backpressure deadlock avoidance.** The output queue is *bounded* (`OUTPUT_QUEUE=4`); forced `terminate()` must keep draining one chunk at a time or a still-writing child blocks shutdown (`session.rs:526`).
- **Pipe vs PTY mode.** `from_pipe_command` is for non-TTY tools; it injects `LinefeedNormalizer` to turn bare `\n` into `\r\n` so vt100 column tracking stays correct (`shot.rs:310`).
- **Truecolor env spoofing.** Always sets `TERM=xterm-truecolor`, `COLORTERM=truecolor`; `ColorMode::Always/Never` toggles `FORCE_COLOR`/`NO_COLOR`/`CLICOLOR(_FORCE)` (`shot.rs:329`). `inheritEnv:false` does `env_clear()` first.
- **Named-session security.** Runtime dir must be a real, user-owned, `0o700` dir; sockets are `0o600`; Unix socket path must be <100 bytes (portability); a flock `*.lock` prevents two starts racing the same name.
- **Default theme colors are baked in** (`#c9d1d9` on `#0d1117`, GitHub-dark) rather than queried — capture is deterministic regardless of the host terminal theme.
- **Braille/blocks drawn as geometry on purpose** — font rendering of these is unreliable across systems, so spinners and sparklines look identical everywhere in exported PNG/MP4.
- **Frame equality drives dedup** — `Frame` derives `PartialEq/Eq/Hash`, so consecutive-identical and content-cached rendering is just `==`/HashMap.

## Relevance (advanced-TUI topics this teaches)
- **pty-emulation** — primary: portable-pty lifecycle, reader thread + bounded channel, settle/idle/deadline capture, process-group teardown, pipe-vs-PTY normalization.
- **ansi-escapes** — key→escape-sequence encoding, control-byte math, and (notably) *responding* to OSC/DCS/kitty capability queries to emulate a real terminal host.
- **rendering-pipeline** — vt100 screen → sparse `Frame` cells → SVG → PNG (resvg/tiny-skia) → FPS-sampled, content-deduped MP4 frames via ffmpeg.
- **unicode-text-width** — wide-char continuation handling and clearing the trailing cell when flattening to text.
- **widgets-rich-content** — synthesizing block/box-drawing/Braille/geometric glyphs as vector shapes instead of font glyphs.
- **input-keyboard-mouse** — full named-key and Ctrl-letter input model; paced typing for demos.
- **app-architecture** — versioned JSONL stdio protocol, Unix-socket daemon sessions, embedded vs named lifecycle, and a typed AsyncDisposable client with failure-artifact capture.
