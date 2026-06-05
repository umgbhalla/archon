# archon fleet TUI — captured evidence

Driven in a real PTY with [`termctrl`](../../../context/terminal-control)
(`--host opentui`), keyboard-only, against `archon --agent fake` (the bundled
credential-free ACP agent). Stills are extracted **deterministically** from the
recording (`termctrl save --recording … --at-marker`), not raced live `show`
calls — the Ctrl+X delete confirm is a sub-2s state that live reads alias.

- `archon-demo.mp4` — captioned walkthrough built from `demo.termctrl` + `demo-edit.json`.
- `demo.termctrl` — recorded timeline (11 markers).
- `demo-edit.json` — marker-range edit plan (captions, holds).
- `NN-*.png` / `NN-*.txt` — one still per beat.

| Beat | What it shows | Key |
| :--- | :--- | :--- |
| 01-launch | empty fleet grid (agent=fake) | launch |
| 02-dispatch-typed | a task typed into the dispatch input | type |
| 03-completed | session ran on the ACP agent → Completed | `Enter` |
| 04-attached | attached view with the streamed reply | `↓` then `Enter` |
| 05-attached-stream | a follow-up prompt streams live (reply doubles) | type + `Enter` |
| 06-detached | back to the grid | `Esc` |
| 07-help | keyboard-shortcut overlay (generated from the keymap) | `?` |
| 08-filter-waiting | filter to needs-input (none → empty state) | `w` |
| 09-stop-armed | Ctrl+X stops the session + arms a 2s delete confirm | `Ctrl+X` |
| 10-deleted | second Ctrl+X within 2s removes the session | `Ctrl+X` |
| 11-quit | exit to the shell | `q` |

Re-export the video:
`termctrl video demo.termctrl --edit demo-edit.json --footer --hide-cursor --out archon-demo.mp4`.
