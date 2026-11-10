import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { type Event, read } from '../src/claude-code.ts';
import { sandbox } from './support/sandbox.ts';
import { answer, assistant, compact, instructions, type Line, meta, nested, noise, summary, user, writeSession }
  from './support/transcript.ts';

async function all(configDir: string, folder: string): Promise<Event[]> {
  const out: Event[] = [];
  await read(configDir, folder, (e) => out.push(e));
  return out;
}
/** The events but prompts: most tests are about the others, and the sessions they write start with one. */
const events = async (configDir: string, folder: string) => (await all(configDir, folder)).filter((e) => e.kind !== 'prompt');

test('no projects folder: no events, no error', async () => {
  const s = sandbox();
  assert.deepEqual(await events(s.configDir, join(s.root, 'repo')), []);
});

test('the folder and its worktrees are read; a sibling folder sharing the prefix is skipped by its cwd', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  writeSession(s.configDir, repo, 'a', [noise('queue-operation', 10), user('hi')]);
  writeSession(s.configDir, join(repo, '.claude', 'worktrees', 'w'), 'b', [user('hi')]);
  writeSession(s.configDir, `${repo}-notes`, 'c', [noise('queue-operation', 10), user('hi')]);
  writeSession(s.configDir, `${repo}-notes`, 'd', [user('hi')]);
  // A folder whose name only starts with the encoded folder is never listed, whatever cwd its sessions recorded.
  writeSession(s.configDir, `${repo}sitory`, 'e', [{ ...user('hi'), cwd: repo }]);
  assert.deepEqual(await events(s.configDir, repo), [
    { kind: 'transcript', session: 'a', agent: null },
    { kind: 'transcript', session: 'b', agent: null },
  ]);
});

test('a folder opened through a symlink: sessions recorded under its real path are read', async () => {
  const s = sandbox();
  const real = join(s.root, 'real');
  mkdirSync(real);
  symlinkSync(real, join(s.root, 'link'));
  writeSession(s.configDir, real, 'a', [user('hi')]);
  assert.deepEqual(await events(s.configDir, join(s.root, 'link')), [{ kind: 'transcript', session: 'a', agent: null }]);
});

test('symlinks are not followed: neither a project folder nor a transcript', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const main = writeSession(s.configDir, repo, 'a', [user('hi')]);
  const elsewhere = writeSession(s.configDir, join(s.root, 'elsewhere'), 'b', [{ ...user('hi'), cwd: repo }]);
  symlinkSync(elsewhere, join(dirname(main), 'c.jsonl'));
  symlinkSync(dirname(elsewhere), `${dirname(main)}-linked`);
  assert.deepEqual(await events(s.configDir, repo), [{ kind: 'transcript', session: 'a', agent: null }]);
});

test("a session's subagents follow it, and are skipped with it", async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  writeSession(s.configDir, repo, 'a', [user('hi')], { x1: [user('task')], x2: [user('task')] });
  writeSession(s.configDir, `${repo}-notes`, 'b', [user('hi')], { y1: [user('task')] });
  assert.deepEqual(await events(s.configDir, repo), [
    { kind: 'transcript', session: 'a', agent: null },
    { kind: 'transcript', session: 'a', agent: 'x1' },
    { kind: 'transcript', session: 'a', agent: 'x2' },
  ]);
});

const claudeMd = { path: '/r/CLAUDE.md', type: 'Project', content: '# rules\n\n- never x' };
const localMd = { path: '/r/CLAUDE.local.md', type: 'Local', content: '- talk in italian' };

test('the instruction files recorded at the start', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  writeSession(s.configDir, repo, 'a', [noise('queue-operation', 10), instructions([claudeMd, localMd]), user('hi')]);
  assert.deepEqual(await events(s.configDir, repo), [
    { kind: 'transcript', session: 'a', agent: null },
    { kind: 'instructions', files: [claudeMd, localMd], replace: false },
  ]);
});

test('a file edited mid-session: only that file, recorded again with its new content', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const edited = { ...localMd, content: '- talk in english' };
  writeSession(s.configDir, repo, 'a', [instructions([claudeMd, localMd]), user('hi'), instructions([edited])]);
  assert.deepEqual((await events(s.configDir, repo)).slice(1), [
    { kind: 'instructions', files: [claudeMd, localMd], replace: false },
    { kind: 'instructions', files: [edited], replace: false },
  ]);
});

