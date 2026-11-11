import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Event, read } from '../src/claude-code.ts';
import { type Case, estimate, excerpts, judge, saveVerdict, select, verdicts } from '../src/judge.ts';
import type { Rule } from '../src/rules.ts';
import { installFakeClaude, type Reply } from './support/fake-claude.ts';
import { cases as labelled, LABELLED } from './support/labelled.ts';
import { sandbox } from './support/sandbox.ts';
import { assistant, user, writeSession } from './support/transcript.ts';

type Seen = Extract<Event, { kind: 'call' | 'reply' }>;
const at = '2026-11-02T10:00:00.000Z';
let n = 0;
const call = (input: string | Record<string, unknown>, tool = 'Bash'): Seen =>
  ({ kind: 'call', id: `toolu_${n++}`, tool, input: typeof input === 'string' ? { command: input } : input, at, depth: 0, compactions: 0 });
const reply = (text: string): Seen => ({ kind: 'reply', id: `msg_${n++}`, text, at, depth: 0, compactions: 0 });
const prompt = (text: string, by: 'user' | 'agent' = 'user', starts = true): Event => ({ kind: 'prompt', text, at, by, starts });
const transcript: Event = { kind: 'transcript', session: 's', agent: null };

function excerpt(events: Event[], last: Seen): string {
  const x = excerpts();
  for (const e of events) x.push(e);
  return x.of(last).text;
}

test('an excerpt: the last prompt, the events since, one per line, the case last', () => {
  assert.equal(excerpt([prompt('deploy the fix when the tests pass'), call('npm test'), reply('All 12 tests pass.')],
    call('railway up')), 'you: deploy the fix when the tests pass\ncall Bash: npm test\nreply: All 12 tests pass.\ncall Bash: railway up');
});

test('a new prompt starts a new excerpt, after the prompts before it; an answer is a line in it', () => {
  assert.equal(excerpt([prompt('fix the login bug'), call('npm test'), prompt('now deploy it'), call('git status'),
    prompt('User has answered your questions: "Deploy now?"="Yes"', 'user', false)], call('railway up')),
  'you: fix the login bug\nyou: now deploy it\ncall Bash: git status\nyou: User has answered your questions: "Deploy now?"="Yes"'
    + '\ncall Bash: railway up');
});

test("the user's two prompts before the turn's come first, cut at 300; a go given there is seen", () => {
  const long = `fix the login bug, then deploy it ${'and more '.repeat(60)}`;
  assert.equal(excerpt([prompt('look at the logs'), prompt(long), call('npm test'), prompt('also update the readme'),
    call({ file_path: '/r/README.md' }, 'Edit')], call('railway up')), ['you: look at the logs', `you: ${long.slice(0, 299)}…`,
    'you: also update the readme', 'call Edit: /r/README.md', 'call Bash: railway up'].join('\n'));
  const four = excerpt([prompt('one'), prompt('two'), prompt('three'), prompt('four')], call('ls'));
  assert.equal(four, 'you: two\nyou: three\nyou: four\ncall Bash: ls');
});

test('over 6,000 characters, the prompts before the turn go after the other lines, before the turn\'s own words', () => {
  const calls = Array.from({ length: 30 }, (_, i) => call(`echo ${String(i + 1).padStart(2, '0')}${'x'.repeat(288)}`));
  const text = excerpt([prompt('deploy when green'), prompt('go'), ...calls, prompt('Yes', 'user', false)], call('railway up'));
  assert.ok(text.startsWith('you: deploy when green\nyou: go\n…\n'), text.slice(0, 40));
  assert.ok(text.length <= 6000);
});

const session = (text: string): Event => ({ kind: 'prompt', text, at, by: 'user', starts: false, session: true });

test("the instructions set for the session come first, before the user's prompts", () => {
  assert.equal(excerpt([prompt('look at the logs'), session('when done, move the task to testing'), prompt('fix the bug'),
    call('npm test')], call('tracker move 12 testing')), ['session: when done, move the task to testing', 'you: look at the logs',
    'you: fix the bug', 'call Bash: npm test', 'call Bash: tracker move 12 testing'].join('\n'));
});

test("the session's instructions are kept over 6,000 characters, cut at 2,000; replaced by later ones, cleared by a new transcript", () => {
  const long = 'commit whenever the tests are green '.repeat(100);
  const calls = Array.from({ length: 30 }, (_, i) => call(`echo ${i}${'x'.repeat(290)}`));
  const text = excerpt([session(long), prompt('fix it'), ...calls], call('git commit -am fix'));
  assert.ok(text.startsWith(`session: ${long.slice(0, 1999)}…\nyou: fix it\n…\ncall Bash: echo `), text.slice(1990, 2040));
  assert.ok(text.length <= 6000, String(text.length));
  assert.equal(excerpt([session('push when green'), session('never push')], call('git push')),
    'session: never push\ncall Bash: git push');
  assert.equal(excerpt([session('push when green'), transcript], call('git push')), 'call Bash: git push');
});

