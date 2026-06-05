# boxen

## What it is (1-2 lines)
A single-file, stateless string transformer that wraps text in a bordered box with padding, margin, alignment, title, and color. Pure function `boxen(text, options) -> string`; no render loop, no terminal control — it just emits an ANSI-decorated multi-line string you print yourself.

## Architecture (how the pieces fit; key files with paths)
Everything lives in `/Users/umang/hub/zonko/archon/context/boxen/index.js` (~378 lines). Types in `index.d.ts`.

The pipeline is a strict 4-stage pass over the input, orchestrated by the default export `boxen()` (index.js:343):
1. **Normalize options** — defaults merged, deprecated `align` aliased, colors validated, `padding`/`margin` expanded from scalar to `{top,right,bottom,left}` via `getObject` (index.js:33).
2. **`determineDimensions(text, options)`** (index.js:278) — compute the final content width (and possibly height), accounting for terminal columns, margins, border width, title width, padding overflow, and margin-shrinking. Mutates `options`.
3. **`makeContentText(text, options)`** (index.js:135) — produce the inner block: align, hard-wrap, pad horizontally to exact width, add vertical padding rows, clamp/extend to fixed height. Returns a `\n`-joined string of equal-width lines.
4. **`boxContent(content, contentWidth, options)`** (index.js:208) — assemble margins, top border (with optional title), left/right border per line, bottom border, applying border/background color functions.

Dependencies do the heavy text math: `string-width` (display width accounting for wide/zero-width chars), `widest-line` (max line width), `wrap-ansi` (wrap preserving ANSI), `slice-ansi` (truncate preserving ANSI), `ansi-align` (block alignment), `cli-boxes` (border glyph tables), `chalk` (color).

## Core techniques (the actual TUI engineering)

**Box model = pure string composition, not a buffer.** There is no 2D cell grid. Each row is a string; the box is built by string concatenation. The invariant that makes it work: after `makeContentText`, *every content line has identical display width* equal to `options.width`. The border code (index.js:240) can then blindly prepend/append the vertical glyph without measuring each line.

**Display width vs. string length is the central problem.** All sizing uses `stringWidth()` / `widestLine()`, never `.length`, because emoji, CJK, and ANSI escapes break `.length`. Padding is computed as `width - stringWidth(newLine)` (index.js:188), so a line containing a 2-cell emoji gets one fewer pad space — keeping the right border aligned. This is the key lesson: **measure in terminal columns, pad in columns.**

**Border width as a constant 2.** `getBorderWidth` (index.js:46) returns 2 (one column each side) or 0 for `none`. Width budgeting everywhere subtracts this so the *outer* box honors a requested `width`, while internal math works in *content* coordinates. `sanitizeOptions` (index.js:268) does `options.width = max(1, width - borderWidth)` so a user-supplied `width` is the total box width, converted to content width once, up front.

**Width resolution algorithm** (`determineDimensions`, index.js:278) — the cleverest part:
- `widest` = widest line after a soft pre-wrap at `columns - borderWidth`, plus horizontal padding (index.js:285). This is the natural content width.
- If a title is given and is wider than content, the box grows to the title width (index.js:298). Title is first truncated with `sliceAnsi` to fit (index.js:289-292).
- `options.width ||= widest` — fixed width wins, else natural width.
- **Margin shrinking** (index.js:307-318): if no explicit width and box + margins overflow the terminal, margins are scaled down proportionally (`multiplier = spaceForMargins / (margin.left+margin.right)`) rather than clipping the box. Then width is re-capped to fit remaining columns.
- **Overflow guards**: if horizontal padding ≥ width, padding is dropped to 0 (index.js:325); same for vertical padding vs. height (index.js:330).

**Text layout** (`makeContentText`, index.js:135):
- `ansiAlign` first does block alignment (pads short lines so multi-line text aligns as a block).
- `max = width - padding.left - padding.right` is the text column budget.
- If text is wider than `max`, each line is hard-wrapped with `wrapAnsi(line, max, {hard:true})`, re-aligned, then manually re-padded for center/right because wrapping produces ragged widths (index.js:142-174). Note the wrap-then-realign sequence — wrapping must precede final alignment.
- Center/right alignment for the non-wrapped case is a simple leading-pad of `(max-textWidth)/2` or `max-textWidth` (index.js:176-180).
- Horizontal padding is applied, then each line is right-padded to exactly `width` (index.js:185-189) — this is where the equal-width invariant is enforced.
- Vertical padding = whole rows of `PAD.repeat(width)` prepended/appended (index.js:191-197).
- Fixed height = slice if too tall, append blank full-width rows if too short (index.js:199-203).

**Title rendering** (`makeTitle`, index.js:101) — the title is embedded *into the top border run*. It receives the full horizontal-glyph string (`chars.top.repeat(contentWidth)`) and replaces a prefix/suffix/middle slice of it with the title text. For center alignment with odd remaining length, it shaves one char off the left run so the bar never overshoots (index.js:120-122). Title is wrapped in spaces by `formatTitle` (index.js:276) unless borderless.