test('a compaction, then the files recorded again in full: they replace the ones in effect', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  writeSession(s.configDir, repo, 'a', [instructions([claudeMd, localMd]), compact(167000), summary(), instructions([claudeMd]),
    instructions([localMd])]);
  assert.deepEqual((await events(s.configDir, repo)).slice(1), [
    { kind: 'instructions', files: [claudeMd, localMd], replace: false },
    { kind: 'compaction', trigger: 'auto', preTokens: 167000 },
    { kind: 'instructions', files: [claudeMd], replace: true },
    { kind: 'instructions', files: [localMd], replace: false },
  ]);
});

test('a nested CLAUDE.md loaded on demand: one more file in effect', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const sub = { path: '/r/src/CLAUDE.md', type: 'Project', content: '- no default exports' };
  writeSession(s.configDir, repo, 'a', [instructions([claudeMd]), compact(1000), nested(sub)]);
  assert.deepEqual((await events(s.configDir, repo)).slice(1), [
    { kind: 'instructions', files: [claudeMd], replace: false },
    { kind: 'compaction', trigger: 'auto', preTokens: 1000 },
    { kind: 'instructions', files: [sub], replace: false },
  ]);
});

const usage = (input: number, created: number, read: number) =>
  ({ input_tokens: input, cache_creation_input_tokens: created, cache_read_input_tokens: read, output_tokens: 40 });

test('a tool call: its id, tool, input and time, the context depth, the compactions before it', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const tool = { id: 'tu1', name: 'Bash', input: { command: 'git status' } };
  writeSession(s.configDir, repo, 'a', [compact(1000),
    { ...assistant({ id: 'm1', tool, usage: usage(3, 500, 120000) }), timestamp: '2026-11-02T10:00:00.000Z' }]);
  assert.deepEqual((await events(s.configDir, repo)).slice(2), [
    { kind: 'call', id: 'tu1', tool: 'Bash', input: { command: 'git status' }, at: '2026-11-02T10:00:00.000Z', depth: 120503,
      compactions: 1 },
  ]);
});

test('a line without usage keeps the depth last seen', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const tool = (id: string) => ({ id, name: 'Read', input: { file_path: 'a.ts' } });
  writeSession(s.configDir, repo, 'a', [assistant({ id: 'm1', tool: tool('t1'), usage: usage(10, 20, 30) }),
    assistant({ id: 'm2', tool: tool('t2') })]);
  assert.deepEqual((await events(s.configDir, repo)).map((e) => e.kind === 'call' && e.depth), [false, 60, 60]);
});

test("the text blocks of one message are one reply, out before its calls; subagents' replies are not read", async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const at = (t: string, line: object) => ({ ...line, timestamp: `2026-11-02T10:00:0${t}.000Z` });
  const tool = { id: 'tu1', name: 'Bash', input: { command: 'ls' } };
  const lines = [at('1', assistant({ id: 'm1', text: 'first', usage: usage(1, 2, 3) })),
    at('2', assistant({ id: 'm1', text: 'second', usage: usage(1, 2, 3) })), at('3', assistant({ id: 'm1', tool })),
    at('4', assistant({ id: 'm2', text: 'third', usage: usage(5, 5, 5) }))];
  writeSession(s.configDir, repo, 'a', lines, { x1: lines });
  const call = { kind: 'call', id: 'tu1', tool: 'Bash', input: { command: 'ls' }, at: '2026-11-02T10:00:03.000Z', depth: 6, compactions: 0 };
  assert.deepEqual(await events(s.configDir, repo), [
    { kind: 'transcript', session: 'a', agent: null },
    { kind: 'reply', id: 'm1', text: 'first\nsecond', at: '2026-11-02T10:00:01.000Z', depth: 6, compactions: 0 },
    call,
    { kind: 'reply', id: 'm2', text: 'third', at: '2026-11-02T10:00:04.000Z', depth: 15, compactions: 0 },
    { kind: 'transcript', session: 'a', agent: 'x1' },
    call,
  ]);
});

test('noise gives nothing, nor a tool result holding an assistant-shaped object', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const types = ['last-prompt', 'mode', 'api-request', 'api-request-blob', 'queue-operation', 'file-history-snapshot',
    'file-history-delta', 'ai-title', 'tools-used'];
  const nestedAssistant = { type: 'assistant', message: { id: 'm9', content: [{ type: 'text', text: 'from a subagent' }] } };
  writeSession(s.configDir, repo, 'a', [...types.map((t) => noise(t, 100)), summary(),
    { ...answer('tu9', 'done'), toolUseResult: nestedAssistant }]);
  assert.deepEqual(await all(s.configDir, repo), [{ kind: 'transcript', session: 'a', agent: null }]);
});

