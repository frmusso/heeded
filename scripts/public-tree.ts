// The public tree: finds what the repository should not say once it is published — references to private working
// notes, notes on who decided what, personal data. The tree starts clean, so any hit fails.
//
//   node scripts/public-tree.ts    one `file:line rule text` per hit; exits 1 on any
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Rule { id: string; re: RegExp }

/** A comment line, or a test's name: where prose lives in code. */
const PROSE = String.raw`^\s*(?:\/\/|\*|\/\*|#|<!--|(?:test|it|describe)(?:\.\w+)*\(\s*['"\x60])`;

export const RULES: Rule[] = [
  { id: 'spec', re: /\b[Ss]pecs? (?:docs\/|20\d\d-\d\d-\d\d|[a-z0-9][\w.]*(?:-[\w.]+)+|v\d[\w.]*|(?:[A-Za-z0-9.'"-]+ ){0,3}§)|\([Ss]pecs? [a-z][\w.-]*[),;]|\([Ss]pecs?$|\bthe spec's\b|\bsee the spec\b|[(;,]\s?[Ss]pecs?\s*$/ },
  { id: 'section', re: /§/ },
  { id: 'doc-slug', re: /\b20\d\d-\d\d-\d\d-[a-z][a-z0-9-]*/ },
  { id: 'plan', re: /\b[Pp]lans? (?:phase|20\d\d-|[A-Z]\d+\b|[a-z0-9-]+ (?:§|task|phase))|\([Pp]lan [a-z0-9]/ },
  // A ruling's number where prose cites it — "(R2)", "rulings R33, R38", "// R6: …", "R48's" — not git's rename
  // scores (R100).
  { id: 'ruling', re: /\b[Rr]ulings?\b|(?:[([]|\b(?:and|see|spec)\s|^\s*(?:\/\/|\/\*\*?|\*|#)\s*|[,;:]\s?)R\d{1,3}\b|\bR\d{1,3}(?:'s|\/R?\d{1,3})\b/ },
  { id: 'ledger', re: /\b[Ll]edger [A-Z]\d+|\b[Ll]edgered\b/ },
  { id: 'notes', re: /superpowers|\bHANDOFF\b/ },
  // Notes on who decided what, and when: "(Mario, 2026-01-02)", "his call", "he asked".
  { id: 'author-notes', re: /\b[A-Z][a-z]+, 20\d\d-\d\d-\d\d\b|\b(?:his|her) (?:call|go|ok|ask|pick|choice|decision|ruling|check|app|Mac|machine)\b|\bhe (?:asked|wants|said|chose|decided|picked)\b/ },
  // The user is "the user" or "they" in prose, never "he".
  { id: 'pronoun', re: new RegExp(PROSE + String.raw`.*?\b(?:[Hh]e|[Hh]im|[Hh]is|[Hh]imself)\b`) },
  { id: 'personal', re: /[\w.+-]+@gmail\.com/ },
];

/** A developer's own working notes (agent instructions, a handoff, specs and plans): never tracked here. */
export function isPrivate(path: string): boolean {
  return /^(?:CLAUDE\.local\.md|HANDOFF\.md|docs\/superpowers\/.*)$/.test(path);
}

/** The ids of the rules `line` breaks, in `rules` order. */
export function hits(line: string, rules: Rule[]): string[] {
  return rules.filter((r) => r.re.test(line)).map((r) => r.id);
}

/** RULES, plus the words only a developer's own copy knows (their names, accounts, home paths, other projects) as the
 * `local` rule: one expression per line, `#` for comments, in the git common dir's `info/public-tree-words` and any
 * `info/public-tree-words-*` beside it (a list shared with other projects, and this one's own), never in the
 * repository. */
export function rules(root: string): Rule[] {
  let words: string[];
  try {
    const info = join(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'info');
    words = readdirSync(info).filter((f) => /^public-tree-words(-.+)?$/.test(f))
      .flatMap((f) => readFileSync(join(info, f), 'utf8').split('\n')).map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return RULES; // no git, or no info folder
  }
  return words.length ? [...RULES, { id: 'local', re: new RegExp(words.join('|'), 'i') }] : RULES;
}

/** The guard and its test name what they look for; a lockfile holds package names only. */
const SKIPPED = /^(?:scripts\/public-tree\.ts|tests\/public-tree\.test\.ts|package-lock\.json)$/;

/** Every hit in the files git tracks or would track: `file:line rules text`, and `file private` for a private note. */
export function scan(root: string): string[] {
  const all = rules(root);
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter((f) => f && !SKIPPED.test(f)).sort();
  const out: string[] = [];
  for (const file of files) {
    if (isPrivate(file)) out.push(`${file} private`);
    let buf: Buffer;
    try { buf = readFileSync(join(root, file)); } catch { continue; } // deleted in the working tree
    if (buf.includes(0)) continue; // binary
    buf.toString('utf8').split('\n').forEach((line, i) => {
      const ids = hits(line, all);
      if (ids.length) out.push(`${file}:${i + 1} ${ids.join(',')} ${line.trim().slice(0, 160)}`);
    });
  }
  return out;
}

if (import.meta.main) {
  const found = scan(join(import.meta.dirname, '..'));
  for (const hit of found) console.log(hit);
  process.exitCode = found.length ? 1 : 0;
}
