# Agent View mock — captured evidence

Driven in a real PTY with [`termctrl`](../../../context/terminal-control) (`--host opentui`),
keyboard-only, against the scripted OpenTUI app in `../app`. Stills are extracted
**deterministically** from the recording (`termctrl save --recording … --at-marker`),
not raced live `show` calls.

- `agent-view-demo.mp4` — 45s captioned, branded walkthrough (built from `demo.termctrl` + `demo-edit.json`).
- `demo.termctrl` — recorded timeline (18 markers).
- `demo-edit.json` — marker-range edit plan (captions, holds) used for the video.
- `NN-*.png` / `NN-*.txt` — one still per beat.

| Beat | Mode / action | Key |
| :--- | :--- | :--- |
| 01-table | grouped session list | launch |
| 02-dispatch | new background session created | type + `Enter` |
| 03-tooshort | <4-char prompt rejected | `Enter` |
| 04-filter | list filtered to working | `s:working` |
| 05-peek | peek panel (recent output) | `Space` |
| 06-question | peek a blocked session, numbered options | `↓` |
| 07-answered | option picked | `1` |
| 08-attached | attached session — inbuilt terminal | `Enter`/`→` |
| 09-help | keyboard-shortcut overlay | `?` |
| 10-groupdir | group by directory | `Ctrl+S` |
| 11-pin | pin a session | `Ctrl+T` |
| 12-rename-edit | inline rename editor | `Ctrl+R` |
| 13-renamed | rename committed | type + `Enter` |
| 14-delete-armed | 2s delete confirm armed | `Ctrl+X` |
| 15-deleted | row removed | `Ctrl+X` again |
| 16-scenario | scripted scenario stepped | `n` |
| 17-narrow / 18-wide | responsive reflow | `resize` |
| 19-bashjob | shell job dispatched (`! pytest -x`) | type `!…` |
| 20-theme-light | light/dark theme toggle | `Ctrl+L` |
| 21-transcript | transcript mode in attached view | `Ctrl+O` |
| 22-reorder | reorder rows within a group | `Shift+↑/↓` |

Re-export the video: `termctrl video demo.termctrl --edit demo-edit.json --footer --hide-cursor --out agent-view-demo.mp4`.
