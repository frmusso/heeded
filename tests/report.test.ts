import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuleData } from '../src/check.ts';
import { json, type Report, rules, text } from '../src/report.ts';

const buckets = (counts: [number, number][]) => counts.map(([applied, broken], i) =>
  ({ from: [0, 100_000, 200_000, 400_000][i], to: [100_000, 200_000, 400_000, null][i], applied, broken }));

const empty: Report = {
  folder: '/home/someone/repos/app', configDir: '/home/someone/.claude', from: null, to: null, sessions: 0, subagents: 0,
  unrecognized: [], notRead: 0, toJudge: 0, atMost: 0, files: [], rules: [], byDepth: buckets([[0, 0], [0, 0], [0, 0], [0, 0]]),
};

test('the json document: heeded 2 first, then the report, two-space indented', () => {
  const report: Report = {
    ...empty, from: '2026-11-01T09:00:00Z', to: '2026-11-04T08:00:00Z', sessions: 2, subagents: 1, notRead: 1,
    files: ['/home/someone/repos/app/CLAUDE.md'],
    rules: [{
      id: '3f2a9c1e', name: 'never sudo', quote: 'never `sudo`', files: ['/home/someone/repos/app/CLAUDE.md'],
      status: 'demoted', reason: 'failed its examples: breaks "sudo ls"',
      check: { field: 'command', when: { tool: '^Bash$' }, broken: { value: '^sudo ' } },
      applied: 0, broken: 0, judged: 0, toJudge: 0, afterCompaction: { applied: 0, broken: 0 },
      byDepth: buckets([[0, 0], [0, 0], [0, 0], [0, 0]]), tokens: 3, evidence: [],
    }],
    byDepth: buckets([[2, 1], [0, 0], [0, 0], [1, 0]]),
  };
  const doc = json(report);
  assert.ok(doc.startsWith('{\n  "heeded": 2,\n  "folder": "/home/someone/repos/app",\n  "configDir": '), doc);
  assert.ok(doc.endsWith('\n}\n'));
  assert.deepEqual(Object.keys(JSON.parse(doc)), ['heeded', 'folder', 'configDir', 'from', 'to', 'sessions', 'subagents',
    'unrecognized', 'notRead', 'toJudge', 'atMost', 'files', 'rules', 'byDepth']);
  assert.deepEqual(JSON.parse(doc), { heeded: 2, ...report });
});

test('the json document of an empty history', () => {
  assert.deepEqual(JSON.parse(json(empty)), { heeded: 2, ...empty });
});

// The sketch of the report, with numbers that give its percentages.
const r = (name: string, status: RuleData['status'], applied: number, broken: number, more: Partial<RuleData> = {}): RuleData => ({
  id: name, name, quote: name, files: ['/home/someone/repos/billing/CLAUDE.md'], status, applied, broken, judged: 0, toJudge: 0,
  afterCompaction: { applied: 0, broken: 0 }, byDepth: buckets([[0, 0], [0, 0], [0, 0], [0, 0]]), tokens: 5, evidence: [],
  ...more,
});
const seen = (at: string, session: string, text: string) => ({ at, session: `${session}-0000-4000-8000-000000000000`, agent: null, text });
const sketch: Report = {
  ...empty, folder: '/home/someone/repos/billing', from: '2026-10-11T12:00:00Z', to: '2026-11-10T12:00:00Z', sessions: 76,
  subagents: 412, files: ['a', 'b', 'c'],
  rules: [
    r('never git add -A', 'broken', 214, 9, { afterCompaction: { applied: 12, broken: 3 }, evidence: [
      seen('2026-11-08T12:00:00Z', '19df6c20', 'git add -A && git commit -m "fix: …"'),
      seen('2026-11-02T12:00:00Z', '8c0e8fab', 'git add -A'), seen('2026-10-29T12:00:00Z', '4f1c22d0', 'git add -A'),
      seen('2026-10-20T12:00:00Z', '0a1b2c3d', 'git add -A')] }),
    r('always talk to me in italian', 'broken', 3812, 152, { afterCompaction: { applied: 410, broken: 127 }, evidence: [
      seen('2026-11-10T09:00:00Z', 'e7128125', 'en: "Sure — here\'s the plan for the …"')] }),
    r('never force-push', 'kept', 61, 0, { toJudge: 2 }),
    r('never push to main', 'to-confirm', 0, 0, { toJudge: 4 }),
    r('never kill billing', 'never-applied', 0, 0, { tokens: 40 }),
    r('failing test first', 'judgment', 20, 4, { judged: 26, evidence: [
      { ...seen('2026-11-07T12:00:00Z', '1a2b3c4d', 'call Edit: src/x.ts'), quote: 'call Edit: src/x.ts' }] }),
    r('ask before spending', 'judgment', 0, 0),
  ],
  toJudge: 9,
  atMost: 9,
  byDepth: buckets([[2310, 46], [900, 27], [300, 27], [100, 16]]),
};
const options = { columns: 80, color: false, now: new Date('2026-11-10T15:00:00Z'), home: '/home/someone' };

