import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Check, compile, counter, culprit, type Data, language, verdict } from '../src/check.ts';
import type { Event } from '../src/claude-code.ts';
import { type Rule, sections, type Version, verify } from '../src/rules.ts';

function compiled(check: Check) {
  const c = compile(check);
  assert.ok(typeof c !== 'string', c as string);
  return c;
}

const gitAdd: Check = {
  field: 'command',
  when: { tool: '^Bash$', value: '\\bgit\\s+add\\b' },
  broken: { value: '\\s(-A|--all)\\b' },
  ignoreCase: false,
};

test('a tool check: applies to its tool and value, broken by its broken pattern', () => {
  const c = compiled(gitAdd);
  const bash = (command: string) => verdict(c, 'Bash', { command });
  assert.equal(bash('git add -A'), 'broken');
  assert.equal(bash('git add --all && git commit'), 'broken');
  assert.equal(bash('git add src/a.ts'), 'kept');
  assert.equal(bash('git add -p'), 'kept');
  assert.equal(bash('ls -A'), 'none');
  assert.equal(verdict(c, 'Edit', { command: 'git add -A' }), 'none');
  assert.equal(verdict(c, 'Bash', {}), 'none');
  assert.equal(verdict(c, 'Bash', { command: 42 }), 'none');
});

test('a check on the tool name alone', () => {
  const c = compiled({ when: { tool: 'mcp__.*clickup.*' }, broken: { tool: '_(create|update|delete)_' } });
  assert.equal(verdict(c, 'mcp__clickup__create_task', { name: 'x' }), 'broken');
  assert.equal(verdict(c, 'mcp__clickup__get_task', { id: '1' }), 'kept');
  assert.equal(verdict(c, 'Bash', { command: 'clickup_create_' }), 'none');
});

test('case is ignored only when the check says so', () => {
  const check = { field: 'command', when: { tool: '^Bash$' }, broken: { value: 'git push --force' } };
  assert.equal(verdict(compiled({ ...check, ignoreCase: true }), 'Bash', { command: 'GIT PUSH --FORCE' }), 'broken');
  assert.equal(verdict(compiled(check), 'Bash', { command: 'GIT PUSH --FORCE' }), 'kept');
});

test('the same call gets the same verdict every time', () => {
  const c = compiled(gitAdd);
  for (let i = 0; i < 3; i++) assert.equal(verdict(c, 'Bash', { command: 'git add -A' }), 'broken');
});

test('a shell command is checked one simple command at a time, on what it does', () => {
  const kill = compiled({ field: 'command', when: { tool: '^Bash$' }, broken: { value: '\\b(kill|pkill|killall)\\b.*billingd' } });
  const store = compiled({ field: 'command', when: { tool: '^Bash$' }, broken: { value: 'store-submit' } });
  const force = compiled({ field: 'command', when: { tool: '^Bash$', value: '\\bgit\\s+push\\b' }, broken: { value: '\\s(--force|-f)\\b' } });
  const bash = (c: ReturnType<typeof compiled>, command: string) => verdict(c, 'Bash', { command });
  assert.equal(bash(kill, "cat > t.ts <<'EOF'\ntest('kill billingd', () => {});\nEOF"), 'kept');
  assert.equal(bash(kill, 'echo "pkill billingd" >> notes.md'), 'kept');
  assert.equal(bash(store, 'grep -n "store-submit" docs/*.md'), 'kept');
  assert.equal(bash(force, 'git commit -m "never --force"'), 'none');
  assert.equal(bash(force, 'git push && rm -f x'), 'kept');
  assert.equal(bash(kill, 'pkill billingd'), 'broken');
  assert.equal(bash(kill, "ssh host 'pkill billingd'"), 'broken');
  assert.equal(bash(force, 'git push --force'), 'broken');
  assert.equal(bash(force, 'cd x && git push -f origin main'), 'broken');
  assert.equal(culprit(force, 'Bash', { command: 'cd x && git push -f origin main' }), 'git push -f origin main');
});

