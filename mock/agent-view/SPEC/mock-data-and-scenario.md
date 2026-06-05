# Agent View — Mock Data & Scripted Scenario

Source of truth for shapes/states: `_raw-inventory.md` (citations there point into `RESEARCH/agent-view-docs.md`).

This file gives a mock everything it needs to render the Agent View table and to **replay a scripted timeline** so the state machine feels alive without any real backend. Nothing here calls a model or a process — it is data plus a list of timed mutations.

The theme reuses the docs' canonical game-dev project: a 2D platformer starring **clawd** with **jump-physics** and **power-up** work (see `_raw-inventory.md` §11).

---

## 1. Type definitions

```ts
/** Color/animation axis = state (inventory §1). */
export type SessionState =
  | "working"     // animated icon — actively running tools / generating
  | "needsInput"  // yellow — waiting on a question or permission
  | "idle"        // dimmed — nothing to do, ready for next prompt
  | "completed"   // green — finished successfully
  | "failed"      // red — ended with an error (also: machine shutdown)
  | "stopped";    // grey — stopped via Ctrl+X / claude stop

/**
 * Group is a SEPARATE axis from state (inventory §3): group names do NOT
 * map 1:1 to states.
 *  - "pinned"        : pinned with Ctrl+T (any state), floats to top
 *  - "readyForReview": session has an open pull request
 *  - "needsInput"    : needsInput-state sessions
 *  - "working"       : working-state sessions
 *  - "completed"     : collects completed + failed + stopped together
 */
export type SessionGroup =
  | "pinned"
  | "readyForReview"
  | "needsInput"
  | "working"
  | "completed";

/** PR color states (inventory §4, L148-156). */
export type PrStatus =
  | "yellow"   // waiting on checks/review, or checks failed
  | "green"    // checks passed, nothing blocking — "merge when green"
  | "purple"   // merged
  | "grey";    // draft or closed

export interface PrRef {
  number: number;          // e.g. 2048
  status: PrStatus;
  url?: string;            // hyperlink target in capable terminals
}

/** A single multiple-choice question shown in the peek panel (inventory §8). */
export interface PeekQuestion {
  text: string;
  /** If present, peek renders numbered options; a number key picks one. */
  options?: string[];
}

/** One line in the attached-session transcript replay (inventory §9). */
export interface TranscriptEntry {
  role: "user" | "assistant" | "tool" | "system";
  /** seconds since session start, for ordering / optional playback */
  t: number;
  text: string;
}

export interface Session {
  id: string;              // full session id (uuid-ish)
  shortId: string;         // 8-char short id shown in shell echo (inventory §12)
  name: string;            // row name, e.g. "clawd walk cycle"
  agent: string;           // subagent/main agent name (for a:<name> filter)
  cwd: string;             // working directory

  state: SessionState;     // color/animation axis
  processAlive: boolean;   // shape axis: true => ✻/✽ alive, false => ∙ exited

  /** /loop session? If true the row is sleeping between iterations (✢). */
  isLoop: boolean;
  loopRun?: number;        // current run count, e.g. 12
  countdown?: string;      // time until next iteration, e.g. "in 4m"

  summary: string;         // one-line Haiku-class summary (no transcript needed)
  /** When 2+ parallel work items run, shown as "2/5" BEFORE the summary. */
  doneTotal?: { done: number; total: number };

  lastChangedAgo: string;  // right-edge time-ago, e.g. "3m", "2h", "1m"

  pr?: PrRef;              // PR label at right edge (may push to readyForReview)
  pinned: boolean;         // Ctrl+T
  group: SessionGroup;     // resolved group for layout

  peekOutput: string[];    // recent output lines shown in peek (NOT full transcript)
  question?: PeekQuestion; // present iff state === "needsInput"

  transcript: TranscriptEntry[]; // full transcript for the attached fullscreen view
}

/** A scripted mutation applied at time t (seconds). */
export interface ScenarioEvent {
  t: number;                       // seconds from scenario start
  sessionId: string;               // target session
  label: string;                   // human-readable note for the demo HUD
  /** Shallow patch merged onto the session; arrays replace, objects shallow-merge. */
  patch: Partial<Session>;
  /** Optional: a line to append to peekOutput instead of replacing it. */
  appendPeek?: string;
  /** Optional: a transcript entry to append (drives the attached view live). */
  appendTranscript?: TranscriptEntry;
}

export interface MockScenario {
  startedAtIso: string;            // anchor for time-ago rendering
  sessions: Session[];             // seed roster
  events: ScenarioEvent[];         // replay timeline, sorted by t
}
```

