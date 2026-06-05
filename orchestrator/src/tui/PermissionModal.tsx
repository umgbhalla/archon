/**
 * PermissionModal — the interactive permission prompt overlay.
 *
 * Surfaces a session's pendingPermission (tool title + options) and lets the user
 * pick. App owns the keymap (number keys / arrows / Enter / Esc map to an option)
 * and passes both the pendingPermission and an `answer` callback down; this
 * component is presentational + reports the chosen optionId (or null to cancel).
 *
 * Styled after Claude Code's permission prompt: a centered bordered card titled
 * with the tool, a "wants to …" line, then the numbered options where allow-kinds
 * read green (✓) and reject-kinds read red (✗); the highlighted option is filled.
 */
import { TextAttributes } from "@opentui/core";
import type { PendingPermission } from "../core/session-manager.ts";
import { colors as c } from "./theme.ts";

export interface PermissionModalProps {
  /** The request to answer. */
  pending: PendingPermission;
  /** Index of the currently highlighted option (App tracks selection). */
  selectedIndex: number;
  /** Answer the request: an optionId selects, null cancels. */
  answer: (optionId: string | null) => void;
  width: number;
  height: number;
}

/** Per-option visual: allow_* reads positive (✓ green), reject_* negative (✗ red). */
function optionStyle(kind: string): { glyph: string; color: string } {
  const k = kind.toLowerCase();
  if (k.startsWith("allow")) return { glyph: "✓", color: c.success };
  if (k.startsWith("reject") || k.startsWith("deny")) return { glyph: "✗", color: c.error };
  return { glyph: "•", color: c.accent };
}

/** A friendly one-liner describing what the tool wants to do. */
function intentLine(p: PendingPermission): string {
  const verb = (p.toolKind ?? "").toLowerCase();
  switch (verb) {
    case "edit":
      return "wants to edit a file";
    case "execute":
      return "wants to run a command";
    case "read":
      return "wants to read a file";
    case "delete":
      return "wants to delete a file";
    case "fetch":
      return "wants to fetch from the network";
    default:
      return verb ? `wants to ${verb}` : "is requesting permission";
  }
}

export function PermissionModal({ pending, selectedIndex, width, height }: PermissionModalProps) {
  const TITLE = " Permission required ";
  const opts = pending.options;

  // Card sized to content (title + intent + spacer + options + spacer), clamped.
  const contentRows = opts.length + 4;
  const boxWidth = Math.min(Math.max(width - 8, 44), 78);
  const boxHeight = Math.min(Math.max(height - 4, 9), contentRows + 4);
  const left = Math.max(0, Math.floor((width - boxWidth) / 2));
  const top = Math.max(0, Math.floor((height - boxHeight) / 2));
  const inner = boxWidth - 6; // account for border + horizontal padding

  function clip(s: string): string {
    return s.length > inner ? s.slice(0, Math.max(0, inner - 1)) + "…" : s;
  }

  return (
    <box
      position="absolute"
      left={left}
      top={top}
      width={boxWidth}
      height={boxHeight}
      border
      borderStyle="rounded"
      borderColor={c.waiting}
      backgroundColor={c.bg}
      title={TITLE}
      titleAlignment="left"
      bottomTitle=" 1-9 choose · ↑↓ move · enter confirm · esc deny "
      bottomTitleAlignment="center"
      flexDirection="column"
      paddingTop={1}
      paddingLeft={2}
      paddingRight={2}
    >
      {/* Tool + intent. */}
      <box height={1}>
        <text wrapMode="none">
          <span fg={c.waiting} attributes={TextAttributes.BOLD}>{"⚙ "}</span>
          <span fg={c.fg} attributes={TextAttributes.BOLD}>{clip(pending.toolTitle)}</span>
        </text>
      </box>
      <box height={1}>
        <text wrapMode="none">
          <span fg={c.fgDim}>{clip(intentLine(pending))}</span>
          {pending.toolKind ? <span fg={c.fgDim}>{`  (${pending.toolKind})`}</span> : null}
        </text>
      </box>
      <box height={1}><text> </text></box>

      {/* Numbered options. */}
      {opts.map((opt, i) => {
        const on = i === selectedIndex;
        const { glyph, color } = optionStyle(opt.kind);
        const cursor = on ? "❯ " : "  ";
        return (
          <box
            key={opt.optionId}
            height={1}
            {...(on ? { backgroundColor: c.selectionBg } : {})}
          >
            <text wrapMode="none" {...(on ? { bg: c.selectionBg } : {})}>
              <span fg={c.accent} {...(on ? { bg: c.selectionBg } : {})}>{cursor}</span>
              <span fg={c.fgDim} {...(on ? { bg: c.selectionBg } : {})}>{`${i + 1}. `}</span>
              <span fg={color} {...(on ? { bg: c.selectionBg } : {})}>{`${glyph} `}</span>
              <span
                fg={on ? c.fg : color}
                attributes={on ? TextAttributes.BOLD : undefined}
                {...(on ? { bg: c.selectionBg } : {})}
              >
                {clip(opt.name)}
              </span>
            </text>
          </box>
        );
      })}
    </box>
  );
}