test('what a command carries is checked with data patterns: a commit message, in both forms', () => {
  const coauthor = compiled({ field: 'command', when: { tool: '^Bash$', value: '^git\\s+commit\\b' }, broken: { data: 'Co-Authored-By' } });
  const bash = (command: string) => verdict(coauthor, 'Bash', { command });
  assert.equal(bash('git commit -m "fix: x\n\nCo-Authored-By: Claude"'), 'broken');
  assert.equal(bash(`git commit -m "$(cat <<'EOF'\nfix: x\n\nCo-Authored-By: Claude\nEOF\n)"`), 'broken');
  assert.equal(bash('git commit -m "fix: x"'), 'kept');
  assert.equal(bash('echo "Co-Authored-By: Claude"'), 'none');
  assert.equal(culprit(coauthor, 'Bash', { command: `git commit -m "$(cat <<'EOF'\nfix: x\n\nCo-Authored-By: Claude\nEOF\n)"` }),
    'git commit -m "$(cat <<EOF\n)" fix: x\n\nCo-Authored-By: Claude');
  assert.equal(compile({ field: 'command', broken: { data: '(a+)+' } }), 'regex may take exponential time: (a+)+');
});

test('a field other than command is matched whole, as written', () => {
  const env = compiled({ field: 'file_path', when: { tool: '^(Edit|Write)$' }, broken: { value: '\\.env$' } });
  assert.equal(verdict(env, 'Write', { file_path: '/a/b && c/.env' }), 'broken');
  assert.equal(culprit(env, 'Write', { file_path: '/a/b && c/.env' }), '/a/b && c/.env');
});

test('a value is matched on its first 4,096 characters', () => {
  const c = compiled(gitAdd);
  assert.equal(verdict(c, 'Bash', { command: `git add ${'x'.repeat(4080)} -A` }), 'broken');
  assert.equal(verdict(c, 'Bash', { command: `git add ${'x'.repeat(4090)} -A` }), 'kept');
});

test("a pattern that doesn't compile is refused, with the pattern", () => {
  assert.equal(compile({ ...gitAdd, broken: { value: '(-A' } }), "regex doesn't compile: (-A");
  assert.equal(compile({ ...gitAdd, when: { tool: '[Bash' } }), "regex doesn't compile: [Bash");
});

test('a repeated group holding a quantifier or an alternation is refused: it can take exponential time', () => {
  for (const p of ['(a+)+', '(\\w+\\s?)*', '(x{2,})+', '((a+))+$', '(a|a)+$', '(?:(b)*c)+']) {
    assert.equal(compile({ ...gitAdd, broken: { value: p } }), `regex may take exponential time: ${p}`);
  }
  for (const p of ['(?:ab)+', '\\(a+\\)+', '--force\\b|\\-f\\b', '([+-]\\d)+', '(-A|--all)', '[(+]+']) {
    assert.equal(typeof compile({ ...gitAdd, broken: { value: p } }), 'object', p);
  }
});

test('a check nothing can break is refused', () => {
  assert.equal(compile({ field: 'command', when: { tool: '^Bash$' } }), 'no broken pattern');
  assert.equal(compile({ field: 'command', when: { tool: '^Bash$' }, broken: {} }), 'no broken pattern');
});

const replies: [string, string][] = [
  ['en', 'I checked the failing test and the problem is in the parser. It reads the whole file into memory, so it breaks on large inputs. I will change it to stream the lines and run the tests again.'],
  ['it', 'Ho controllato il test che fallisce e il problema è nel parser. Legge tutto il file in memoria, quindi si rompe con input grandi. Adesso lo cambio per leggere le righe una alla volta e poi rilancio i test.'],
  ['es', 'He revisado la prueba que falla y el problema está en el analizador. Lee todo el archivo en memoria, así que se rompe con entradas grandes. Ahora lo cambio para leer las líneas una por una y vuelvo a ejecutar las pruebas.'],
  ['fr', 'J\'ai vérifié le test qui échoue et le problème est dans l\'analyseur. Il lit tout le fichier en mémoire, donc il casse avec de grandes entrées. Je vais le changer pour lire les lignes une par une et relancer les tests.'],
  ['de', 'Ich habe den fehlschlagenden Test geprüft und das Problem liegt im Parser. Er liest die ganze Datei in den Speicher, deshalb bricht er bei großen Eingaben. Ich ändere es jetzt so, dass die Zeilen einzeln gelesen werden, und starte die Tests neu.'],
  ['pt', 'Verifiquei o teste que falha e o problema está no analisador. Ele lê o arquivo inteiro na memória, então quebra com entradas grandes. Agora vou mudar para ler as linhas uma de cada vez e rodar os testes de novo.'],
];