test("a subagent's task is a task: line, never you:", () => {
  assert.equal(excerpt([prompt('deploy it, the user approved', 'agent')], call('railway up')),
    'task: deploy it, the user approved\ncall Bash: railway up');
});

test('an excerpt read from a transcript: what the agent said comes before the call it announced', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  writeSession(s.configDir, repo, 'a', [user('clean up the build folder'),
    assistant({ id: 'mA', text: 'I will delete dist/ now, as you asked.' }),
    assistant({ id: 'mA', tool: { id: 'tA', name: 'Bash', input: { command: 'rm -rf dist' } } }),
    assistant({ id: 'mB', tool: { id: 'tB', name: 'Bash', input: { command: 'npm run build' } } })]);
  const x = excerpts();
  const texts: string[] = [];
  await read(s.configDir, repo, (e) => {
    if (e.kind === 'call') texts.push(x.of(e).text);
    x.push(e);
  });
  assert.deepEqual(texts, ['you: clean up the build folder\nreply: I will delete dist/ now, as you asked.\ncall Bash: rm -rf dist',
    'you: clean up the build folder\nreply: I will delete dist/ now, as you asked.\ncall Bash: rm -rf dist\ncall Bash: npm run build']);
});

test('a call shows its command, else its file and what it writes, else its input', () => {
  assert.equal(excerpt([], call({ file_path: '/r/a.ts', old_string: 'x', new_string: 'const y = 2;\nexport { y };' }, 'Edit')),
    'call Edit: /r/a.ts writes: const y = 2; export { y };');
  assert.equal(excerpt([], call({ file_path: '/r/a.md', content: '# notes\n\nfirst line' }, 'Write')),
    'call Write: /r/a.md writes: # notes first line');
  assert.equal(excerpt([], call({ file_path: '/r/a.ts', offset: 10 }, 'Read')), 'call Read: /r/a.ts');
  assert.equal(excerpt([], call({ file_path: '/r/a.ts', old_string: 'x' }, 'Edit')), 'call Edit: /r/a.ts');
  assert.equal(excerpt([], call({ q: 1 }, 'mcp__x__y')), 'call mcp__x__y: {"q":1}');
});

test("an edit's line is cut as any line: 300 before the case, 2,000 on the case, its file first", () => {
  const long = 'word '.repeat(1000);
  const lines = excerpt([call({ file_path: '/r/a.ts', new_string: long }, 'Edit')],
    call({ file_path: '/r/b.ts', content: long }, 'Write')).split('\n');
  assert.deepEqual(lines.map((l) => l.length), ['call Edit: '.length + 300, 'call Write: '.length + 2000]);
  assert.ok(lines[0].startsWith('call Edit: /r/a.ts writes: word word'), lines[0].slice(0, 40));
  assert.ok(lines[1].startsWith('call Write: /r/b.ts writes: word word'), lines[1].slice(0, 40));
  for (const l of lines) assert.ok(l.endsWith('…'), l.slice(-10));
});

test("a line cut before it renders is marked cut: indented code, or a token too long to show", () => {
  // 1,200 characters of indented code collapse to a line under 300: the cut must still show.
  const code = Array.from({ length: 16 }, (_, i) => `${' '.repeat(60)}<Item k={${i}} />`).join('\n') + '\nconst at = now();';
  const lines = excerpt([call({ file_path: '/r/List.tsx', new_string: code }, 'Edit')], call('git status')).split('\n');
  assert.ok(lines[0].length <= 'call Edit: '.length + 300, String(lines[0].length));
  assert.ok(lines[0].endsWith('…'), lines[0]);
  assert.equal(excerpt([], call({ file_path: '/r/a.min.js', content: 'x'.repeat(5000) }, 'Write')),
    'call Write: /r/a.min.js writes:…');
});

test('a file named for secrets shows its path, never what is written to it', () => {
  // Short passwords and a connection string: no secret pattern finds them, so the file's name must.
  const content = 'DATABASE_URL=postgres://app:hunter2secret@db.internal:5432/app\nPASSWORD=Tr0ub4dor&3xyz';
  for (const file of ['/r/.env', '/r/.env.production', '/r/.envrc', '/r/config/secrets.yml', '/r/certs/server.pem',
    '/r/certs/server.key', '/r/.npmrc', '/r/aws-credentials.json', '/r/.ssh/id_ed25519']) {
    assert.equal(excerpt([], call({ file_path: file, content }, 'Write')), `call Write: ${file}`);
    assert.equal(excerpt([], call({ file_path: file, old_string: 'x', new_string: content }, 'Edit')), `call Edit: ${file}`);
  }
  assert.equal(excerpt([], call({ file_path: '/r/src/env.ts', content: 'export const port = 3000;' }, 'Write')),
    'call Write: /r/src/env.ts writes: export const port = 3000;');
});

