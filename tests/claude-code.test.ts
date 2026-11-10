import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { type Event, read } from '../src/claude-code.ts';
import { sandbox } from './support/sandbox.ts';
import { assistant, compact, instructions, nested, noise, summary, user, writeSession } from './support/transcript.ts';

async function events(configDir: string, folder: string): Promise<Event[]> {
  const out: Event[] = [];
  await read(configDir, folder, (e) => out.push(e));
  return out;
}

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

test("the text blocks of one message are one reply, before the message's calls; subagents' replies are not read", async () => {
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

test('noise and user lines give nothing, even a user line holding an assistant-shaped object', async () => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  const types = ['last-prompt', 'mode', 'api-request', 'api-request-blob', 'queue-operation', 'file-history-snapshot',
    'file-history-delta', 'ai-title', 'tools-used'];
  const nestedAssistant = { type: 'assistant', message: { id: 'm9', content: [{ type: 'text', text: 'from a subagent' }] } };
  writeSession(s.configDir, repo, 'a', [...types.map((t) => noise(t, 100)), user('hi'), summary(),
    { ...user('done'), toolUseResult: nestedAssistant }]);
  assert.deepEqual(await events(s.configDir, repo), [{ kind: 'transcript', session: 'a', agent: null }]);
});
