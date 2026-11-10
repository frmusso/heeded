import assert from 'node:assert/strict';
import { test } from 'node:test';
import { json, type Report } from '../src/report.ts';

const buckets = (counts: [number, number][]) => counts.map(([applied, broken], i) =>
  ({ from: [0, 100_000, 200_000, 400_000][i], to: [100_000, 200_000, 400_000, null][i], applied, broken }));

const empty: Report = {
  folder: '/home/someone/repos/app', configDir: '/home/someone/.claude', from: null, to: null, sessions: 0, subagents: 0,
  unrecognized: [], notRead: 0, files: [], rules: [], byDepth: buckets([[0, 0], [0, 0], [0, 0], [0, 0]]),
};

test('the json document: heeded 1 first, then the report, two-space indented', () => {
  const report: Report = {
    ...empty, from: '2026-11-01T09:00:00Z', to: '2026-11-04T08:00:00Z', sessions: 2, subagents: 1, notRead: 1,
    files: ['/home/someone/repos/app/CLAUDE.md'],
    rules: [{
      id: '3f2a9c1e', name: 'never sudo', quote: 'never `sudo`', files: ['/home/someone/repos/app/CLAUDE.md'],
      status: 'demoted', reason: 'failed its examples: breaks "sudo ls"',
      check: { field: 'command', when: { tool: '^Bash$' }, broken: { value: '^sudo ' } },
      applied: 0, broken: 0, afterCompaction: { applied: 0, broken: 0 }, byDepth: buckets([[0, 0], [0, 0], [0, 0], [0, 0]]),
      tokens: 3, evidence: [],
    }],
    byDepth: buckets([[2, 1], [0, 0], [0, 0], [1, 0]]),
  };
  const doc = json(report);
  assert.ok(doc.startsWith('{\n  "heeded": 1,\n  "folder": "/home/someone/repos/app",\n  "configDir": '), doc);
  assert.ok(doc.endsWith('\n}\n'));
  assert.deepEqual(Object.keys(JSON.parse(doc)), ['heeded', 'folder', 'configDir', 'from', 'to', 'sessions', 'subagents',
    'unrecognized', 'notRead', 'files', 'rules', 'byDepth']);
  assert.deepEqual(JSON.parse(doc), { heeded: 1, ...report });
});

test('the json document of an empty history', () => {
  assert.deepEqual(JSON.parse(json(empty)), { heeded: 1, ...empty });
});