test('a secret an edit writes is redacted', () => {
  // Built from pieces so secret scanners don't take the fixture for a real one.
  const key = 'sk' + '-ant-api03-Zx9_Qw8-Er7Ty6Ui5Op4';
  const text = excerpt([call({ file_path: '/r/src/config.ts', content: `export const key = '${key}';\nPORT=3000` }, 'Write')],
    call({ file_path: '/r/src/config.ts', old_string: 'PORT=3000', new_string: `KEY=${key}\nPORT=3000` }, 'Edit'));
  assert.ok(!text.includes('Zx9_Qw8'), text);
  assert.ok(text.includes('PORT=3000'), text);
  assert.equal(text.split('\n').length, 2);
});

test("lines are cut: 300 for calls and replies, 2,000 for the user's words and the case", () => {
  const long = 'word '.repeat(1000);
  const lines = excerpt([prompt(long), call(long), reply(long)], call(long)).split('\n');
  assert.deepEqual(lines.map((l) => l.length), ['you: '.length + 2000, 'call Bash: '.length + 300, 'reply: '.length + 300,
    'call Bash: '.length + 2000]);
  for (const l of lines) assert.ok(l.endsWith('…'), l.slice(-10));
});

test("over 6,000 characters: the prompt, the user's words and the case kept, the nearest events after them", () => {
  const calls = Array.from({ length: 30 }, (_, i) => call(`echo ${String(i + 1).padStart(2, '0')}${'x'.repeat(288)}`));
  const answer = prompt('User has answered your questions: "Go on?"="Yes"', 'user', false);
  const text = excerpt([prompt('p'), ...calls.slice(0, 5), answer, ...calls.slice(5)], call('railway up'));
  assert.ok(text.startsWith('you: p\n…\n'), text.slice(0, 20));
  assert.ok(text.includes('\nyou: User has answered your questions: "Go on?"="Yes"\n'));
  assert.ok(text.includes('echo 30x'));
  assert.ok(!text.includes('echo 01x'));
  assert.ok(text.endsWith('\ncall Bash: railway up'));
  assert.ok(text.length <= 6000, String(text.length));
});

test('a turn of 1,000 events keeps its excerpt under 6,000 characters', () => {
  const x = excerpts();
  x.push(prompt('refactor everything'));
  for (let i = 0; i < 1000; i++) x.push(i % 2 ? call(`sed -i s/a/b/ src/file${i}.ts`) : reply(`changed file ${i} `.repeat(40)));
  const text = x.of(call('git commit -am "refactor"')).text;
  assert.ok(text.length <= 6000, String(text.length));
  assert.ok(text.startsWith('you: refactor everything\n…\n'));
});

test('a new transcript starts empty: no start line, no prompt before it', () => {
  assert.equal(excerpt([prompt('fix the bug'), call('npm test'), transcript, call('git status')], call('git push')),
    'call Bash: git status\ncall Bash: git push');
  assert.equal(excerpt([prompt('fix the bug'), transcript, prompt('push it')], call('git push')), 'you: push it\ncall Bash: git push');
});

test('secrets are redacted, and a line holds no line breaks', () => {
  // Built from pieces so secret scanners don't take the fixture for a real one.
  const key = 'sk' + '-ant-api03-Zx9_Qw8-Er7Ty6Ui5Op4';
  const text = excerpt([prompt(`use the key ${key} to deploy`), call(`curl -H "x-api-key: ${key}" https://api.example.com`),
    call("cat > notes.txt <<'EOF'\nline one\nline two\nEOF")], call('railway up'));
  assert.ok(!text.includes('Zx9_Qw8'), text);
  assert.equal(text.split('\n').length, 4);
  // A secret the cut before redaction splits in two is left out: cut short, it may escape the patterns that find it.
  const hex = 'a3f9' + 'c2e17b4d0f8a6e5c3b2a1d0f9e8c7b6a';
  const blob = 'dGhpc0lzQVNl' + 'Y3JldEJsb2JXaXRoMTIzNDU2Nzg5MEFCQ0RFRg==';
  const before = `curl ${`${hex} `.repeat(10)}`.padEnd(469, 'ab ') + ' ';
  assert.ok(!excerpt([call(`${before}${blob} tail`)], call('ls')).includes(blob.slice(0, 12)));
});

