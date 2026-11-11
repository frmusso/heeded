import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { load, PROMPT_VERSION, remember, rulesOf, save, sectionHash, sections, verify } from '../src/rules.ts';
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

test('a tool rule nothing can break is demoted', () => {
  const when = { field: 'command', when: gitAdd.check.when };
  assert.equal(verify({ ...gitAdd, check: when }, section)!.demoted, 'no broken pattern');
  assert.equal(verify({ ...gitAdd, check: { ...when, broken: {} } }, section)!.demoted, 'no broken pattern');
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
  assert.equal(verify({ ...gitAdd, keeping: [bash('ls')] }, section)!.demoted,
    'failed its examples: none of the keeping examples applies');
  assert.equal(verify({ ...gitAdd, keeping: [...gitAdd.keeping, bash('grep -n "git add -A" notes.md')] }, section)!.demoted,
    undefined);
});

test('a language rule outside the six languages heeded detects is demoted', () => {
  const lang = (language: string) => ({ quote: 'talk to the user in italian', name: 'talk in italian', kind: 'language',
    trigger: 'replying to the user', check: { language } });
  assert.equal(verify(lang('it'), section)!.demoted, undefined);
  assert.equal(verify(lang('ja'), section)!.demoted, 'language ja not supported');
});

test('a judgment rule is kept as is, its trigger in words', () => {
  const raw = { quote: 'write a failing test first', name: 'failing test first', kind: 'judgment', trigger: 'changing code' };
  const { id, context, ...rest } = verify(raw, section)!;
  assert.deepEqual(rest, { ...raw, heading: 'git', noCases: 'no case to judge it on' });
  assert.equal(context, '## git - never `git add -A`: stage files by name. - talk to the user in italian - write a failing test first');
});

const commits = sections('# git\n## commits\n- commit only when asked\n- say what you committed')[0];
const commit = {
  quote: 'commit only when asked', name: 'commit only when asked', kind: 'judgment', trigger: 'committing',
  check: { field: 'command', when: { tool: '^Bash$', value: '(^|\\s)git\\s+commit(\\s|$)' }, broken: { value: '(' } },
  keeping: [{ tool: 'Bash', value: 'git commit -m "fix: x"' }],
};

test('a judgment rule with a when is usable when its examples are cases of it', () => {
  const rule = verify(commit, commits)!;
  assert.equal(rule.noCases, undefined);
  // What breaks it is the judge's to say: a broken pattern is dropped, even one that doesn't compile.
  assert.deepEqual(rule.check, { field: 'command', when: commit.check.when });
});

test('a judgment rule about replies needs no example', () => {
  const reply = { quote: 'say what you committed', name: 'say what you committed', kind: 'judgment', trigger: 'replying',
    check: { reply: true } };
  assert.equal(verify(reply, commits)!.noCases, undefined);
});

test('a judgment rule without a usable when has no cases, with the reason', () => {
  const noCases = (patch: object) => verify({ ...commit, ...patch }, commits)!.noCases;
  assert.equal(noCases({ check: undefined }), 'no case to judge it on');
  assert.equal(noCases({ check: { field: 'command', broken: { value: 'x' } } }), 'no case to judge it on');
  assert.equal(noCases({ check: { field: 'command', when: { value: '(x' } } }), "regex doesn't compile: (x");
  assert.equal(noCases({ keeping: undefined }), 'no example of a case');
  assert.equal(noCases({ keeping: [{ tool: 'Bash', value: 'ls' }] }), 'failed its examples: "ls" is not a case');
});

test('a rule knows the words around it in its section: what they mean, cut, secrets redacted', () => {
  const key = `gh${'p_'}Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78`;
  const text = `## tmux\n\n${'Each service runs in a pane. '.repeat(30)}**Do not hardcode pane ids** (\`%0\`, \`%1\`, …) — they `
    + `change on every session restart. Discover the right pane by its path with ${key}:\n\n${'tmux list-panes -s -t main\n'.repeat(60)}`;
  const raw = { quote: '**Do not hardcode pane ids** (`%0`, `%1`, …)', name: 'no hardcoded pane ids', kind: 'judgment', trigger: 'tmux' };
  const { context } = verify(raw, sections(text)[0])!;
  assert.ok(context!.includes('— they change on every session restart. Discover the right pane'), context);
  assert.ok(context!.startsWith('…') && context!.endsWith('…'), context);
  assert.ok(!context!.includes(key) && !context!.includes('\n'));
  assert.ok(context!.length <= 1500 + raw.quote.length + 2, String(context!.length));
});

