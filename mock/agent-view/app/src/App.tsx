// Agent View mock — root App.
//
// SHARED FILE — component agents must NOT edit this. It owns: the header,
// the grouped session list (rows + selection band), the dispatch input, the
// footer hints, keyboard wiring (keymap -> store), mode switching to the stub
// components, and the single deleteConfirm 2s timer.

import { TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef } from "react"
import { AttachedSession } from "./components/AttachedSession"
import { DeleteConfirm } from "./components/DeleteConfirm"
import { HelpOverlay } from "./components/HelpOverlay"
import { Onboarding } from "./components/Onboarding"
import { PeekPanel } from "./components/PeekPanel"
import { RenameInput } from "./components/RenameInput"
import { scenarioEvents } from "./data/scenario"
import type { Session } from "./data/types"
import { keyToAction } from "./state/keymap"
import {
  buildRenderGroups,
  DELETE_ARM_MS,
  selectedSelectable,
  selectedSession,
  sessionById,
  useStore,
} from "./state/store"
import { colorForPr, colorForState, GROUP_TITLES, iconForShape, setThemeMode, theme } from "./theme/theme"

// ───────────────────────── Header ─────────────────────────

function Header({ sessions }: { sessions: Session[] }) {
  const c = theme.colors
  const awaiting = sessions.filter((s) => s.state === "needsInput").length
  const working = sessions.filter((s) => s.state === "working").length
  const completed = sessions.filter((s) => s.state === "completed").length
  const summary = `${awaiting} awaiting input · ${working} working · ${completed} completed`
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={1}>
      <box height={1}>
        <text>
          <span fg={c.claude} attributes={TextAttributes.BOLD}>{"▟▙  "}</span>
          <span fg={c.fg} attributes={TextAttributes.BOLD}>Claude Code</span>
          <span fg={c.fgDim}>{" v2.1.140"}</span>
        </text>
      </box>
      <box height={1}>
        <text>
          <span fg={c.claude}>{"▜▛  "}</span>
          <span fg={c.fgDim}>{"Opus 4.7 (1M context) · /Users/jane/code/web-app"}</span>
        </text>
      </box>
      <box height={1}>
        <text fg={c.fgDim}>{`    ${summary}`}</text>
      </box>
    </box>
  )
}

// ───────────────────────── Row ─────────────────────────

function SessionRow({ session, selected, width }: { session: Session; selected: boolean; width: number }) {
  const c = theme.colors
  const bg = selected ? c.selectionBg : undefined
  const icon = iconForShape({ processAlive: session.processAlive, isLoop: session.isLoop, state: session.state })
  const iconColor = colorForState(session.state)

  const NAME_W = 24
  const name = session.name.length > NAME_W ? `${session.name.slice(0, NAME_W - 1)}…` : session.name.padEnd(NAME_W)

  const donePrefix = session.doneTotal ? `${session.doneTotal.done}/${session.doneTotal.total} ` : ""
  const right = session.isLoop ? (session.countdown ?? session.lastChangedAgo) : session.lastChangedAgo

  const prText = session.pr ? `PR #${session.pr.number}` : ""
  const SUMMARY_W = Math.max(10, width - 4 - 2 - NAME_W - 1 - (prText ? prText.length + 2 : 0) - 1 - 6)
  let summary = `${donePrefix}${session.summary}`
  if (summary.length > SUMMARY_W) summary = `${summary.slice(0, SUMMARY_W - 1)}…`
  summary = summary.padEnd(SUMMARY_W)

  return (
    <box height={1} paddingLeft={4} paddingRight={2} {...(bg ? { backgroundColor: bg } : {})}>
      <text wrapMode="none" {...(bg ? { bg } : {})}>
        <span fg={iconColor} {...(bg ? { bg } : {})}>{`${icon} `}</span>
        <span fg={c.fg} attributes={TextAttributes.BOLD} {...(bg ? { bg } : {})}>{name}</span>
        <span fg={c.fgDim} {...(bg ? { bg } : {})}>{` ${summary}`}</span>
        {session.pr ? <span fg={colorForPr(session.pr.status)} {...(bg ? { bg } : {})}>{` ${prText}`}</span> : null}
        <span fg={c.fgDim} {...(bg ? { bg } : {})}>{` ${right.padStart(5)}`}</span>
      </text>
    </box>
  )
}

// ───────────────────────── App ─────────────────────────