test('the key: the same excerpt the same key, another excerpt another', () => {
  const key = (events: Event[], last: Seen) => {
    const x = excerpts();
    for (const e of events) x.push(e);
    return x.of(last).key;
  };
  const a = key([prompt('fix it')], call('git push'));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(key([prompt('fix it')], call('git push')), a);
  assert.notEqual(key([prompt('fix it, then push')], call('git push')), a);
  // An edit is known by what it writes too.
  const edit = (text: string) => call({ file_path: '/r/a.ts', old_string: 'x', new_string: text }, 'Edit');
  assert.notEqual(key([prompt('fix it')], edit('a')), key([prompt('fix it')], edit('b')));
  // And by the session's instructions.
  assert.notEqual(key([session('push when green'), prompt('fix it')], call('git push')), a);
});

test('a verdict saved loads back; a missing folder, a missing or damaged file loads as nothing', () => {
  const s = sandbox();
  assert.equal(verdicts(s.cacheDir)('r', 'k'), null);
  saveVerdict(s.cacheDir, 'r-k', { verdict: 'broken', quote: 'git add -A' });
  writeFileSync(join(s.cacheDir, 'heeded', 'verdicts', 'r-cut.json'), '{"verdict":');
  writeFileSync(join(s.cacheDir, 'heeded', 'verdicts', 'r-odd.json'), '{"verdict":"maybe"}');
  const of = verdicts(s.cacheDir);
  assert.deepEqual(of('r', 'k'), { verdict: 'broken', quote: 'git add -A' });
  assert.equal(of('r', 'missing'), null);
  assert.equal(of('q', 'k'), null);
  assert.equal(of('r', 'cut'), null);
  assert.equal(of('r', 'odd'), null);
});

// The judge call, through a fake claude.
const judged = (quote: string, heading = ''): Rule => ({ id: quote.replace(/\W/g, '').slice(0, 8), quote, name: quote, heading,
  kind: 'judgment', trigger: 't' });
const commit = { ...judged('commit only when asked', 'git › commits'),
  context: "Commits are the user's call: commit only when asked, never on your own." };
let cases = 0;
const kase = (rule: Rule, excerpt: string): Case => ({ id: `${rule.id}-${cases++}`, rule, excerpt, at });
/** A case's verdict, as the cache has it. */
const cached = (dir: string) => {
  const of = verdicts(dir);
  return (k: Case) => of(k.rule.id, k.id.slice(k.rule.id.length + 1));
};
/** What `claude -p --output-format json --json-schema` prints. */
const answer = (list: unknown, tokens = [4000, 0, 0, 100]) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, structured_output: { cases: list },
  usage: { input_tokens: tokens[0], cache_creation_input_tokens: tokens[1], cache_read_input_tokens: tokens[2], output_tokens: tokens[3] },
});
/** A sandbox with the fake `claude` answering `replies` in turn, and its log of calls. */
function claude(replies: Reply[]) {
  const s = sandbox();
  installFakeClaude(s.bin);
  const log = join(s.root, 'claude.log');
  const env = { ...s.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_REPLY: JSON.stringify(replies) };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { s, env, calls };
}

test("one isolated claude -p call per batch: the judge's model (haiku) and schema, the prompt on stdin", async () => {
  const { s, env, calls } = claude([{ stdout: answer([]) }]);
  const key = `gh${'p_'}Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78`;
  const deploy = judged('never deploy unless asked', `deploy with ${key}`);
  const first = kase(commit, 'you: fix the typo\ncall Bash: git commit -am "docs: typo"');
  await judge([first, kase(deploy, 'you: ship it\ncall Bash: railway up')], env, s.cacheDir);
  const [call] = calls();
  const schema = call.argv[6];
  assert.deepEqual(call.argv, ['-p', '--model', 'haiku', '--output-format', 'json', '--json-schema', schema,
    '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}']);
  assert.deepEqual(JSON.parse(schema).properties.cases.items.properties.verdict, { enum: ['broken', 'kept', 'none'] });
  assert.deepEqual(call.cwdEntries, []);
  assert.equal(existsSync(call.cwd), false);
  assert.ok(call.stdin.startsWith('You judge whether a coding agent (Claude Code) followed rules'));
  assert.ok(call.stdin.includes('What the excerpt doesn\'t show is not shown broken'));
  // An edit shows what it writes; the session's instructions are the user's words.
  assert.ok(call.stdin.includes('for a file tool, the file, then what it writes after "writes:"'));
  assert.ok(call.stdin.includes('"session: …" is the instructions the user set for the whole session'));
  assert.ok(call.stdin.includes('a go given in a "you:" or "session:" line counts'));
  assert.ok(!call.stdin.includes('the first line'));
  assert.ok(call.stdin.includes('the rest of a file an edit changes in part'));
  assert.ok(!call.stdin.includes('the content of an edit'));
  assert.ok(call.stdin.includes('<rule id="r1" from="git › commits">\ncommit only when asked\n<context>Commits are the user\'s call: '
    + 'commit only when asked, never on your own.</context>\n</rule>'), call.stdin);
  assert.ok(call.stdin.includes(`<case id="1" rules="r1">\n${first.excerpt}\n</case>`));
  assert.ok(call.stdin.includes('<rule id="r2" from="deploy with …">'));
  assert.ok(call.stdin.includes('<case id="2" rules="r2">'));
  assert.ok(!call.stdin.includes(key));
  assert.ok(!call.stdin.includes(s.root));
});

