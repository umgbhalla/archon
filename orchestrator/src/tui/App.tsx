/**
 * App — the archon session-grid TUI (fleet surface).
 *
 * Binds to the REAL SessionManager (no seed data): renders sessions grouped by
 * logical state with the dual-channel glyph (color = state, shape = liveness),
 * tracks selection by stable session id, and hosts a dispatch input that creates
 * a new session via the backend. Enter attaches to a session and streams its ACP
 * updates into a fullscreen attached view with its own prompt input.
 *
 * Layout patterns ported from mock/agent-view/app/src/App.tsx (header, grouped
 * list + selection band, bracketed dispatch input, footer hints).
 */
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useReducer, useRef } from "react";
import type { SessionManager, SessionSnapshot } from "../core/session-manager.ts";
import { keyToAction } from "./keymap.ts";
import {
  buildRenderGroups,
  initialUiState,
  reducer,
  selectedSelectable,
  selectedSession,
  type UiAction,
  type UiState,
} from "./store.ts";
import { colors as c, colorForState, iconForLiveness } from "./theme.ts";

export interface AppProps {
  manager: SessionManager;
  /** Agent backend name used when the dispatch input creates a session. */
  agent: string;
  cwd: string;
  /** Extra named agents from config, merged into the registry for resolution. */
  configAgents?: Record<string, string[]>;
}

// ───────────────────────── Header ─────────────────────────
function Header({ sessions, agent }: { sessions: SessionSnapshot[]; agent: string }) {
  const waiting = sessions.filter((s) => s.state === "waiting").length;
  const busy = sessions.filter((s) => s.state === "busy").length;
  const done = sessions.filter((s) => s.state === "completed").length;
  const summary = `${sessions.length} sessions · ${waiting} need input · ${busy} working · ${done} completed`;
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={1}>
      <box height={1}>
        <text>
          <span fg={c.accent} attributes={TextAttributes.BOLD}>{"▟▙  "}</span>
          <span fg={c.fg} attributes={TextAttributes.BOLD}>archon</span>
          <span fg={c.fgDim}>{`  fleet · agent=${agent}`}</span>
        </text>
      </box>
      <box height={1}>
        <text fg={c.fgDim}>{`    ${summary}`}</text>
      </box>
    </box>
  );
}

// ───────────────────────── Row ─────────────────────────
function SessionRow({
  session,
  selected,
  width,
}: {
  session: SessionSnapshot;
  selected: boolean;
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
        <span fg={c.fgDim} {...(bg ? { bg } : {})}>{` ${age.padStart(5)}`}</span>
      </text>
    </box>
  );
}

// ───────────────────────── Attached view ─────────────────────────
function AttachedView({
  session,
  lines,
  input,
  width,
  height,
}: {
  session: SessionSnapshot;
  lines: string[];
  input: string;
  width: number;
  height: number;
}) {
  const icon = iconForLiveness({ alive: session.state !== "stopped", state: session.state });
  const visibleRows = Math.max(3, height - 8);
  const tail = lines.slice(-visibleRows);
  const rule = "─".repeat(Math.max(1, width - 4));
  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={c.bg} paddingLeft={2}>
      <box height={1}><text> </text></box>
      <box height={1}>
        <text>
          <span fg={c.accent} attributes={TextAttributes.BOLD}>{"▟▙  "}</span>
          <span fg={c.fg} attributes={TextAttributes.BOLD}>{session.id}</span>
          <span fg={c.fgDim}>{`  ${session.agent} · ${session.cwd}`}</span>
          <span fg={colorForState(session.state)}>{`   attached ${icon} ${session.state}`}</span>
        </text>
      </box>
      <text fg={c.separator}>{rule}</text>
      <box flexDirection="column" flexGrow={1}>
        {tail.length === 0 ? (
          <box height={1}><text fg={c.fgDim}>{"(no output yet — type a prompt below and press Enter)"}</text></box>
        ) : (
          tail.map((ln, i) => (
            <box key={i} height={1}>
              <text fg={c.accent} wrapMode="none">{`⏵ ${ln}`}</text>
            </box>
          ))
        )}
      </box>
      <text fg={c.separator}>{rule}</text>
      <box height={1}>
        <text>
          <span fg={c.accent}>{"> "}</span>
          {input.length > 0 ? <span fg={c.fg}>{input}</span> : <span fg={c.fgDim}>{"send a prompt to this session"}</span>}
        </text>
      </box>
      <box height={1}>
        <text fg={c.fgDim}>{"enter send · ← / esc / ctrl+z detach · ctrl+c detach"}</text>
      </box>
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

  // Live snapshot + transcripts, driven by the manager's event stream.
  const sessionsRef = useRef<SessionSnapshot[]>(manager.snapshot().sessions);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const transcriptsRef = useRef<Map<string, string[]>>(new Map());

  useEffect(() => {
    renderer.setBackgroundColor(c.bg);
    const onEvent = (ev: unknown) => {
      const e = ev as { type: string; id?: string; update?: { kind: string; role?: string; text?: string } };
      if (e.type === "session_chunk" && e.id && e.update?.kind === "message_chunk" && e.update.role === "assistant") {
        const m = transcriptsRef.current;
        const lines = m.get(e.id) ?? [];
        const last = lines[lines.length - 1] ?? "";
        m.set(e.id, lines.length === 0 ? [e.update.text ?? ""] : [...lines.slice(0, -1), last + (e.update.text ?? "")]);
      }
      if (e.type === "session_removed" && e.id) transcriptsRef.current.delete(e.id);
      sessionsRef.current = manager.snapshot().sessions;
      dispatch({ type: "reconcileSelection", sessions: sessionsRef.current });
      force();
    };
    manager.on("event", onEvent);
    sessionsRef.current = manager.snapshot().sessions;
    return () => {
      manager.off("event", onEvent);
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
    dispatch({ type: "setHud", hud: `prompting ${id}…` });
    void manager.prompt(id, text).then(
      () => dispatch({ type: "setHud", hud: `turn done ${id}` }),
      (err) => dispatch({ type: "setHud", hud: `error: ${(err as Error).message}` }),
    );
  };

  useKeyboard((key) => {
    const cur = uiRef.current;
    const curSessions = sessionsRef.current;
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
    const action = keyToAction(key, cur, curSessions);
    if (action) dispatch(action as UiAction);
  });

  // Fullscreen replacement: attached session.
  if (ui.mode === "attached" && ui.attachedId) {
    const attached = sessions.find((s) => s.id === ui.attachedId);
    if (attached) {
      const lines = transcriptsRef.current.get(attached.id) ?? [];
      return <AttachedView session={attached} lines={lines} input={ui.attachInput} width={width} height={height} />;
    }
  }

  const renderGroups = buildRenderGroups(sessions);
  const sel = selectedSelectable(ui, sessions);
  const rule = "─".repeat(Math.max(1, width - 4));

  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={c.bg}>
      <Header sessions={sessions} agent={agent} />

      {sessions.length === 0 ? (
        <box flexDirection="column" paddingTop={2} paddingLeft={4} flexGrow={1}>
          <text fg={c.fgDim}>No sessions yet.</text>
          <text fg={c.fgDim}>Type a task below and press Enter to dispatch a new agent session.</text>
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
        <text fg={c.fgDim}>↑/↓ select · enter attach/dispatch · → attach · q/esc exit · ctrl+c exit</text>
        <text>
          <span fg={c.accent}>{"hud "}</span>
          <span fg={c.fgDim}>{ui.hud}</span>
        </text>
      </box>
    </box>
  );
}

export type { UiState };
