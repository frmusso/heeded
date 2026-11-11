import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applies, type Check, compile, counter, culprit, type Data, language, sequence, verdict, walk } from '../src/check.ts';
import type { Event } from '../src/claude-code.ts';
import type { Verdict } from '../src/judge.ts';
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

test('a check with only a when compiles: it finds the calls it is about', () => {
  const c = compiled({ field: 'command', when: { tool: '^Bash$', value: '(^|\\s)git\\s+commit(\\s|$)' } });
  assert.equal(applies(c, 'Bash', { command: 'git commit -m x' }), true);
  assert.equal(applies(c, 'Bash', { command: 'git status' }), false);
  assert.equal(applies(c, 'Edit', { command: 'git commit -m x' }), false);
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

/** The judge, as most tests want it: every case confirmed broken. */
// Sequence rules: a call that must come before the ones a rule is about, or follow them before the turn ends.
const readFirst: Check = { field: 'file_path', when: { tool: '^(Edit|Write)$', value: '/shared/context/' },
  first: { field: 'file_path', tool: '^Read$', value: 'shared/CLAUDE\\.md$' } };
const buildAfter: Check = { field: 'file_path', when: { tool: '^(Edit|Write)$', value: '/src/' },
  then: { field: 'command', tool: '^Bash$', value: '(^|\\s)npm\\s+run\\s+build(\\s|$)' } };
function steps(check: Check) {
  const s = sequence(check);
  assert.ok(typeof s !== 'string', s as string);
  return walk<string>(s);
}
const edit = (file_path: string) => ['Edit', { file_path }] as const;

test("a sequence rule's first: kept when it came earlier in the session; the call alone breaks it", () => {
  const w = steps(readFirst);
  assert.deepEqual(w.call(...edit('/r/shared/context/a.md'), 'e1'), [{ item: 'e1', broken: true }]);
  assert.deepEqual(w.call('Read', { file_path: '/r/shared/CLAUDE.md' }, 'r1'), []);
  assert.deepEqual(w.call(...edit('/r/shared/context/b.md'), 'e2'), [{ item: 'e2', broken: false }]);
  assert.deepEqual(w.call(...edit('/r/src/x.ts'), 'e3'), []);
  // A turn ending changes nothing: the first counts for the whole session.
  assert.deepEqual(w.end(), []);
  assert.deepEqual(w.call(...edit('/r/shared/context/c.md'), 'e4'), [{ item: 'e4', broken: false }]);
});

test('a call that is both the first and a call the rule is about never keeps itself', () => {
  const w = steps({ field: 'command', when: { tool: '^Bash$', value: '(^|\\s)git\\s+commit(\\s|$)' },
    first: { field: 'command', tool: '^Bash$', value: '(^|\\s)git\\s+(status|commit)(\\s|$)' } });
  assert.deepEqual(w.call('Bash', { command: 'git commit -m a' }, 'c1'), [{ item: 'c1', broken: true }]);
  assert.deepEqual(w.call('Bash', { command: 'git commit -m b' }, 'c2'), [{ item: 'c2', broken: false }]);
});

test("a sequence rule's then: kept when it follows before the turn ends; the ones still waiting at the end break it", () => {
  const w = steps(buildAfter);
  assert.deepEqual(w.call(...edit('/r/src/a.ts'), 'a'), []);
  assert.deepEqual(w.call(...edit('/r/src/b.ts'), 'b'), []);
  assert.deepEqual(w.call('Bash', { command: 'npm run build' }, 'x'), [{ item: 'a', broken: false }, { item: 'b', broken: false }]);
  assert.deepEqual(w.call(...edit('/r/src/c.ts'), 'c'), []);
  assert.deepEqual(w.end(), ['c']);
  // A then in the next turn keeps nothing of the last.
  assert.deepEqual(w.call('Bash', { command: 'npm run build' }, 'y'), []);
});

test('a call copied from an earlier session moves the walk on but is no case again', () => {
  const w = steps(readFirst);
  assert.deepEqual(w.call(...edit('/r/shared/context/a.md'), null), []);
  assert.deepEqual(w.call('Read', { file_path: '/r/shared/CLAUDE.md' }, null), []);
  assert.deepEqual(w.call(...edit('/r/shared/context/b.md'), 'e'), [{ item: 'e', broken: false }]);
  const t = steps(buildAfter);
  assert.deepEqual(t.call(...edit('/r/src/a.ts'), null), []);
  assert.deepEqual(t.end(), []);
});

test("a sequence check that can't be used says why", () => {
  assert.equal(sequence({ field: 'file_path', first: readFirst.first }), 'no calls it is about (when)');
  assert.equal(sequence({ ...readFirst, first: undefined }), 'neither first nor then');
  assert.equal(sequence({ ...readFirst, then: buildAfter.then }), 'both first and then');
  assert.equal(sequence({ ...readFirst, first: { tool: '(' } }), "regex doesn't compile: (");
  assert.equal(sequence({ ...buildAfter, when: { value: '(a+)+' } }), 'regex may take exponential time: (a+)+');
});

const confirmed = (): Verdict => ({ verdict: 'broken' });

/** Files are named by their content: `rulesBy[content]` holds what rulesOf gives for it. */
function feed(events: Event[], rulesBy: Record<string, Rule[]>, versionsBy: Record<string, Version[]> = {},
  verdictOf: (rule: string, key: string) => Verdict | null = confirmed) {
  const c = counter((f) => (f.type === 'AutoMem' ? null : { rules: rulesBy[f.content] ?? [], versions: versionsBy[f.content] ?? [] }),
    verdictOf);
  for (const e of events) c.on(e);
  return c;
}
const count = (...args: Parameters<typeof feed>): Data => feed(...args).result();
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
    ['never kill billing', 'never-applied', undefined], ['failing test first', 'judgment', 'no case to judge it on'],
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
  { A: [addAll] }, { M: missing.map((section, i) => ({ section, identity: section.hash, read: false, readAt: null, before: i === 1 })) });
  // One section never read (its rules unchecked), one to read again (its rules from before count).
  assert.deepEqual({ ...data, rules: undefined, byDepth: undefined }, { rules: undefined, byDepth: undefined, notRead: 1, toReread: 1,
    toJudge: 0, atMost: 0,
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
// A version not read with a version of it read before takes that one's rules, as the cache gives them.
const version = (text: string, identity: string, readAt: string | null = null, read = false): Version =>
  ({ section: { path: [], text, hash: text }, identity, read, readAt, before: !read && readAt !== null });
const unread = version;
function asked(events: Event[], versionsBy: Record<string, Version[]>) {
  const c = counter((f) => ({ rules: [], versions: versionsBy[f.content] ?? [] }));
  for (const e of events) c.on(e);
  return { pending: c.pending().map((p) => [p.section.text, p.at]), notRead: c.result().notRead };
}

test('one text to read again under one path and never read under another is one section to read again, not two', () => {
  const c = counter((f) => ({ rules: [], versions: f.content === 'A'
    ? [version('same', 'root', '2026-11-01T00:00:00Z')] : [version('same', 'copy')] }));
  for (const e of [start(), files({ '/r/CLAUDE.md': 'A', '/r/w/CLAUDE.md': 'B' }), bash('ls', { at: '2026-11-02T10:00:00Z' })]) c.on(e);
  const { notRead, toReread } = c.result();
  assert.deepEqual([notRead, toReread], [0, 1]);
});

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

// The judge's verdicts: a tool rule's candidate counts once judged.
const unjudged = () => null;
/** The ids of the cases waiting, by their call's time. */
const waitingAt = (events: Event[], rulesBy: Record<string, Rule[]>) =>
  Object.fromEntries(feed(events, rulesBy, {}, unjudged).waiting().tool.flat().map((k) => [k.at, k.id]));
const by = (verdicts: Record<string, Verdict>) => (rule: string, key: string) => verdicts[`${rule}-${key}`] ?? null;
const at = (day: number) => ({ at: `2026-11-0${day}T10:00:00Z` });
const tally = (data: Data, r: Rule) => {
  const x = data.rules.find((y) => y.id === r.id)!;
  return { status: x.status, applied: x.applied, broken: x.broken, judged: x.judged, toJudge: x.toJudge };
};

test('a candidate counts only once judged: broken when confirmed, kept, or not a case of the rule', () => {
  const events = [start(), files({ '/r/CLAUDE.md': 'A' }), bash('git add -A', at(1)), bash('git add -A', at(2)), bash('git add -A', at(3))];
  const ids = feed(events, { A: [addAll] }, {}, unjudged).waiting().tool[0].map((k) => k.id);
  assert.equal(ids.length, 3);
  const data = count(events, { A: [addAll] }, {},
    by({ [ids[0]]: { verdict: 'broken', quote: 'git add -A' }, [ids[1]]: { verdict: 'kept' }, [ids[2]]: { verdict: 'none' } }));
  assert.deepEqual(tally(data, addAll), { status: 'broken', applied: 2, broken: 1, judged: 3, toJudge: 0 });
  assert.deepEqual(data.rules[0].evidence, [{ ...at(3), session: 's1', agent: null, text: 'git add -A', quote: 'git add -A' }]);
});

test("a rule whose candidates aren't judged yet is to confirm, never broken", () => {
  const data = count([start(), files({ '/r/CLAUDE.md': 'A' }), bash('git add -A'), bash('git add -A')], { A: [addAll] }, {}, unjudged);
  assert.deepEqual(tally(data, addAll), { status: 'to-confirm', applied: 0, broken: 0, judged: 0, toJudge: 2 });
  assert.deepEqual(data.rules[0].evidence, []);
  assert.equal(data.toJudge, 2);
});

test('the cases waiting: latest first, at most 40 per rule, with their rule and excerpt', () => {
  const calls = Array.from({ length: 45 }, (_, i) => bash(`git add -A f${i}.ts`, { at: `2026-11-02T10:${String(i).padStart(2, '0')}:00Z` }));
  const c = feed([start(), files({ '/r/CLAUDE.md': 'A' }), ...calls], { A: [addAll] }, {}, unjudged);
  const [waiting] = c.waiting().tool;
  assert.equal(waiting.length, 40);
  assert.deepEqual(waiting.map((k) => k.at), calls.toReversed().slice(0, 40).map((e) => e.kind === 'call' && e.at));
  for (const [i, k] of waiting.entries()) {
    assert.equal(k.rule.id, addAll.id);
    assert.ok(k.excerpt.endsWith(`\ncall Bash: git add -A f${44 - i}.ts`), k.excerpt.slice(-40));
    assert.ok(k.id.startsWith(`${addAll.id}-`));
  }
  assert.equal(tally(c.result(), addAll).toJudge, 45);
});

test('a judged case is not waiting', () => {
  const events = [start(), files({ '/r/CLAUDE.md': 'A' }), bash('git add -A', at(1)), bash('git add -A', at(2))];
  const ids = waitingAt(events, { A: [addAll] });
  const c = feed(events, { A: [addAll] }, {}, by({ [ids[at(2).at]]: { verdict: 'kept' } }));
  assert.deepEqual(c.waiting().tool.flat().map((k) => k.id), [ids[at(1).at]]);
});

test('two copies of one call are one case', () => {
  const events = (s: string) => [start(s), files({ '/r/CLAUDE.md': 'A' }), bash('git add -A', { id: 'tu-x' })];
  const c = feed([...events('s1'), ...events('s2')], { A: [addAll] }, {}, unjudged);
  assert.equal(c.waiting().tool.flat().length, 1);
  assert.equal(tally(c.result(), addAll).toJudge, 1);
});

test('after compaction and by depth, candidates count once decided', () => {
  const events = [start(), files({ '/r/CLAUDE.md': 'A' }), bash('git add -A', { ...at(1), depth: 150_000, compactions: 1 }),
    bash('git add -A', { ...at(2), depth: 300_000, compactions: 1 }), bash('git add -A', { ...at(3), depth: 50_000, compactions: 1 })];
  const ids = waitingAt(events, { A: [addAll] });
  const r = count(events, { A: [addAll] }, {}, by({ [ids[at(1).at]]: { verdict: 'broken' }, [ids[at(3).at]]: { verdict: 'none' } }))
    .rules[0];
  assert.deepEqual(r.afterCompaction, { applied: 1, broken: 1 });
  assert.deepEqual(r.byDepth.map((b) => [b.applied, b.broken]), [[0, 0], [1, 1], [0, 0], [0, 0]]);
});

// Judgment rules: judged on a sample of their latest cases.
const commit = rule({ quote: 'commit only when asked', name: 'commit only when asked', kind: 'judgment', trigger: 'committing',
  check: { field: 'command', when: { tool: '^Bash$', value: '(^|\\s)git\\s+commit(\\s|$)' } },
  keeping: [{ tool: 'Bash', value: 'git commit -m x' }] });
const said = rule({ quote: 'say what you changed', name: 'say what you changed', kind: 'judgment', trigger: 'replying',
  check: { reply: true } });
/** The judge, in turn: the n-th case asked about gets the n-th verdict, the ones after none yet. */
const inTurn = (verdicts: Verdict[]) => {
  const given = new Map<string, Verdict | null>();
  return (rule: string, key: string) => {
    const id = `${rule}-${key}`;
    if (!given.has(id)) given.set(id, verdicts[given.size] ?? null);
    return given.get(id)!;
  };
};

test("a judgment rule's cases: the calls its when matches, and every reply for a reply rule", () => {
  const c = feed([start(), files({ '/r/CLAUDE.md': 'A' }), bash('git commit -m x', at(1)), bash('git status', at(2)),
    reply('done', at(3)), reply(EN, at(4))], { A: [commit, said] }, {}, unjudged);
  const ends = Object.fromEntries(c.waiting().judgment.map((l) => [l[0].rule.name, l.map((k) => k.excerpt.split('\n').at(-1))]));
  assert.deepEqual(ends, { 'commit only when asked': ['call Bash: git commit -m x'], 'say what you changed': [`reply: ${EN}`, 'reply: done'] });
  assert.deepEqual(c.waiting().tool, []);
  assert.equal(c.result().toJudge, 3);
});

test("a judgment rule's share is over its decided cases: none leaves them", () => {
  const long = `git commit -m "${'x'.repeat(300)}"`;
  const data = count([start(), files({ '/r/CLAUDE.md': 'A' }), bash('git commit -m a', at(1)), bash('git commit -m b', at(2)),
    bash(long, at(3)), bash('git commit -m d', at(4))], { A: [commit] }, {},
  inTurn([{ verdict: 'kept' }, { verdict: 'kept' }, { verdict: 'broken', quote: 'git commit -m' }, { verdict: 'none' }]));
  assert.deepEqual(tally(data, commit), { status: 'judgment', applied: 3, broken: 1, judged: 4, toJudge: 0 });
  assert.deepEqual(data.rules[0].evidence,
    [{ ...at(3), session: 's1', agent: null, text: `${`call Bash: ${long}`.slice(0, 200)}…`, quote: 'git commit -m' }]);
});

test('a judgment rule is judged on 8 cases first: none applies, it stops there; one does, until 20 decided or 40 judged', () => {
  const commits = (n: number) => [start(), files({ '/r/CLAUDE.md': 'A' }),
    ...Array.from({ length: n }, (_, i) => bash(`git commit -m c${i}`, { at: `2026-11-02T10:${String(i).padStart(2, '0')}:00Z` }))];
  const waiting = (n: number, verdicts: Verdict[]) => {
    const c = feed(commits(n), { A: [commit] }, {}, inTurn(verdicts));
    return [c.waiting().judgment.flat().length, c.result().toJudge];
  };
  const times = (n: number, verdict: Verdict['verdict']): Verdict[] => Array.from({ length: n }, () => ({ verdict }));
  assert.deepEqual(waiting(30, []), [8, 8]);
  assert.deepEqual(waiting(30, times(5, 'none')), [3, 3]);
  assert.deepEqual(waiting(30, times(8, 'none')), [0, 0]);
  assert.deepEqual(waiting(42, times(39, 'none')), [0, 0]);
  assert.deepEqual(waiting(30, [{ verdict: 'kept' }, ...times(7, 'none')]), [19, 19]);
  assert.deepEqual(waiting(23, times(18, 'kept')), [2, 2]);
  assert.deepEqual(waiting(22, times(20, 'kept')), [0, 0]);
  // A sample stopped after 8 none opens again when a later case applies: the cases met while it was stopped wait too.
  assert.deepEqual(waiting(14, [...times(8, 'none'), ...Array(5).fill(undefined), { verdict: 'kept' }]), [5, 5]);
  // A tool rule's candidates have no sample.
  const adds = feed([start(), files({ '/r/CLAUDE.md': 'A' }),
    ...Array.from({ length: 12 }, (_, i) => bash(`git add -A d${i}`, { at: `2026-11-02T10:${String(i).padStart(2, '0')}:00Z` }))],
  { A: [addAll] }, {}, unjudged);
  assert.equal(adds.waiting().tool.flat().length, 12);
});

test("each rule's cases waiting now, and the most every rule may still take", () => {
  const minute = (i: number) => ({ at: `2026-11-02T1${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}:00Z` });
  const run = (r: Rule, n: number, command: (i: number) => string, verdicts: Verdict[]) => {
    const data = count([start(), files({ '/r/CLAUDE.md': 'A' }), ...Array.from({ length: n }, (_, i) => bash(command(i), minute(i)))],
      { A: [r] }, {}, inTurn(verdicts));
    return [data.rules[0].toJudge, data.toJudge, data.atMost];
  };
  const times = (n: number, verdict: Verdict['verdict']): Verdict[] => Array.from({ length: n }, () => ({ verdict }));
  const commits = (i: number) => `git commit -m c${i}`;
  // Stopped after 8 none: nothing now, nothing later.
  assert.deepEqual(run(commit, 12, commits, times(8, 'none')), [0, 0, 0]);
  // Still sampling: 3 of its 8 now; every case left if one applies.
  assert.deepEqual(run(commit, 12, commits, times(5, 'none')), [3, 3, 7]);
  // One applied: up to 20 decided now; up to 40 judged at most.
  assert.deepEqual(run(commit, 30, commits, [{ verdict: 'kept' }]), [19, 19, 29]);
  // A tool rule's candidates: all of them, past the 40 it lists.
  assert.deepEqual(run(addAll, 50, (i) => `git add -A d${i}`, []), [50, 50, 50]);
});

test("the agent's own call, an edit to its memory, is no case of a judgment rule; a tool rule still checks it", () => {
  const edits = rule({ quote: 'say why in every edit', name: 'say why', kind: 'judgment', trigger: 'editing',
    check: { field: 'file_path', when: { tool: '^(Edit|Write)$', value: '.' } },
    keeping: [{ tool: 'Edit', value: '/r/a.ts' }] });
  const noMd = rule({ quote: 'never write markdown files', name: 'never write markdown', kind: 'tool', trigger: 'writing',
    check: { field: 'file_path', when: { tool: '^Write$', value: '.' }, broken: { value: '\\.md$' } },
    breaking: [{ tool: 'Write', value: '/r/a.md' }], keeping: [{ tool: 'Write', value: '/r/a.ts' }] });
  const memory = '/home/.claude/projects/x/memory/notes.md';
  const write = (file_path: string, own?: true): Event => ({ kind: 'call', id: `tu${++ids}`, tool: 'Write',
    input: { file_path, content: 'x' }, ...at(1), depth: 0, compactions: 0, ...(own ? { own } : {}) });
  const c = feed([start(), files({ '/r/CLAUDE.md': 'A' }), write(memory, true), write('/r/a.ts')], { A: [edits, noMd] }, {},
    unjudged);
  const lists = c.waiting();
  assert.deepEqual(lists.judgment.flat().map((k) => k.excerpt.split('\n').at(-1)), ['call Write: /r/a.ts writes: x']);
  assert.ok(lists.judgment[0][0].excerpt.includes(`call Write: ${memory}`));
  assert.deepEqual(lists.tool.flat().map((k) => k.excerpt.split('\n').at(-1)), [`call Write: ${memory} writes: x`]);
});

test('a judgment rule without cases is never a case', () => {
  const vague = rule({ quote: 'think before you act', name: 'think first', kind: 'judgment', trigger: 'always' });
  const c = feed([start(), files({ '/r/CLAUDE.md': 'A' }), bash('git commit -m x'), reply(EN)], { A: [vague] }, {}, unjudged);
  assert.deepEqual(c.waiting().judgment, []);
  assert.deepEqual(tally(c.result(), vague), { status: 'judgment', applied: 0, broken: 0, judged: 0, toJudge: 0 });
  assert.equal(c.result().rules[0].reason, 'no case to judge it on');
});

test('two events that read alike are one case to judge', () => {
  const events = (s: string) => [start(s), files({ '/r/CLAUDE.md': 'A' }), bash('git add -A')];
  const c = feed([...events('s1'), ...events('s2')], { A: [addAll] }, {}, unjudged);
  assert.equal(c.waiting().tool.flat().length, 1);
  assert.equal(tally(c.result(), addAll).toJudge, 2);
});

test('one quote read two ways (with no cases, then with a when) is one rule, counted as first read', () => {
  const vague = rule({ quote: 'commit only when asked', name: 'commit only when asked', kind: 'judgment', trigger: 'committing' });
  assert.equal(vague.id, commit.id);
  const c = feed([start(), files({ '/r/A.md': 'A' }), files({ '/r/B.md': 'B' }), bash('git commit -m x')], { A: [vague], B: [commit] },
    {}, unjudged);
  assert.deepEqual(c.waiting().judgment, []);
  assert.equal(c.result().rules.find((x) => x.id === commit.id)!.reason, 'no case to judge it on');
});
