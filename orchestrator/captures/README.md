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

---

## Chat demo — attached view, permission modal, multi-turn (agent=fake)

A second deterministic walkthrough of the **chat surface** inside the attached
view, driven with `termctrl` against `archon --agent fake` (credential-free).
Same method: stills extracted from the recording at named markers, not live reads.

- `chat-demo.mp4` — captioned walkthrough built from `chat-demo.termctrl` + `chat-demo.json`.
- `chat-demo.termctrl` — recorded timeline (11 markers).
- `chat-demo.json` — marker-range edit plan (captions, holds).
- `chat-*.png` — one still per beat.

| Beat | What it shows | Key |
| :--- | :--- | :--- |
| chat-launch | empty fleet grid (agent=fake) | launch |
| chat-session-created | a dispatched task ran → Completed in the grid | type + `Enter` |
| chat-attached | the attached chat log (user + assistant turn) | `↓` then `Enter` |
| chat-permission-modal | "edit a file" → streamed **thought** + **tool_call card** + **permission modal** | type + `Enter` |
| chat-allowed-resumed | pick **Allow** → tool_call completes, the turn resumes + finishes | `1` |
| chat-followup-turn | a follow-up prompt → second assistant turn (multi-turn) | type + `Enter` |
| chat-overflow | more turns overflow the viewport (`⋮ N earlier lines`) | type + `Enter` |
| chat-scrollback | **PgUp** scrolls back to the top of the transcript | `PgUp` |

Re-export the video:
`termctrl video chat-demo.termctrl --edit chat-demo.json --footer --tail-ms 1200 --out chat-demo.mp4`.

**Real vs scripted.** The chat surface, structured conversation model, interactive
permission flow, and scrollback are all **real** code paths against a live
`SessionManager` — the `fake` agent only stands in for a real ACP model so the
demo is deterministic and needs no credentials. The same flow runs against real
`claude` (verified by hand: a 2-turn TUI conversation in a temp cwd streamed
`PINEAPPLE` then `MANGO`; see `src/real-integration.test.ts`, gated on
`ARCHON_TEST_REAL=1`). Still thin: only `allow_once`/`reject_once` options are
exercised by the fake agent; tool-call cards show title + status but not a diff
preview; the run-inspector / DAG surface from the north star is not built yet.
