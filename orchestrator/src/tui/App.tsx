/**
 * App — the archon session-grid TUI (fleet surface).
 *
 * Binds to the REAL SessionManager (no seed data): renders sessions grouped by
 * logical state with the dual-channel glyph (color = state, shape = liveness),
 * tracks selection by stable session id, and hosts a dispatch input that creates
 * a new session via the backend. Enter attaches to a session and streams its ACP
 * updates into a fullscreen attached view with its own prompt input.
 *
 * Fleet ops bound to live daemon/manager state:
 *   - attach (Enter/→) → fullscreen streamed view; ←/Esc detach
 *   - Ctrl+X stop, then Ctrl+X again within 2s to delete (manager.cancel/remove)
 *   - w → filter to needs-input (waiting) sessions
 *   - ? → help overlay generated from the keymap (HELP_SECTIONS)
 *
 * Layout patterns ported from mock/agent-view/app/src/App.tsx (header, grouped
 * list + selection band, bracketed dispatch input, footer hints, help/confirm
 * overlays).
 */
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useReducer, useRef } from "react";
import type { SessionManager, SessionSnapshot } from "../core/session-manager.ts";
import { ChatView } from "./ChatView.tsx";
import { PermissionModal } from "./PermissionModal.tsx";
import { HELP_SECTIONS, keyToAction } from "./keymap.ts";
import {
  applyFilter,
  buildRenderGroups,
  initialUiState,
  reducer,
  selectedSelectable,
  selectedSession,
  type UiAction,
  type UiState,
} from "./store.ts";
import { colors as c, colorForState, iconForLiveness } from "./theme.ts";

/** Arm window for the Ctrl+X delete chord. */
const DELETE_ARM_MS = 2000;

export interface AppProps {
  manager: SessionManager;
  /** Agent backend name used when the dispatch input creates a session. */
  agent: string;
  cwd: string;
  /** Extra named agents from config, merged into the registry for resolution. */
  configAgents?: Record<string, string[]>;
}

// ───────────────────────── Header ─────────────────────────
function Header({
  sessions,
  agent,
  filterWaiting,
}: {
  sessions: SessionSnapshot[];
  agent: string;
  filterWaiting: boolean;
}) {
  const waiting = sessions.filter((s) => s.state === "waiting").length;
  const busy = sessions.filter((s) => s.state === "busy").length;
  const done = sessions.filter((s) => s.state === "completed").length;
  const failed = sessions.filter((s) => s.state === "failed").length;
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={1}>
      <box height={1}>
        <text>
          <span fg={c.accent} attributes={TextAttributes.BOLD}>{"▟▙  "}</span>
          <span fg={c.fg} attributes={TextAttributes.BOLD}>archon</span>
          <span fg={c.fgDim}>{`  fleet · agent=${agent}`}</span>
          {filterWaiting ? <span fg={c.waiting} attributes={TextAttributes.BOLD}>{"   [filter: needs-input]"}</span> : null}
        </text>
      </box>
      <box height={1}>
        <text wrapMode="none">
          <span fg={c.fgDim}>{`    ${sessions.length} sessions · `}</span>
          <span fg={waiting > 0 ? c.waiting : c.fgDim} attributes={waiting > 0 ? TextAttributes.BOLD : undefined}>{`${waiting} need input`}</span>
          <span fg={c.fgDim}>{" · "}</span>
          <span fg={busy > 0 ? c.busy : c.fgDim}>{`${busy} working`}</span>
          <span fg={c.fgDim}>{" · "}</span>
          <span fg={done > 0 ? c.success : c.fgDim}>{`${done} completed`}</span>
          {failed > 0 ? <span fg={c.error}>{` · ${failed} failed`}</span> : null}
        </text>
      </box>
    </box>
  );
}

