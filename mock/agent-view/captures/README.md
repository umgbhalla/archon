# Agent View mock — captured evidence

Driven in a real PTY with [`termctrl`](../../../context/terminal-control) (`--host opentui`),
keyboard-only, against the scripted OpenTUI app in `../app`.

| File | Mode | Reached by |
| :--- | :--- | :--------- |
| `01-table` | grouped session list | launch |
| `02-peek` | peek panel (recent output) | `Space` |
| `03-peek-question` | peek panel w/ numbered options | `↓` to a Needs-input row |
| `04-attached` | attached session ("inbuilt terminal") — recap + transcript | `→` |
| `05-help` | keyboard-shortcut overlay | `?` |
| `06-scenario` | scripted scenario stepped (HUD `2/10`) | `n` ×2 |
| `07-rename` | inline rename editor | `Ctrl+R` |
| `08-delete` | delete flow (stop → 2s arm → disarm) | `Ctrl+X` |

Each `.png` is the rendered screen; `.txt` is the same screen as text.

- `av.termctrl` — full recorded timeline (table → peek → question → attached → help → scenario → rename → delete → exit).
- `av-demo.mp4` — walkthrough video exported from that timeline (real timing). The armed 2s delete-confirm banner is visible live here even though the CLI still-capture lands after disarm.

Re-export the video: `termctrl video av.termctrl --out av-demo.mp4 --hide-cursor --footer`.