for (const [code, text] of replies) {
  test(`a reply in ${code}`, () => {
    assert.equal(language(text), code);
  });
}

test('code, URLs and paths are not words: an Italian reply around English code is Italian', () => {
  const text = 'Ho sistemato il parser in `src/claude-code.ts`: adesso legge le righe una alla volta, quindi non carica più tutto '
    + 'il file in memoria. Ecco la parte che è cambiata:\n```ts\n// read the file line by line so that the whole of it is '
    + 'never in memory at once, which is what the old code did when it was given a large file to read\nfor await (const '
    + 'line of lines(path)) yield line;\n```\nVedi https://nodejs.org/api/fs.html and the docs at /Users/someone/the/project/'
    + 'is/where/it/is/and/what/it/does';
  assert.equal(language(text), 'it');
});

test('half English, half Italian: no verdict', () => {
  const text = 'I checked the failing test and the problem is in the parser. Ho controllato il test che fallisce e il problema è nel parser.';
  assert.equal(language(text), null);
});

test('under 20 words: no verdict', () => {
  assert.equal(language('Ho controllato il test che fallisce e il problema è nel parser, ora lo sistemo.'), null);
});

test('a reply that is mostly a command: no verdict', () => {
  assert.equal(language('Run this:\n\n```sh\nnpm install && npm run build && npm test -- --watch\n```\n\nthen `git status` in /Users/x/repo.'), null);
});

test('words shared by languages tell none apart: a Spanish reply full of them is still Spanish', () => {
  const text = 'Creo que no es para hoy: lo que pasa es que el código de la parte de arriba no se carga, y por eso la página se '
    + 'queda en blanco cuando la abres desde el móvil.';
  assert.equal(language(text), 'es');
});

test('a reply of names and terms with few common words: no verdict', () => {
  const text = 'Parser sistemato: test verdi, build pulita, lint ok, typecheck ok, budget rispettati, pacchetto piccolo, avvio '
    + 'rapido, memoria bassa, throughput alto, tutto pronto per la review.';
  assert.equal(language(text), null);
});

// Counting: events fed in, as the adapter emits them, over rules verified from their own quotes.
const rule = (raw: Record<string, unknown>) => verify(raw, sections(raw.quote as string)[0])!;
const bashRule = (quote: string, name: string, broken: string, breaking: string, keeping: string) => rule({
  quote, name, kind: 'tool', trigger: 'running commands',
  check: { field: 'command', when: { tool: '^Bash$' }, broken: { value: broken } },
  breaking: [{ tool: 'Bash', value: breaking }], keeping: [{ tool: 'Bash', value: keeping }],
});
const addAll = rule({
  quote: 'never `git add -A`', name: 'never git add -A', kind: 'tool', trigger: 'staging files with git',
  check: { field: 'command', when: { tool: '^Bash$', value: '\\bgit\\s+add\\b' }, broken: { value: '\\s(-A|--all)\\b' } },
  breaking: [{ tool: 'Bash', value: 'git add -A' }], keeping: [{ tool: 'Bash', value: 'git add a.ts' }],
});
const italian = rule({ quote: 'talk to the user in italian', name: 'talk in italian', kind: 'language', trigger: 'replying',
  check: { language: 'it' } });
const IT = 'Ho controllato il test che fallisce e il problema è nel parser. Legge tutto il file in memoria, quindi si rompe con '
  + 'input grandi. Adesso lo cambio per leggere le righe una alla volta e poi rilancio i test.';
const EN = 'I checked the failing test and the problem is in the parser. It reads the whole file into memory, so it breaks '
  + 'on large inputs. I will change it to stream the lines and run the tests again.';

