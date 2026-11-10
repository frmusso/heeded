import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { estimate, extract, type Section, sections } from '../src/rules.ts';
import { installFakeClaude } from './support/fake-claude.ts';
import { sandbox } from './support/sandbox.ts';

const section = (text: string, hash = text.slice(0, 8), path: string[] = []): Section => ({ path, text, hash });

test('the estimate: one call per 30,000 characters of sections, ~4k tokens each, plus the text read and written', () => {
  assert.deepEqual(estimate([section('x'.repeat(10_000)), section('y'.repeat(25_000))]), { calls: 2, tokens: 25_500 });
  assert.deepEqual(estimate([section('x'.repeat(10_000)), section('y'.repeat(20_000))]), { calls: 1, tokens: 19_000 });
  assert.deepEqual(estimate([section('x'.repeat(45_000))]), { calls: 1, tokens: 26_500 });
});

/** What `claude -p --output-format json --json-schema` prints. */
const answer = (sections: { id: string; rules: unknown[] }[], tokens = [3800, 0, 0, 200]) => {
  const structured = { sections };
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(structured), structured_output: structured,
    usage: { input_tokens: tokens[0], cache_creation_input_tokens: tokens[1], cache_read_input_tokens: tokens[2],
      output_tokens: tokens[3] },
    total_cost_usd: 0.01,
  });
};

/** A sandbox with the fake `claude` answering `replies` in turn, and its log of calls. */
function claude(replies: { stdout?: string; exit?: number; stderr?: string }[]) {
  const s = sandbox();
  installFakeClaude(s.bin);
  const log = join(s.root, 'claude.log');
  const env = { ...s.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_REPLY: JSON.stringify(replies) };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { s, env, calls };
}

test('one isolated claude -p call per batch: the exact flags, an empty folder of its own, the prompt on stdin', async () => {
  const { s, env, calls } = claude([{ stdout: answer([{ id: '1', rules: [] }]) }]);
  const key = `sk-${'ant-api03-Zx9_Qw8-Er7Ty6Ui5Op4'}`;
  await extract([section(`## git\n\n- never push with ${key}`, 'h1', ['rules'])], env);
  const [call] = calls();
  const schema = call.argv[6];
  assert.deepEqual(call.argv, ['-p', '--model', 'sonnet', '--output-format', 'json', '--json-schema', schema,
    '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}']);
  assert.equal(JSON.parse(schema).type, 'object');
  assert.deepEqual(call.cwdEntries, []);
  assert.equal(existsSync(call.cwd), false);
  assert.match(call.stdin, /<section id="1" path="rules">\n## git\n\n- never push with …\n<\/section>/);
  assert.ok(!call.stdin.includes(key));
  assert.ok(!call.stdin.includes(s.root));
});

test('rules come back by section id, unknown ids ignored; tokens summed', async () => {
  const rule = { quote: 'q', name: 'n', kind: 'judgment', trigger: 't' };
  const { env, calls } = claude([
    { stdout: answer([{ id: '1', rules: [rule] }, { id: '9', rules: [rule] }], [3800, 100, 0, 200]) },
    { stdout: answer([{ id: '2', rules: [] }, { id: '1', rules: [] }], [3800, 0, 50, 300]) },
  ]);
  const result = await extract([section('a'.repeat(20_000), 'ha'), section('b'.repeat(25_000), 'hb'), section('c', 'hc')], env);
  assert.equal(calls().length, 2);
  assert.deepEqual(result, { rules: new Map([['ha', [rule]], ['hb', []], ['hc', []]]), tokens: 8250, errors: [] });
});

test('claude not on the PATH: one error, nothing read, no other call tried', async () => {
  const s = sandbox();
  const result = await extract([section('a'.repeat(20_000), 'ha'), section('b'.repeat(20_000), 'hb')], s.env);
  assert.deepEqual(result, { rules: new Map(), tokens: 0,
    errors: ['claude not found. install claude code, or run heeded where claude runs.'] });
});

test('a call that fails or answers out of shape: an error, nothing read for its batch; the other batches still read', async () => {
  const { env, calls } = claude([
    { exit: 1, stderr: 'Error: rate limited\nretry later\n' },
    { stdout: JSON.stringify({ type: 'result', is_error: true, result: 'nope' }) },
    { stdout: answer([{ id: '1', rules: 'none' as never }]) },
    { stdout: 'not json' },
    { stdout: answer([{ id: '1', rules: [] }]) },
  ]);
  const result = await extract(['a', 'b', 'c', 'd', 'e'].map((x) => section(x.repeat(20_000), `h${x}`)), env);
  assert.equal(calls().length, 5);
  const shape = "claude's answer didn't match the schema";
  assert.deepEqual(result.errors, ['claude exited with code 1: Error: rate limited', shape, shape, shape]);
  assert.deepEqual(result.rules, new Map([['he', []]]));
});

test("the sandbox's PATH holds only its own folder, so the real claude is never reached, even when it sits next to node", () => {
  const s = sandbox();
  for (const dir of s.env.PATH.split(':')) assert.ok(dir.startsWith(s.root), dir);
});

test('a secret in a heading above the section never reaches claude either', async () => {
  const { env, calls } = claude([{ stdout: answer([{ id: '1', rules: [] }]) }]);
  const key = `gh${'p_'}Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78`;
  const [, section] = sections(`# deploy with ${key}\n\nhow\n\n## rules\n\n- never push`);
  await extract([section], env);
  assert.ok(!calls()[0].stdin.includes(key));
  assert.match(calls()[0].stdin, /path="deploy with …"/);
});

test('an answer that leaves a section out: an error, nothing read for its batch', async () => {
  const rule = { quote: 'q', name: 'n', kind: 'judgment', trigger: 't' };
  const { env } = claude([{ stdout: answer([{ id: 'section-1', rules: [rule] }, { id: '2', rules: [] }]) }]);
  const result = await extract([section('a', 'ha'), section('b', 'hb')], env);
  assert.deepEqual(result.errors, ["claude's answer didn't match the schema"]);
  assert.deepEqual(result.rules, new Map());
});