---

## 2. Seed roster (13 sessions, every state + every group)

Spanning all 6 states (`working`, `needsInput`, `idle`, `completed`, `failed`, `stopped`), all 5 groups, both process shapes, a `/loop` row, `done/total`, every PR color, and a multiple-choice peek question. The dimmed `idle` and grey `stopped` rows live inside the `completed` group's fold (`… N more`) per inventory §3 (Completed group collects completed + failed + stopped; idle pinned stays visible because pinned floats up).

```ts
export const seedSessions: Session[] = [
  // ───────────── Pinned (floats to top regardless of state) ─────────────
  {
    id: "9f1c0a72-pinned-clawd-walk",
    shortId: "9f1c0a72",
    name: "clawd walk cycle",
    agent: "sprite-artist",
    cwd: "~/games/clawd-jumps",
    state: "working",
    processAlive: true,         // ✽ animated alive
    isLoop: false,
    summary: "Write assets/sprites/clawd-walk.png",
    lastChangedAgo: "3m",
    pinned: true,
    group: "pinned",
    peekOutput: [
      "Rendering frame 6/8 of walk cycle…",
      "Wrote assets/sprites/clawd-walk-f5.png",
      "Write assets/sprites/clawd-walk.png",
    ],
    transcript: [
      { role: "user", t: 0, text: "Draw an 8-frame walk cycle for clawd at 32x32." },
      { role: "assistant", t: 4, text: "Sketching the keyframes (contact, down, pass, up) then inbetweens." },
      { role: "tool", t: 40, text: "Write assets/sprites/clawd-walk-f1.png" },
      { role: "tool", t: 95, text: "Write assets/sprites/clawd-walk-f5.png" },
      { role: "assistant", t: 150, text: "Compositing the sheet now." },
    ],
  },
  {
    id: "2b7e44a1-pinned-idle-design-doc",
    shortId: "2b7e44a1",
    name: "design doc keeper",
    agent: "default",
    cwd: "~/games/clawd-jumps",
    state: "idle",              // dimmed — pinned keeps process alive while idle
    processAlive: true,         // ✻ static alive
    isLoop: false,
    summary: "Idle — ready for your next prompt",
    lastChangedAgo: "22m",
    pinned: true,
    group: "pinned",
    peekOutput: ["Standing by. Last action: updated DESIGN.md outline."],
    transcript: [
      { role: "user", t: 0, text: "Keep DESIGN.md in sync as we go." },
      { role: "assistant", t: 6, text: "Outline refreshed. I'll wait for the next instruction." },
    ],
  },

  // ───────────── Ready for review (has an open PR) ─────────────
  {
    id: "7c5dcf5d-review-jump-physics",
    shortId: "7c5dcf5d",
    name: "jump physics",
    agent: "default",
    cwd: "~/games/clawd-jumps",
    state: "completed",         // finished work, but PR pulls it to readyForReview
    processAlive: false,        // ∙ exited
    isLoop: false,
    summary: "Opened PR with collision fix",
    lastChangedAgo: "2h",
    pr: { number: 2048, status: "yellow", url: "https://github.com/acme/clawd-jumps/pull/2048" },
    pinned: false,
    group: "readyForReview",
    peekOutput: [
      "Pushed branch fix/jump-collision",
      "Opened PR #2048 — \"Fix clawd clipping through one-way platforms\"",
      "Waiting on CI: 3 checks running…",
    ],
    transcript: [
      { role: "user", t: 0, text: "Clawd clips through one-way platforms on a fast fall. Fix it." },
      { role: "assistant", t: 8, text: "Repro'd at fall speed > 600px/s. Adding swept-AABB continuous collision." },
      { role: "tool", t: 120, text: "Edit src/physics/CollisionSystem.ts" },
      { role: "tool", t: 240, text: "Bash gh pr create --fill" },
      { role: "assistant", t: 250, text: "Opened PR #2048. CI is running." },
    ],
  },
  {
    id: "a3309e10-review-checkpoint-save",
    shortId: "a3309e10",
    name: "checkpoint save system",
    agent: "default",
    cwd: "~/games/clawd-jumps",
    state: "completed",
    processAlive: false,        // ∙ exited
    isLoop: false,
    summary: "3 PRs open — save/load, autosave, slot UI",
    lastChangedAgo: "5h",
    // When >1 PR, label shows a count, colored by the one most needing attention.
    pr: { number: 2051, status: "grey", url: "https://github.com/acme/clawd-jumps/pull/2051" },
    pinned: false,
    group: "readyForReview",
    peekOutput: [
      "PR #2049  save/load core        green",
      "PR #2050  autosave on checkpoint yellow",
      "PR #2051  save-slot UI           grey (draft)",
    ],
    transcript: [
      { role: "user", t: 0, text: "Build a 3-slot checkpoint save system." },
      { role: "assistant", t: 10, text: "Splitting into 3 PRs: core, autosave, UI." },
      { role: "tool", t: 400, text: "Bash gh pr create (x3)" },
    ],
  },

  // ───────────── Needs input (yellow) ─────────────
  {
    id: "c81f2d6b-needs-powerup",
    shortId: "c81f2d6b",
    name: "power-up design",
    agent: "game-designer",
    cwd: "~/games/clawd-jumps",
    state: "needsInput",
    processAlive: true,         // ✻ alive
    isLoop: false,
    summary: "needs input: double jump or wall climb?",
    lastChangedAgo: "1m",
    pinned: false,
    group: "needsInput",
    peekOutput: [
      "Prototyped both traversal power-ups in a sandbox level.",
      "Double jump: forgiving, classic. Wall climb: higher skill ceiling.",
      "Which should be clawd's tier-1 power-up?",
    ],
    question: {
      text: "Which traversal power-up should ship as clawd's tier-1 ability?",
      options: [
        "Double jump (forgiving, fast to learn)",
        "Wall climb (higher skill ceiling)",
        "Ship both, gate wall climb behind a collectible",
      ],
    },
    transcript: [
      { role: "user", t: 0, text: "Design clawd's first traversal power-up." },
      { role: "assistant", t: 12, text: "Built two prototypes to compare feel." },
      { role: "assistant", t: 60, text: "I need a call: double jump or wall climb? (see options)" },
    ],
  },
  {
    id: "d4a9c7f2-needs-perm-secrets",
    shortId: "d4a9c7f2",
    name: "leaderboard backend",
    agent: "backend-eng",
    cwd: "~/games/clawd-jumps/server",
    state: "needsInput",
    processAlive: true,         // ✻ alive — waiting on a permission decision
    isLoop: false,
    summary: "needs input: allow writing .env.production?",
    lastChangedAgo: "4m",
    pinned: false,
    group: "needsInput",
    peekOutput: [
      "Scaffolded /scores POST + GET with rate limiting.",
      "Wants to write DB connection string to .env.production.",
      "Permission required to write outside the repo's tracked files.",
    ],
    question: {
      text: "Allow writing the connection string to .env.production?",
      options: ["Allow once", "Allow for this session", "Deny — I'll add it manually"],
    },
    transcript: [
      { role: "user", t: 0, text: "Stand up a leaderboard API with a Postgres store." },
      { role: "tool", t: 90, text: "Write src/routes/scores.ts" },
      { role: "system", t: 130, text: "Permission requested: write .env.production" },
    ],
  },

  // ───────────── Working ─────────────
  {
    id: "e07b1188-working-collision",
    shortId: "e07b1188",
    name: "collision detection",
    agent: "default",
    cwd: "~/games/clawd-jumps",
    state: "working",
    processAlive: true,         // ✽ animated
    isLoop: false,
    summary: "Edit src/physics/CollisionSystem.ts",
    lastChangedAgo: "2m",
    pinned: false,
    group: "working",
    peekOutput: [
      "Reading src/physics/CollisionSystem.ts",
      "Adding broad-phase spatial hash before narrow-phase checks.",
      "Edit src/physics/CollisionSystem.ts",
    ],
    transcript: [
      { role: "user", t: 0, text: "Collision is O(n^2); add a broad phase." },
      { role: "assistant", t: 9, text: "Adding a uniform spatial hash grid for broad-phase culling." },
      { role: "tool", t: 70, text: "Edit src/physics/CollisionSystem.ts" },
    ],
  },
  {
    id: "f9d2a604-working-parallel-tilesets",
    shortId: "f9d2a604",
    name: "tileset import",
    agent: "default",
    cwd: "~/games/clawd-jumps",
    state: "working",
    processAlive: true,         // ✽ animated, running parallel work items
    isLoop: false,
    doneTotal: { done: 2, total: 5 },  // shows "2/5" before summary
    summary: "importing biome tilesets",
    lastChangedAgo: "30s",
    pinned: false,
    group: "working",
    peekOutput: [
      "Longest-running item: slicing cavern-biome.png (1m 10s)",
      "Done: forest, meadow. Running: cavern, lava, ice.",
    ],
    transcript: [
      { role: "user", t: 0, text: "Import all 5 biome tilesets and slice them to 16x16." },
      { role: "assistant", t: 5, text: "Fanning out one subagent per biome." },
      { role: "tool", t: 30, text: "Slice forest-biome.png -> 240 tiles" },
      { role: "tool", t: 55, text: "Slice meadow-biome.png -> 198 tiles" },
    ],
  },
  {
    id: "10aa55cd-loop-playtest",
    shortId: "10aa55cd",
    name: "playtest level 3",
    agent: "playtester",
    cwd: "~/games/clawd-jumps",
    state: "working",           // a /loop session sits in the Working group
    processAlive: false,        // ✢ rendered separately (sleeping shape)
    isLoop: true,
    loopRun: 12,
    countdown: "in 4m",
    summary: "run 12 · all checkpoints cleared",
    lastChangedAgo: "in 4m",
    pinned: false,
    group: "working",
    peekOutput: [
      "run 12 finished: cleared all 7 checkpoints, 0 soft-locks.",
      "Avg clear time 2m 41s. Sleeping until next iteration…",
    ],
    transcript: [
      { role: "user", t: 0, text: "/loop every 5m: auto-playtest level 3, report soft-locks." },
      { role: "assistant", t: 3, text: "Loop armed. I'll run a headless playthrough each iteration." },
      { role: "system", t: 300, text: "run 11 complete — 1 soft-lock at checkpoint 4." },
      { role: "system", t: 600, text: "run 12 complete — all checkpoints cleared." },
    ],
  },

  // ───────────── Completed group (completed + failed + stopped + idle-foldable) ─────────────
  {
    id: "11bb66de-completed-title",
    shortId: "11bb66de",
    name: "title screen",
    agent: "ui-eng",
    cwd: "~/games/clawd-jumps",
    state: "completed",
    processAlive: true,         // ✻ static alive
    isLoop: false,
    summary: "result: menu, options, and credits done",
    lastChangedAgo: "9m",
    pinned: false,
    group: "completed",
    peekOutput: [
      "Built MainMenu, OptionsMenu, CreditsScroll.",
      "result: menu, options, and credits done",
    ],
    transcript: [
      { role: "user", t: 0, text: "Build the title screen: menu, options, credits." },
      { role: "assistant", t: 8, text: "Wiring up scene flow and input focus." },
      { role: "assistant", t: 200, text: "Done. Menu, options, and credits are in." },
    ],
  },
  {
    id: "22cc77ef-completed-sfx",
    shortId: "22cc77ef",
    name: "sound effects",
    agent: "audio-eng",
    cwd: "~/games/clawd-jumps",
    state: "completed",
    processAlive: false,        // ∙ exited
    isLoop: false,
    summary: "result: 14 SFX exported to assets/audio",
    lastChangedAgo: "4h",
    pinned: false,
    group: "completed",
    peekOutput: ["result: 14 SFX exported to assets/audio"],
    transcript: [
      { role: "user", t: 0, text: "Generate jump/land/coin/hurt SFX, export to assets/audio." },
      { role: "tool", t: 300, text: "Write assets/audio/jump.wav (… 14 files)" },
    ],
  },
  {
    id: "33dd88f0-failed-shader",
    shortId: "33dd88f0",
    name: "water shader",
    agent: "default",
    cwd: "~/games/clawd-jumps",
    state: "failed",            // red — failures always stay visible (never folded)
    processAlive: false,        // ∙ exited (attach/peek/reply restarts it)
    isLoop: false,
    summary: "error: GLSL compile failed (line 42)",
    lastChangedAgo: "1h",
    pinned: false,
    group: "completed",
    peekOutput: [
      "Compiling assets/shaders/water.frag…",
      "ERROR: 0:42: 'texture2D' : no matching overloaded function found",
      "error: GLSL compile failed (line 42)",
    ],
    transcript: [
      { role: "user", t: 0, text: "Add an animated water shader to the lava-biome bonus stage." },
      { role: "tool", t: 60, text: "Write assets/shaders/water.frag" },
      { role: "system", t: 80, text: "GLSL compile failed at line 42." },
    ],
  },
  {
    id: "44ee99a1-stopped-balance",
    shortId: "44ee99a1",
    name: "difficulty balance pass",
    agent: "game-designer",
    cwd: "~/games/clawd-jumps",
    state: "stopped",           // grey — stopped via Ctrl+X / claude stop
    processAlive: false,        // ∙ exited
    isLoop: false,
    summary: "stopped at your request",
    lastChangedAgo: "35m",
    pinned: false,
    group: "completed",
    peekOutput: ["Was retuning enemy HP curves. Stopped before applying changes."],
    transcript: [
      { role: "user", t: 0, text: "Rebalance enemy HP across all 7 levels." },
      { role: "assistant", t: 15, text: "Drafting a new HP curve…" },
      { role: "system", t: 40, text: "Session stopped by user (Ctrl+X)." },
    ],
  },
];
```