/** Files are named by their content: `rulesBy[content]` holds what rulesOf gives for it. */
function count(events: Event[], rulesBy: Record<string, Rule[]>, versionsBy: Record<string, Version[]> = {}): Data {
  const c = counter((f) => (f.type === 'AutoMem' ? null : { rules: rulesBy[f.content] ?? [], versions: versionsBy[f.content] ?? [] }));
  for (const e of events) c.on(e);
  return c.result();
}
const start = (session = 's1', agent: string | null = null): Event => ({ kind: 'transcript', session, agent });
const files = (paths: Record<string, string>, replace = false): Event =>
  ({ kind: 'instructions', files: Object.entries(paths).map(([path, content]) => ({ path, type: 'Project', content })), replace });
let ids = 0;
type When = { id?: string; at?: string; depth?: number; compactions?: number };
const bash = (command: string, w: When = {}): Event => ({ kind: 'call', id: w.id ?? `tu${++ids}`, tool: 'Bash', input: { command },
  at: w.at ?? '2026-11-02T10:00:00Z', depth: w.depth ?? 0, compactions: w.compactions ?? 0 });
const reply = (text: string, w: When = {}): Event => ({ kind: 'reply', id: w.id ?? `m${++ids}`, text,
  at: w.at ?? '2026-11-02T10:00:00Z', depth: w.depth ?? 0, compactions: w.compactions ?? 0 });
const counts = (data: Data, r: Rule) => {
  const found = data.rules.find((x) => x.id === r.id);
  return found && { status: found.status, applied: found.applied, broken: found.broken };
};

test('a tool rule: the calls it applies to, and the ones that broke it', () => {
  const data = count([start(), files({ '/r/CLAUDE.md': 'A' }), bash('git add -A'), bash('git add a.ts'), bash('ls')], { A: [addAll] });
  assert.deepEqual(counts(data, addAll), { status: 'broken', applied: 2, broken: 1 });
});

test('a language rule: replies of 20 words or more, never calls', () => {
  const data = count([start(), files({ '/r/CLAUDE.md': 'A' }), reply(IT), reply(EN), reply('ok, fatto.'), bash('git add -A')],
    { A: [italian] });
  assert.deepEqual(counts(data, italian), { status: 'broken', applied: 2, broken: 1 });
});

test('the rules in effect follow the files: an edit from that point, a replace drops files not sent again, a nested file adds', () => {
  const data = count([
    start(), files({ '/r/CLAUDE.md': 'A' }), bash('git add -A'),
    files({ '/r/CLAUDE.md': 'none' }), bash('git add -A'),
    files({ '/r/sub/CLAUDE.md': 'A' }), bash('git add -A'),
    files({ '/r/CLAUDE.local.md': 'B' }, true), bash('git add -A'), reply(IT),
  ], { A: [addAll], B: [italian] });
  assert.deepEqual(counts(data, addAll), { status: 'broken', applied: 2, broken: 2 });
  assert.deepEqual(counts(data, italian), { status: 'kept', applied: 1, broken: 0 });
});

test('a subagent that recorded no instructions counts nothing; a new session starts with none', () => {
  const data = count([start('s1'), files({ '/r/CLAUDE.md': 'A' }), bash('git add -A'), start('s1', 'x1'), bash('git add -A'),
    start('s2'), bash('git add -A')], { A: [addAll] });
  assert.deepEqual(counts(data, addAll), { status: 'broken', applied: 1, broken: 1 });
});

test('a call or a reply copied into another transcript (a resumed or forked session) counts once', () => {
  const events = (s: string) => [start(s), files({ '/r/CLAUDE.md': 'A' }), bash('git add -A', { id: 'tu-x' }), reply(EN, { id: 'm-x' })];
  const data = count([...events('s1'), ...events('s2')], { A: [addAll, italian] });
  assert.deepEqual(counts(data, addAll), { status: 'broken', applied: 1, broken: 1 });
  assert.deepEqual(counts(data, italian), { status: 'broken', applied: 1, broken: 1 });
});