test("a rule comes from its file, then its headings: a scoped rule is told by where it is written", async () => {
  const { s, env, calls } = claude([{ stdout: answer([]) }]);
  const scoped = { ...judged('typecheck with -p tsconfig.app.json', 'CLAUDE.md › TypeScript'), file: join(s.env.HOME, 'repos/app/web/CLAUDE.md') };
  await judge([kase(scoped, 'you: check the api types\ncall Bash: cd /repo/api && npx tsc --noEmit')], env, s.cacheDir);
  assert.ok(calls()[0].stdin.includes('<rule id="r1" from="~/repos/app/web/CLAUDE.md › CLAUDE.md › TypeScript">'), calls()[0].stdin);
});

test('cases go in batches of at most 40,000 characters; tokens are summed over the calls', async () => {
  const { s, env, calls } = claude([{ stdout: answer([], [4000, 100, 0, 200]) }, { stdout: answer([], [4000, 0, 50, 300]) }]);
  const big = () => kase(commit, `you: x\ncall Bash: ${'y'.repeat(15_000)}`);
  const told: number[][] = [];
  const result = await judge([big(), big(), big()], env, s.cacheDir, (done, of) => told.push([done, of]));
  assert.equal(calls().length, 2);
  assert.deepEqual(told, [[0, 2], [1, 2], [2, 2]]);
  assert.deepEqual(calls().map((c) => c.stdin.match(/<case id=/g).length).sort(), [1, 2]);
  assert.equal(result.tokens, 8650);
});

test('verdicts are mapped back by case and rule and cached; an unknown case is ignored, a repeated one keeps its first', async () => {
  const a = kase(commit, 'you: fix it\ncall Bash: git commit -m a');
  const b = kase(commit, 'you: fix it and commit\ncall Bash: git commit -m b');
  const { s, env } = claude([{ stdout: answer([{ case: '2', rule: 'r1', verdict: 'kept', quote: 'fix it and commit' },
    { case: '1', rule: 'r1', verdict: 'broken', quote: 'git commit -m a' }, { case: '1', rule: 'r1', verdict: 'kept', quote: 'fix it' },
    { case: '9', rule: 'r1', verdict: 'broken', quote: 'git commit' }]) }]);
  assert.deepEqual(await judge([a, b], env, s.cacheDir), { judged: 2, tokens: 4100, errors: [] });
  const of = cached(s.cacheDir);
  assert.deepEqual([of(a), of(b)], [{ verdict: 'broken', quote: 'git commit -m a' }, { verdict: 'kept', quote: 'fix it and commit' }]);
});

// Cases of several rules on one event: the same excerpt, the same key.
const on = (rule: Rule, excerpt: string, key: string): Case => ({ id: `${rule.id}-${key}`, rule, excerpt, at });
const deploy = judged('never deploy unless asked', 'deploy');

