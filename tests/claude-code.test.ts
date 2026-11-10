import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { type Event, read } from '../src/claude-code.ts';
import { sandbox } from './support/sandbox.ts';
import { noise, user, writeSession } from './support/transcript.ts';

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