test('after compaction, and by context depth: per rule and summed', () => {
  const data = count([start(), files({ '/r/CLAUDE.md': 'A' }),
    bash('git add -A', { depth: 50_000 }), bash('git add a.ts', { depth: 150_000, compactions: 1 }),
    bash('git add -A', { depth: 300_000, compactions: 1 }), bash('git add --all', { depth: 450_000, compactions: 2 }),
    reply(IT, { depth: 99_999 }), reply(EN, { depth: 100_000 })], { A: [addAll, italian] });
  const r = data.rules.find((x) => x.id === addAll.id)!;
  assert.deepEqual(r.afterCompaction, { applied: 3, broken: 2 });
  assert.deepEqual(r.byDepth, [
    { from: 0, to: 100_000, applied: 1, broken: 1 }, { from: 100_000, to: 200_000, applied: 1, broken: 0 },
    { from: 200_000, to: 400_000, applied: 1, broken: 1 }, { from: 400_000, to: null, applied: 1, broken: 1 },
  ]);
  assert.deepEqual(data.byDepth, [
    { from: 0, to: 100_000, applied: 2, broken: 1 }, { from: 100_000, to: 200_000, applied: 2, broken: 1 },
    { from: 200_000, to: 400_000, applied: 1, broken: 1 }, { from: 400_000, to: null, applied: 1, broken: 1 },
  ]);
});

test('evidence of each violation: latest first, one line, secrets redacted, with its session and agent', () => {
  const key = `sk-${'ant-api03-Zx9_Qw8-Er7Ty6Ui5Op4'}`;
  const long = `git add -A ${'x'.repeat(300)}`;
  const data = count([start('s1'), files({ '/r/CLAUDE.md': 'A' }),
    bash(`git add -A &&\n  echo ${key}`, { at: '2026-11-02T10:00:00Z' }), reply(EN, { at: '2026-11-03T09:00:00Z' }),
    bash(long, { at: '2026-11-01T10:00:00Z' }), bash('git add a.ts'),
    start('s1', 'x1'), files({ '/r/CLAUDE.md': 'A' }), bash('git add --all', { at: '2026-11-04T08:00:00Z' })],
  { A: [addAll, italian] });
  assert.deepEqual(data.rules.find((r) => r.id === addAll.id)!.evidence, [
    { at: '2026-11-04T08:00:00Z', session: 's1', agent: 'x1', text: 'git add --all' },
    { at: '2026-11-02T10:00:00Z', session: 's1', agent: null, text: 'git add -A' },
    { at: '2026-11-01T10:00:00Z', session: 's1', agent: null, text: `${long.slice(0, 200)}…` },
  ]);
  assert.deepEqual(data.rules.find((r) => r.id === italian.id)!.evidence, [
    { at: '2026-11-03T09:00:00Z', session: 's1', agent: null, text: 'en: "I checked the failing test and the problem …"' },
  ]);
});

const gitRule = (quote: string, when: string, broken: string, breaking: string, keeping: string) => rule({
  quote, name: quote, kind: 'tool', trigger: 'running commands',
  check: { field: 'command', when: { tool: '^Bash$', value: when }, broken: { value: broken } },
  breaking: [{ tool: 'Bash', value: breaking }], keeping: [{ tool: 'Bash', value: keeping }],
});

test("each rule's status, in the report's order: broken by kept share, kept, never applied, judgment, demoted", () => {
  const push = gitRule('never force-push', '\\bgit\\s+push\\b', '--force', 'git push --force', 'git push');
  const rm = gitRule('never rm -rf', '\\brm\\b', '-rf', 'rm -rf /', 'rm a.txt');
  const kill = gitRule('never kill billing', '\\bkill\\b', 'billing', 'kill -9 billing', 'kill 42');
  const judge = rule({ quote: 'write a failing test first', name: 'failing test first', kind: 'judgment', trigger: 'coding' });
  const demoted = bashRule('never sudo', 'never sudo', '^sudo', 'please sudo', 'ls');
  const data = count([start(), files({ '/r/CLAUDE.md': 'A' }), bash('git push'), bash('git push --force'), bash('rm a.txt'),
    bash('git add -A')], { A: [judge, demoted, kill, rm, push, addAll] });
  assert.deepEqual(data.rules.map((r) => [r.name, r.status, r.reason]), [
    ['never git add -A', 'broken', undefined], ['never force-push', 'broken', undefined], ['never rm -rf', 'kept', undefined],
    ['never kill billing', 'never-applied', undefined], ['failing test first', 'judgment', undefined],
    ['never sudo', 'demoted', 'failed its examples: breaks "please sudo"'],
  ]);
  assert.equal(data.rules[3].tokens, 5);
});