// ───────────────────────── Row ─────────────────────────
function SessionRow({
  session,
  selected,
  armed,
  width,
}: {
  session: SessionSnapshot;
  selected: boolean;
  armed: boolean;
  width: number;
}) {
  const bg = selected ? c.selectionBg : undefined;
  // process liveness: a session whose last turn ended (completed/failed/stopped)
  // is treated as "alive but static"; only stopped is "exited" for the glyph.
  const alive = session.state !== "stopped";
  const icon = iconForLiveness({ alive, state: session.state });
  const iconColor = colorForState(session.state);

  const ID_W = 16;
  const idText = session.id.length > ID_W ? `${session.id.slice(0, ID_W - 1)}…` : session.id.padEnd(ID_W);

  const msg = (session.lastMessage || session.lastStopReason || "—").replace(/\s+/g, " ").trim();
  const MSG_W = Math.max(10, width - 4 - 2 - ID_W - 1 - 8);
  let summary = msg.length > MSG_W ? `${msg.slice(0, MSG_W - 1)}…` : msg.padEnd(MSG_W);

  const ageSec = Math.max(0, Math.round((Date.now() - session.updatedAt) / 1000));
  const age = ageSec < 60 ? `${ageSec}s` : `${Math.round(ageSec / 60)}m`;

  return (
    <box height={1} paddingLeft={4} paddingRight={2} {...(bg ? { backgroundColor: bg } : {})}>
      <text wrapMode="none" {...(bg ? { bg } : {})}>
        <span fg={iconColor} {...(bg ? { bg } : {})}>{`${icon} `}</span>
        <span fg={c.fg} attributes={TextAttributes.BOLD} {...(bg ? { bg } : {})}>{idText}</span>
        <span fg={c.fgDim} {...(bg ? { bg } : {})}>{` ${summary}`}</span>
        {armed ? (
          <span fg={c.error} attributes={TextAttributes.BOLD} {...(bg ? { bg } : {})}>{" ⌫del?"}</span>
        ) : (
          <span fg={c.fgDim} {...(bg ? { bg } : {})}>{` ${age.padStart(5)}`}</span>
        )}
      </text>
    </box>
  );
}

// ───────────────────────── Help overlay ─────────────────────────
// Generated verbatim from the keymap's HELP_SECTIONS so the docs can never drift
// from the bindings.
function HelpOverlay({ width, height }: { width: number; height: number }) {
  const KEY_COL = HELP_SECTIONS.reduce(
    (m, s) => s.rows.reduce((mm, r) => Math.max(mm, r.keys.length), m),
    0,
  );
  const longestLine = HELP_SECTIONS.reduce(
    (m, s) => s.rows.reduce((mm, r) => Math.max(mm, KEY_COL + 3 + r.action.length), m),
    0,
  );
  const TITLE = "Keyboard shortcuts";
  const FOOTER = "esc or ? to close";
  const innerWidth = Math.max(longestLine, TITLE.length + 4, FOOTER.length + 4);
  const boxWidth = Math.min(width - 4, innerWidth + 6);
  const totalRows = HELP_SECTIONS.reduce((n, s) => n + s.rows.length, 0);
  const contentLines = totalRows + HELP_SECTIONS.length * 2;
  const boxHeight = Math.min(height - 2, contentLines + 4);
  const left = Math.max(0, Math.floor((width - boxWidth) / 2));
  const top = Math.max(0, Math.floor((height - boxHeight) / 2));
  return (
    <box
      position="absolute"
      left={left}
      top={top}
      width={boxWidth}
      height={boxHeight}
      border
      borderStyle="rounded"
      borderColor={c.separator}
      backgroundColor={c.bg}
      title={TITLE}
      titleAlignment="left"
      bottomTitle={FOOTER}
      bottomTitleAlignment="center"
      flexDirection="column"
      paddingTop={1}
      paddingBottom={0}
      paddingLeft={2}
      paddingRight={2}
    >
      {HELP_SECTIONS.map((section, si) => (
        <box key={section.title} flexDirection="column">
          <text fg={c.accent} attributes={TextAttributes.BOLD} wrapMode="none">{section.title}</text>
          {section.rows.map((r, ri) => (
            <text key={ri} wrapMode="none">
              <span fg={c.fg} attributes={TextAttributes.BOLD}>{"  " + r.keys.padEnd(KEY_COL)}</span>
              <span fg={c.fgDim}>{"   " + r.action}</span>
            </text>
          ))}
          {si < HELP_SECTIONS.length - 1 ? <text> </text> : null}
        </box>
      ))}
    </box>
  );
}

