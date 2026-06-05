/**
 * ChatView — the attached conversation surface (chat substrate renderer).
 *
 * Renders a session's STRUCTURED ConversationEntry[] as a real Claude-Code-like
 * session log: USER turns (bright, chevron), ASSISTANT turns (accent, with a live
 * spinner/cursor while streaming), THOUGHT entries (dim, distinct), TOOL_CALL
 * entries as compact status cards, and PLAN entries as a checklist. Text is run
 * through a tiny markdown-ish styler (bold headings, dim fenced code) and wrapped
 * to the viewport. Scrollback is driven by the `scrollOffset` prop (0 = pinned to
 * the latest line, auto-sticking to the bottom while a turn streams).
 *
 * App owns keymap->action wiring and passes the live snapshot + input buffer down;
 * this component is presentational (no manager access).
 */
import { TextAttributes } from "@opentui/core";
import { useEffect, useState } from "react";
import type { SessionSnapshot } from "../core/session-manager.ts";
import type {
  ConversationEntry,
  TextEntry,
  ToolCallEntry,
  PlanEntry,
} from "../core/conversation.ts";
import { colors as c, colorForState, iconForLiveness } from "./theme.ts";

export interface ChatViewProps {
  /** Live session snapshot (carries entries + state + pendingPermission). */
  session: SessionSnapshot;
  /** Current prompt input buffer. */
  input: string;
  width: number;
  height: number;
  /** Lines scrolled up from the bottom (0 = pinned to latest). */
  scrollOffset: number;
}

/** Braille spinner frames (steady, terminal-native). */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

// ───────────────────────── styled-text model ─────────────────────────
// A rendered row is a list of styled spans. The renderer flattens every entry
// into rows so windowing (scrollback) operates on a uniform line stream.

interface Span {
  text: string;
  fg: string;
  attributes?: number;
}
interface Row {
  /** Optional leading gutter glyph rendered before the spans (already colored). */
  gutter?: Span;
  spans: Span[];
  /** Empty marker so the windower can render a blank row. */
  blank?: boolean;
}

function blankRow(): Row {
  return { spans: [], blank: true };
}

/** Hard-wrap a string to `w` columns on whitespace where possible. */
function wrap(text: string, w: number): string[] {
  if (w <= 0) return [text];
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      out.push("");
      continue;
    }
    let line = rawLine;
    while (line.length > w) {
      // Prefer to break at the last space within the window.
      let cut = line.lastIndexOf(" ", w);
      if (cut <= 0) cut = w; // no space → hard cut
      out.push(line.slice(0, cut).replace(/\s+$/, ""));
      line = line.slice(cut).replace(/^\s+/, "");
    }
    out.push(line);
  }
  return out;
}

/**
 * Tiny markdown-ish styler for a single (already newline-split) text line.
 * Lightweight by design — handles headings, bullets, and inline `code` /
 * **bold**; fenced code is handled by the caller (it tracks ``` state). Returns
 * the spans for the line, given a base color.
 */
function styleInline(line: string, base: string): Span[] {
  // Headings: # … → bold, accent.
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    return [{ text: heading[2] ?? "", fg: c.accent, attributes: TextAttributes.BOLD }];
  }
  // Bullets: normalize "- "/"* " to "• ".
  let prefix = "";
  let rest = line;
  const bullet = /^(\s*)([-*])\s+(.*)$/.exec(line);
  if (bullet) {
    prefix = `${bullet[1] ?? ""}• `;
    rest = bullet[3] ?? "";
  }
  const spans: Span[] = [];
  if (prefix) spans.push({ text: prefix, fg: c.fgDim });

  // Inline tokens: **bold** and `code`.
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    if (m.index > last) spans.push({ text: rest.slice(last, m.index), fg: base });
    const tok = m[0];
    if (tok.startsWith("**")) {
      spans.push({ text: tok.slice(2, -2), fg: base, attributes: TextAttributes.BOLD });
    } else {
      spans.push({ text: tok.slice(1, -1), fg: c.waiting });
    }
    last = m.index + tok.length;
  }
  if (last < rest.length) spans.push({ text: rest.slice(last), fg: base });
  if (spans.length === 0) spans.push({ text: "", fg: base });
  return spans;
}

/**
 * Render a text entry's body into rows. Tracks fenced ``` blocks (rendered dim,
 * monospace-ish, no inline styling). `bodyWidth` is the wrap budget (after the
 * gutter). Returns rows WITHOUT the leading gutter — the caller attaches it to
 * the first row.
 */
