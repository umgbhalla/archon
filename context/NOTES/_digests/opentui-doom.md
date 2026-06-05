# opentui-doom

## What it is (1-2 lines)
Plays full DOOM in a terminal by compiling `doomgeneric` to WASM (Emscripten) and blitting its RGBA framebuffer into an OpenTUI `FrameBufferRenderable` using Unicode upper-half-block characters (`▀`) for 2x vertical resolution. A compact, real-world case study in driving a high-FPS pixel framebuffer through a cell-based TUI, plus keyboard/mouse-to-game-key translation and out-of-process audio.

## Architecture (how the pieces fit; key files with paths)
- `src/index.ts` — entry point + the entire render loop. Creates the `CliRenderer`, wires UI (loading text, controls overlay), instantiates `DoomEngine`, registers keyboard/mouse handlers, and runs `gameLoop` via `renderer.setFrameCallback`.
- `src/doom-engine.ts` — `DoomEngine` class: the WASM lifecycle wrapper. Loads `doom/build/doom.js` (Emscripten module), sets up the virtual FS (WAD, save dir, `default.cfg`), calls `doomgeneric_Create`, exposes `tick()`, `getFrameBuffer()`, `pushKey()`, `syncSaves()`.
- `src/doom-input.ts` — maps OpenTUI `KeyEvent`s to DOOM key codes (from `doomkeys.h`), with synthetic key-up via timers.
- `src/doom-mouse.ts` — translates mouse X deltas into held turn-key presses; left click = fire.
- `src/doom-audio.ts` — fire-and-forget audio by spawning `mpv` subprocesses; music volume controlled live over an mpv IPC unix socket.
- `src/doom-saves.ts` — persists DOOM `.dsg` save slots between the WASM virtual FS and `~/.opentui-doom/`.
- `doom/doomgeneric_opentui.c` — the C platform shim implementing doomgeneric's 5 required hooks; exposes `DG_GetFrameBuffer` / `DG_PushKeyEvent` to JS via `EMSCRIPTEN_KEEPALIVE`; holds a ring-buffer key queue.
- `scripts/build-doom.sh` — Emscripten build with the exported-functions/runtime-methods list.

Data flow per frame: `gameLoop` -> `engine.tick()` (`_doomgeneric_Tick`) -> DOOM renders into `DG_ScreenBuffer` (ARGB) -> JS reads it via the framebuffer pointer -> converts + downscales -> writes cells into OpenTUI's `FrameBuffer` -> OpenTUI diffs and flushes to terminal.

## Core techniques (the actual TUI engineering)

### Half-block framebuffer rendering (the headline trick) — `src/index.ts:264-293`
Each terminal cell renders TWO vertical pixels using `▀` (upper half block): the glyph's **foreground color = top pixel**, **background color = bottom pixel**. This doubles vertical resolution for free since terminals are ~2:1 tall per cell.
- Effective resolution: `fb.width` columns x `fb.height*2` pixel rows.
- Source is downscaled with integer floor sampling (nearest-neighbor):
  ```
  scaleX = DOOM_WIDTH  / fb.width
  scaleY = DOOM_HEIGHT / (fb.height * 2)   // *2 because each cell = 2 rows
  srcY1 = floor(y*2 * scaleY)              // top pixel row
  srcY2 = floor((y*2+1) * scaleY)          // bottom pixel row
  fb.setCell(x, y, "▀", RGBA(top), RGBA(bottom))
  ```
- DOOM is compiled at a deliberately high internal res (1280x800, see `-DDOOMGENERIC_RESX/RESY` in build script and `DOOM_WIDTH/HEIGHT` in engine) so the downsample to terminal size stays crisp.