test('a line cut short is skipped, the lines around it read', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const tool = { id: 'tu1', name: 'Bash', input: { command: 'ls' } };
  writeSession(s.configDir, repo, 'a', [instructions([claudeMd]), '{"type":"assistant","message":{"id":"m1","content":[{"ty',
    assistant({ id: 'm2', tool })]);
  assert.deepEqual((await events(s.configDir, repo)).map((e) => e.kind), ['transcript', 'instructions', 'call']);
});

test('shapes heeded does not know are skipped', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const bad = (line: Record<string, unknown>, patch: object) => ({ ...line, ...patch });
  writeSession(s.configDir, repo, 'a', [
    { type: 'attachment', attachment: { type: 'instructions' } },
    { type: 'attachment', attachment: { type: 'nested_memory', path: '/r/x/CLAUDE.md' } },
    { type: 'attachment', attachment: { type: 'instructions', files: [{ path: '/r/CLAUDE.md' }, claudeMd] } },
    { type: 'system', subtype: 'compact_boundary' },
    bad(assistant({ id: 'm1', text: 'x' }), { message: { id: 'm1', content: 'x' } }),
    assistant({ id: 'm2', tool: { name: 'Bash', input: { command: 'ls' } } as never }),
    assistant({ id: 'm3', tool: { id: 'tu3', name: 'Bash', input: 'ls' } as never }),
  ]);
  assert.deepEqual((await events(s.configDir, repo)).slice(1), [{ kind: 'instructions', files: [claudeMd], replace: false }]);
});

const unrecognized = async (configDir: string, folder: string) => (await read(configDir, folder, () => {})).unrecognized;
const lines = (n: number, line: string) => Array.from({ length: n }, () => line);

test('from 20 lines on, a file mostly unparsable is named as unrecognized', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const a = writeSession(s.configDir, repo, 'a', [user('hi'), ...lines(9, '{"type":"user"}'), ...lines(11, 'type=user')]);
  const b = writeSession(s.configDir, repo, 'b', [user('hi'), ...lines(9, '{"type":"user"}'),
    ...lines(11, '{"type":"assistant" cut}')]);
  assert.deepEqual(await unrecognized(s.configDir, repo), [a, b]);
});

test('from 20 lines on, a file with no assistant or user line is named as unrecognized', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const file = writeSession(s.configDir, repo, 'a', [{ type: 'attachment', attachment: { type: 'date' } },
    ...lines(19, '{"type":"progress"}')]);
  assert.deepEqual(await unrecognized(s.configDir, repo), [file]);
});

test('under 20 lines a file is not judged, and half unparsable is not most', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  writeSession(s.configDir, repo, 'a', lines(19, 'type=user'));
  writeSession(s.configDir, repo, 'b', [user('hi'), ...lines(9, '{"type":"user"}'), ...lines(10, 'type=user')]);
  assert.deepEqual(await unrecognized(s.configDir, repo), []);
});

test('an empty file: no events, not unrecognized', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const file = writeSession(s.configDir, repo, 'a', []);
  writeFileSync(file, '');
  assert.deepEqual(await events(s.configDir, repo), []);
  assert.deepEqual(await unrecognized(s.configDir, repo), []);
});

test('a transcript that cannot be read is skipped, the others read', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  chmodSync(writeSession(s.configDir, repo, 'a', [user('hi')]), 0o000);
  writeSession(s.configDir, repo, 'b', [user('hi')]);
  assert.deepEqual(await events(s.configDir, repo), [{ kind: 'transcript', session: 'b', agent: null }]);
});

test('a line whose time is not a date is skipped', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const tool = { id: 'tu1', name: 'Bash', input: { command: 'ls' } };
  writeSession(s.configDir, repo, 'a', [{ ...assistant({ id: 'm1', tool }), timestamp: 'not a date' }]);
  assert.deepEqual((await events(s.configDir, repo)).map((e) => e.kind), ['transcript']);
});