Fold rule for the mock: in the `completed` group, keep `failed` and any `pr`-bearing rows always visible; collapse the rest beyond the first two into a synthetic `… N more` row (inventory §3, L202).

---

## 3. Scripted event timeline (t = 0..70s)

A mock replays these in order, applying each `patch` (and optional `appendPeek` / `appendTranscript`) to the matching session, then re-sorting groups. This exercises the full state machine: a working row's summary refreshes, a needsInput appears, a completed arrives, a PR turns green, and the `/loop` row ticks.

```ts
export const scenarioEvents: ScenarioEvent[] = [
  // t=4s — a Working row's summary refreshes (summaries refresh ~every 15s + at turn end)
  {
    t: 4,
    sessionId: "e07b1188-working-collision",
    label: "Working summary refresh",
    patch: { summary: "Bash npm test -- physics", lastChangedAgo: "now" },
    appendPeek: "Running physics test suite (42 cases)…",
    appendTranscript: { role: "tool", t: 124, text: "Bash npm test -- physics" },
  },

  // t=10s — parallel tileset job advances its done/total count
  {
    t: 10,
    sessionId: "f9d2a604-working-parallel-tilesets",
    label: "done/total advances 2/5 -> 3/5",
    patch: { doneTotal: { done: 3, total: 5 }, summary: "importing biome tilesets", lastChangedAgo: "now" },
    appendPeek: "Done: forest, meadow, cavern. Running: lava, ice.",
    appendTranscript: { role: "tool", t: 90, text: "Slice cavern-biome.png -> 256 tiles" },
  },

  // t=18s — a brand-new Needs input session APPEARS (enemy AI asks a multiple-choice question)
  {
    t: 18,
    sessionId: "55ff00b2-needs-enemy-ai",
    label: "New needsInput session appears",
    patch: {
      // full new session object delivered via patch-as-upsert
      id: "55ff00b2-needs-enemy-ai",
      shortId: "55ff00b2",
      name: "enemy AI patrols",
      agent: "game-designer",
      cwd: "~/games/clawd-jumps",
      state: "needsInput",
      processAlive: true,
      isLoop: false,
      summary: "needs input: how aggressive should patrol enemies be?",
      lastChangedAgo: "now",
      pinned: false,
      group: "needsInput",
      peekOutput: [
        "Implemented patrol + chase states for the goomba-like enemy.",
        "Need a difficulty call on aggression before I tune ranges.",
      ],
      question: {
        text: "How aggressive should patrol enemies be by default?",
        options: ["Passive (turn at edges only)", "Alert (chase within 3 tiles)", "Relentless (chase across gaps)"],
      },
      transcript: [
        { role: "user", t: 0, text: "Add patrolling enemies to level 2." },
        { role: "assistant", t: 12, text: "Patrol + chase states done; need an aggression default." },
      ],
    },
  },

  // t=26s — the collision Working session COMPLETES and arrives in the Completed group
  {
    t: 26,
    sessionId: "e07b1188-working-collision",
    label: "Working -> Completed (task finished)",
    patch: {
      state: "completed",
      processAlive: true,
      group: "completed",
      summary: "result: broad-phase added, 42/42 tests pass",
      lastChangedAgo: "now",
    },
    appendPeek: "All 42 physics tests pass. Collision is now ~O(n).",
    appendTranscript: { role: "assistant", t: 180, text: "Broad phase landed. 42/42 green. Done." },
  },

  // t=34s — jump-physics PR turns GREEN (checks passed, nothing blocking — "merge when green")
  {
    t: 34,
    sessionId: "7c5dcf5d-review-jump-physics",
    label: "PR #2048 yellow -> green",
    patch: {
      pr: { number: 2048, status: "green", url: "https://github.com/acme/clawd-jumps/pull/2048" },
      summary: "PR #2048 checks passed — ready to merge",
      lastChangedAgo: "now",
    },
    appendPeek: "CI green: build, unit, lint all passed. No reviews blocking.",
  },

  // t=40s — the pinned clawd walk-cycle finishes a turn; summary refresh
  {
    t: 40,
    sessionId: "9f1c0a72-pinned-clawd-walk",
    label: "Pinned working summary refresh",
    patch: { summary: "Wrote assets/sprites/clawd-walk.png (8 frames)", lastChangedAgo: "now" },
    appendPeek: "Sheet composited: 8 frames, 256x32, exported.",
    appendTranscript: { role: "assistant", t: 200, text: "Walk cycle sheet exported. Looks bouncy." },
  },

  // t=48s — the /loop playtest TICKS: countdown fires, run count increments, new result
  {
    t: 48,
    sessionId: "10aa55cd-loop-playtest",
    label: "Loop tick run 12 -> 13",
    patch: {
      loopRun: 13,
      countdown: "in 5m",
      summary: "run 13 · soft-lock at checkpoint 4",
      lastChangedAgo: "now",
    },
    appendPeek: "run 13: SOFT-LOCK at checkpoint 4 (player can fall into a pit with no return).",
    appendTranscript: { role: "system", t: 900, text: "run 13 complete — 1 soft-lock at checkpoint 4." },
  },

  // t=56s — user answers the power-up question in peek; it flips Working
  {
    t: 56,
    sessionId: "c81f2d6b-needs-powerup",
    label: "needsInput answered -> Working",
    patch: {
      state: "working",
      group: "working",
      question: undefined,
      summary: "implementing double jump (your pick)",
      lastChangedAgo: "now",
    },
    appendPeek: "Got it — double jump. Wiring the input buffer + air-jump counter.",
    appendTranscript: { role: "user", t: 90, text: "Double jump." },
  },

  // t=64s — the leaderboard permission denial -> session continues, drops out of needsInput to idle
  {
    t: 64,
    sessionId: "d4a9c7f2-needs-perm-secrets",
    label: "Permission denied -> idle (folds into completed group via idle)",
    patch: {
      state: "idle",
      group: "completed",
      question: undefined,
      summary: "Idle — wrote .env.production.example instead",
      lastChangedAgo: "now",
    },
    appendPeek: "Understood, won't touch .env.production. Left a .example file for you.",
  },

  // t=70s — water shader FAILED row gets a retry nudge (stays visible; failures never fold)
  {
    t: 70,
    sessionId: "33dd88f0-failed-shader",
    label: "Failed row refresh (still red, still visible)",
    patch: { summary: "error: GLSL compile failed — peek to retry", lastChangedAgo: "now" },
    appendPeek: "Tip: reply 'use texture()' to retry on GLSL 3.30.",
  },
];
```

