import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/model.ts';

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