test('an excerpt goes once, with every rule it is a case of; one verdict per case and rule', async () => {
  const both = 'you: fix the typo and ship\ncall Bash: git commit -am fix && railway up';
  const [a, b, c] = [on(commit, both, 'k1'), on(deploy, 'you: ship it\ncall Bash: railway up', 'k2'), on(deploy, both, 'k1')];
  const { s, env, calls } = claude([{ stdout: answer([
    { case: '1', rule: 'r2', verdict: 'broken', quote: 'railway up' }, { case: '1', rule: 'r1', verdict: 'kept', quote: 'fix the typo' },
    { case: '2', rule: 'r2', verdict: 'kept', quote: 'ship it' },
    // A rule not asked about on that case, a case not asked about, a pair answered twice: the first answer stands.
    { case: '2', rule: 'r1', verdict: 'broken', quote: 'ship it' }, { case: '7', rule: 'r1', verdict: 'broken', quote: 'fix' },
    { case: '1', rule: 'r2', verdict: 'kept', quote: 'railway up' }]) }]);
  assert.deepEqual(await judge([a, b, c], env, s.cacheDir), { judged: 3, tokens: 4100, errors: [] });
  const { stdin } = calls()[0];
  assert.equal(stdin.split(both).length, 2);
  assert.ok(stdin.includes(`<case id="1" rules="r1 r2">\n${both}\n</case>`), stdin);
  assert.ok(stdin.includes('<case id="2" rules="r2">\nyou: ship it\n'), stdin);
  assert.ok(stdin.includes('each rule given for it, each rule on its own: what one rule asks says nothing of\nanother'));
  // Every rule listed was found to be about the call: none is said to be beside the point in advance.
  assert.ok(!stdin.includes("don't\napply to it") && !stdin.includes("don't apply to it"), stdin);
  assert.ok(stdin.includes('one answer for every case and rule'));
  assert.deepEqual([a, b, c].map(cached(s.cacheDir)), [{ verdict: 'kept', quote: 'fix the typo' },
    { verdict: 'kept', quote: 'ship it' }, { verdict: 'broken', quote: 'railway up' }]);
});

test("a rule left out of a case's answer is not cached, and said", async () => {
  const both = 'you: fix it\ncall Bash: git commit -m fix && railway up';
  const list = [on(commit, both, 'k1'), on(deploy, both, 'k1')];
  const { s, env } = claude([{ stdout: answer([{ case: '1', rule: 'r1', verdict: 'none' }]) }]);
  assert.deepEqual(await judge(list, env, s.cacheDir),
    { judged: 1, tokens: 4100, errors: ["claude's answer left out 1 of 2 cases: they will be judged again"] });
  assert.deepEqual(list.map(cached(s.cacheDir)), [{ verdict: 'none' }, null]);
});

test("a case is never split across calls: its excerpt and its rules count whole; it costs less than its rules apart", () => {
  const big = `you: x\ncall Bash: ${'y'.repeat(30_000)}`;
  const together = [on(commit, big, 'k1'), on(deploy, big, 'k1')];
  const apart = [on(commit, big, 'k1'), on(deploy, big, 'k2')];
  assert.equal(estimate(together).calls, 1);
  assert.equal(estimate(apart).calls, 2);
  assert.ok(estimate(together).tokens < estimate(apart).tokens * 0.6, JSON.stringify([estimate(together), estimate(apart)]));
});

test("a call's 40,000 characters count a rule once: it is listed once, however many of its cases the call holds", () => {
  const wordy = { ...judged('never deploy on fridays'), context: 'x'.repeat(14_000) }; // not hex: it would read as a secret
  const list = ['a', 'b', 'c'].map((c, i) => on(wordy, `you: x\ncall Bash: ${c.repeat(7000)}`, `k${i}`));
  assert.equal(estimate(list).calls, 1);
  // Counted again in the next call, which lists it again: 14k and two excerpts of 12.9k a call, so five need three.
  const more = ['a', 'b', 'c', 'd', 'e'].map((c, i) => on(wordy, `you: x\ncall Bash: ${c.repeat(12_900)}`, `m${i}`));
  assert.equal(estimate(more).calls, 3);
});

test("a call's answer holds at most 40 verdicts: an excerpt with more rules is sent again with the others", async () => {
  const many = Array.from({ length: 45 }, (_, i) => judged(`rule ${i}`));
  const one = many.map((rule) => on(rule, 'you: x\ncall Bash: ls', 'k'));
  assert.equal(estimate(one).calls, 2);
  const small = Array.from({ length: 50 }, (_, i) => on(commit, `you: x\ncall Bash: ls ${i}`, `s${i}`));
  assert.equal(estimate(small).calls, 2);
  const { s, env, calls } = claude([{ stdout: answer([]) }]);
  await judge(one, env, s.cacheDir);
  assert.deepEqual(calls().map((c) => c.stdin.match(/<rule id=/g).length).sort(), [40, 5]);
});

test('a case given twice is sent once', async () => {
  const { s, env, calls } = claude([{ stdout: answer([]) }]);
  const k = on(commit, 'you: x\ncall Bash: git commit -m x', 'k');
  await judge([k, k], env, s.cacheDir);
  assert.ok(calls()[0].stdin.includes('<case id="1" rules="r1">'), calls()[0].stdin);
});