test('a rule knows the headings it is under', () => {
  assert.equal(verify(commit, commits)!.heading, 'git › commits');
  assert.equal(verify(commit, sections('- commit only when asked')[0])!.heading, '');
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

test("a file's rules: its cached sections give rules, the others are unread; memoized by path and content", () => {
  const s = sandbox();
  const content = `${section.text}\n\n## other\n\nnothing to see`;
  const [, other] = sections(content);
  save(s.cacheDir, section.hash, [gitAdd, { ...gitAdd, quote: 'not in the section' }]);
  const of = rulesOf(s.cacheDir);
  const a = of({ path: '/a/CLAUDE.md', type: 'Project', content });
  // Each rule knows the file it was read from: a scoped rule is told by where it is written.
  assert.deepEqual(a, { rules: [{ ...verify(gitAdd, section), file: '/a/CLAUDE.md' }], versions: [
    { section, identity: JSON.stringify(['/a/CLAUDE.md', [], '## git']), read: true, readAt: null, before: false },
    { section: other, identity: JSON.stringify(['/a/CLAUDE.md', [], '## other']), read: false, readAt: null, before: false }] });
  assert.equal(of({ path: '/a/CLAUDE.md', type: 'Project', content }), a);
  assert.deepEqual(of({ path: '/b/CLAUDE.md', type: 'Project', content })!.rules, [{ ...a!.rules[0], file: '/b/CLAUDE.md' }]);
  assert.equal(of({ path: '/m/MEMORY.md', type: 'AutoMem', content }), null);
});

test('a quote is checked against the text the model saw: with its secrets redacted', () => {
  const [withKey] = sections(`- never print the token gh${'p_'}Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78 in a reply`);
  const raw = { quote: 'never print the token … in a reply', name: 'never print the token', kind: 'judgment', trigger: 'replying' };
  assert.equal(verify(raw, withKey)?.quote, 'never print the token … in a reply');
});

test('a fence closes only with its own kind of marker', () => {
  const md = '# setup\n\n~~~\n```\n# still code\n~~~\nafter';
  assert.deepEqual(sections(md).map((s) => s.text), [md]);
});

test('a name holds no control characters: no line breaks, no terminal escapes', () => {
  assert.equal(verify({ ...gitAdd, name: 'never\n git\x1b[31m add' }, section)!.name, 'never git [31m add');
});

// Two versions of one section: the later one adds a rule; the earlier one also had a rule the later dropped.
const v1 = '## git\n\n- never `git add -A`: stage files\n  by name.\n- never rebase';
const v2 = '## git\n\n- never `git add -A`: stage files\n  by name.\n- never force-push';
const rule = (quote: string) => ({ quote, name: quote, kind: 'judgment', trigger: 'git' });

test('a version not read takes the rules of the remembered version of its section, where their words are written', () => {
  const s = sandbox();
  const [later] = sections(v2);
  save(s.cacheDir, later.hash, [rule('never `git add -A`'), rule('never force-push')]);
  remember(s.cacheDir, JSON.stringify(['/r/CLAUDE.md', [], '## git']), later.hash, '2026-11-05T10:00:00Z');
  const found = rulesOf(s.cacheDir)({ path: '/r/CLAUDE.md', type: 'Project', content: v1 })!;
  assert.deepEqual(found.rules.map((r) => r.quote), ['never `git add -A`']);
  assert.deepEqual(found.versions.map((u) => u.readAt), ['2026-11-05T10:00:00Z']);
  assert.deepEqual(rulesOf(s.cacheDir)({ path: '/other/CLAUDE.md', type: 'Project', content: v1 }), { rules: [],
    versions: [{ section: sections(v1)[0], identity: JSON.stringify(['/other/CLAUDE.md', [], '## git']), read: false, readAt: null,
      before: false }] });
});

test('the remembered version of a section only moves forward in time', () => {
  const s = sandbox();
  const id = JSON.stringify(['/r/CLAUDE.md', [], '## git']);
  const [earlier] = sections(v1);
  const [later] = sections(v2);
  save(s.cacheDir, earlier.hash, [rule('never rebase')]);
  save(s.cacheDir, later.hash, [rule('never force-push')]);
  remember(s.cacheDir, id, later.hash, '2026-11-05T10:00:00Z');
  remember(s.cacheDir, id, earlier.hash, '2026-11-01T10:00:00Z');
  const [third] = sections(`${v2}\n- never force-push again`);
  assert.deepEqual(rulesOf(s.cacheDir)({ path: '/r/CLAUDE.md', type: 'Project', content: third.text })!.rules.map((r) => r.quote),
    ['never force-push']);
});

test('what the cache remembers belongs to one prompt and model: readings from another are not stood for', () => {
  const s = sandbox();
  const id = JSON.stringify(['/r/CLAUDE.md', [], '## git']);
  const [later] = sections(v2);
  // A reading made with another prompt: its rules are under its own hash, and its memory under its own name.
  save(s.cacheDir, 'old-prompt-hash', [rule('never `git add -A`')]);
  mkdirSync(join(s.cacheDir, 'heeded', 'latest'), { recursive: true });
  const name = createHash('sha256').update(id).digest('hex');
  writeFileSync(join(s.cacheDir, 'heeded', 'latest', `${name}.json`), JSON.stringify({ hash: 'old-prompt-hash', at: '2026-11-09T00:00:00Z' }));
  const found = rulesOf(s.cacheDir)({ path: '/r/CLAUDE.md', type: 'Project', content: later.text })!;
  assert.deepEqual([found.rules, found.versions.map((u) => u.readAt)], [[], [null]]);
  remember(s.cacheDir, id, later.hash, '');
  assert.deepEqual(rulesOf(s.cacheDir)({ path: '/r/CLAUDE.md', type: 'Project', content: v1 })!.versions.map((u) => u.readAt), ['']);
});

test('a section read only under the previous prompt keeps those rules, to be read again; read under this one, its new rules win', () => {
  const s = sandbox();
  const [later] = sections(v2);
  const file = { path: '/r/CLAUDE.md', type: 'Project', content: later.text };
  save(s.cacheDir, sectionHash(later.path, later.text, PROMPT_VERSION - 1), [rule('never force-push')]);
  const before = rulesOf(s.cacheDir)(file)!;
  assert.deepEqual(before.rules.map((r) => r.quote), ['never force-push']);
  assert.deepEqual(before.versions.map((v) => [v.read, v.before]), [[false, true]]);
  save(s.cacheDir, later.hash, [rule('never `git add -A`')]);
  const now = rulesOf(s.cacheDir)(file)!;
  assert.deepEqual(now.rules.map((r) => r.quote), ['never `git add -A`']);
  assert.deepEqual(now.versions.map((v) => [v.read, v.before]), [[true, false]]);
});

test('an edited section, read under the previous prompt in an earlier version, keeps that version\'s rules where their words are', () => {
  const s = sandbox();
  const [earlier] = sections(v1);
  const old = sectionHash(earlier.path, earlier.text, PROMPT_VERSION - 1);
  save(s.cacheDir, old, [rule('never `git add -A`'), rule('never rebase')]);
  remember(s.cacheDir, JSON.stringify(['/r/CLAUDE.md', [], '## git']), old, '2026-11-01T10:00:00Z', PROMPT_VERSION - 1);
  const found = rulesOf(s.cacheDir)({ path: '/r/CLAUDE.md', type: 'Project', content: v2 })!;
  assert.deepEqual(found.rules.map((r) => r.quote), ['never `git add -A`']);
  assert.deepEqual(found.versions.map((v) => [v.read, v.before, v.readAt]), [[false, true, null]]);
});

test('two prompts back, nothing is kept: the section is read from nothing', () => {
  const s = sandbox();
  const [later] = sections(v2);
  const old = sectionHash(later.path, later.text, PROMPT_VERSION - 2);
  save(s.cacheDir, old, [rule('never force-push')]);
  remember(s.cacheDir, JSON.stringify(['/r/CLAUDE.md', [], '## git']), old, '2026-11-01T10:00:00Z', PROMPT_VERSION - 2);
  const found = rulesOf(s.cacheDir)({ path: '/r/CLAUDE.md', type: 'Project', content: later.text })!;
  assert.deepEqual([found.rules, found.versions.map((v) => v.before)], [[], [false]]);
});

test('a version read under this prompt stands for a section before the same text read under the previous one', () => {
  const s = sandbox();
  const [earlier] = sections(v1);
  const [later] = sections(v2);
  save(s.cacheDir, earlier.hash, [rule('never `git add -A`'), rule('never rebase')]);
  remember(s.cacheDir, JSON.stringify(['/r/CLAUDE.md', [], '## git']), earlier.hash, '2026-11-01T10:00:00Z');
  save(s.cacheDir, sectionHash(later.path, later.text, PROMPT_VERSION - 1), [rule('never force-push')]);
  const found = rulesOf(s.cacheDir)({ path: '/r/CLAUDE.md', type: 'Project', content: v2 })!;
  assert.deepEqual(found.rules.map((r) => r.quote), ['never `git add -A`']);
});

test('rules from before that no longer appear in the section stand for nothing: it is not read yet', () => {
  const s = sandbox();
  const [earlier] = sections(v1);
  save(s.cacheDir, earlier.hash, [rule('never rebase')]);
  remember(s.cacheDir, JSON.stringify(['/r/CLAUDE.md', [], '## git']), earlier.hash, '2026-11-01T10:00:00Z');
  const found = rulesOf(s.cacheDir)({ path: '/r/CLAUDE.md', type: 'Project', content: v2 })!;
  assert.deepEqual([found.rules, found.versions.map((v) => v.before)], [[], [false]]);
});

test('two sections with the same heading in one file are two sections', () => {
  const md = '# notes\n\n## todo\n\n- a\n\n# more\n\n## todo\n\n- b\n\n# notes\n\n## todo\n\n- c';
  const ids = rulesOf(sandbox().cacheDir)({ path: '/r/CLAUDE.md', type: 'Project', content: md })!.versions.map((v) => v.identity);
  assert.equal(new Set(ids).size, ids.length);
});
