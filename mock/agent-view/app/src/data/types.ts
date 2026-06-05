/** Color/animation axis = state (inventory §1). */
export type SessionState =
  | "working" // animated icon — actively running tools / generating
  | "needsInput" // yellow — waiting on a question or permission
  | "idle" // dimmed — nothing to do, ready for next prompt
  | "completed" // green — finished successfully
  | "failed" // red — ended with an error (also: machine shutdown)
  | "stopped" // grey — stopped via Ctrl+X / claude stop

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
  | "completed"

/** PR color states (inventory §4, L148-156). */
export type PrStatus =
  | "yellow" // waiting on checks/review, or checks failed
  | "green" // checks passed, nothing blocking — "merge when green"
  | "purple" // merged
  | "grey" // draft or closed

export interface PrRef {
  number: number // e.g. 2048
  status: PrStatus
  url?: string // hyperlink target in capable terminals
}

/** A single multiple-choice question shown in the peek panel (inventory §8). */
export interface PeekQuestion {
  text: string
  /** If present, peek renders numbered options; a number key picks one. */
  options?: string[]
}

/** One line in the attached-session transcript replay (inventory §9). */
export interface TranscriptEntry {
  role: "user" | "assistant" | "tool" | "system"
  /** seconds since session start, for ordering / optional playback */
  t: number
  text: string
}

export interface Session {
  id: string // full session id (uuid-ish)
  shortId: string // 8-char short id shown in shell echo (inventory §12)
  name: string // row name, e.g. "clawd walk cycle"
  agent: string // subagent/main agent name (for a:<name> filter)
  cwd: string // working directory

  state: SessionState // color/animation axis
  processAlive: boolean // shape axis: true => ✻/✽ alive, false => ∙ exited

  /** /loop session? If true the row is sleeping between iterations (✢). */
  isLoop: boolean
  loopRun?: number // current run count, e.g. 12
  countdown?: string // time until next iteration, e.g. "in 4m"

  summary: string // one-line Haiku-class summary (no transcript needed)
  /** When 2+ parallel work items run, shown as "2/5" BEFORE the summary. */
  doneTotal?: { done: number; total: number }

  lastChangedAgo: string // right-edge time-ago, e.g. "3m", "2h", "1m"

  pr?: PrRef // PR label at right edge (may push to readyForReview)
  pinned: boolean // Ctrl+T
  group: SessionGroup // resolved group for layout

  peekOutput: string[] // recent output lines shown in peek (NOT full transcript)
  question?: PeekQuestion // present iff state === "needsInput"

  transcript: TranscriptEntry[] // full transcript for the attached fullscreen view
}

/** A scripted mutation applied at time t (seconds). */
export interface ScenarioEvent {
  t: number // seconds from scenario start
  sessionId: string // target session
  label: string // human-readable note for the demo HUD
  /** Shallow patch merged onto the session; arrays replace, objects shallow-merge. */
  patch: Partial<Session>
  /** Optional: a line to append to peekOutput instead of replacing it. */
  appendPeek?: string
  /** Optional: a transcript entry to append (drives the attached view live). */
  appendTranscript?: TranscriptEntry
}

export interface MockScenario {
  startedAtIso: string // anchor for time-ago rendering
  sessions: Session[] // seed roster
  events: ScenarioEvent[] // replay timeline, sorted by t
}