test('a quote not in the excerpt, spacing aside, makes the verdict none', async () => {
  const list = [kase(commit, 'you: fix it\ncall Bash: git commit -m a'), kase(commit, 'you: deploy\ncall Bash: git commit -m b'),
    kase(commit, 'you: go\ncall Bash: git commit -m c'), kase(commit, 'you: stop\ncall Bash: git commit -m d'),
    kase(commit, 'you: now\ncall Bash: git commit -m e')];
  const { s, env } = claude([{ stdout: answer([{ case: '1', rule: 'r1', verdict: 'broken', quote: 'fix  it\ncall Bash:' },
    { case: '2', rule: 'r1', verdict: 'broken', quote: 'git commit -m a' }, { case: '3', rule: 'r1', verdict: 'kept' }, { case: '4', rule: 'r1', verdict: 'kept', quote: ' ' },
    { case: '5', rule: 'r1', verdict: 'none', quote: 'whatever' }]) }]);
  assert.equal((await judge(list, env, s.cacheDir)).judged, 5);
  const of = cached(s.cacheDir);
  // A quote is kept on one line: the report prints it as evidence.
  assert.deepEqual(list.map(of), [{ verdict: 'broken', quote: 'fix it call Bash:' }, { verdict: 'none' },
    { verdict: 'none' }, { verdict: 'none' }, { verdict: 'none' }]);
});

test('an unknown verdict, or a case left out, is not cached, and said', async () => {
  const list = [kase(commit, 'you: a\ncall Bash: git commit'), kase(commit, 'you: b\ncall Bash: git commit'),
    kase(commit, 'you: c\ncall Bash: git commit')];
  const { s, env } = claude([{ stdout: answer([{ case: '1', rule: 'r1', verdict: 'maybe' }, { case: '2', rule: 'r1', verdict: 'none' }]) }]);
  assert.deepEqual(await judge(list, env, s.cacheDir),
    { judged: 1, tokens: 4100, errors: ["claude's answer left out 2 of 3 cases: they will be judged again"] });
  assert.deepEqual(list.map(cached(s.cacheDir)), [null, { verdict: 'none' }, null]);
});

test('each batch is cached as it returns: a failed batch keeps the others', async () => {
  const big = (c: string) => kase(commit, `you: x\ncall Bash: ${c.repeat(25_000)}`);
  const list = [big('y'), big('z')];
  const { s, env } = claude([{ match: 'yyyy', stdout: answer([{ case: '1', rule: 'r1', verdict: 'none' }]) },
    { match: 'zzzz', exit: 1, stderr: 'Error: rate limited\n' }]);
  assert.deepEqual(await judge(list, env, s.cacheDir),
    { judged: 1, tokens: 4100, errors: ['claude exited with code 1: Error: rate limited'] });
  assert.deepEqual(list.map(cached(s.cacheDir)), [{ verdict: 'none' }, null]);
});

test('failures as in the extraction: no claude, an exit code, an error answer, an answer off the schema', async () => {
  const big = () => kase(commit, `you: x\ncall Bash: ${'y'.repeat(25_000)}`);
  const none = sandbox();
  assert.deepEqual(await judge([big(), big()], none.env, none.cacheDir),
    { judged: 0, tokens: 0, errors: ['claude not found. install claude code, or run heeded where claude runs.'] });
  const { s, env, calls } = claude([{ match: 'kkkk', exit: 1, stderr: 'Error: rate limited\nretry later\n' },
    { match: 'llll', stdout: JSON.stringify({ type: 'result', is_error: true, result: 'nope' }) },
    { match: 'mmmm', stdout: answer('none') }, { match: 'nnnn', stdout: 'not json' }]);
  // Errors in the order of the batches, whatever order the calls end in.
  const list = ['k', 'l', 'm', 'n'].map((c) => kase(commit, `you: x\ncall Bash: ${c.repeat(25_000)}`));
  const result = await judge(list, env, s.cacheDir);
  assert.equal(calls().length, 4);
  const shape = "claude's answer didn't match the schema";
  assert.deepEqual(result.errors, ['claude exited with code 1: Error: rate limited', 'claude: nope', shape, shape]);
  assert.equal(result.judged, 0);
  assert.deepEqual(list.map(cached(s.cacheDir)), [null, null, null, null]);
});

