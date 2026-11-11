// The report: the terminal's text and the json document, from the same data.
import type { Data, RuleData } from './check.ts';
import { BUDGET } from './judge.ts';

/** The counts, where they were read from, and what judging every case waiting would cost. */
export interface Report extends Data { folder: string; configDir: string; unrecognized: string[]; toJudgeTokens: number }

export function json(r: Report): string {
  const { folder, configDir, from, to, sessions, subagents, unrecognized, notRead, toJudge, toJudgeTokens, atMost, files, rules,
    byDepth } = r;
  return `${JSON.stringify({ heeded: 2, folder, configDir, from, to, sessions, subagents, unrecognized, notRead, toJudge,
    toJudgeTokens, atMost, files, rules, byDepth }, null, 2)}\n`;
}

interface TextOptions { columns: number; color: boolean; now: Date; home: string }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const date = (iso: string) => `${MONTHS[new Date(iso).getMonth()]} ${new Date(iso).getDate()}`;
const thousands = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, word: string) => `${thousands(n)} ${word}${n === 1 ? '' : 's'}`;
const cut = (s: string, width: number) => (s.length > width ? `${s.slice(0, width - 1)}…` : s);
const tilde = (path: string, home: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
const paint = (color: boolean, code: number, off: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[${off}m` : s);
const notRead = (n: number) => `  ${plural(n, 'section')} not read yet: the rules in them aren't checked`;

/** Tokens as heeded says them: ~106k, ~1.1M. */
export const approx = (tokens: number) =>
  (tokens >= 999_500 ? `~${Number((tokens / 1_000_000).toFixed(1))}M` : `~${Math.round(tokens / 1000)}k`);

/** The instruction files in the order the report and `heeded rules` list them: the folder's own first, then the files
 * from outside it (the user's own file, a parent folder's), each in the order heeded met them. */
const inOrder = (r: Report) => {
  const inside = (f: string) => f.startsWith(`${r.folder}/`);
  return [...r.files.filter(inside), ...r.files.filter((f) => !inside(f))];
};

/** A file as the user finds it: by its path in the folder, or from home. */
const where = (r: Report, path: string, home: string) =>
  (path.startsWith(`${r.folder}/`) ? path.slice(r.folder.length + 1) : tilde(path, home));

/** Floored, so never 100% with a violation; and never 0% with a case kept. */
function kept(applied: number, broken: number): string {
  const p = Math.floor((100 * (applied - broken)) / applied);
  return `${applied > broken && p === 0 ? 1 : p}%`;
}

/** Days between two times, by the local calendar. */
function ago(iso: string, now: Date): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(new Date(iso))) / 86_400_000);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Cells in columns two spaces apart; a row's last cell sets no width. */
function columns(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.slice(0, -1).forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows.map((row) => row.map((c, i) => (i < row.length - 1 ? c.padEnd(widths[i] + 2) : c)).join(''));
}

/** The report for a terminal, `columns` wide. */
export function text(r: Report, o: TextOptions): string {
  const home = (path: string) => tilde(path, o.home);
  const color = (code: number, off: number, s: string) => paint(o.color, code, off, s);
  // Only rules and evidence are cut to the width: a folder's path is never cut.
  const out = (blocks: string[][]) => `\n${blocks.filter((b) => b.length).map((b) => b.join('\n')).join('\n\n')}\n`.replace(/^( {4})([✗✓○?·])/gm, (_, indent, mark) =>
    indent + (mark === '✗' ? color(31, 39, mark) : mark === '✓' ? color(32, 39, mark) : color(2, 22, mark)))
    .replace(/^( {8}[a-z]{3} \d.*)$/gm, (line) => color(2, 22, line));
  const unrecognized = r.unrecognized.length
    ? [`  ${plural(r.unrecognized.length, 'transcript')} unrecognized: claude code may have changed its format`] : [];
  if (!r.sessions) return out([[`  no claude code transcripts for ${home(r.folder)} in ${home(r.configDir)}`, ...unrecognized]]);

  const span = r.from && r.to ? ` · ${date(r.from) === date(r.to) ? date(r.from) : `${date(r.from)} – ${date(r.to)}`}` : '';
  const header = `  ${home(r.folder)} · ${plural(r.sessions, 'session')}, ${plural(r.subagents, 'subagent')}${span}`;
  if (!r.files.length) return out([[header, '  no instructions recorded', ...unrecognized]]);

  const checked = r.rules.filter((x) => ['broken', 'kept', 'to-confirm', 'never-applied'].includes(x.status));
  const judgment = r.rules.filter((x) => x.status === 'judgment');
  const demoted = r.rules.filter((x) => x.status === 'demoted').length;
  const counts = `  ${plural(r.files.length, 'file')} · ${plural(r.rules.length, 'rule')} · ${thousands(checked.length)} checked`
    + ` · ${thousands(judgment.length)} need a judge${demoted ? ` · ${thousands(demoted)} set aside` : ''}`;

  // The rules' cells, the name column narrowed until the widest row fits: the checked rules; the judgment rules that
  // never applied (their sample ended with every case none, or they had no case) with the others never applied; then
  // the judgment rules judged on a sample, whose share is of their cases judged. A judgment rule whose cases still
  // wait, or that no call or reply can show, is counted at the end.
  const unapplied = judgment.filter((x) => !x.reason && !x.applied && !x.toJudge);
  const never = (x: RuleData) => x.status === 'never-applied' || unapplied.includes(x);
  // Grouped by the file each rule is written in (the first, when it is in several), each file in that order.
  const listed = [...checked, ...unapplied, ...judgment.filter((x) => x.applied)];
  const shown = inOrder(r).flatMap((f) => listed.filter((x) => x.files[0] === f));
  const rows = shown.map((x) => [x.name, ...(never(x)
    ? [`never applied${x.judged ? ` in ${thousands(x.judged)} judged` : ''}`, `~${thousands(x.tokens)} tokens every session`]
    : x.status === 'to-confirm' ? []
    : [`kept ${kept(x.applied, x.broken)} of ${thousands(x.applied)}${x.status === 'judgment' ? ' judged' : ''}`,
      ...(x.broken ? [`broken ${thousands(x.broken)}×`, `last ${ago(x.evidence[0].at, o.now)}`] : [])]),
  ...(x.status !== 'judgment' && x.toJudge ? [`${thousands(x.toJudge)} to confirm`] : [])]);
  const laid = (width: number) => columns(rows.map(([name, ...rest]) => [cut(name, width).padEnd(width), ...rest]));
  let width = Math.max(...rows.map((row) => row[0].length));
  while (width > 10 && Math.max(...laid(width).map((l) => l.length + 6)) > o.columns) width--;
  const mark = { broken: '✗', kept: '✓', 'to-confirm': '?', judgment: '·' } as Record<string, string>;
  const lines = laid(width).map((l, i) => cut(`    ${never(shown[i]) ? '○' : mark[shown[i].status]} ${l}`, o.columns));
  const rules: string[] = [];
  shown.forEach((x, i) => {
    if (x.files[0] !== shown[i - 1]?.files[0]) rules.push(`  ${where(r, x.files[0], o.home)}`);
    rules.push(lines[i]);
    if (x.afterCompaction.applied >= 20) {
      const { applied, broken } = x.afterCompaction;
      rules.push(`        after compaction kept ${kept(applied, broken)} of ${thousands(applied)}`);
    }
    // A judgment rule's evidence is the judge's words; a tool rule's, what in the call broke it.
    for (const e of x.broken ? x.evidence.slice(0, 3) : []) {
      const what = x.status === 'judgment' ? e.quote ?? e.text : e.text;
      rules.push(cut(`        ${date(e.at).padEnd(6)}  ${e.session.slice(0, 8)}  ${what}`, o.columns));
    }
  });

  const labels = ['0–100k', '100–200k', '200–400k', '400k+'];
  const depth = r.byDepth.some((b) => b.applied) ? [
    `  kept by context depth${labels.map((l) => `   ${l}`).join('')}`,
    `  ${' '.repeat(21)}${r.byDepth.map((b, i) => `   ${(b.applied >= 20 ? kept(b.applied, b.broken) : '–').padStart(labels[i].length)}`).join('')}`,
  ] : [];

  const unseen = judgment.filter((x) => x.reason).length;
  const aside = [unseen && `${plural(unseen, 'rule')} no call or reply shows`, demoted && `${thousands(demoted)} set aside`]
    .filter(Boolean).join(', ');
  const todo = r.toJudgeTokens > BUDGET ? `heeded judges ${approx(BUDGET)} a run, heeded --all all of them` : 'run heeded again';
  const end = [
    ...(aside ? [`  ${aside}: heeded rules`] : []),
    ...(r.notRead ? [notRead(r.notRead)] : []),
    ...(r.toJudge ? [`  ${plural(r.toJudge, 'case')} waiting for the judge, ${approx(r.toJudgeTokens)} tokens: ${todo}`] : []),
    ...unrecognized,
  ];
  return out([[header, counts], rules, depth, end]);
}

/** How a rule is checked, in words: a tool check shows every pattern, whole; a judgment rule, the cases it is judged on. */
function how(x: RuleData): string {
  if (x.status === 'judgment') {
    return x.reason ? `needs a judge, no cases: ${x.reason}` : x.check?.reply ? 'judged on replies' : `judged on ${patterns(x.check!)}`;
  }
  if (x.status === 'demoted') return x.reason!;
  if (x.check!.language) return `language ${x.check!.language}`;
  return patterns(x.check!);
}

function patterns(c: NonNullable<RuleData['check']>): string {
  const tool = c.when?.tool;
  return [
    `${tool === undefined ? 'any tool' : /^\^\w+\$$/.test(tool) ? tool.slice(1, -1) : `tool ${tool}`}${c.field ? ` ${c.field}` : ''}`,
    c.when?.value !== undefined && `when ${c.when.value}`,
    c.when?.data !== undefined && `when data ${c.when.data}`,
    c.broken?.tool !== undefined && `broken tool ${c.broken.tool}`,
    c.broken?.value !== undefined && `broken ${c.broken.value}`,
    c.broken?.data !== undefined && `broken data ${c.broken.data}`,
    c.ignoreCase && 'ignoring case',
  ].filter(Boolean).join('  ');
}

/** The rules found, by file, and how each one is checked. Never cut to the terminal's width: the patterns are what this
 * list is for. */
export function rules(r: Report, o: { color: boolean; home: string }): string {
  const width = Math.max(...r.rules.map((x) => x.name.length));
  const lines = ['', `  ${tilde(r.folder, o.home)} · ${plural(r.files.length, 'file')} · ${plural(r.rules.length, 'rule')}`, ''];
  for (const file of inOrder(r)) {
    const mine = r.rules.filter((x) => x.files[0] === file);
    if (mine.length) lines.push(`  ${where(r, file, o.home)}`);
    for (const x of mine) {
      const mark = x.status === 'judgment' ? paint(o.color, 2, 22, '·') : x.status === 'demoted' ? paint(o.color, 33, 39, '!')
        : paint(o.color, 32, 39, '✓');
      lines.push(`    ${mark} ${x.name.padEnd(width + 2)}${how(x)}`);
    }
  }
  if (r.notRead) lines.push('', notRead(r.notRead));
  return `${lines.join('\n')}\n`;
}