function textBodyRows(text: string, base: string, bodyWidth: number): Row[] {
  const rows: Row[] = [];
  let inFence = false;
  for (const logical of text.split("\n")) {
    const fence = /^\s*```/.test(logical);
    if (fence) {
      inFence = !inFence;
      rows.push({
        spans: [{ text: logical.trim() === "```" ? "```" : logical.trim(), fg: c.separator }],
      });
      continue;
    }
    if (inFence) {
      for (const w of wrap(logical, bodyWidth)) {
        rows.push({ spans: [{ text: w, fg: c.fgDim }] });
      }
      continue;
    }
    for (const w of wrap(logical, bodyWidth)) {
      rows.push({ spans: styleInline(w, base) });
    }
  }
  if (rows.length === 0) rows.push({ spans: [{ text: "", fg: base }] });
  return rows;
}

/** ACP plan entry shape (best-effort; entries are typed `unknown` upstream). */
function planChecklist(entries: unknown[]): { mark: string; color: string; text: string }[] {
  return entries.map((raw) => {
    const e = (raw ?? {}) as { content?: string; status?: string; priority?: string };
    const status = e.status ?? "pending";
    const mark =
      status === "completed" ? "✓" : status === "in_progress" ? "▸" : "○";
    const color =
      status === "completed" ? c.success : status === "in_progress" ? c.busy : c.fgDim;
    return { mark, color, text: e.content ?? String(raw) };
  });
}

/** Flatten one conversation entry into rendered rows. */
function entryRows(
  entry: ConversationEntry,
  bodyWidth: number,
  spinnerFrame: string,
): Row[] {
  switch (entry.kind) {
    case "user": {
      const t = entry as TextEntry;
      const body = textBodyRows(t.text, c.fg, bodyWidth);
      body[0] = {
        gutter: { text: "› ", fg: c.accent, attributes: TextAttributes.BOLD },
        spans: body[0]!.spans.map((s) => ({ ...s, attributes: s.attributes ?? TextAttributes.BOLD })),
      };
      return body;
    }
    case "assistant": {
      const t = entry as TextEntry;
      const body = textBodyRows(t.text, c.fg, bodyWidth);
      const gutter: Span = t.streaming
        ? { text: `${spinnerFrame} `, fg: c.busy }
        : { text: "⏵ ", fg: c.accent };
      body[0] = { gutter, spans: body[0]!.spans };
      if (t.streaming) {
        // Append a live caret to the last row.
        const lastIdx = body.length - 1;
        body[lastIdx] = {
          ...body[lastIdx]!,
          spans: [...body[lastIdx]!.spans, { text: "▌", fg: c.busy, attributes: TextAttributes.BOLD }],
        };
      }
      return body;
    }
    case "thought": {
      const t = entry as TextEntry;
      // Dim + italic, distinct from assistant prose.
      const body = textBodyRows(t.text, c.fgDim, bodyWidth).map((r) => ({
        ...r,
        spans: r.spans.map((s) => ({
          text: s.text,
          fg: c.fgDim,
          attributes: TextAttributes.ITALIC,
        })),
      }));
      body[0] = { gutter: { text: "✻ ", fg: c.fgDim }, spans: body[0]!.spans };
      return body;
    }
    case "tool_call": {
      const tc = entry as ToolCallEntry;
      const status = tc.status ?? "pending";
      const mark =
        status === "completed" ? "✓" : status === "failed" ? "✗" : "⚙";
      const color =
        status === "failed" ? c.error : status === "completed" ? c.success : c.busy;
      const kind = tc.toolKind ? ` ${tc.toolKind}` : "";
      const title = wrap(tc.title, Math.max(8, bodyWidth - 14));
      const rows: Row[] = [
        {
          gutter: { text: `${mark} `, fg: color },
          spans: [
            { text: title[0] ?? "", fg: c.fg, attributes: TextAttributes.BOLD },
            { text: `  [${status}${kind}]`, fg: color },
          ],
        },
      ];
      for (let i = 1; i < title.length; i++) {
        rows.push({ spans: [{ text: `  ${title[i]}`, fg: c.fg }] });
      }
      return rows;
    }
    case "plan": {
      const p = entry as PlanEntry;
      const items = planChecklist(p.entries);
      const rows: Row[] = [
        {
          gutter: { text: "▤ ", fg: c.waiting },
          spans: [
            { text: "Plan", fg: c.waiting, attributes: TextAttributes.BOLD },
            { text: `  (${items.length} steps)`, fg: c.fgDim },
          ],
        },
      ];
      for (const it of items) {
        for (const [j, w] of wrap(it.text, Math.max(8, bodyWidth - 4)).entries()) {
          rows.push({
            spans:
              j === 0
                ? [{ text: `  ${it.mark} `, fg: it.color }, { text: w, fg: c.fg }]
                : [{ text: `      ${w}`, fg: c.fg }],
          });
        }
      }
      return rows;
    }
  }
}

export function ChatView({ session, input, width, height, scrollOffset }: ChatViewProps) {
  const icon = iconForLiveness({ alive: session.state !== "stopped", state: session.state });
  const innerWidth = Math.max(8, width - 4);
  const rule = "─".repeat(innerWidth);
  // chrome: top spacer(1) header(1) rule(1) … rule(1) input(1) footer(1) = 6.
  const visibleRows = Math.max(3, height - 6);

  // Is any text entry still streaming? Drives a self-contained spinner tick.
  const streaming = session.entries.some(
    (e) => (e.kind === "assistant" || e.kind === "thought") && (e as TextEntry).streaming,
  );
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!streaming) return;
    const h = setInterval(() => setTick((t) => t + 1), 90);
    return () => clearInterval(h);
  }, [streaming]);
  const spinnerFrame = SPINNER[tick % SPINNER.length]!;

  // The body wrap budget reserves 2 cols for the gutter glyph.
  const bodyWidth = Math.max(8, innerWidth - 2);

  // Flatten entries → rows, with a blank spacer between top-level entries so the
  // log breathes like a real session transcript.
  const rows: Row[] = [];
  session.entries.forEach((entry, i) => {
    if (i > 0) rows.push(blankRow());
    rows.push(...entryRows(entry, bodyWidth, spinnerFrame));
  });

  // Scrollback: scrollOffset lifts the window up from the tail (0 = pinned).
  const maxOffset = Math.max(0, rows.length - visibleRows);
  // Auto-stick to the bottom while streaming (ignore stale offsets).
  const effectiveOffset = streaming ? 0 : Math.min(scrollOffset, maxOffset);
  const end = rows.length - effectiveOffset;
  const startRow = Math.max(0, end - visibleRows);
  const window = rows.slice(startRow, end);
  const hiddenAbove = startRow;
  const hiddenBelow = rows.length - end;

  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={c.bg} paddingLeft={2}>
      <box height={1}><text> </text></box>
      <box height={1}>
        <text wrapMode="none">
          <span fg={c.accent} attributes={TextAttributes.BOLD}>{"▟▙  "}</span>
          <span fg={c.fg} attributes={TextAttributes.BOLD}>{session.id}</span>
          <span fg={c.fgDim}>{`  ${session.agent} · ${session.cwd}`}</span>
          <span fg={colorForState(session.state)}>{`   attached ${icon} ${session.state}`}</span>
        </text>
      </box>
      <text fg={c.separator} wrapMode="none">{rule}</text>

      <box flexDirection="column" flexGrow={1}>
        {rows.length === 0 ? (
          <box height={1}><text fg={c.fgDim}>{"(no output yet — type a prompt below and press Enter)"}</text></box>
        ) : (
          <>
            {hiddenAbove > 0 ? (
              <box height={1}>
                <text fg={c.fgDim} wrapMode="none">{`  ⋮ ${hiddenAbove} earlier ${hiddenAbove === 1 ? "line" : "lines"} (PgUp)`}</text>
              </box>
            ) : null}
            {window.map((row, i) => (
              <box key={startRow + i} height={1}>
                {row.blank ? (
                  <text> </text>
                ) : (
                  <text wrapMode="none">
                    {row.gutter ? (
                      <span fg={row.gutter.fg} attributes={row.gutter.attributes}>{row.gutter.text}</span>
                    ) : (
                      <span fg={c.fgDim}>{"  "}</span>
                    )}
                    {row.spans.map((s, j) => (
                      <span key={j} fg={s.fg} attributes={s.attributes}>{s.text}</span>
                    ))}
                  </text>
                )}
              </box>
            ))}
            {hiddenBelow > 0 ? (
              <box height={1}>
                <text fg={c.fgDim} wrapMode="none">{`  ⋮ ${hiddenBelow} more below (PgDn)`}</text>
              </box>
            ) : null}
          </>
        )}
      </box>

      <text fg={c.separator} wrapMode="none">{rule}</text>
      <box height={1}>
        <text wrapMode="none">
          <span fg={c.accent} attributes={TextAttributes.BOLD}>{"> "}</span>
          {input.length > 0 ? (
            <>
              <span fg={c.fg}>{input}</span>
              <span fg={c.accent} attributes={TextAttributes.BOLD}>{"▌"}</span>
            </>
          ) : (
            <span fg={c.fgDim}>{"send a prompt to this session"}</span>
          )}
        </text>
      </box>
      <box height={1}>
        <text fg={c.fgDim} wrapMode="none">
          {streaming
            ? "enter send · pgup/pgdn scroll · ctrl+c interrupt · ← / esc detach · ? help"
            : "enter send · pgup/pgdn scroll · ← / esc detach · ? help"}
        </text>
      </box>
    </box>
  );
}
