// How edit_file finds the text to replace: ported from OpenCode 2.2.5's edit tool (packages/core/src/tool/plugin/edit.ts in
// github.com/anomalyco/opencode, tag v2.2.5, read on 6 November 2026; MIT License, Copyright (c) 2025 opencode). On a long
// batch of work every edit that misses costs a step, and a model copies a file's text imperfectly. Three ways of looking,
// in order, the first that finds anything decides:
//
// 1. The exact text, in a view of the file with every line ending as LF, as a model reads it.
// 2. The same after curly quotes, dashes and special spaces are made plain (one character for one, so places line up).
// 3. Line by line, ignoring the whitespace at the end of each line.
//
// What matched is mapped back to the file's own bytes and each replacement takes its line endings from the text it
// replaces, so CRLF and mixed line endings stay as they were, region by region. A looser match keeps the file's own
// characters too wherever the model didn't change its copy of them. Several matches are refused unless every
// one is asked for. A miss says the closest lines of the file, or that the new text is already there, so the next try can
// land without reading the file again. OpenCode 1's cascade of fuzzier matches (loose indentation, similar blocks) isn't
// here, on purpose: it could change the wrong place.

const CRLF = "\r\n";
const BOM = "\uFEFF";
/** Lines a miss shows of the file, and characters of each. */
const HINT_LINES = 12;
const HINT_LINE_CHARS = 200;
/**
 * The largest table that matching a replacement's lines to the old ones may take (each cell four bytes): this runs inside
 * the hub, which outlives any one edit. An edit bigger than that takes the region's main line ending throughout.
 */
const ALIGN_MAX_CELLS = 4_000_000;

interface Match {
  start: number;
  end: number;
}

/** What an edit came to. */
export type EditOutcome =
  /** The file's new text, and how many places changed. */
  | { result: "edited"; text: string; places: number }
  /** Not in the file; what might help the next try. */
  | { result: "missing"; hint: string | null }
  /** In several places, and only one was asked for. */
  | { result: "several"; places: number }
  /** Found, but replacing it leaves the file as it was. */
  | { result: "unchanged" };

/** Curly quotes, dashes and special spaces made plain, one character for one. */
const plain = (value: string) =>
  value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");

function occurrences(content: string, search: string): Match[] {
  const found: Match[] = [];
  if (!search) return found;
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) {
    found.push({ start: offset, end: offset + search.length });
    offset += search.length;
  }
  return found;
}

/** Where the lines of `search` are in `content`, ignoring each line's trailing whitespace; matches never overlap. */
function lineOccurrences(content: string, search: string): Match[] {
  const trailingNewline = search.endsWith("\n");
  const expected = search.split("\n");
  if (trailingNewline) expected.pop();
  const key = (line: string) => plain(line.trimEnd());
  const wanted = expected.map(key);
  const lines = [...content.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => {
      const newline = match[0].endsWith("\n");
      const text = newline ? match[0].slice(0, -1) : match[0];
      return { start: match.index, end: match.index + match[0].length, key: key(text), contentEnd: match.index + text.length - (text.endsWith("\r") ? 1 : 0), newline };
    });
  const found: Match[] = [];
  lines.forEach((line, index) => {
    if (line.key !== wanted[0]) return;
    const actual = lines.slice(index, index + wanted.length);
    if (actual.length !== wanted.length || !actual.every((item, i) => item.key === wanted[i])) return;
    const last = actual[actual.length - 1];
    if (trailingNewline && !last.newline) return;
    const candidate = { start: line.start, end: trailingNewline ? last.end : last.contentEnd };
    // Candidates come in order, so only the latest match can overlap this one.
    const latest = found[found.length - 1];
    if (!latest || latest.end <= candidate.start) found.push(candidate);
  });
  return found;
}

/** The main line ending in a text, or `fallback` when neither leads. */
function lineEnding(text: string, fallback: string): string {
  const crlf = text.split(CRLF).length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  if (crlf === lf) return fallback;
  return crlf > lf ? CRLF : "\n";
}

/**
 * For each line of `after`, the line of `before` it keeps (longest common subsequence) or, between kept lines, the one it
 * takes the place of; undefined for a line with no counterpart.
 */
