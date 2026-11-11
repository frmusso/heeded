import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuleData } from '../src/check.ts';
import { approx, json, type Report, rules, text } from '../src/report.ts';

const buckets = (counts: [number, number][]) => counts.map(([applied, broken], i) =>
  ({ from: [0, 100_000, 200_000, 400_000][i], to: [100_000, 200_000, 400_000, null][i], applied, broken }));

const empty: Report = {
  folder: '/home/someone/repos/app', configDir: '/home/someone/.claude', from: null, to: null, sessions: 0, subagents: 0,
  unrecognized: [], notRead: 0, toReread: 0, toJudge: 0, toJudgeTokens: 0, atMost: 0, files: [], rules: [], byDepth: buckets([[0, 0], [0, 0], [0, 0], [0, 0]]),
};

test('the json document: heeded 2 first, then the report, two-space indented', () => {
  const report: Report = {
    ...empty, from: '2026-11-01T09:00:00Z', to: '2026-11-04T08:00:00Z', sessions: 2, subagents: 1, notRead: 1,
    files: ['/home/someone/repos/app/CLAUDE.md'],
    rules: [{
      id: '3f2a9c1e', name: 'never sudo', quote: 'never `sudo`', files: ['/home/someone/repos/app/CLAUDE.md'],
      heading: 'app › safety', lines: { '/home/someone/repos/app/CLAUDE.md': 12 },
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
    'unrecognized', 'notRead', 'toReread', 'toJudge', 'toJudgeTokens', 'atMost', 'files', 'rules', 'byDepth']);
  assert.deepEqual(JSON.parse(doc), { heeded: 2, ...report });
});

test('the json document of an empty history', () => {
  assert.deepEqual(JSON.parse(json(empty)), { heeded: 2, ...empty });
});

// The sketch of the report, with numbers that give its percentages.
const r = (name: string, status: RuleData['status'], applied: number, broken: number, more: Partial<RuleData> = {}): RuleData => ({
  id: name, name, quote: name, files: ['/home/someone/repos/billing/CLAUDE.md'], heading: '', lines: {}, status,
  applied, broken, judged: 0, toJudge: 0, afterCompaction: { applied: 0, broken: 0 },
  byDepth: buckets([[0, 0], [0, 0], [0, 0], [0, 0]]), tokens: 5, evidence: [],
  ...more,
});
const seen = (at: string, session: string, text: string) => ({ at, session: `${session}-0000-4000-8000-000000000000`, agent: null, text });
const own = '/home/someone/.claude/CLAUDE.md';
const web = '/home/someone/repos/billing/web/CLAUDE.md';
const sketch: Report = {
  ...empty, folder: '/home/someone/repos/billing', from: '2026-10-11T12:00:00Z', to: '2026-11-10T12:00:00Z', sessions: 76,
  subagents: 412, files: [own, '/home/someone/repos/billing/CLAUDE.md', web],
  rules: [
    r('never git add -A', 'broken', 214, 9, { afterCompaction: { applied: 12, broken: 3 }, evidence: [
      seen('2026-11-08T12:00:00Z', '19df6c20', 'git add -A && git commit -m "fix: …"'),
      seen('2026-11-02T12:00:00Z', '8c0e8fab', 'git add -A'), seen('2026-10-29T12:00:00Z', '4f1c22d0', 'git add -A'),
      seen('2026-10-20T12:00:00Z', '0a1b2c3d', 'git add -A')] }),
    r('always talk to me in italian', 'broken', 3812, 152, { afterCompaction: { applied: 410, broken: 127 }, evidence: [
      seen('2026-11-10T09:00:00Z', 'e7128125', 'en: "Sure — here\'s the plan for the …"')] }),
    r('never force-push', 'kept', 61, 0, { toJudge: 2, files: [own] }),
    r('never push to main', 'to-confirm', 0, 0, { toJudge: 4 }),
    r('never kill billing', 'never-applied', 0, 0, { tokens: 40 }),
    r('failing test first', 'judgment', 20, 4, { judged: 26, evidence: [
      { ...seen('2026-11-07T12:00:00Z', '1a2b3c4d', 'call Edit: src/x.ts'), quote: 'call Edit: src/x.ts' }] }),
    r('ask before spending', 'judgment', 0, 0, { toJudge: 3 }),
    r('clickup writes', 'judgment', 0, 0, { judged: 8, tokens: 30, files: [own] }),
    r('plan before coding', 'judgment', 0, 0, { reason: 'no case to judge it on', files: [web] }),
  ],
  toJudge: 9,
  toJudgeTokens: 31_000,
  atMost: 9,
  byDepth: buckets([[2310, 46], [900, 27], [300, 27], [100, 16]]),
};
const options = { columns: 80, color: false, now: new Date('2026-11-10T15:00:00Z'), home: '/home/someone' };

const rows80 = `  CLAUDE.md
    ✗ failing test fir…  kept 80% of 20 judged      broken 4×    last 3 days ago
        nov 7   1a2b3c4d  call Edit: src/x.ts
    ✗ never git add -A   kept 95% of 214            broken 9×    last 2 days ago
        nov 8   19df6c20  git add -A && git commit -m "fix: …"
        nov 2   8c0e8fab  git add -A
        oct 29  4f1c22d0  git add -A
    ✗ always talk to m…  kept 96% of 3,812          broken 152×  last today
        after compaction kept 69% of 410
        nov 10  e7128125  en: "Sure — here's the plan for the …"
    ? never push to ma…  4 to confirm
    ○ never kill billi…  never applied              ~40 tokens every session
  ~/.claude/CLAUDE.md
    ✓ never force-push   kept 100% of 61            2 to confirm
    ○ clickup writes     never applied in 8 judged  ~30 tokens every session
`;
const at80 = `
  ~/repos/billing · 76 sessions, 412 subagents · oct 11 – nov 10
  3 files · 9 rules · 5 checked · 4 need a judge

  CLAUDE.md
    ✗ failing test fir…  kept 80% of 20 judged      broken 4×    last 3 days ago
        nov 7   1a2b3c4d  call Edit: src/x.ts
    ✗ never git add -A   kept 95% of 214            broken 9×    last 2 days ago
        nov 8   19df6c20  git add -A && git commit -m "fix: …"
        nov 2   8c0e8fab  git add -A
        oct 29  4f1c22d0  git add -A
    ✗ always talk to m…  kept 96% of 3,812          broken 152×  last today
        after compaction kept 69% of 410
        nov 10  e7128125  en: "Sure — here's the plan for the …"
    ? never push to ma…  4 to confirm
    ○ never kill billi…  never applied              ~40 tokens every session
  ~/.claude/CLAUDE.md
    ✓ never force-push   kept 100% of 61            2 to confirm
    ○ clickup writes     never applied in 8 judged  ~30 tokens every session

  kept by context depth   0–100k   100–200k   200–400k   400k+
                             98%        97%        91%     84%

  1 rule no call or reply shows: heeded rules
  9 cases waiting for the judge, ~31k tokens: run heeded again
`;

test('the report at 80 columns: the names are cut to fit', () => {
  assert.equal(text(sketch, options), at80);
});

test('the report at 120 columns: names whole', () => {
  const rows = `
  CLAUDE.md
    ✗ failing test first            kept 80% of 20 judged      broken 4×    last 3 days ago
        nov 7   1a2b3c4d  call Edit: src/x.ts
    ✗ never git add -A              kept 95% of 214            broken 9×    last 2 days ago
        nov 8   19df6c20  git add -A && git commit -m "fix: …"
        nov 2   8c0e8fab  git add -A
        oct 29  4f1c22d0  git add -A
    ✗ always talk to me in italian  kept 96% of 3,812          broken 152×  last today
        after compaction kept 69% of 410
        nov 10  e7128125  en: "Sure — here's the plan for the …"
    ? never push to main            4 to confirm
    ○ never kill billing            never applied              ~40 tokens every session
  ~/.claude/CLAUDE.md
    ✓ never force-push              kept 100% of 61            2 to confirm
    ○ clickup writes                never applied in 8 judged  ~30 tokens every session
`;
  const at120 = at80.replace(`\n${rows80}`, rows);
  assert.notEqual(at120, at80);
  assert.equal(text(sketch, { ...options, columns: 120 }), at120);
});

test('in colour: the marks, and the evidence dimmed', () => {
  const coloured = at80.replace(/✗/g, '\x1b[31m✗\x1b[39m').replace('✓', '\x1b[32m✓\x1b[39m').replace(/○/g, '\x1b[2m○\x1b[22m')
    .replace('    ? ', '    \x1b[2m?\x1b[22m ')
    .replace(/^( {8}(?:nov|oct) .*)$/gm, '\x1b[2m$1\x1b[22m');
  assert.equal(text(sketch, { ...options, color: true }), coloured);
});

test('a judgment rule that never applied is listed with the never-applied rules; one still waiting or with no case is not', () => {
  const out = text(sketch, { ...options, columns: 120 });
  assert.match(out, /\n {4}○ never kill billing +never applied +~40 tokens every session\n/);
  assert.match(out, /\n {4}○ clickup writes +never applied in 8 judged +~30 tokens every session\n/);
  assert.doesNotMatch(out, /ask before spending|plan before coding/);
});

test('the end: the rules no case shows and those set aside, then the cases waiting, their tokens and what to do', () => {
  const end = (more: Partial<Report>) => text({ ...sketch, ...more }, options).split('\n\n').at(-1);
  assert.equal(end({}), '  1 rule no call or reply shows: heeded rules\n  9 cases waiting for the judge, ~31k tokens: run heeded again\n');
  assert.equal(end({ toJudge: 837, toJudgeTokens: 2_702_000, rules: [...sketch.rules, r('never rm', 'demoted', 0, 0)] }),
    '  1 rule no call or reply shows, 1 set aside: heeded rules\n'
    + '  837 cases waiting for the judge, ~2.7M tokens: heeded judges ~150k a run, heeded --all all of them\n');
});

test('nothing to read and no case waiting: the report says it is up to date, and how it keeps up', () => {
  const end = (more: Partial<Report>) => text({ ...sketch, ...more }, options).split('\n\n').at(-1)!;
  assert.equal(end({ toJudge: 0 }), '  1 rule no call or reply shows: heeded rules\n'
    + '  up to date: new sessions and changes to instruction files are read on the next run\n');
  assert.doesNotMatch(end({}), /up to date/);
  assert.doesNotMatch(end({ toJudge: 0, notRead: 2 }), /up to date/);
  assert.doesNotMatch(end({ toJudge: 0, toReread: 2 }), /up to date/);
});

test('tokens as heeded says them', () => {
  assert.deepEqual([106_000, 999_499, 999_500, 1_140_000, 2_702_000].map(approx), ['~106k', '~999k', '~1M', '~1.1M', '~2.7M']);
});

test("the rules under the file they are written in: the folder's files first, then the others; a file with nothing shown has no line", () => {
  const out = text(sketch, { ...options, columns: 120 });
  assert.match(out, /\n {2}CLAUDE\.md\n {4}✗ failing test first [^\n]+\n {8}nov 7 [^\n]+\n {4}✗ never git add -A [^\n]+\n {8}nov 8 [\s\S]*\n {4}○ never kill billing [^\n]+\n {2}~\/\.claude\/CLAUDE\.md\n {4}✓ never force-push [^\n]+\n {4}○ clickup writes /);
  assert.doesNotMatch(out, /web\/CLAUDE\.md/);
  // Columns line up across files.
  const at = (name: string) => out.split('\n').find((l) => l.includes(name))!.search(/(kept|never applied)/);
  assert.equal(at('never force-push'), at('never git add -A'));
});

test('a rule in several files is listed under the first the report lists; the folder\'s files, the shallowest first', () => {
  const root = '/home/someone/repos/billing/CLAUDE.md';
  const copy = '/home/someone/repos/billing/.claude/worktrees/w/CLAUDE.md';
  // Met first in the user's own file, then in a worktree's copy: both found again in the folder's own CLAUDE.md.
  const report = { ...sketch, files: [own, copy, root], toJudge: 0,
    rules: [r('never git add -A', 'kept', 3, 0, { files: [own, root], check: { language: 'it' } }),
      r('never force-push', 'kept', 2, 0, { files: [copy, root], check: { language: 'it' } })] };
  const out = text(report, { ...options, columns: 120 });
  assert.match(out, /\n {2}CLAUDE\.md\n {4}✓ never git add -A [^\n]+\n {4}✓ never force-push /);
  assert.doesNotMatch(out, /worktrees|~\/\.claude/);
  assert.match(rules(report, { color: false, home: '/home/someone' }), /\n {2}CLAUDE\.md\n {4}✓ never git add -A [^\n]+\n {4}✓ never force-push /);
});

// Each rule's line in the file it is listed under; 'never push to main' is in that file no longer (its line is in another).
const billing = '/home/someone/repos/billing/CLAUDE.md';
const where: Record<string, Record<string, number>> = { 'never git add -A': { [billing]: 12 },
  'always talk to me in italian': { [billing]: 3 }, 'never push to main': { [own]: 9 }, 'never kill billing': { [billing]: 140 },
  'failing test first': { [billing]: 27 }, 'never force-push': { [own]: 104 }, 'clickup writes': { [own]: 7 } };
const placed = (report: Report): Report => ({ ...report, rules: report.rules.map((x) => ({ ...x, lines: where[x.name] ?? {} })) });

test("each rule's line in its file after the mark, padded to the widest; none where the file no longer has its words", () => {
  const rows = `
  CLAUDE.md
    ✗ :27   failing test first            kept 80% of 20 judged      broken 4×    last 3 days ago
        nov 7   1a2b3c4d  call Edit: src/x.ts
    ✗ :12   never git add -A              kept 95% of 214            broken 9×    last 2 days ago
        nov 8   19df6c20  git add -A && git commit -m "fix: …"
        nov 2   8c0e8fab  git add -A
        oct 29  4f1c22d0  git add -A
    ✗ :3    always talk to me in italian  kept 96% of 3,812          broken 152×  last today
        after compaction kept 69% of 410
        nov 10  e7128125  en: "Sure — here's the plan for the …"
    ?       never push to main            4 to confirm
    ○ :140  never kill billing            never applied              ~40 tokens every session
  ~/.claude/CLAUDE.md
    ✓ :104  never force-push              kept 100% of 61            2 to confirm
    ○ :7    clickup writes                never applied in 8 judged  ~30 tokens every session
`;
  assert.equal(text(placed(sketch), { ...options, columns: 120 }), at80.replace(`\n${rows80}`, rows));
});

test('with lines, the names are cut to fit 80 columns, the lines whole', () => {
  const out = text(placed(sketch), options);
  for (const line of out.split('\n')) assert.ok(line.length <= 80, line);
  assert.match(out, /\n {4}✗ :12 {3}never git …  kept 95% of 214 /);
  assert.match(out, /\n {4}○ :140 {2}never kill…  never applied /);
  assert.match(text(placed(sketch), { ...options, color: true }), /\n {4}\x1b\[31m✗\x1b\[39m :12 {3}never git …/);
});

test("heeded rules: each rule's line in its file, the same way", () => {
  const lines = { 'never git add -A': { [local]: 8 }, 'always talk to me in italian': { [local]: 21 },
    'clickup is read-only': { '/home/someone/.claude/CLAUDE.md': 4 } } as Record<string, Record<string, number>>;
  const out = rules({ ...found, rules: found.rules.map((x) => ({ ...x, lines: lines[x.name] ?? {} })) },
    { color: false, home: '/home/someone' });
  assert.equal(out, listed.replace(/\n {4}(.) /g, (_, mark) => `\n    ${mark}      `)
    .replace('✓      never git add -A', '✓ :8   never git add -A')
    .replace('✓      always talk', '✓ :21  always talk')
    .replace('✓      clickup', '✓ :4   clickup'));
});

test("a judged rule's mark is its outcome, and so is its place: broken first, the least kept leading", () => {
  const report = { ...sketch, toJudge: 0, rules: [
    r('never git add -A', 'broken', 214, 9, { evidence: [seen('2026-11-08T12:00:00Z', '19df6c20', 'git add -A')] }),
    r('failing test first', 'judgment', 20, 4, { judged: 26, evidence: [
      { ...seen('2026-11-07T12:00:00Z', '1a2b3c4d', 'call Edit: src/x.ts'), quote: 'call Edit: src/x.ts' }] }),
    r('never force-push', 'kept', 61, 0),
    r('say what you changed', 'judgment', 70, 0, { judged: 70 }),
    r('never push to main', 'to-confirm', 0, 0, { toJudge: 4 }),
    r('plan before coding', 'judgment', 0, 0, { judged: 8 }),
  ] };
  const out = text(report, { ...options, columns: 120 });
  const rows = out.split('\n').filter((l) => /^ {4}\S/.test(l)).map((l) => l.trim().replace(/ {2,}.*/, ''));
  assert.deepEqual(rows, ['✗ failing test first', '✗ never git add -A', '✓ say what you changed', '✓ never force-push',
    '? never push to main', '○ plan before coding']);
  assert.match(out, /✗ failing test first +kept 80% of 20 judged +broken 4×/);
  assert.match(text(report, { ...options, columns: 120, color: true }), /\x1b\[31m✗\x1b\[39m failing test first/);
});

test('no transcripts: one line naming the folder and the config dir', () => {
  assert.equal(text(empty, options), '\n  no claude code transcripts for ~/repos/app in ~/.claude\n');
});

test('sessions without instruction files: one line', () => {
  assert.equal(text({ ...empty, sessions: 3, from: '2026-11-10T12:00:00Z', to: '2026-11-10T12:00:00Z' }, options),
    '\n  ~/repos/app · 3 sessions, 0 subagents · nov 10\n  no instructions recorded\n');
});

test('transcripts not recognized, and sections not read yet: one line each', () => {
  const out = text({ ...sketch, unrecognized: ['a.jsonl', 'b.jsonl'], notRead: 14, toReread: 3 }, options);
  assert.ok(out.endsWith('  1 rule no call or reply shows: heeded rules\n'
    + '  14 sections not read yet: their rules aren\'t checked until heeded reads them\n'
    + '  3 sections to read again: their rules from before count meanwhile\n'
    + '  9 cases waiting for the judge, ~31k tokens: run heeded again\n'
    + '  2 transcripts unrecognized: claude code may have changed its format\n'), out);
});

test('the edges: 1% when a case was kept, – under 20 cases, yesterday, one of each, demoted rules', () => {
  const out = text({ ...sketch, sessions: 1, subagents: 1, files: ['/home/someone/repos/billing/CLAUDE.md'], toJudge: 0,
    rules: [r('never sudo', 'broken', 1000, 999, { evidence: [seen('2026-11-09T12:00:00Z', 'aaaaaaaa', 'sudo ls')] }),
      r('failing test first', 'judgment', 0, 0, { reason: 'no case to judge it on' }), r('never rm', 'demoted', 0, 0)],
    byDepth: buckets([[1000, 999], [19, 0], [0, 0], [0, 0]]) }, options);
  assert.equal(out, `
  ~/repos/billing · 1 session, 1 subagent · oct 11 – nov 10
  1 file · 3 rules · 1 checked · 1 need a judge · 1 set aside

  CLAUDE.md
    ✗ never sudo  kept 1% of 1,000  broken 999×  last yesterday
        nov 9   aaaaaaaa  sudo ls

  kept by context depth   0–100k   100–200k   200–400k   400k+
                              1%          –          –       –

  1 rule no call or reply shows, 1 set aside: heeded rules
  up to date: new sessions and changes to instruction files are read on the next run
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

  CLAUDE.local.md
    ✓ never git add -A              Bash command  when \\bgit\\s+add\\b  broken \\s(-A|--all)\\b
    ✓ always talk to me in italian  language it
    · failing test first            needs a judge, no cases: no case to judge it on
    ! never kill billing            failed its examples: keeps "pkill -f billingd-test"
  ~/.claude/CLAUDE.md
    ✓ clickup is read-only          tool mcp__.*clickup.*  broken tool _(create|update|delete)_  ignoring case
`;

test('heeded rules: by file, each rule under the first file that has it, with how it is checked, whole', () => {
  assert.equal(rules(found, { color: false, home: '/home/someone' }), listed);
});

test('heeded rules in colour: the marks', () => {
  assert.equal(rules(found, { color: true, home: '/home/someone' }),
    listed.replace(/✓/g, '\x1b[32m✓\x1b[39m').replace('    · ', '    \x1b[2m·\x1b[22m ').replace('!', '\x1b[33m!\x1b[39m'));
});

test('one section not read yet, or to read again: its rules', () => {
  assert.ok(text({ ...sketch, notRead: 1, toReread: 1 }, options).includes(
    '  1 section not read yet: its rules aren\'t checked until heeded reads it\n'
    + '  1 section to read again: its rules from before count meanwhile\n'));
});

test('heeded rules with sections not read yet, or to read again, says so', () => {
  assert.ok(rules({ ...found, notRead: 2, toReread: 1 }, { color: false, home: '/home/someone' })
    .endsWith(`${listed}\n  2 sections not read yet: their rules aren't checked until heeded reads them\n`
      + '  1 section to read again: its rules from before count meanwhile\n'));
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
