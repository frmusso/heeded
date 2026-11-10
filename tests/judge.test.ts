import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Event } from '../src/claude-code.ts';
import { excerpts, saveVerdict, verdicts } from '../src/judge.ts';
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