function alignLines(before: string[], after: string[]): (number | undefined)[] {
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--) table[i * width + j] = before[i] === after[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const result: (number | undefined)[] = [];
  const gap = { before: [] as number[], after: [] as number[] };
  const flush = () => {
    gap.after.forEach((j, k) => (result[j] = gap.before[k]));
    gap.before = [];
    gap.after = [];
  };
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      flush();
      result[j++] = i++;
      continue;
    }
    if (table[(i + 1) * width + j] >= table[i * width + j + 1]) gap.before.push(i++);
    else gap.after.push(j++);
  }
  while (i < before.length) gap.before.push(i++);
  while (j < after.length) gap.after.push(j++);
  flush();
  return result;
}

/**
 * A line of the replacement as it goes in over the file's line `own`, which the model's old_string had as `asked`: what the
 * model left as it copied it stays as the file has it, so a change to one word doesn't straighten the line's curly quotes.
 * Only where the two line up one for one; otherwise the line goes in as written.
 */
function ownText(own: string, asked: string, line: string): string {
  if (asked === line) return own;
  if (own.length !== asked.length) return line;
  let head = 0;
  while (head < line.length && head < asked.length && line[head] === asked[head]) head++;
  let tail = 0;
  while (tail < line.length - head && tail < asked.length - head && line[line.length - 1 - tail] === asked[asked.length - 1 - tail]) tail++;
  // A run of a character the change makes longer goes in whole, or a dash kept from the file ends up beside a typed one.
  if (head && line[head] === asked[head - 1]) for (const c = asked[head - 1]; head && asked[head - 1] === c; ) head--;
  if (tail && line[line.length - 1 - tail] === asked[asked.length - tail]) for (const c = asked[asked.length - tail]; tail && asked[asked.length - tail] === c; ) tail--;
  return own.slice(0, head) + line.slice(head, line.length - tail) + own.slice(own.length - tail);
}

/**
 * The replacement's lines joined with line endings from the text it replaces: a line that keeps a line of the region, or
 * changes in place, reuses that line's ending; only lines beyond those take `fallback`. A line the model left unchanged
 * keeps its bytes, even in a file of mixed endings or when it was found by a looser match (`asked` is old_string, line for
 * line with the region). An edit too big to line up (ALIGN_MAX_CELLS) goes in as written.
 */
function withRegionEndings(region: string, asked: string, replacement: string, fallback: string): string {
  const before = region.split(/\r?\n/);
  const endings = [...region.matchAll(/\r?\n/g)].map((match) => match[0]);
  const copied = asked.split("\n");
  const after = replacement.split("\n");
  if ((before.length + 1) * (after.length + 1) > ALIGN_MAX_CELLS) return after.join(fallback);
  const key = (line: string) => plain(line.trimEnd());
  const source = alignLines(before.map(key), after.map(key));
  return after
    .map((line, index) => {
      const at = source[index];
      const text = at === undefined || copied[at] === undefined ? line : ownText(before[at], copied[at], line);
      return index === after.length - 1 ? text : text + (endings[at!] ?? fallback);
    })
    .join("");
}