test('the same rule in two files is one rule, from both files', () => {
  const data = count([start(), files({ '/r/CLAUDE.md': 'A', '/r/.claude/worktrees/w/CLAUDE.md': 'A2' }), bash('git add -A')],
    { A: [addAll], A2: [addAll] });
  assert.equal(data.rules.length, 1);
  assert.deepEqual(data.rules[0].files, ['/r/CLAUDE.md', '/r/.claude/worktrees/w/CLAUDE.md']);
  assert.deepEqual(counts(data, addAll), { status: 'broken', applied: 1, broken: 1 });
});

test('the totals: sections not read yet, the files measured, sessions and subagents that did something, the span', () => {
  const missing = [{ path: [], text: 'a', hash: 'h1' }, { path: [], text: 'b', hash: 'h2' }];
  const memory: Event = { kind: 'instructions', files: [{ path: '/m/MEMORY.md', type: 'AutoMem', content: 'E' }], replace: false };
  const data = count([start('s1'), files({ '/r/CLAUDE.md': 'A', '/r/CLAUDE.local.md': 'M', '/r/sub/CLAUDE.md': 'none' }), memory,
    bash('ls', { at: '2026-11-03T10:00:00Z' }), start('s1', 'x1'), files({ '/r/CLAUDE.local.md': 'M' }),
    reply('ok', { at: '2026-11-01T09:00:00Z' }), start('s1', 'x2'), start('s2'), bash('ls', { at: '2026-11-05T08:00:00Z' }),
    start('s3'), files({ '/r/CLAUDE.md': 'A' })],
  { A: [addAll] }, { M: missing.map((section) => ({ section, identity: section.hash, read: false, readAt: null })) });
  assert.deepEqual({ ...data, rules: undefined, byDepth: undefined }, { rules: undefined, byDepth: undefined, notRead: 2,
    files: ['/r/CLAUDE.md', '/r/CLAUDE.local.md', '/r/sub/CLAUDE.md'], sessions: 2, subagents: 1,
    from: '2026-11-01T09:00:00Z', to: '2026-11-05T08:00:00Z' });
});

test('evidence never reads undefined, and holds no control characters', () => {
  const mcp = rule({ quote: 'clickup is read-only', name: 'clickup is read-only', kind: 'tool', trigger: 'clickup',
    check: { field: 'name', when: { tool: '^mcp__clickup__' }, broken: { tool: '_create_' } },
    breaking: [{ tool: 'mcp__clickup__create_task', value: 'x' }], keeping: [{ tool: 'mcp__clickup__get_task', value: 'x' }] });
  const data = count([start(), files({ '/r/CLAUDE.md': 'A' }), bash('git add -A\x1b[2J', { at: '2026-11-02T10:00:00Z' }),
    { kind: 'call', id: 'c1', tool: 'mcp__clickup__create_task', input: {}, at: '2026-11-01T10:00:00Z', depth: 0, compactions: 0 }],
  { A: [addAll, mcp] });
  assert.equal(data.rules.find((r) => r.id === addAll.id)!.evidence[0].text, 'git add -A [2J');
  assert.equal(data.rules.find((r) => r.id === mcp.id)!.evidence[0].text, 'mcp__clickup__create_task');
});

test('a quoted block is not the reply: an Italian reply quoting a long English passage is Italian', () => {
  const quote = '> I checked the failing test and the problem is in the parser. It reads the whole file into memory, so it\n'
    + '> breaks on large inputs. I will change it to stream the lines and run the tests again, and then I will update\n'
    + '> the changelog with the fix and the new limits, so that the people who use it know what to expect from it.';
  const reply = 'Ho scritto la nota per il changelog della nuova versione e ho messo anche questa parte, che non è ancora '
    + `nel commit: dimmi se ti piace così.\n\n${quote}\n\nSe vuoi la cambio.`;
  assert.equal(language(reply), 'it');
});

