import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ask, pool } from '../src/model.ts';
import { installFakeClaude } from './support/fake-claude.ts';
import { sandbox } from './support/sandbox.ts';

const tick = () => new Promise((done) => setTimeout(done, 5));

test('a pool runs its items in order, at most 3 at once', async () => {
  const started: number[] = [];
  let running = 0;
  let most = 0;
  await pool([0, 1, 2, 3, 4, 5, 6], async (item) => {
    started.push(item);
    most = Math.max(most, ++running);
    await tick();
    running--;
  });
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(most, 3);
});

test('after stop(), no other item starts; the ones running finish', async () => {
  const started: number[] = [];
  await pool(Array.from({ length: 10 }, (_, i) => i), async (item, _, stop) => {
    started.push(item);
    await tick();
    if (item === 0) stop();
    await tick();
  });
  assert.deepEqual(started, [0, 1, 2]);
});

test('an item that throws stops the others from starting, and the pool rejects with it', async () => {
  const started: number[] = [];
  await assert.rejects(pool(Array.from({ length: 10 }, (_, i) => i), async (item) => {
    started.push(item);
    await tick();
    if (item === 1) throw new Error('disk full');
  }), /disk full/);
  await tick();
  await tick();
  assert.ok(started.length <= 4, String(started));
});

test('a claude call that takes too long is stopped: an error for its batch, not the end of the run', async () => {
  const s = sandbox();
  installFakeClaude(s.bin);
  const env = { ...s.env, FAKE_CLAUDE_LOG: join(s.root, 'claude.log'), FAKE_CLAUDE_WAIT: '5000',
    FAKE_CLAUDE_REPLY: JSON.stringify([{ stdout: '{}' }]) };
  const start = Date.now();
  const run = await ask('haiku', '{}', 'prompt', env, 300);
  assert.ok(Date.now() - start < 3000, `${Date.now() - start} ms`);
  assert.equal(run.fatal, undefined);
  assert.match(run.error ?? '', /^claude took more than [\d.]+ minutes?: stopped$/);
});