test('text, a tool call, then more text in one message: a reply before the call, another after it', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const tool = { id: 'tu1', name: 'Bash', input: { command: 'ls' } };
  writeSession(s.configDir, repo, 'a', [assistant({ id: 'm1', text: 'one' }), assistant({ id: 'm1', tool }),
    assistant({ id: 'm1', text: 'two' }), assistant({ id: 'm2', text: 'three' })]);
  const said = (await events(s.configDir, repo)).slice(1).map((e) => (e.kind === 'reply' ? `${e.id} ${e.text}` : e.kind));
  assert.deepEqual(said, ['m1 one', 'call', 'm1/1 two', 'm2 three']);
});

test("a session's folder or subagents folder that is a symlink is not followed", async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const other = writeSession(s.configDir, join(s.root, 'other'), 'x', [user('hi')], { o1: [user('task')] });
  const a = writeSession(s.configDir, repo, 'a', [user('hi')]);
  symlinkSync(join(dirname(other), 'x'), join(dirname(a), 'a'));
  const b = writeSession(s.configDir, repo, 'b', [user('hi')]);
  mkdirSync(join(dirname(b), 'b'));
  symlinkSync(join(dirname(other), 'x', 'subagents'), join(dirname(b), 'b', 'subagents'));
  assert.deepEqual(await events(s.configDir, repo), [
    { kind: 'transcript', session: 'a', agent: null }, { kind: 'transcript', session: 'b', agent: null },
  ]);
});

const at = (s: string, line: Line) => ({ ...line, timestamp: `2026-11-02T10:00:0${s}.000Z` });
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } };
const prompt = (text: string, s: string, by = 'user', isAnswer = false) =>
  ({ kind: 'prompt', text, at: `2026-11-02T10:00:0${s}.000Z`, by, answer: isAnswer });

test('a user prompt: a string, or text blocks with an image left out', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  writeSession(s.configDir, repo, 'a', [at('1', user('fix the login bug')),
    at('2', { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'look at this' }, image] } })]);
  assert.deepEqual(await all(s.configDir, repo), [{ kind: 'transcript', session: 'a', agent: null },
    prompt('fix the login bug', '1'), prompt('look at this', '2')]);
});

test('not prompts: a tag line, an isMeta line, a compaction summary, an interruption, a tool result, an image alone', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  writeSession(s.configDir, repo, 'a', [user('<command-name>/compact</command-name>'),
    meta('Caveat: the messages below were generated by the user while running local commands.'), summary(),
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    answer('toolu_1', 'file contents'), { type: 'user', message: { role: 'user', content: [image] } }]);
  assert.deepEqual(await all(s.configDir, repo), [{ kind: 'transcript', session: 'a', agent: null }]);
});

test("an answer through AskUserQuestion or ExitPlanMode is the user's words", async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const ask = { id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [] } };
  const plan = { id: 'toolu_p', name: 'ExitPlanMode', input: { plan: 'p' } };
  writeSession(s.configDir, repo, 'a', [assistant({ id: 'm1', tool: ask }),
    at('1', answer('toolu_q', 'User has answered your questions: "Deploy now?"="Yes"')), assistant({ id: 'm2', tool: plan }),
    at('2', answer('toolu_p', [{ type: 'text', text: 'User has approved your plan.' }]))]);
  assert.deepEqual((await all(s.configDir, repo)).filter((e) => e.kind === 'prompt'), [
    prompt('User has answered your questions: "Deploy now?"="Yes"', '1', 'user', true),
    prompt('User has approved your plan.', '2', 'user', true),
  ]);
});

test("a subagent's prompts are its task: by agent", async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  writeSession(s.configDir, repo, 'a', [noise('queue-operation', 10)], { x1: [at('1', user('find the config loader'))] });
  assert.deepEqual((await all(s.configDir, repo)).filter((e) => e.kind === 'prompt'),
    [prompt('find the config loader', '1', 'agent')]);
});

test('a tool-result line that answers no question is never parsed', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  // Parsed, these 14 of 22 lines would fail, and the file would be unrecognized.
  const result = '{"type":"user","message":{"content":[{"tool_use_id":"toolu_9","type":"tool_result","content":"x"}]} broken}';
  writeSession(s.configDir, repo, 'a', [...Array.from({ length: 8 }, (_, i) => assistant({ id: `m${i}`, text: 'ok' })),
    ...lines(14, result)]);
  assert.deepEqual(await unrecognized(s.configDir, repo), []);
});