### Framebuffer ownership / diffing handled by OpenTUI
The repo never emits ANSI itself. It calls `framebufferRenderable.frameBuffer.setCell(x, y, glyph, fg, bg)` per cell; OpenTUI's `FrameBufferRenderable` owns the dirty-diff + ANSI flush. Resize is handled by `framebufferRenderable.frameBuffer.resize(width, height)` on the renderer's `"resize"` event (`src/index.ts:297`). Lesson: treat the library framebuffer as a mutable cell grid and rewrite it wholesale each frame; let the lib diff.

### ARGB -> RGBA pixel conversion across the WASM boundary — `src/doom-engine.ts:244-264`
DOOM stores 32-bit ARGB. JS reads each pixel from WASM linear memory with `module.getValue(ptr + i*4, "i32")` and unpacks:
```
R = (argb >> 16) & 0xff;  G = (argb >> 8) & 0xff;  B = argb & 0xff;  A = 255;
```
Note: it loops `getValue` per pixel (1280*800 = ~1M calls/frame) rather than slicing `HEAPU8` — a correctness-over-speed choice; a `HEAPU32` subarray view would be far faster.

### Keyboard: synthetic key-up via timers — `src/doom-input.ts`
Terminals deliver key *repeats*, not press/release pairs, so the handler fakes releases:
- Tracks per-key `keyStates`; on first press sends `pushKey(true, code)`.
- Schedules `pushKey(false, code)` 300ms after the last event (`keyTimers`), cancelled if the key repeats. This converts terminal autorepeat into held-down semantics DOOM expects.
- WASD sends **two** codes — the movement key AND the literal char (`'w'.charCodeAt(0)`) — so movement works in-game and typing works in save-name dialogs (`mapKeyToDoom`, lines 75-78). `default.cfg` is generated to bind those char codes to movement (`doom-engine.ts:136-145`).
- Menu confirm keys (`y`/`n`) bypass the held model: press then auto-release after 50ms, and re-fire on every keypress (`isMenuConfirmKey`), because DOOM only reads the keydown.
- Ctrl+C is intercepted before mapping for clean exit; Ctrl (non-C) maps to FIRE.

### Mouse-look as synthetic turn-key holds — `src/doom-mouse.ts`
There is no relative mouse delta in a terminal, so it diffs successive absolute cell X positions. Positive delta -> hold RIGHTARROW, negative -> LEFTARROW. A 100ms `releaseTimer` (refreshed on every move) releases the turn key after motion stops; direction change releases old key and presses new. Left mouse button = FIRE down/up. Same "convert events into sustained key state" pattern as keyboard.

### Out-of-process audio via mpv + IPC socket — `src/doom-audio.ts`
- Sound effects: fire-and-forget `spawn("mpv", ["--no-video","--no-terminal","--really-quiet","--volume=..", file])`; processes self-deregister on `exit`. All live procs tracked in a `Set` and `SIGKILL`ed on shutdown.
- Music: single long-lived mpv with `--input-ipc-server=/tmp/doom-music-mpv.sock`; live volume changes are sent as JSON commands over a unix socket (`{command:["set_property","volume",v]}`) instead of restarting playback.
- C calls these JS functions through Emscripten `EM_ASM` callbacks declared on the Module config object (`doom-engine.ts:104-109`).

### WASM virtual filesystem bridging — `src/doom-engine.ts` preRun + `syncSaves`
- `preRun` populates the Emscripten MEMFS before main: `FS_createPath`/`FS_createDataFile` to drop `doom1.wad` at `/doom`, create `/.savegame`, write `default.cfg`, and preload existing saves from disk.
- DOOM may write saves to several paths; `syncSaves()` brute-force scans a candidate list (`/`, `/.savegame`, `/doom`, `/tmp`, ...) for `doomsav{0-5}.dsg`, reads them out of MEMFS and writes to `~/.opentui-doom/`. Called every 5s and on exit. MEMFS is volatile, so this manual sync is the persistence layer.

