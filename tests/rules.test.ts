import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sections } from '../src/rules.ts';

const shape = (content: string) => sections(content).map(({ path, text }) => ({ path, text }));

test('a section is a heading and its text up to the next heading of any level, under its ancestors', () => {
  const md = 'intro\n\n# heeded\n\nwhat it is\n\n## rules\n\n- never x\n\n### detail\n\nmore\n\n## voice\n\nlowercase\n';
  assert.deepEqual(shape(md), [
    { path: [], text: 'intro' },
    { path: [], text: '# heeded\n\nwhat it is' },
    { path: ['heeded'], text: '## rules\n\n- never x' },
    { path: ['heeded', 'rules'], text: '### detail\n\nmore' },
    { path: ['heeded'], text: '## voice\n\nlowercase' },
  ]);
});

test('a # line inside fenced code is not a heading', () => {
  const md = '# setup\n\n```sh\n# install\nnpm i\n```\n\n~~~\n## not this either\n~~~\nafter';
  assert.deepEqual(shape(md), [{ path: [], text: md }]);
});

test('no headings: the whole file is one section', () => {
  assert.deepEqual(shape('- never x\n- always y\n'), [{ path: [], text: '- never x\n- always y' }]);
});

test('a section with nothing under its heading is dropped; its heading stays as context', () => {
  assert.deepEqual(shape('\n  \n# rules\n\n## git\n\n- never x\n\n## empty\n   \n'), [
    { path: ['rules'], text: '## git\n\n- never x' },
  ]);
});

test('CRLF line endings read as LF', () => {
  assert.deepEqual(shape('# a\r\n\r\ntext\r\nmore\r\n'), [{ path: [], text: '# a\n\ntext\nmore' }]);
});

test('a section is known by its hash: an edit changes only its own, and so does a new place in the file', () => {
  const before = sections('# a\n\none\n\n# b\n\ntwo');
  const after = sections('# a\n\none\n\n# b\n\ntwo, edited');
  assert.match(before[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(after[0].hash, before[0].hash);
  assert.notEqual(after[1].hash, before[1].hash);
  assert.notEqual(sections('# p\n\n## a\n\none')[0].hash, sections('# q\n\n## a\n\none')[0].hash);
});
