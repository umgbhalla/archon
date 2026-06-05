import type { PeekQuestion, Session, TranscriptEntry } from "./types"

export const seedSessions: Session[] = [
  // ───────────── Pinned (floats to top regardless of state) ─────────────
  {
    id: "9f1c0a72-pinned-clawd-walk",
    shortId: "9f1c0a72",
    name: "clawd walk cycle",
    agent: "sprite-artist",
    cwd: "~/games/clawd-jumps",
    state: "working",
    processAlive: true, // ✽ animated alive
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
    state: "idle", // dimmed — pinned keeps process alive while idle
    processAlive: true, // ✻ static alive
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
    state: "completed", // finished work, but PR pulls it to readyForReview
    processAlive: false, // ∙ exited
    isLoop: false,
    summary: "Opened PR with collision fix",
    lastChangedAgo: "2h",
    pr: { number: 2048, status: "yellow", url: "https://github.com/acme/clawd-jumps/pull/2048" },
    pinned: false,
    group: "readyForReview",
    peekOutput: [
      "Pushed branch fix/jump-collision",
      'Opened PR #2048 — "Fix clawd clipping through one-way platforms"',
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
    processAlive: false, // ∙ exited
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
    processAlive: true, // ✻ alive
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
    processAlive: true, // ✻ alive — waiting on a permission decision
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
    processAlive: true, // ✽ animated
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
    processAlive: true, // ✽ animated, running parallel work items
    isLoop: false,
    doneTotal: { done: 2, total: 5 }, // shows "2/5" before summary
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
    state: "working", // a /loop session sits in the Working group
    processAlive: false, // ✢ rendered separately (sleeping shape)
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
    processAlive: true, // ✻ static alive
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
    processAlive: false, // ∙ exited
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
    state: "failed", // red — failures always stay visible (never folded)
    processAlive: false, // ∙ exited (attach/peek/reply restarts it)
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
    state: "stopped", // grey — stopped via Ctrl+X / claude stop
    processAlive: false, // ∙ exited
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
]

// Attaching to "collision detection" (e07b1188) after it completed at t=26.
export const attachedCollision: TranscriptEntry[] = [
  { role: "system", t: -1, text: "↩ Recap: while you were away I added a broad-phase spatial hash and all 42 physics tests passed." },
  { role: "user", t: 0, text: "Collision is O(n^2); add a broad phase." },
  { role: "assistant", t: 9, text: "Adding a uniform spatial hash grid for broad-phase culling, then keeping the swept-AABB narrow phase." },
  { role: "tool", t: 70, text: "Edit src/physics/CollisionSystem.ts" },
  { role: "tool", t: 124, text: "Bash npm test -- physics" },
  { role: "tool", t: 175, text: "✓ 42 passing (1.8s)" },
  { role: "assistant", t: 180, text: "Broad phase landed. 42/42 green. Worst-case pair checks dropped from ~4,900 to ~120 on a busy frame." },
]

// Attaching to the /loop "playtest level 3" (10aa55cd) — shows iteration history.
export const attachedPlaytest: TranscriptEntry[] = [
  { role: "system", t: -1, text: "↩ Recap: 13 playtest runs so far. Latest run found a soft-lock at checkpoint 4." },
  { role: "user", t: 0, text: "/loop every 5m: auto-playtest level 3, report soft-locks." },
  { role: "assistant", t: 3, text: "Loop armed. Headless playthrough each iteration; I'll report soft-locks and clear times." },
  { role: "system", t: 600, text: "run 12 complete — all checkpoints cleared, avg 2m41s." },
  { role: "system", t: 900, text: "run 13 complete — SOFT-LOCK at checkpoint 4: a pit with no return path after the moving platform leaves." },
  { role: "assistant", t: 905, text: "Recommend adding a respawn trigger or a one-way ledge at checkpoint 4. Sleeping until the next run (in 5m)." },
]

export const samplePeekQuestion: PeekQuestion = {
  text: "Which traversal power-up should ship as clawd's tier-1 ability?",
  options: [
    "Double jump (forgiving, fast to learn)", // press 1
    "Wall climb (higher skill ceiling)", // press 2
    "Ship both, gate wall climb behind a collectible", // press 3
  ],
}
