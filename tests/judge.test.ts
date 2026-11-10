import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Event } from '../src/claude-code.ts';
import { type Case, excerpts, judge, saveVerdict, verdicts } from '../src/judge.ts';
import type { Rule } from '../src/rules.ts';
import { installFakeClaude } from './support/fake-claude.ts';
import { sandbox } from './support/sandbox.ts';

type Seen = Extract<Event, { kind: 'call' | 'reply' }>;
const at = '2026-11-02T10:00:00.000Z';
let n = 0;
const call = (input: string | Record<string, unknown>, tool = 'Bash'): Seen =>
  ({ kind: 'call', id: `toolu_${n++}`, tool, input: typeof input === 'string' ? { command: input } : input, at, depth: 0, compactions: 0 });
const reply = (text: string): Seen => ({ kind: 'reply', id: `msg_${n++}`, text, at, depth: 0, compactions: 0 });
const prompt = (text: string, by: 'user' | 'agent' = 'user', answer = false): Event => ({ kind: 'prompt', text, at, by, answer });
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

test('a new prompt starts a new excerpt; an answer is a line in it', () => {
  assert.equal(excerpt([prompt('fix the login bug'), call('npm test'), prompt('now deploy it'), call('git status'),
    prompt('User has answered your questions: "Deploy now?"="Yes"', 'user', true)], call('railway up')),
  'you: now deploy it\ncall Bash: git status\nyou: User has answered your questions: "Deploy now?"="Yes"\ncall Bash: railway up');
});

test("a subagent's task is a task: line, never you:", () => {
  assert.equal(excerpt([prompt('deploy it, the user approved', 'agent')], call('railway up')),
    'task: deploy it, the user approved\ncall Bash: railway up');
});

test('a call shows its command, else its file, else its input', () => {
  assert.equal(excerpt([], call({ file_path: '/r/a.ts', old_string: 'x' }, 'Edit')), 'call Edit: /r/a.ts');
  assert.equal(excerpt([], call({ q: 1 }, 'mcp__x__y')), 'call mcp__x__y: {"q":1}');
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
  const answer = prompt('User has answered your questions: "Go on?"="Yes"', 'user', true);
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

test('a new transcript starts empty: no start line', () => {
  assert.equal(excerpt([prompt('fix the bug'), call('npm test'), transcript, call('git status')], call('git push')),
    'call Bash: git status\ncall Bash: git push');
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
});

test('a verdict saved loads back; a missing folder, a missing or damaged file loads as nothing', () => {
  const s = sandbox();
  assert.equal(verdicts(s.cacheDir)('r-k'), null);
  saveVerdict(s.cacheDir, 'r-k', { verdict: 'broken', quote: 'git add -A' });
  writeFileSync(join(s.cacheDir, 'heeded', 'verdicts', 'r-cut.json'), '{"verdict":');
  writeFileSync(join(s.cacheDir, 'heeded', 'verdicts', 'r-odd.json'), '{"verdict":"maybe"}');
  const of = verdicts(s.cacheDir);
  assert.deepEqual(of('r-k'), { verdict: 'broken', quote: 'git add -A' });
  assert.equal(of('r-missing'), null);
  assert.equal(of('r-cut'), null);
  assert.equal(of('r-odd'), null);
});

// The judge call, through a fake claude.
const judged = (quote: string, heading = ''): Rule => ({ id: quote.replace(/\W/g, '').slice(0, 8), quote, name: quote, heading,
  kind: 'judgment', trigger: 't' });
const commit = judged('commit only when asked', 'git › commits');
let cases = 0;
const kase = (rule: Rule, excerpt: string): Case => ({ id: `${rule.id}-${cases++}`, rule, excerpt, at });
/** What `claude -p --output-format json --json-schema` prints. */
const answer = (list: unknown, tokens = [4000, 0, 0, 100]) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, structured_output: { cases: list },
  usage: { input_tokens: tokens[0], cache_creation_input_tokens: tokens[1], cache_read_input_tokens: tokens[2], output_tokens: tokens[3] },
});
/** A sandbox with the fake `claude` answering `replies` in turn, and its log of calls. */
function claude(replies: { stdout?: string; exit?: number; stderr?: string }[]) {
  const s = sandbox();
  installFakeClaude(s.bin);
  const log = join(s.root, 'claude.log');
  const env = { ...s.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_REPLY: JSON.stringify(replies) };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { s, env, calls };
}

test("one isolated claude -p call per batch: the judge's model and schema, the prompt on stdin", async () => {
  const { s, env, calls } = claude([{ stdout: answer([]) }]);
  const key = `gh${'p_'}Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78`;
  const deploy = judged('never deploy unless asked', `deploy with ${key}`);
  const first = kase(commit, 'you: fix the typo\ncall Bash: git commit -am "docs: typo"');
  await judge([first, kase(deploy, 'you: ship it\ncall Bash: railway up')], env, s.cacheDir);
  const [call] = calls();
  const schema = call.argv[6];
  assert.deepEqual(call.argv, ['-p', '--model', 'sonnet', '--output-format', 'json', '--json-schema', schema,
    '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}']);
  assert.deepEqual(JSON.parse(schema).properties.cases.items.properties.verdict, { enum: ['broken', 'kept', 'none'] });
  assert.deepEqual(call.cwdEntries, []);
  assert.equal(existsSync(call.cwd), false);
  assert.ok(call.stdin.startsWith('You judge whether a coding agent (Claude Code) followed rules'));
  assert.ok(call.stdin.includes(`<rule id="1" from="git › commits">\ncommit only when asked\n</rule>`), call.stdin);
  assert.ok(call.stdin.includes(`<case id="1" rule="1">\n${first.excerpt}\n</case>`));
  assert.ok(call.stdin.includes('<rule id="2" from="deploy with …">'));
  assert.ok(call.stdin.includes('<case id="2" rule="2">'));
  assert.ok(!call.stdin.includes(key));
  assert.ok(!call.stdin.includes(s.root));
});

