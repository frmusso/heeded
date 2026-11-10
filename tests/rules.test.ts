import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { load, rulesOf, save, sections, verify } from '../src/rules.ts';
import { sandbox } from './support/sandbox.ts';

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

const section = sections('## git\n\n- never `git add -A`: stage files\n  by name.\n- talk to the user in italian\n- write a failing test first')[0];
const gitAdd = {
  quote: 'never `git add -A`',
  name: 'never git add -A',
  kind: 'tool',
  trigger: 'staging files with git',
  check: { field: 'command', when: { tool: '^Bash$', value: '\\bgit\\s+add\\b' }, broken: { value: '\\s(-A|--all)\\b' } },
  breaking: [{ tool: 'Bash', value: 'git add -A' }, { tool: 'Bash', value: 'git add --all && git commit' }],
  keeping: [{ tool: 'Bash', value: 'git add src/a.ts' }, { tool: 'Bash', value: 'git add -p' }],
};

test("a rule whose quote isn't in its section, word for word, is dropped; line breaks and spacing don't count", () => {
  assert.equal(verify({ ...gitAdd, quote: 'never git add -A' }, section), null);
  assert.equal(verify({ ...gitAdd, quote: 'stage files by name' }, section)?.quote, 'stage files by name');
  assert.equal(verify({ ...gitAdd, quote: 'stage  files\tby name' }, section)?.quote, 'stage  files\tby name');
});

test('a rule is known by its quote: the same words with other spacing or case have the same id', () => {
  const a = verify(gitAdd, section);
  const b = verify({ ...gitAdd, quote: 'Never  `git add -A`' }, sections('- Never  `git add -A`')[0]);
  assert.match(a!.id, /^[0-9a-f]{8}$/);
  assert.equal(b!.id, a!.id);
  assert.notEqual(verify({ ...gitAdd, quote: 'talk to the user in italian' }, section)!.id, a!.id);
});

test('a name is cut to 40 characters', () => {
  const name = 'never stage every file at once with git add -A';
  assert.equal(verify({ ...gitAdd, name }, section)!.name, 'never stage every file at once with git');
});

test('a tool rule whose pattern is refused is demoted, with the reason', () => {
  assert.equal(verify({ ...gitAdd, check: { ...gitAdd.check, broken: { value: '(a+)+' } } }, section)!.demoted,
    'regex may take exponential time: (a+)+');
  assert.equal(verify({ ...gitAdd, check: undefined }, section)!.demoted, 'no broken pattern');
  assert.equal(verify(gitAdd, section)!.demoted, undefined);
});

test('a tool rule without an example that breaks it and one that keeps it is demoted', () => {
  assert.equal(verify({ ...gitAdd, breaking: [] }, section)!.demoted, 'no breaking example');
  assert.equal(verify({ ...gitAdd, keeping: undefined }, section)!.demoted, 'no keeping example');
});

test('a tool rule failing one of its own examples is demoted, naming it', () => {
  const bash = (value: string) => ({ tool: 'Bash', value });
  assert.equal(verify({ ...gitAdd, breaking: [...gitAdd.breaking, bash('git add -u')] }, section)!.demoted,
    'failed its examples: breaks "git add -u"');
  assert.equal(verify({ ...gitAdd, keeping: [bash('git add -A')] }, section)!.demoted, 'failed its examples: keeps "git add -A"');
  assert.equal(verify({ ...gitAdd, keeping: [bash('ls')] }, section)!.demoted, 'failed its examples: keeps "ls"');
});

test('a language rule outside the six languages heeded detects is demoted', () => {
  const lang = (language: string) => ({ quote: 'talk to the user in italian', name: 'talk in italian', kind: 'language',
    trigger: 'replying to the user', check: { language } });
  assert.equal(verify(lang('it'), section)!.demoted, undefined);
  assert.equal(verify(lang('ja'), section)!.demoted, 'language ja not supported');
});

test('a judgment rule is kept as is, its trigger in words', () => {
  const raw = { quote: 'write a failing test first', name: 'failing test first', kind: 'judgment', trigger: 'changing code' };
  const { id, ...rest } = verify(raw, section)!;
  assert.deepEqual(rest, raw);
});

test('the cache: what is saved loads back; a missing or corrupt file loads as nothing', () => {
  const s = sandbox();
  const rules = [gitAdd];
  save(s.cacheDir, 'abc', rules);
  assert.deepEqual(load(s.cacheDir, 'abc'), rules);
  assert.deepEqual(readdirSync(join(s.cacheDir, 'heeded')), ['abc.json']);
  assert.equal(load(s.cacheDir, 'nope'), null);
  writeFileSync(join(s.cacheDir, 'heeded', 'bad.json'), '[{"quote": ');
  assert.equal(load(s.cacheDir, 'bad'), null);
  writeFileSync(join(s.cacheDir, 'heeded', 'obj.json'), '{}');
  assert.equal(load(s.cacheDir, 'obj'), null);
});

test("a file's rules: its cached sections give rules, the others are missing; the same content is read once", () => {
  const s = sandbox();
  const content = `${section.text}\n\n## other\n\nnothing to see`;
  const [, other] = sections(content);
  save(s.cacheDir, section.hash, [gitAdd, { ...gitAdd, quote: 'not in the section' }]);
  const of = rulesOf(s.cacheDir);
  const a = of({ path: '/a/CLAUDE.md', type: 'Project', content });
  assert.deepEqual(a, { rules: [verify(gitAdd, section)], missing: [other] });
  assert.equal(of({ path: '/b/CLAUDE.md', type: 'Project', content }), a);
  assert.deepEqual(of({ path: '/m/MEMORY.md', type: 'AutoMem', content }), { rules: [], missing: [] });
});

test('a quote is checked against the text the model saw: with its secrets redacted', () => {
  const [withKey] = sections(`- never print the token gh${'p_'}Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78 in a reply`);
  const raw = { quote: 'never print the token … in a reply', name: 'never print the token', kind: 'judgment', trigger: 'replying' };
  assert.equal(verify(raw, withKey)?.quote, 'never print the token … in a reply');
});