---

## 4. Sample attached-session transcripts

Two fuller transcripts a mock can show when the user attaches (`Enter`/`→`). Each opens with the on-attach **recap** (inventory §9, L173).

```ts
// Attaching to "collision detection" (e07b1188) after it completed at t=26.
export const attachedCollision: TranscriptEntry[] = [
  { role: "system", t: -1, text: "↩ Recap: while you were away I added a broad-phase spatial hash and all 42 physics tests passed." },
  { role: "user", t: 0, text: "Collision is O(n^2); add a broad phase." },
  { role: "assistant", t: 9, text: "Adding a uniform spatial hash grid for broad-phase culling, then keeping the swept-AABB narrow phase." },
  { role: "tool", t: 70, text: "Edit src/physics/CollisionSystem.ts" },
  { role: "tool", t: 124, text: "Bash npm test -- physics" },
  { role: "tool", t: 175, text: "✓ 42 passing (1.8s)" },
  { role: "assistant", t: 180, text: "Broad phase landed. 42/42 green. Worst-case pair checks dropped from ~4,900 to ~120 on a busy frame." },
];

// Attaching to the /loop "playtest level 3" (10aa55cd) — shows iteration history.
export const attachedPlaytest: TranscriptEntry[] = [
  { role: "system", t: -1, text: "↩ Recap: 13 playtest runs so far. Latest run found a soft-lock at checkpoint 4." },
  { role: "user", t: 0, text: "/loop every 5m: auto-playtest level 3, report soft-locks." },
  { role: "assistant", t: 3, text: "Loop armed. Headless playthrough each iteration; I'll report soft-locks and clear times." },
  { role: "system", t: 600, text: "run 12 complete — all checkpoints cleared, avg 2m41s." },
  { role: "system", t: 900, text: "run 13 complete — SOFT-LOCK at checkpoint 4: a pit with no return path after the moving platform leaves." },
  { role: "assistant", t: 905, text: "Recommend adding a respawn trigger or a one-way ledge at checkpoint 4. Sleeping until the next run (in 5m)." },
];
```

