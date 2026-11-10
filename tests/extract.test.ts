import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { estimate, extract, load, rulesOf, type Section, sections } from '../src/rules.ts';
import { installFakeClaude } from './support/fake-claude.ts';
import { sandbox } from './support/sandbox.ts';

const section = (text: string, hash = text.slice(0, 8), path: string[] = []): Section => ({ path, text, hash });
/** Sections as the counter hands them over: each its own section, never in effect during a call. */
const pending = (...list: Section[]) => list.map((s) => ({ section: s, identity: s.hash, at: '' }));

test('the estimate: one call per 30,000 characters of sections, ~4.4k tokens each, plus the text read and the answer', () => {
  assert.deepEqual(estimate([section('x'.repeat(10_000)), section('y'.repeat(25_000))]), { calls: 2, tokens: 35_050 });
  assert.deepEqual(estimate([section('x'.repeat(10_000)), section('y'.repeat(20_000))]), { calls: 1, tokens: 26_900 });
  assert.deepEqual(estimate([section('x'.repeat(45_000))]), { calls: 1, tokens: 38_150 });
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
  await extract(pending(section(`## git\n\n- never push with ${key}`, 'h1', ['rules'])), env, s.cacheDir);
  const [call] = calls();
  const schema = call.argv[6];
  assert.deepEqual(call.argv, ['-p', '--model', 'sonnet', '--output-format', 'json', '--json-schema', schema,
    '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}']);
  const check = JSON.parse(schema).properties.sections.items.properties.rules.items.properties.check.properties;
  assert.deepEqual([check.when.properties.data, check.broken.properties.data], [{ type: 'string' }, { type: 'string' }]);
  assert.deepEqual(call.cwdEntries, []);
  assert.equal(existsSync(call.cwd), false);
  assert.match(call.stdin, /<section id="1" path="rules">\n## git\n\n- never push with …\n<\/section>/);
  assert.ok(!call.stdin.includes(key));
  assert.ok(!call.stdin.includes(s.root));
});

test('each batch is cached as it is read, by section id, unknown ids ignored; tokens summed', async () => {
  const rule = { quote: 'q', name: 'n', kind: 'judgment', trigger: 't' };
  const { s, env, calls } = claude([
    { stdout: answer([{ id: '1', rules: [rule] }, { id: '9', rules: [rule] }], [3800, 100, 0, 200]) },
    { stdout: answer([{ id: '2', rules: [] }, { id: '1', rules: [] }], [3800, 0, 50, 300]) },
  ]);
  const result = await extract(pending(section('a'.repeat(20_000), 'ha'), section('b'.repeat(25_000), 'hb'), section('c', 'hc')), env,
    s.cacheDir);
  assert.equal(calls().length, 2);
  assert.deepEqual(result, { read: 3, tokens: 8250, errors: [] });
  assert.deepEqual([load(s.cacheDir, 'ha'), load(s.cacheDir, 'hb'), load(s.cacheDir, 'hc')], [[rule], [], []]);
});

test('claude not on the PATH: one error, nothing read, no other call tried', async () => {
  const s = sandbox();
  const result = await extract(pending(section('a'.repeat(20_000), 'ha'), section('b'.repeat(20_000), 'hb')), s.env, s.cacheDir);
  assert.deepEqual(result, { read: 0, tokens: 0, errors: ['claude not found. install claude code, or run heeded where claude runs.'] });
});

test('a call that fails or answers out of shape: an error, nothing read for its batch; the other batches still read', async () => {
  const { s, env, calls } = claude([
    { exit: 1, stderr: 'Error: rate limited\nretry later\n' },
    { stdout: JSON.stringify({ type: 'result', is_error: true, result: 'nope' }) },
    { stdout: answer([{ id: '1', rules: 'none' as never }]) },
    { stdout: 'not json' },
    { stdout: answer([{ id: '1', rules: [] }]) },
  ]);
  const result = await extract(pending(...['a', 'b', 'c', 'd', 'e'].map((x) => section(x.repeat(20_000), `h${x}`))), env, s.cacheDir);
  assert.equal(calls().length, 5);
  const shape = "claude's answer didn't match the schema";
  assert.deepEqual(result.errors, ['claude exited with code 1: Error: rate limited', 'claude: nope', shape, shape]);
  assert.equal(result.read, 1);
  assert.deepEqual(['ha', 'hb', 'hc', 'hd', 'he'].map((h) => load(s.cacheDir, h)), [null, null, null, null, []]);
});

test("the sandbox's PATH holds only its own folder, so the real claude is never reached, even when it sits next to node", () => {
  const s = sandbox();
  for (const dir of s.env.PATH.split(':')) assert.ok(dir.startsWith(s.root), dir);
});

test('a secret in a heading above the section never reaches claude either', async () => {
  const { s, env, calls } = claude([{ stdout: answer([{ id: '1', rules: [] }]) }]);
  const key = `gh${'p_'}Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78`;
  const [, section] = sections(`# deploy with ${key}\n\nhow\n\n## rules\n\n- never push`);
  await extract(pending(section), env, s.cacheDir);
  assert.ok(!calls()[0].stdin.includes(key));
  assert.match(calls()[0].stdin, /path="deploy with …"/);
});

test('an answer that leaves a section out: the ones answered are kept, the one left out is asked about again', async () => {
  const rule = { quote: 'q', name: 'n', kind: 'judgment', trigger: 't' };
  const { s, env } = claude([{ stdout: answer([{ id: 'section-1', rules: [rule] }, { id: '2', rules: [] }]) }]);
  const result = await extract(pending(section('a', 'ha'), section('b', 'hb')), env, s.cacheDir);
  assert.deepEqual(result.errors, ["claude's answer left out 1 of 2 sections: they will be asked about again"]);
  assert.equal(result.read, 1);
  assert.deepEqual([load(s.cacheDir, 'ha'), load(s.cacheDir, 'hb')], [null, []]);
});

test('a failed call says what claude said: the first line of its error, wherever it wrote it', async () => {
  const { s, env } = claude([{ exit: 1, stdout: 'Invalid API key · Please run /login\n' }]);
  assert.deepEqual((await extract(pending(section('a', 'ha')), env, s.cacheDir)).errors,
    ['claude exited with code 1: Invalid API key · Please run /login']);
});

test('a section read is remembered with when it was in effect: its other versions take its rules', async () => {
  const later = '## git\n\n- never force-push';
  const { s, env } = claude([{ stdout: answer([{ id: '1', rules: [{ quote: 'never force-push', name: 'n', kind: 'judgment', trigger: 't' }] }]) }]);
  const [read] = sections(later);
  await extract([{ section: read, identity: JSON.stringify(['/r/CLAUDE.md', [], '## git']), at: '2026-11-05T10:00:00Z' }], env, s.cacheDir);
  const older = rulesOf(s.cacheDir)({ path: '/r/CLAUDE.md', type: 'Project', content: `${later}, ever` })!;
  assert.deepEqual(older.rules.map((r) => r.quote), ['never force-push']);
  assert.deepEqual(older.versions.map((u) => u.readAt), ['2026-11-05T10:00:00Z']);
});

test('the same text under two paths is sent once, and remembered for both', async () => {
  const text = '## git\n\n- never force-push';
  const { s, env, calls } = claude([{ stdout: answer([{ id: '1', rules: [{ quote: 'never force-push', name: 'n', kind: 'judgment', trigger: 't' }] }]) }]);
  const [read] = sections(text);
  const id = (path: string) => JSON.stringify([path, [], '## git']);
  const result = await extract([{ section: read, identity: id('/r/CLAUDE.md'), at: '2026-11-05T10:00:00Z' },
    { section: read, identity: id('/r/w/CLAUDE.md'), at: '2026-11-04T10:00:00Z' }], env, s.cacheDir);
  assert.equal(result.read, 1);
  assert.equal(calls()[0].stdin.match(/<section id=/g)!.length, 1);
  for (const path of ['/r/CLAUDE.md', '/r/w/CLAUDE.md']) {
    const older = rulesOf(s.cacheDir)({ path, type: 'Project', content: `${text}, ever` })!;
    assert.deepEqual(older.rules.map((r) => r.quote), ['never force-push'], path);
  }
});