// ───────────────────────── Delete-confirm banner ─────────────────────────
function DeleteConfirm({ targetId, width }: { targetId: string; width: number }) {
  const boxWidth = Math.min(Math.max(width - 4, 40), 72);
  return (
    <box
      position="absolute"
      left={2}
      top={5}
      width={boxWidth}
      border
      borderStyle="rounded"
      borderColor={c.error}
      backgroundColor={c.bg}
      padding={1}
      flexDirection="column"
    >
      <text wrapMode="none">
        <span fg={c.error} attributes={TextAttributes.BOLD}>{"⚠ stopped"}</span>
        <span fg={c.fgDim}>{" · press "}</span>
        <span fg={c.error} attributes={TextAttributes.BOLD}>{"Ctrl+X"}</span>
        <span fg={c.fgDim}>{" again within 2s to "}</span>
        <span fg={c.error} attributes={TextAttributes.BOLD}>{"delete"}</span>
      </text>
      <text wrapMode="none">
        <span fg={c.fgDim}>{"target: "}</span>
        <span fg={c.fg}>{`"${targetId}"`}</span>
      </text>
      <text wrapMode="none">
        <span fg={c.fg} attributes={TextAttributes.BOLD}>{"esc"}</span>
        <span fg={c.fgDim}>{" to keep (stays stopped) · auto-disarms in 2s"}</span>
      </text>
    </box>
  );
}