const at80 = `
  ~/repos/billing · 76 sessions, 412 subagents · oct 11 – nov 10
  3 files · 7 rules · 5 checked · 2 need a judge

  ✗ never git add -A         kept 95% of 214        broken 9×    last 2 days ago
      nov 8   19df6c20  git add -A && git commit -m "fix: …"
      nov 2   8c0e8fab  git add -A
      oct 29  4f1c22d0  git add -A
  ✗ always talk to me in i…  kept 96% of 3,812      broken 152×  last today
      after compaction kept 69% of 410
      nov 10  e7128125  en: "Sure — here's the plan for the …"
  ✓ never force-push         kept 100% of 61        2 to confirm
  ? never push to main       4 to confirm
  ○ never kill billing       never applied          ~40 tokens every session
  · failing test first       kept 80% of 20 judged  broken 4×    last 3 days ago
      nov 7   1a2b3c4d  call Edit: src/x.ts

  kept by context depth   0–100k   100–200k   200–400k   400k+
                             98%        97%        91%     84%

  1 rule not judged yet: heeded rules
  9 cases waiting for the judge
`;

test('the report at 80 columns: the names are cut to fit', () => {
  assert.equal(text(sketch, options), at80);
});

test('the report at 120 columns: names whole', () => {
  const rows = `
  ✗ never git add -A              kept 95% of 214        broken 9×    last 2 days ago
      nov 8   19df6c20  git add -A && git commit -m "fix: …"
      nov 2   8c0e8fab  git add -A
      oct 29  4f1c22d0  git add -A
  ✗ always talk to me in italian  kept 96% of 3,812      broken 152×  last today
      after compaction kept 69% of 410
      nov 10  e7128125  en: "Sure — here's the plan for the …"
  ✓ never force-push              kept 100% of 61        2 to confirm
  ? never push to main            4 to confirm
  ○ never kill billing            never applied          ~40 tokens every session
  · failing test first            kept 80% of 20 judged  broken 4×    last 3 days ago
      nov 7   1a2b3c4d  call Edit: src/x.ts
`;
  const at120 = at80.replace(/\n {2}✗[\s\S]*src\/x\.ts\n/, rows);
  assert.notEqual(at120, at80);
  assert.equal(text(sketch, { ...options, columns: 120 }), at120);
});

test('in colour: the marks, and the evidence dimmed', () => {
  const coloured = at80.replace(/✗/g, '\x1b[31m✗\x1b[39m').replace('✓', '\x1b[32m✓\x1b[39m').replace('○', '\x1b[2m○\x1b[22m')
    .replace('  ? ', '  \x1b[2m?\x1b[22m ').replace('  · failing', '  \x1b[2m·\x1b[22m failing')
    .replace(/^( {6}(?:nov|oct) .*)$/gm, '\x1b[2m$1\x1b[22m');
  assert.equal(text(sketch, { ...options, color: true }), coloured);
});

test('no transcripts: one line naming the folder and the config dir', () => {
  assert.equal(text(empty, options), '\n  no claude code transcripts for ~/repos/app in ~/.claude\n');
});

test('sessions without instruction files: one line', () => {
  assert.equal(text({ ...empty, sessions: 3, from: '2026-11-10T12:00:00Z', to: '2026-11-10T12:00:00Z' }, options),
    '\n  ~/repos/app · 3 sessions, 0 subagents · nov 10\n  no instructions recorded\n');
});

test('transcripts not recognized, and sections not read yet: one line each', () => {
  const out = text({ ...sketch, unrecognized: ['a.jsonl', 'b.jsonl'], notRead: 14 }, options);
  assert.ok(out.endsWith('  1 rule not judged yet: heeded rules\n'
    + '  14 sections not read yet: the rules in them aren\'t checked\n'
    + '  9 cases waiting for the judge\n'
    + '  2 transcripts unrecognized: claude code may have changed its format\n'), out);
});