export function App() {
  const { state, dispatch } = useStore()
  const { width, height } = useTerminalDimensions()
  const renderer = useRenderer()
  const c = theme.colors

  useEffect(() => {
    setThemeMode(state.themeMode)
    renderer.setBackgroundColor(c.bg)
  }, [renderer, c.bg, state.themeMode])

  // Single timer in the whole app: the 2s deleteConfirm arm window (U29).
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (state.mode === "deleteConfirm") {
      disarmTimer.current = setTimeout(() => dispatch({ type: "deleteDisarm" }), DELETE_ARM_MS)
      return () => {
        if (disarmTimer.current) clearTimeout(disarmTimer.current)
      }
    }
    return undefined
  }, [state.mode, state.deleteArmedId, state.deleteArmedGroup, dispatch])

  // Exit to shell.
  useEffect(() => {
    if (state.exited) {
      renderer.destroy?.()
      process.exit(0)
    }
  }, [state.exited, renderer])

  useKeyboard((key) => {
    const action = keyToAction(key, state)
    if (action) dispatch(action)
  })

  const renderGroups = buildRenderGroups(state)
  const sel = selectedSelectable(state)
  const selSession = selectedSession(state)

  // Fullscreen replacement: attached session.
  if (state.mode === "attachedSession") {
    const attached = sessionById(state, state.attachedId)
    if (attached) return <AttachedSession session={attached} width={width} height={height} transcriptMode={state.transcriptMode} />
  }

  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={c.bg}>
      <Header sessions={state.sessions} />

      {/* Onboarding (empty roster) or the grouped session list */}
      {state.mode === "onboardingEmpty" || state.sessions.length === 0 ? (
        <Onboarding width={width} height={height} />
      ) : (
      <box flexDirection="column" paddingTop={1} flexGrow={1}>
        {renderGroups.map((rg) => {
          const headerSelected = sel?.kind === "header" && sel.group === rg.group
          return (
            <box key={rg.group} flexDirection="column">
              <box height={1} paddingLeft={2} {...(headerSelected ? { backgroundColor: c.selectionBg } : {})}>
                <text fg={c.fg} attributes={TextAttributes.BOLD} {...(headerSelected ? { bg: c.selectionBg } : {})}>
                  {`${rg.collapsed ? "▸ " : ""}${GROUP_TITLES[rg.group]}`}
                </text>
              </box>
              {rg.rows.map((row) => (
                <SessionRow key={row.id} session={row} selected={sel?.kind === "row" && sel.sessionId === row.id} width={width} />
              ))}
              {rg.foldedCount > 0 ? (
                <box height={1} paddingLeft={4}>
                  <text fg={c.fgDim}>{`… ${rg.foldedCount} more`}</text>
                </box>
              ) : null}
              <box height={1}><text> </text></box>
            </box>
          )
        })}
      </box>

)}

      {/* Dispatch input bracketed by dim rules */}
      <box flexDirection="column" paddingLeft={2}>
        <text fg={c.separator}>{"─".repeat(Math.max(1, width - 4))}</text>
        <text>
          <span fg={c.claude}>{"❯ "}</span>
          {state.input.text.length > 0 ? (
            <span fg={state.input.isFilter ? c.warning : c.fg}>{state.input.text}</span>
          ) : (
            <span fg={c.fgDim}>describe a task for a new session</span>
          )}
        </text>
        <text fg={c.separator}>{"─".repeat(Math.max(1, width - 4))}</text>
      </box>

      {/* Footer hints + demo HUD */}
      <box flexDirection="column" paddingLeft={2}>
        <text fg={c.fgDim}>space peek · enter attach · ctrl+t pin · ctrl+r rename · ctrl+x delete · ctrl+s group · ctrl+l theme · n scenario · ? help</text>
        <text>
          <span fg={c.claude}>{"hud "}</span>
          <span fg={c.fgDim}>{`${state.hud}  (${state.scenarioCursor}/${scenarioEvents.length})`}</span>
        </text>
      </box>

      {/* Overlays */}
      {state.mode === "peekPanel" && selSession ? (
        <PeekPanel session={selSession} replyBuffer={state.replyBuffer} width={width} height={height} />
      ) : null}
      {state.mode === "helpOverlay" ? <HelpOverlay width={width} height={height} /> : null}
      {state.mode === "renameInput" && selSession ? (
        <RenameInput renameBuffer={state.renameBuffer} originalName={selSession.name} width={width} />
      ) : null}
      {state.mode === "deleteConfirm" ? (
        <DeleteConfirm
          targetName={sessionById(state, state.deleteArmedId)?.name ?? null}
          targetGroup={state.deleteArmedGroup ? GROUP_TITLES[state.deleteArmedGroup] : null}
          width={width}
        />
      ) : null}
    </box>
  )
}