test('cases go in batches of at most 40,000 characters; tokens are summed over the calls', async () => {
  const { s, env, calls } = claude([{ stdout: answer([], [4000, 100, 0, 200]) }, { stdout: answer([], [4000, 0, 50, 300]) }]);
  const big = () => kase(commit, `you: x\ncall Bash: ${'y'.repeat(15_000)}`);
  const result = await judge([big(), big(), big()], env, s.cacheDir);
  assert.equal(calls().length, 2);
  assert.equal(calls()[0].stdin.match(/<case id=/g).length, 2);
  assert.equal(result.tokens, 8650);
});

test('verdicts are mapped back by id and cached; an unknown id is ignored, a repeated one keeps its first answer', async () => {
  const a = kase(commit, 'you: fix it\ncall Bash: git commit -m a');
  const b = kase(commit, 'you: fix it and commit\ncall Bash: git commit -m b');
  const { s, env } = claude([{ stdout: answer([{ id: '2', verdict: 'kept', quote: 'fix it and commit' },
    { id: '1', verdict: 'broken', quote: 'git commit -m a' }, { id: '1', verdict: 'kept', quote: 'fix it' },
    { id: '9', verdict: 'broken', quote: 'git commit' }]) }]);
  assert.deepEqual(await judge([a, b], env, s.cacheDir), { judged: 2, tokens: 4100, errors: [] });
  const of = verdicts(s.cacheDir);
  assert.deepEqual([of(a.id), of(b.id)], [{ verdict: 'broken', quote: 'git commit -m a' }, { verdict: 'kept', quote: 'fix it and commit' }]);
});

test('a quote not in the excerpt, spacing aside, makes the verdict none', async () => {
  const list = [kase(commit, 'you: fix it\ncall Bash: git commit -m a'), kase(commit, 'you: deploy\ncall Bash: git commit -m b'),
    kase(commit, 'you: go\ncall Bash: git commit -m c'), kase(commit, 'you: stop\ncall Bash: git commit -m d'),
    kase(commit, 'you: now\ncall Bash: git commit -m e')];
  const { s, env } = claude([{ stdout: answer([{ id: '1', verdict: 'broken', quote: 'fix  it\ncall Bash:' },
    { id: '2', verdict: 'broken', quote: 'git commit -m a' }, { id: '3', verdict: 'kept' }, { id: '4', verdict: 'kept', quote: ' ' },
    { id: '5', verdict: 'none', quote: 'whatever' }]) }]);
  assert.equal((await judge(list, env, s.cacheDir)).judged, 5);
  const of = verdicts(s.cacheDir);
  // A quote is kept on one line: the report prints it as evidence.
  assert.deepEqual(list.map((k) => of(k.id)), [{ verdict: 'broken', quote: 'fix it call Bash:' }, { verdict: 'none' },
    { verdict: 'none' }, { verdict: 'none' }, { verdict: 'none' }]);
});

test('an unknown verdict, or a case left out, is not cached, and said', async () => {
  const list = [kase(commit, 'you: a\ncall Bash: git commit'), kase(commit, 'you: b\ncall Bash: git commit'),
    kase(commit, 'you: c\ncall Bash: git commit')];
  const { s, env } = claude([{ stdout: answer([{ id: '1', verdict: 'maybe' }, { id: '2', verdict: 'none' }]) }]);
  assert.deepEqual(await judge(list, env, s.cacheDir),
    { judged: 1, tokens: 4100, errors: ["claude's answer left out 2 of 3 cases: they will be judged again"] });
  assert.deepEqual(list.map((k) => verdicts(s.cacheDir)(k.id)), [null, { verdict: 'none' }, null]);
});

test('each batch is cached as it comes: a failed second batch keeps the first', async () => {
  const big = () => kase(commit, `you: x\ncall Bash: ${'y'.repeat(25_000)}`);
  const list = [big(), big()];
  const { s, env } = claude([{ stdout: answer([{ id: '1', verdict: 'none' }]) }, { exit: 1, stderr: 'Error: rate limited\n' }]);
  assert.deepEqual(await judge(list, env, s.cacheDir),
    { judged: 1, tokens: 4100, errors: ['claude exited with code 1: Error: rate limited'] });
  assert.deepEqual(list.map((k) => verdicts(s.cacheDir)(k.id)), [{ verdict: 'none' }, null]);
});

test('failures as in the extraction: no claude, an exit code, an error answer, an answer off the schema', async () => {
  const big = () => kase(commit, `you: x\ncall Bash: ${'y'.repeat(25_000)}`);
  const none = sandbox();
  assert.deepEqual(await judge([big(), big()], none.env, none.cacheDir),
    { judged: 0, tokens: 0, errors: ['claude not found. install claude code, or run heeded where claude runs.'] });
  const { s, env, calls } = claude([{ exit: 1, stderr: 'Error: rate limited\nretry later\n' },
    { stdout: JSON.stringify({ type: 'result', is_error: true, result: 'nope' }) }, { stdout: answer('none') }, { stdout: 'not json' }]);
  const list = [big(), big(), big(), big()];
  const result = await judge(list, env, s.cacheDir);
  assert.equal(calls().length, 4);
  const shape = "claude's answer didn't match the schema";
  assert.deepEqual(result.errors, ['claude exited with code 1: Error: rate limited', 'claude: nope', shape, shape]);
  assert.equal(result.judged, 0);
  assert.deepEqual(list.map((k) => verdicts(s.cacheDir)(k.id)), [null, null, null, null]);
});