// ───────────────────────── App ─────────────────────────
export function App({ manager, agent, cwd, configAgents }: AppProps) {
  const { width, height } = useTerminalDimensions();
  const renderer = useRenderer();
  const [ui, dispatch] = useReducer(reducer, undefined, initialUiState);
  // Mirror the latest committed UI state into a ref so the keyboard handler
  // never reads a stale closure (keystrokes can batch within one act/frame).
  const uiRef = useRef(ui);
  uiRef.current = ui;

  // Live snapshot, driven by the manager's event stream. The structured
  // conversation now rides on each SessionSnapshot.entries, so the TUI no longer
  // re-accumulates transcript text by hand — it reads entries straight off the snap.
  const sessionsRef = useRef<SessionSnapshot[]>(manager.snapshot().sessions);
  const [, force] = useReducer((x: number) => x + 1, 0);
  // Highlighted option index for the permission modal (per attached session).
  const permSelRef = useRef(0);
  // Pending disarm timer for the Ctrl+X delete chord.
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    renderer.setBackgroundColor(c.bg);
    const onEvent = (ev: unknown) => {
      const e = ev as { type: string; id?: string };
      // a fresh permission request resets the modal selection to the first option.
      if (e.type === "permission_requested") permSelRef.current = 0;
      sessionsRef.current = manager.snapshot().sessions;
      dispatch({ type: "reconcileSelection", sessions: sessionsRef.current });
      force();
    };
    manager.on("event", onEvent);
    sessionsRef.current = manager.snapshot().sessions;
    return () => {
      manager.off("event", onEvent);
      if (armTimer.current) clearTimeout(armTimer.current);
    };
  }, [manager, renderer]);

  const sessions = sessionsRef.current;

  // Exit to shell.
  useEffect(() => {
    if (ui.exited) {
      void manager.dispose().finally(() => {
        renderer.destroy?.();
        process.exit(0);
      });
    }
  }, [ui.exited, manager, renderer]);

  // Async side-effecting actions (createSession / prompt) live here, not the reducer.
  const createSession = (text: string) => {
    dispatch({ type: "dispatchClear" });
    dispatch({ type: "setHud", hud: "creating session…" });
    void (async () => {
      try {
        const id = await manager.createSession({ agent, cwd, configAgents });
        // Interactive from creation so permission requests PAUSE (state=waiting)
        // and surface in the grid / the permission modal — not auto-resolved.
        manager.setInteractive(id, true);
        dispatch({ type: "setHud", hud: `created ${id} · prompting…` });
        await manager.prompt(id, text);
        dispatch({ type: "setHud", hud: `session ${id} done` });
      } catch (err) {
        dispatch({ type: "setHud", hud: `error: ${(err as Error).message}` });
      }
    })();
  };

  const sendPrompt = (id: string, text: string) => {
    dispatch({ type: "attachClear" });
    dispatch({ type: "scrollReset" });
    dispatch({ type: "setHud", hud: `prompting ${id}…` });
    // Interactive: the attached view answers permission prompts via the modal.
    manager.setInteractive(id, true);
    void manager.prompt(id, text).then(
      () => dispatch({ type: "setHud", hud: `turn done ${id}` }),
      (err) => dispatch({ type: "setHud", hud: `error: ${(err as Error).message}` }),
    );
  };

  // Answer the attached session's pending permission, if any.
  const answerPermission = (id: string, optionId: string | null) => {
    manager.answerPermission(id, optionId);
    dispatch({ type: "setHud", hud: optionId ? `allowed ${id}` : `denied ${id}` });
  };

  const clearArmTimer = () => {
    if (armTimer.current) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
  };

  // Ctrl+X chord: first press stops + arms a 2s delete window; a second press on
  // the SAME session within the window deletes it. Bound to live manager state.
  const handleStopChord = () => {
    const cur = uiRef.current;
    const sess = selectedSession(cur, sessionsRef.current);
    if (!sess) {
      dispatch({ type: "setHud", hud: "no session selected" });
      return;
    }
    if (cur.deleteArmedId === sess.id) {
      // Second press → delete.
      clearArmTimer();
      dispatch({ type: "disarmDelete" });
      dispatch({ type: "setHud", hud: `deleting ${sess.id}…` });
      void manager.remove(sess.id).then(
        () => dispatch({ type: "setHud", hud: `deleted ${sess.id}` }),
        (err) => dispatch({ type: "setHud", hud: `error: ${(err as Error).message}` }),
      );
      return;
    }
    // First press → stop + arm.
    dispatch({ type: "setHud", hud: `stopping ${sess.id}…` });
    void manager.cancel(sess.id).then(
      () => dispatch({ type: "setHud", hud: `stopped ${sess.id} · Ctrl+X again to delete` }),
      // Even if cancel rejects (already idle/completed), still arm delete.
      () => dispatch({ type: "setHud", hud: `${sess.id} · Ctrl+X again to delete` }),
    );
    dispatch({ type: "stopArm", id: sess.id });
    clearArmTimer();
    armTimer.current = setTimeout(() => {
      armTimer.current = null;
      dispatch({ type: "disarmDelete" });
    }, DELETE_ARM_MS);
  };

  useKeyboard((key) => {
    const cur = uiRef.current;
    const curSessions = sessionsRef.current;

    // Permission modal: when attached to a session awaiting a permission answer,
    // keystrokes drive the modal (number keys / arrows select, Enter confirms,
    // Esc denies) and short-circuit all other bindings.
    if (cur.mode === "attached" && cur.attachedId) {
      const attached = curSessions.find((s) => s.id === cur.attachedId);
      const pending = attached?.pendingPermission;
      if (pending) {
        const n = pending.options.length;
        if (key.name === "escape") {
          answerPermission(cur.attachedId, null);
          return;
        }
        if (key.name === "up") {
          permSelRef.current = (permSelRef.current - 1 + n) % n;
          force();
          return;
        }
        if (key.name === "down") {
          permSelRef.current = (permSelRef.current + 1) % n;
          force();
          return;
        }
        if (/^[1-9]$/.test(key.sequence ?? "")) {
          const idx = Number(key.sequence) - 1;
          if (idx < n) {
            answerPermission(cur.attachedId, pending.options[idx]!.optionId);
          }
          return;
        }
        if (key.name === "return") {
          const opt = pending.options[permSelRef.current];
          answerPermission(cur.attachedId, opt ? opt.optionId : null);
          return;
        }
        return; // swallow everything else while the modal is up
      }
    }

    // Enter is overloaded + async-side-effecting, so intercept it here.
    if (key.name === "return") {
      if (cur.mode === "attached" && cur.attachedId) {
        if (cur.attachInput.trim().length > 0) sendPrompt(cur.attachedId, cur.attachInput.trim());
        return;
      }
      if (cur.mode === "grid" && cur.dispatch.trim().length > 0) {
        createSession(cur.dispatch.trim());
        return;
      }
    }
    // Ctrl+X stop/delete chord is stateful + async, so intercept it here.
    if (cur.mode === "grid" && key.ctrl && key.name === "x") {
      handleStopChord();
      return;
    }
    // Esc disarms a pending delete window (and cancels its timer) before anything else.
    if (cur.mode === "grid" && cur.deleteArmedId && key.name === "escape") {
      clearArmTimer();
      dispatch({ type: "disarmDelete" });
      dispatch({ type: "setHud", hud: "delete disarmed" });
      return;
    }
    const action = keyToAction(key, cur, curSessions);
    if (action) dispatch(action as UiAction);
  });

  // Fullscreen replacement: attached session (help / permission can overlay it).
  if (ui.mode === "attached" && ui.attachedId) {
    const attached = sessions.find((s) => s.id === ui.attachedId);
    if (attached) {
      return (
        <box width={width} height={height}>
          <ChatView session={attached} input={ui.attachInput} width={width} height={height} scrollOffset={ui.attachScroll} />
          {attached.pendingPermission ? (
            <PermissionModal
              pending={attached.pendingPermission}
              selectedIndex={permSelRef.current}
              answer={(optId) => answerPermission(attached.id, optId)}
              width={width}
              height={height}
            />
          ) : null}
        </box>
      );
    }
  }
  if (ui.mode === "help" && ui.helpReturnMode === "attached" && ui.attachedId) {
    const attached = sessions.find((s) => s.id === ui.attachedId);
    if (attached) {
      return (
        <box width={width} height={height}>
          <ChatView session={attached} input={ui.attachInput} width={width} height={height} scrollOffset={ui.attachScroll} />
          <HelpOverlay width={width} height={height} />
        </box>
      );
    }
  }

  const visibleSessions = applyFilter(sessions, ui.filterWaiting);
  const renderGroups = buildRenderGroups(sessions, ui.filterWaiting);
  const sel = selectedSelectable(ui, sessions);
  const rule = "─".repeat(Math.max(1, width - 4));

  const footerHint = ui.deleteArmedId
    ? "ctrl+x delete · esc keep · ↑/↓ select"
    : ui.filterWaiting
      ? "w all · enter/→ attach · ctrl+x stop · ? help · q exit"
      : "↑/↓ select · enter/→ attach · ctrl+x stop · w needs-input · ? help · q exit";

  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={c.bg}>
      <Header sessions={sessions} agent={agent} filterWaiting={ui.filterWaiting} />

      {visibleSessions.length === 0 ? (
        <box flexDirection="column" paddingTop={2} paddingLeft={4} flexGrow={1}>
          {ui.filterWaiting ? (
            <>
              <text fg={c.fgDim}>No sessions need input right now.</text>
              <text fg={c.fgDim}>Press w to show all sessions.</text>
            </>
          ) : (
            <>
              <text fg={c.fgDim}>No sessions yet.</text>
              <text fg={c.fgDim}>Type a task below and press Enter to dispatch a new agent session.</text>
            </>
          )}
        </box>
      ) : (
        <box flexDirection="column" paddingTop={1} flexGrow={1}>
          {renderGroups.map((rg) => {
            const headerSelected = sel?.kind === "header" && sel.group === rg.group;
            return (
              <box key={rg.group} flexDirection="column">
                <box height={1} paddingLeft={2} {...(headerSelected ? { backgroundColor: c.selectionBg } : {})}>
                  <text fg={colorForState(rg.group)} attributes={TextAttributes.BOLD} {...(headerSelected ? { bg: c.selectionBg } : {})}>
                    {`${rg.title}  (${rg.rows.length})`}
                  </text>
                </box>
                {rg.rows.map((row) => (
                  <SessionRow
                    key={row.id}
                    session={row}
                    selected={sel?.kind === "row" && sel.sessionId === row.id}
                    armed={ui.deleteArmedId === row.id}
                    width={width}
                  />
                ))}
                <box height={1}><text> </text></box>
              </box>
            );
          })}
        </box>
      )}

      {/* Dispatch input bracketed by dim rules */}
      <box flexDirection="column" paddingLeft={2}>
        <text fg={c.separator}>{rule}</text>
        <text>
          <span fg={c.accent}>{"❯ "}</span>
          {ui.dispatch.length > 0 ? (
            <span fg={c.fg}>{ui.dispatch}</span>
          ) : (
            <span fg={c.fgDim}>describe a task for a new session</span>
          )}
        </text>
        <text fg={c.separator}>{rule}</text>
      </box>

      {/* Footer */}
      <box flexDirection="column" paddingLeft={2}>
        <text fg={c.fgDim}>{footerHint}</text>
        <text>
          <span fg={c.accent}>{"hud "}</span>
          <span fg={c.fgDim}>{ui.hud}</span>
        </text>
      </box>

      {/* Overlays */}
      {ui.deleteArmedId ? <DeleteConfirm targetId={ui.deleteArmedId} width={width} /> : null}
      {ui.mode === "help" ? <HelpOverlay width={width} height={height} /> : null}
    </box>
  );
}

export type { UiState };