/** How many of the sorted `positions` come before `offset`. */
function countBefore(positions: number[], offset: number): number {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (positions[middle] < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Looks in the LF view of the file, in the three ways, and maps what it found back to the file's own offsets. */
function matchView(source: string, oldString: string, newString: string) {
  const view = source.replaceAll(CRLF, "\n");
  const removed = [...source.matchAll(/\r\n/g)].map((match, index) => match.index - index);
  const fileEnding = lineEnding(source, "\n");
  const search = oldString.replaceAll(CRLF, "\n");
  const replacement = newString.replaceAll(CRLF, "\n");
  const exact = occurrences(view, search);
  // Made plain, a search with no letter or digit in it (a bare dash, a space) would match every hyphen or space, and
  // spaces alone would match any blank line.
  const unicode = exact.length || !/[\p{L}\p{N}]/u.test(search) ? [] : occurrences(plain(view), plain(search));
  const trailing = exact.length || unicode.length || !search.trim() ? [] : lineOccurrences(view, search);
  return {
    matches: (exact.length ? exact : unicode.length ? unicode : trailing).map((match) => ({ start: match.start + countBefore(removed, match.start), end: match.end + countBefore(removed, match.end) })),
    replace: (match: Match) => {
      const region = source.slice(match.start, match.end);
      return withRegionEndings(region, search, replacement, lineEnding(region, fileEnding));
    },
  };
}

/**
 * What to tell a model whose old_string wasn't found: new_string is already there (often an edit that was already made),
 * or the lines closest to old_string, numbered as read_file numbers them. Lines vote for where old_string starts when they
 * match ignoring all whitespace, and at least half must agree. Only the span from the first to the last line that matched
 * is shown.
 */
function missHint(source: string, oldString: string, newString: string): string | null {
  const view = source.replaceAll(CRLF, "\n");
  const replacement = newString.replaceAll(CRLF, "\n");
  if (replacement.trim().length >= 20 && plain(view).includes(plain(replacement))) return "new_string is already in the file, so this edit may already have been made.";
  const key = (line: string) => plain(line).replace(/\s+/g, " ").trim();
  const distinct = (line: string) => /[\p{L}\p{N}]/u.test(line);
  const lines = view.split("\n");
  const search = oldString.replaceAll(CRLF, "\n").split("\n");
  const positions = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const value = key(line);
    if (!distinct(value)) return;
    const found = positions.get(value);
    if (found) found.push(index);
    else positions.set(value, [index]);
  });
  const votes = new Map<number, number>();
  const wanted = search.filter((line, offset) => {
    const value = key(line);
    if (!distinct(value)) return false;
    for (const index of positions.get(value) ?? []) votes.set(index - offset, (votes.get(index - offset) ?? 0) + 1);
    return true;
  }).length;
  const [start, count] = [...votes].reduce((best, vote) => (vote[1] > best[1] ? vote : best), [0, 0]);
  if (count === 0 || count * 2 < wanted) return null;
  const matched = search.flatMap((line, offset) => {
    const value = key(line);
    const index = start + offset;
    return value !== "" && index >= 0 && index < lines.length && key(lines[index]) === value ? [index] : [];
  });
  const from = matched[0];
  const to = Math.min(matched[matched.length - 1] + 1, from + HINT_LINES);
  const shown = lines.slice(from, to).map((line, index) => `${from + index + 1}\t${line.length > HINT_LINE_CHARS ? `${line.slice(0, HINT_LINE_CHARS)}…` : line}`);
  return ["The closest lines in the file:", ...shown].join("\n");
}

/**
 * Replaces `oldString` with `newString` in a file's text. Strings that differ only in \r ask to change line endings
 * themselves, so they apply to the exact bytes; every other edit looks in the LF view and keeps the file's endings. A byte
 * order mark stays at the start and is no part of what's matched.
 */
export function editText(file: string, oldString: string, newString: string, replaceAll: boolean): EditOutcome {
  const bom = file.startsWith(BOM);
  const source = bom ? file.slice(1) : file;
  const unmarked = (s: string) => (bom && s.startsWith(BOM) ? s.slice(1) : s);
  const search = unmarked(oldString);
  const replacement = unmarked(newString);
  const endingsOnly = search.replaceAll("\r", "") === replacement.replaceAll("\r", "");
  const { matches, replace } = endingsOnly ? { matches: occurrences(source, search), replace: () => replacement } : matchView(source, search, replacement);
  if (!matches.length) return { result: "missing", hint: missHint(source, search, replacement) };
  if (matches.length > 1 && !replaceAll) return { result: "several", places: matches.length };
  // In one pass, in order (matches never overlap): this runs on the hub's only thread, and a file can have 900,000 of them.
  const pieces: string[] = [];
  let at = 0;
  for (const match of matches) {
    pieces.push(source.slice(at, match.start), replace(match));
    at = match.end;
  }
  pieces.push(source.slice(at));
  const text = pieces.join("");
  if (text === source) return { result: "unchanged" };
  return { result: "edited", text: bom ? BOM + text : text, places: matches.length };
}