**Border assembly** (`boxContent`, index.js:208): top line = `topLeft + (title-or-top-run) + topRight`; each content line = `left + content + right`; bottom = `bottomLeft + bottom-run + bottomRight`. Color is applied per-segment via `colorizeBorder`/`colorizeContent` closures so border color and background color compose independently.

**Float/positioning via left margin** (index.js:218-226): `float: 'center'|'right'` is implemented purely as a computed left-margin pad (`(columns - contentWidth - borderWidth)/2` etc.), not absolute cursor positioning. Top/bottom margins are literal `\n` repeats (index.js:230, 246).

**Color handling** (index.js:338-341): named colors hit `chalk[name]`; hex (`/^#(?:[0-f]{3}){1,2}$/i`) routes to `chalk.hex`/`chalk.bgHex`; background named colors are built with `camelCase(['bg', color])` -> `chalk.bgRed` etc. Validation up front throws on bad colors.

## Code patterns worth stealing

Scalar-or-object spacing normalization (note the 3x horizontal multiplier — terminal cells are ~half as tall as wide):
```js
const getObject = detail => typeof detail === 'number'
  ? {top: detail, right: detail*3, bottom: detail, left: detail*3}
  : {top:0, right:0, bottom:0, left:0, ...detail};
```

The equal-width invariant — pad by *display width*, not length:
```js
lines = lines.map(line => {
  const newLine = paddingLeft + line + paddingRight;
  return newLine + PAD.repeat(width - stringWidth(newLine)); // emoji-safe pad
});
```

Border applied as blind string wrap because all lines are pre-sized:
```js
result += lines
  .map(line => marginLeft + colorizeBorder(chars.left) + colorizeContent(line) + colorizeBorder(chars.right))
  .join('\n');
```

Embedding a title into the top border run instead of a separate row:
```js
chars.topLeft
  + (title ? makeTitle(title, chars.top.repeat(contentWidth), titleAlignment)
           : chars.top.repeat(contentWidth))
  + chars.topRight
```

Proportional margin shrink instead of clipping when content + margins overflow:
```js
const multiplier = spaceForMargins / (margin.left + margin.right);
margin.left  = Math.max(0, Math.floor(margin.left  * multiplier));
margin.right = Math.max(0, Math.floor(margin.right * multiplier));
```

Terminal width discovery with fallbacks (stdout -> stderr -> $COLUMNS -> 80), index.js:15.

## Gotchas / non-obvious decisions
- **No grid/buffer, no diffing.** This is a one-shot formatter; it has nothing to teach about frame reconciliation. Reprinting is the caller's job.
- **`width`/`height` options mean OUTER box size**, converted to inner content size by subtracting border width once in `sanitizeOptions`. Mixing the two coordinate systems is the main source of off-by-2 confusion.
- **Center math can drift by a half-cell.** `(max-textWidth)/2` isn't floored (index.js:154,177), relying on `PAD.repeat` truncating the fractional count — works only because `String.repeat` floors its argument.
- **Wrap must happen before final alignment**; alignment of the original text is discarded and redone per wrapped chunk (index.js:142-174). Doing it once up front would misalign wrapped lines.
- **Title can force the box wider** than its content (index.js:298), and titles are silently truncated to fit (`sliceAnsi`), so a long title degrades rather than breaking layout.
- **`none` border still has structure**: it's modeled as a border style with empty-string glyphs (index.js:63-68) so the same assembly code path runs; only `getBorderWidth` returns 0.
- **Retro-compat shims**: legacy `vertical`/`horizontal` custom-border keys are expanded to `left/right` and `top/bottom` (index.js:78-87); legacy `align` aliases `textAlignment` (index.js:355).
- **Background color is applied per content line, not as a filled rectangle** — but since lines are equal width, the colored region is rectangular anyway.
- Test harness pins `COLUMNS=60` and `FORCE_COLOR=0` (package.json) — width-dependent output is deterministic only when columns are fixed.

## Relevance (which advanced-TUI topics this teaches)
- **layout**: definitive reference for the terminal box model — padding/margin/border budgeting, content vs. outer coordinate systems, alignment, proportional overflow shrinking, fixed width/height clamping.
- **unicode-text-width**: textbook example of why you must measure in display columns (`string-width`/`widest-line`) and pad accordingly, and how to slice/wrap ANSI-bearing text safely (`slice-ansi`/`wrap-ansi`).
- **ansi-escapes**: color composition via segment-wise wrapping and ANSI-aware width math (escapes are zero-width).
- **widgets-rich-content**: a self-contained "box" widget (titles, borders, color) built purely by string composition — a pattern reusable inside any higher-level TUI framework's leaf renderer.