---

## 5. Sample multiple-choice peek question (standalone, for quick wiring)

```ts
export const samplePeekQuestion: PeekQuestion = {
  text: "Which traversal power-up should ship as clawd's tier-1 ability?",
  options: [
    "Double jump (forgiving, fast to learn)", // press 1
    "Wall climb (higher skill ceiling)",       // press 2
    "Ship both, gate wall climb behind a collectible", // press 3
  ],
};
// Peek renders these numbered; a number key picks one (inventory §8, L165).
// Tab fills the reply input with a suggested answer the user can edit before sending.
```

---

## 6. Assembled scenario export

```ts
export const mockScenario: MockScenario = {
  startedAtIso: "2026-06-05T14:30:00Z",
  sessions: seedSessions,
  events: scenarioEvents,
};
```

### Coverage checklist
- States: working (clawd walk, collision, tileset), needsInput (power-up, leaderboard, +enemy AI at t=18), idle (design doc keeper, leaderboard at t=64), completed (title, sfx, +collision at t=26), failed (water shader), stopped (balance pass). ✅ all 6
- Groups: pinned, readyForReview, needsInput, working, completed. ✅ all 5
- Process shapes: ✻ alive-static, ✽ alive-animated, ∙ exited, ✢ loop-sleeping. ✅ all 4
- PR colors: yellow→green (#2048), grey draft (#2051), and the multi-PR count row. ✅
- Extras: `doneTotal` 2/5→3/5, `/loop` run 12→13 + countdown, multiple-choice peek, fold `… N more`. ✅
- Timeline beats requested: working summary change (t=4), needsInput appears (t=18), completed arrives (t=26), PR turns green (t=34), loop ticks (t=48). ✅
```
