import { seedSessions } from "./seed"
import type { MockScenario, ScenarioEvent } from "./types"

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
]

export const mockScenario: MockScenario = {
  startedAtIso: "2026-06-05T14:30:00Z",
  sessions: seedSessions,
  events: scenarioEvents,
}
