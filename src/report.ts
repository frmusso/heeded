// The report: the terminal's text and the json document, from the same data.
import type { Data } from './check.ts';

/** The counts, and where they were read from. */
export interface Report extends Data { folder: string; configDir: string; unrecognized: string[] }

export function json(r: Report): string {
  const { folder, configDir, from, to, sessions, subagents, unrecognized, notRead, files, rules, byDepth } = r;
  return `${JSON.stringify({ heeded: 1, folder, configDir, from, to, sessions, subagents, unrecognized, notRead, files, rules,
    byDepth }, null, 2)}\n`;
}

interface TextOptions { columns: number; color: boolean; now: Date; home: string }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const date = (iso: string) => `${MONTHS[new Date(iso).getMonth()]} ${new Date(iso).getDate()}`;
const thousands = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, word: string) => `${thousands(n)} ${word}${n === 1 ? '' : 's'}`;
const cut = (s: string, width: number) => (s.length > width ? `${s.slice(0, width - 1)}…` : s);

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
  const tilde = (path: string) => (path === o.home || path.startsWith(`${o.home}/`) ? `~${path.slice(o.home.length)}` : path);
  const paint = (code: number, off: number, s: string) => (o.color ? `\x1b[${code}m${s}\x1b[${off}m` : s);
  const out = (blocks: string[][]) => `\n${blocks.filter((b) => b.length).map((b) => b.map((l) => cut(l, o.columns))
    .join('\n')).join('\n\n')}\n`.replace(/^( {2})([✗✓○])/gm, (_, indent, mark) =>
    indent + (mark === '✗' ? paint(31, 39, mark) : mark === '✓' ? paint(32, 39, mark) : paint(2, 22, mark)))
    .replace(/^( {6}[a-z]{3} \d.*)$/gm, (line) => paint(2, 22, line));
  const unrecognized = r.unrecognized.length
    ? [`  ${plural(r.unrecognized.length, 'transcript')} unrecognized: claude code may have changed its format`] : [];
  if (!r.sessions) return out([[`  no claude code transcripts for ${tilde(r.folder)} in ${tilde(r.configDir)}`, ...unrecognized]]);

  const span = r.from && r.to ? ` · ${date(r.from) === date(r.to) ? date(r.from) : `${date(r.from)} – ${date(r.to)}`}` : '';
  const header = `  ${tilde(r.folder)} · ${plural(r.sessions, 'session')}, ${plural(r.subagents, 'subagent')}${span}`;
  if (!r.files.length) return out([[header, '  no instructions recorded', ...unrecognized]]);

  const checked = r.rules.filter((x) => ['broken', 'kept', 'never-applied'].includes(x.status));
  const judged = r.rules.filter((x) => x.status === 'judgment').length;
  const demoted = r.rules.filter((x) => x.status === 'demoted').length;
  const counts = `  ${plural(r.files.length, 'file')} · ${plural(r.rules.length, 'rule')} · ${thousands(checked.length)} checked`
    + ` · ${thousands(judged)} need a judge${demoted ? ` · ${thousands(demoted)} demoted` : ''}`;

  // The rules' cells, the name column narrowed until the widest row fits.
  const rows = checked.map((x) => [x.name, ...(x.status === 'never-applied'
    ? ['never applied', `~${thousands(x.tokens)} tokens every session`]
    : [`kept ${kept(x.applied, x.broken)} of ${thousands(x.applied)}`,
      ...(x.broken ? [`broken ${thousands(x.broken)}×`, `last ${ago(x.evidence[0].at, o.now)}`] : [])])]);
  const laid = (width: number) => columns(rows.map(([name, ...rest]) => [cut(name, width).padEnd(width), ...rest]));
  let width = Math.max(...rows.map((row) => row[0].length));
  while (width > 10 && Math.max(...laid(width).map((l) => l.length + 4)) > o.columns) width--;
  const mark = { broken: '✗', kept: '✓', 'never-applied': '○' } as Record<string, string>;
  const lines = laid(width).map((l, i) => `  ${mark[checked[i].status]} ${l}`);
  const rules: string[] = [];
  checked.forEach((x, i) => {
    rules.push(lines[i]);
    if (x.afterCompaction.applied >= 20) {
      rules.push(`      after compaction kept ${kept(x.afterCompaction.applied, x.afterCompaction.broken)} of ${thousands(x.afterCompaction.applied)}`);
    }
    for (const e of x.broken ? x.evidence.slice(0, 3) : []) {
      rules.push(`      ${date(e.at).padEnd(6)}  ${e.session.slice(0, 8)}  ${e.text}`);
    }
  });

  const labels = ['0–100k', '100–200k', '200–400k', '400k+'];
  const depth = r.byDepth.some((b) => b.applied) ? [
    `  kept by context depth${labels.map((l) => `   ${l}`).join('')}`,
    `  ${' '.repeat(21)}${r.byDepth.map((b, i) => `   ${(b.applied >= 20 ? kept(b.applied, b.broken) : '–').padStart(labels[i].length)}`).join('')}`,
  ] : [];

  const notChecked = [judged && `${plural(judged, 'rule')} ${judged === 1 ? 'needs' : 'need'} a judge`, demoted && `${thousands(demoted)} demoted`]
    .filter(Boolean).join(', ');
  const end = [
    ...(notChecked ? [`  ${notChecked}, not checked yet: heeded rules`] : []),
    ...(r.notRead ? [`  ${plural(r.notRead, 'section')} not read yet: the rules in them aren't checked`] : []),
    ...unrecognized,
  ];
  return out([[header, counts], rules, depth, end]);
}