// Which sections to ask about: per section, the version in effect latest, unless it was read or a later one was.
const version = (text: string, identity: string, readAt: string | null = null, read = false): Version =>
  ({ section: { path: [], text, hash: text }, identity, read, readAt });
const unread = version;
function asked(events: Event[], versionsBy: Record<string, Version[]>) {
  const c = counter((f) => ({ rules: [], versions: versionsBy[f.content] ?? [] }));
  for (const e of events) c.on(e);
  return { pending: c.pending().map((p) => [p.section.text, p.at]), notRead: c.result().notRead };
}

test('of the versions of a section not read, only the one in effect latest is asked about', () => {
  assert.deepEqual(asked([start('s1'), files({ '/r/CLAUDE.md': 'A1' }), bash('ls', { at: '2026-11-01T10:00:00Z' }),
    start('s2'), files({ '/r/CLAUDE.md': 'A2' }), bash('ls', { at: '2026-11-03T10:00:00Z' }),
    start('s3'), files({ '/r/CLAUDE.md': 'A1' }), bash('ls', { at: '2026-11-02T10:00:00Z' })],
  { A1: [unread('v1', 'id')], A2: [unread('v2', 'id')] }), { pending: [['v2', '2026-11-03T10:00:00Z']], notRead: 1 });
});

test('nothing is asked when a version read was in effect as late; a version never in effect during a call is the oldest', () => {
  assert.deepEqual(asked([start(), files({ '/r/CLAUDE.md': 'A1' }), bash('ls', { at: '2026-11-01T10:00:00Z' })],
    { A1: [unread('v1', 'id', '2026-11-05T00:00:00Z')] }), { pending: [], notRead: 0 });
  assert.deepEqual(asked([start(), files({ '/r/CLAUDE.md': 'A1' })], { A1: [unread('v1', 'id')] }),
    { pending: [['v1', '']], notRead: 1 });
  assert.deepEqual(asked([start(), files({ '/r/CLAUDE.md': 'A1' })], { A1: [unread('v1', 'id', '')] }), { pending: [], notRead: 0 });
});

test('a rule on the start of a commit message holds in both commit forms', () => {
  const conventional = compiled({ field: 'command', when: { tool: '^Bash$', value: '\\bgit\\s+commit\\b', data: '\\S' },
    broken: { data: '^(?!(feat|fix|perf|chore|test|docs)(\\([^)]*\\))?: )' } });
  const bash = (command: string) => verdict(conventional, 'Bash', { command });
  assert.equal(bash('git commit -m "feat: add x"'), 'kept');
  assert.equal(bash(`git commit -m "$(cat <<'EOF'\nfeat: add x\n\nwhy it matters\nEOF\n)"`), 'kept');
  assert.equal(bash('git commit -m "update stuff"'), 'broken');
  assert.equal(bash(`git commit -m "$(cat <<'EOF'\nupdate stuff\nEOF\n)"`), 'broken');
  assert.equal(bash('git commit --amend --no-edit'), 'none');
});

test('a version read and in effect later than one not read: nothing is asked (a branch switched back)', () => {
  assert.deepEqual(asked([start('s1'), files({ '/r/CLAUDE.md': 'A' }), bash('ls', { at: '2026-11-01T10:00:00Z' }),
    start('s2'), files({ '/r/CLAUDE.md': 'B' }), bash('ls', { at: '2026-11-02T10:00:00Z' }),
    start('s3'), files({ '/r/CLAUDE.md': 'A' }), bash('ls', { at: '2026-11-03T10:00:00Z' })],
  { A: [version('va', 'id', '2026-11-01T10:00:00Z', true)], B: [unread('vb', 'id', '2026-11-01T10:00:00Z')] }), { pending: [], notRead: 0 });
});

test('the same text under two paths is one section to read', () => {
  const c = counter((f) => ({ rules: [], versions: [version('same', f.path)] }));
  for (const e of [start(), files({ '/r/CLAUDE.md': 'A', '/r/.claude/worktrees/w/CLAUDE.md': 'A' }), bash('ls')]) c.on(e);
  assert.equal(c.pending().length, 2);
  assert.equal(c.result().notRead, 1);
});