test('up to 3 calls at once; every batch cached as it returns; the progress counts calls done', async () => {
  const list = ['g', 'h', 'i', 'j', 'k'].map((c) => kase(commit, `you: x\ncall Bash: ${c.repeat(25_000)}`));
  const { s, env, calls } = claude([{ stdout: answer([{ case: '1', rule: 'r1', verdict: 'none' }]) }]);
  const told: number[][] = [];
  const result = await judge(list, { ...env, FAKE_CLAUDE_WAIT: '500' }, s.cacheDir, (done, of) => told.push([done, of]));
  assert.deepEqual(result, { judged: 5, tokens: 20_500, errors: [] });
  assert.equal(Math.max(...calls().map((c) => c.running)), 3);
  assert.deepEqual(told, [[0, 5], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);
  assert.deepEqual(list.map(cached(s.cacheDir)), list.map(() => ({ verdict: 'none' })));
});

// What judging costs, and what a run judges within its budget.
const twenty = judged('never commit for me!');

test('the estimate: the prompts judging sends, ~1.8 characters a token, ~1.2k tokens a call, ~210 a verdict', async () => {
  const { s, env, calls } = claude([{ stdout: answer([]) }]);
  const shared = { ...twenty, context: 'x'.repeat(3000) }; // not hex: it would read as a secret
  const list = [kase(shared, 'e'.repeat(10_000)), kase(shared, 'e'.repeat(10_000)), kase(judged('another rule'), 'f'.repeat(30_000))];
  await judge(list, env, s.cacheDir);
  const sent = calls().reduce((n, c) => n + c.stdin.length, 0);
  assert.equal(calls().length, 2);
  assert.deepEqual(estimate(list), { calls: 2, tokens: 1200 * 2 + Math.ceil(sent / 1.8) + 210 * 3 });
  // A rule is read once a call: the words around it don't count again for its second case.
  assert.equal(calls().find((c) => c.stdin.includes('never commit for me!')).stdin.split('x'.repeat(3000)).length, 2);
});

const timed = (rule: Rule, day: number): Case => ({ ...kase(rule, 'you: x\ncall Bash: y'), at: `2026-11-0${day}T10:00:00Z` });
const t1 = judged('never git add -A');
const t2 = judged('never force-push');
const j1 = judged('commit only when asked');

test('tool candidates first, then judgment cases; rules in turn, latest rule first', () => {
  const [t1a, t1b, t2a, j1a, j1b] = [timed(t1, 3), timed(t1, 2), timed(t2, 4), timed(j1, 9), timed(j1, 8)];
  assert.deepEqual(select([[t1a, t1b], [t2a]], [[j1a, j1b]], Infinity), [t2a, t1a, t1b, j1a, j1b]);
});

test('the selection stops at the budget', () => {
  const list = [timed(t1, 3), timed(t1, 2), timed(t1, 1)];
  assert.deepEqual(select([list], [], estimate(list.slice(0, 2)).tokens), list.slice(0, 2));
});

test("a case taken brings the other rules' cases on its excerpt: they cost a rule and a verdict, so a run judges more", () => {
  const ex = (c: string) => `you: x\ncall Bash: ${c.repeat(10_000)}`;
  const j2 = judged('never deploy on fridays');
  const day = (d: number) => `2026-11-0${d}T10:00:00Z`;
  const [c1, c2] = [{ ...on(j1, ex('a'), 'e1'), at: day(5) }, { ...on(j1, ex('b'), 'e2'), at: day(4) }];
  const [d1, d2] = [{ ...on(j2, ex('c'), 'e3'), at: day(3) }, { ...on(j2, ex('a'), 'e1'), at: day(2) }];
  // Without them, the run would stop after c1 and d1: c2's excerpt doesn't fit.
  const budget = estimate([c1, d1]).tokens + 500;
  const ids = (list: Case[]) => list.map((c) => c.id);
  assert.deepEqual(ids(select([], [[c1, c2], [d1, d2]], budget)), ids([c1, d2, d1]));
  assert.deepEqual(ids(select([], [[c1, c2], [d1, d2]], Infinity)), ids([c1, d2, d1, c2]));
  // A tool candidate and a judgment case on one event share it too.
  const t = { ...on(t1, ex('a'), 'e1'), at: day(1) };
  assert.deepEqual(ids(select([[t]], [[c1, c2]], Infinity)), ids([t, c1, c2]));
  // A case brought along is still within the budget: the first that doesn't fit ends the selection.
  assert.deepEqual(ids(select([], [[c1, c2], [d1, d2]], estimate([c1]).tokens + 10)), ids([c1]));
});

test('nothing waiting, nothing selected', () => {
  assert.deepEqual(select([], [], 150_000), []);
});

test('the labelled set: every case is well formed', () => {
  assert.equal(LABELLED.length, 34);
  // Three excerpts with two rules each: their cases share a key.
  assert.equal(new Set(labelled().map((k) => k.id.slice(9))).size, 31);
  const list = labelled();
  for (const k of list) {
    const lines = k.excerpt.split('\n');
    assert.match(lines[0], /^(session|you|task): /, k.excerpt);
    assert.match(lines.at(-1)!, /^(call |reply: )/, k.excerpt);
  }
  assert.equal(new Set(list.map((k) => k.id)).size, LABELLED.length);
});