### C <-> JS interop surface — `doom/doomgeneric_opentui.c`, `scripts/build-doom.sh`
- doomgeneric requires 5 platform hooks; the shim no-ops most (`DG_SleepMs` is a no-op because JS owns timing; deliberately avoids `emscripten_sleep` to skip ASYNCIFY) and routes timing to `emscripten_get_now()`.
- Key input uses a fixed 256-entry ring buffer; `DG_PushKeyEvent` (called from JS) enqueues, `DG_GetKey` (called by DOOM's `i_input.c`) dequeues.
- Exported symbols are pinned via `EMSCRIPTEN_KEEPALIVE` and the `EXPORTED_FUNCTIONS`/`EXPORTED_RUNTIME_METHODS` lists (build script lines 51-52). Runtime kept alive with `NO_EXIT_RUNTIME=1`/`EXIT_RUNTIME=0` so the module persists across ticks.

## Code patterns worth stealing
- **Half-block 2x vertical pixels**: `setCell(x, y, "▀", fgTopPixel, bgBottomPixel)` — the canonical terminal "graphics" doubling trick.
- **Terminal events -> sustained input state**: keep a `Map` of pressed keys and a debounce timer per key to synthesize key-up, since terminals only give repeats:
  ```ts
  if (!wasPressed) { state.set(id,true); engine.pushKey(true, code); }
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => { engine.pushKey(false, code); state.set(id,false); }, 300));
  ```
- **Mouse-look from absolute positions**: diff successive X, hold a direction key, release on a refreshed idle timer.
- **Dual key emission** for context-sensitive input (movement code + literal char) so the same physical key works in gameplay and text fields.
- **Frame loop discipline**: `let isExiting=false; gameLoop` bails immediately on `isExiting`, and cleanup clears the frame callback (`renderer.setFrameCallback(null)`) *before* stopping the renderer to prevent ticking a torn-down module.
- **Live subprocess control over IPC socket** rather than respawn (mpv volume).
- **Let the framebuffer lib own diffing**: rewrite all cells every frame; never hand-roll ANSI.

## Gotchas / non-obvious decisions
- `getFrameBuffer()` reads pixels one-at-a-time via `getValue(..., "i32")` (~1M calls/frame at 1280x800). Works but is the obvious perf hot spot; a `new Uint32Array(HEAPU8.buffer, ptr, pixels)` view would avoid the per-pixel FFI cost.
- `targetFps: 35` matches DOOM's native tic rate; mismatch causes speed bugs.
- `exitOnCtrlC:false` so audio subprocesses and saves get cleaned up manually; SIGINT/SIGTERM/exit all funnel through `cleanup()`. Forgetting this orphans mpv processes.
- MEMFS is in-memory only — without `syncSaves()` writing back to the host FS, all progress is lost. Save path is uncertain so it scans multiple dirs.
- `DG_SleepMs` must be a no-op (not `emscripten_sleep`) to avoid needing ASYNCIFY; timing is owned entirely by the JS frame loop.
- Audio depends on an external `mpv` binary on PATH; not bundled.
- Downscaling is nearest-neighbor floor sampling — no averaging, so small terminals alias heavily, but it's cheap.
- Each WASD keypress floods DOOM with two codes; the generated `default.cfg` must agree with the char codes or movement breaks.

## Relevance (advanced-TUI topics this teaches)
- rendering-pipeline: framebuffer blit loop, per-cell writes, downscaling, lib-owned diff/flush.
- unicode-text-width: half-block (`▀`) glyph technique for 2x vertical pixel density via fg/bg colors.
- input-keyboard-mouse: terminal repeat -> press/release synthesis, mouse-look from absolute positions, dual-emission keys.
- ansi-escapes: indirectly — shows where ANSI is delegated to OpenTUI (`FrameBufferRenderable`) instead of hand-rolled; uses raw `\x1b[` sequences only to disambiguate arrow keys.
- app-architecture: frame callback loop, lifecycle/cleanup ordering, WASM module wrapper boundary, subprocess + IPC audio, MEMFS<->host persistence sync.