test('the edges: 1% when a case was kept, – under 20 cases, yesterday, one of each, demoted rules', () => {
  const out = text({ ...sketch, sessions: 1, subagents: 1, files: ['a'], toJudge: 0,
    rules: [r('never sudo', 'broken', 1000, 999, { evidence: [seen('2026-11-09T12:00:00Z', 'aaaaaaaa', 'sudo ls')] }),
      r('failing test first', 'judgment', 0, 0), r('never rm', 'demoted', 0, 0)],
    byDepth: buckets([[1000, 999], [19, 0], [0, 0], [0, 0]]) }, options);
  assert.equal(out, `
  ~/repos/billing · 1 session, 1 subagent · oct 11 – nov 10
  1 file · 3 rules · 1 checked · 1 need a judge · 1 demoted

  ✗ never sudo  kept 1% of 1,000  broken 999×  last yesterday
      nov 9   aaaaaaaa  sudo ls

  kept by context depth   0–100k   100–200k   200–400k   400k+
                              1%          –          –       –

  1 rule not judged yet, 1 demoted: heeded rules
`);
});

// heeded rules, over one rule of each kind.
const local = '/home/someone/repos/billing/CLAUDE.local.md';
const found: Report = {
  ...sketch, notRead: 0,
  files: ['/home/someone/.claude/CLAUDE.md', local, '/home/someone/repos/billing/CLAUDE.md'],
  rules: [
    r('never git add -A', 'broken', 3, 1, { files: [local, '/home/someone/repos/billing/CLAUDE.md'],
      check: { field: 'command', when: { tool: '^Bash$', value: '\\bgit\\s+add\\b' }, broken: { value: '\\s(-A|--all)\\b' } } }),
    r('clickup is read-only', 'kept', 4, 0, { files: ['/home/someone/.claude/CLAUDE.md'],
      check: { when: { tool: 'mcp__.*clickup.*' }, broken: { tool: '_(create|update|delete)_' }, ignoreCase: true } }),
    r('always talk to me in italian', 'never-applied', 0, 0, { files: [local], check: { language: 'it' } }),
    r('failing test first', 'judgment', 0, 0, { files: [local], reason: 'no case to judge it on' }),
    r('never kill billing', 'demoted', 0, 0, { files: [local], reason: 'failed its examples: keeps "pkill -f billingd-test"' }),
  ],
};
const listed = `
  ~/repos/billing · 3 files · 5 rules

  ~/.claude/CLAUDE.md
    ✓ clickup is read-only          tool mcp__.*clickup.*  broken tool _(create|update|delete)_  ignoring case
  CLAUDE.local.md
    ✓ never git add -A              Bash command  when \\bgit\\s+add\\b  broken \\s(-A|--all)\\b
    ✓ always talk to me in italian  language it
    · failing test first            needs a judge, no cases: no case to judge it on
    ! never kill billing            failed its examples: keeps "pkill -f billingd-test"
`;

test('heeded rules: by file, each rule under the first file that has it, with how it is checked, whole', () => {
  assert.equal(rules(found, { color: false, home: '/home/someone' }), listed);
});

test('heeded rules in colour: the marks', () => {
  assert.equal(rules(found, { color: true, home: '/home/someone' }),
    listed.replace(/✓/g, '\x1b[32m✓\x1b[39m').replace('    · ', '    \x1b[2m·\x1b[22m ').replace('!', '\x1b[33m!\x1b[39m'));
});

test('heeded rules with sections not read yet says so', () => {
  assert.ok(rules({ ...found, notRead: 2 }, { color: false, home: '/home/someone' })
    .endsWith(`${listed}\n  2 sections not read yet: the rules in them aren't checked\n`));
});

test('heeded rules shows what a command carries is checked for', () => {
  const commit = r('no co-authors in commits', 'kept', 2, 0, { files: [local],
    check: { field: 'command', when: { tool: '^Bash$', value: '\\bgit\\s+commit\\b', data: '\\S' }, broken: { data: 'Co-Authored-By' } } });
  assert.match(rules({ ...found, rules: [commit] }, { color: false, home: '/home/someone' }),
    /no co-authors in commits {2}Bash command {2}when \\bgit\\s\+commit\\b {2}when data \\S {2}broken data Co-Authored-By\n/);
});

test('heeded rules: a judgment rule shows what it is judged on, or why it has no cases', () => {
  const judged = [
    r('say what you changed', 'judgment', 0, 0, { files: [local], check: { reply: true } }),
    r('commit only when asked', 'judgment', 0, 0, { files: [local],
      check: { field: 'command', when: { tool: '^Bash$', value: '(^|\\s)git\\s+commit(\\s|$)' } } }),
    r('plan before coding', 'judgment', 0, 0, { files: [local], reason: 'failed its examples: "ls" is not a case' }),
  ];
  assert.equal(rules({ ...found, rules: judged }, { color: false, home: '/home/someone' }), `
  ~/repos/billing · 3 files · 3 rules

  CLAUDE.local.md
    · say what you changed    judged on replies
    · commit only when asked  judged on Bash command  when (^|\\s)git\\s+commit(\\s|$)
    · plan before coding      needs a judge, no cases: failed its examples: "ls" is not a case
`);
});
