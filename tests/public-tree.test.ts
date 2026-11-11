// The public tree: what the repository says on its own once published. Comments, tests and docs carry no references to
// private working notes (specs, plans, rulings, ledger items, the handoff), no notes on who decided what, and no
// personal data. Any hit fails: the tree starts clean.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RULES, hits, isPrivate, rules, scan } from '../scripts/public-tree.ts';

const samples: [string, string][] = [
  ['spec', '// Kept in order (spec website-live-demo §3).'],
  ['spec', '* the window frame (spec 2026-10-15-session-coalitions-design.md)'],
  ['spec', '/** It is over (a report is not: see the spec). */'],
  ['section', '// the home strip (§1.5)'],
  ['doc-slug', '// see 2026-10-15-website-live-demo for the contract'],
  ['plan', '// the Windows half (plan windows phase 4)'],
  ['plan', '// (plan 2026-10-15-website-live-demo, "Performance")'],
  ['ruling', '// nothing looked for (ruling R116)'],
  ['ruling', '// a test home never names real jobs (R2)'],
  ['ruling', '// Ruling: a command, never a custom demo state'],
  ['ledger', '// without decrypting it (ledger T15)'],
  ['ledger', '// the open questions, ledgered'],
  ['notes', '// see HANDOFF for the state'],
  ['notes', '// docs/superpowers/specs/x.md'],
  ['author-notes', '// (Mario, 2026-01-02: one bar again)'],
  ['author-notes', '// what he asked for'],
  ['pronoun', '// A connection he disconnected stays closed.'],
  ['personal', '// write to someone@gmail.com'],
];

for (const [rule, text] of samples) {
  test(`${rule} catches: ${text}`, () => {
    assert.ok(hits(text, RULES).includes(rule), JSON.stringify(hits(text, RULES)));
  });
}

for (const text of [
  'const HANDOFF_TEXT_MAX = 64 * 1024 * 1024;',
  "author: 'Francesco Musso',",
  '## 0.2.0-beta.20 — 2026-10-26',
  "at: '2026-10-31T11:51:00.000Z'",
  'const he = sessions.length; // the user picks one',
]) {
  test(`nothing to report in: ${text}`, () => {
    assert.deepEqual(hits(text, RULES), []);
  });
}

test("a developer's own words come from the git common dir, never from the repository", () => {
  const repo = mkdtempSync(join(tmpdir(), 'heeded-words-'));
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, '.git', 'info', 'public-tree-words'), '# names only this copy knows\nacme-secret-name\n\n');
  assert.deepEqual(hits('// see Acme-Secret-Name', rules(repo)), ['local']);
  // More files beside it, public-tree-words-<anything>: words shared with other projects, and this one's own.
  writeFileSync(join(repo, '.git', 'info', 'public-tree-words-project'), 'other-private-project\n');
  assert.deepEqual(hits('// see other-private-project', rules(repo)), ['local']);
  assert.deepEqual(hits('// see acme-secret-name', rules(repo)), ['local']);
  const plain = mkdtempSync(join(tmpdir(), 'heeded-nogit-'));
  assert.deepEqual(hits('// see acme-secret-name', rules(plain)), []);
  rmSync(repo, { recursive: true });
  rmSync(plain, { recursive: true });
});

test('the private working notes are never tracked: they live in a repository of their own', () => {
  for (const f of ['CLAUDE.local.md', 'HANDOFF.md', 'docs/superpowers/specs/x.md']) assert.equal(isPrivate(f), true, f);
  for (const f of ['src/x/CLAUDE.local.md', 'README.md']) assert.equal(isPrivate(f), false, f);
});

test('a scan names each hit by file and line, and each private file; the guard itself is skipped', () => {
  const repo = mkdtempSync(join(tmpdir(), 'heeded-scan-'));
  execFileSync('git', ['init', '-q', repo]);
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'scripts'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 1;\n// see HANDOFF\n');
  writeFileSync(join(repo, 'scripts', 'public-tree.ts'), '// see HANDOFF\n');
  writeFileSync(join(repo, 'HANDOFF.md'), 'state\n');
  assert.deepEqual(scan(repo), ['HANDOFF.md private', 'src/a.ts:2 notes // see HANDOFF']);
  rmSync(repo, { recursive: true });
});

test('the real tree: no private file, no hit', () => {
  assert.deepEqual(scan(join(import.meta.dirname, '..')), []);
});
