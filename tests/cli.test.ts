import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { counter } from '../src/check.ts';
import { read } from '../src/claude-code.ts';
import { main } from '../src/cli.ts';
import { saveVerdict } from '../src/judge.ts';
import { remember, rulesOf, save, sections } from '../src/rules.ts';
import { installFakeClaude } from './support/fake-claude.ts';
import { sandbox } from './support/sandbox.ts';
import { assistant, instructions, writeSession } from './support/transcript.ts';

const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env: sandbox().env, encoding: 'utf8' });

test('heeded --help', () => {
  const { status, stdout } = run('--help');
  assert.equal(status, 0);
  assert.equal(stdout, `heeded — did your coding agent follow its instructions?

usage
  heeded            report on the claude code sessions run in this folder
  heeded rules      the rules found, and how each one is checked

options
  --all             judge every case waiting, not one run's 150k tokens
  --json            the report as json
  --help, --version

reads CLAUDE_CONFIG_DIR, else ~/.claude. caches rules and verdicts in XDG_CACHE_HOME, else ~/.cache.
`);
});

test('heeded --version', () => {
  const { status, stdout } = run('--version');
  assert.equal(status, 0);
  assert.equal(stdout, '0.1.0\n');
});

test('an unknown option or command: exit 2, one lowercase line on stderr', () => {
  for (const args of [['--nope'], ['nope'], ['rules', 'more']]) {
    const { status, stdout, stderr } = run(...args);
    assert.equal(status, 2, args.join(' '));
    assert.equal(stdout, '');
    assert.match(stderr, /^heeded: [^\n]+\. see heeded --help\.\n$/);
    assert.equal(stderr, stderr.toLowerCase());
  }
});

// In-process runs over a session in a sandbox: CLAUDE.md holds one section with one rule, broken once.
const content = '- never `git add -A`';
const gitAdd = {
  quote: 'never `git add -A`', name: 'never git add -A', kind: 'tool', trigger: 'staging files with git',
  check: { field: 'command', when: { tool: '^Bash$', value: '\\bgit\\s+add\\b' }, broken: { value: '\\s(-A|--all)\\b' } },
  breaking: [{ tool: 'Bash', value: 'git add -A' }], keeping: [{ tool: 'Bash', value: 'git add a.ts' }],
};
const usage = { input_tokens: 3800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200 };
const answer = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { sections: [{ id: '1', rules: [gitAdd] }] },
  usage });
/** The judge's answer for the session's one case, `git add -A`. */
const confirmed = JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
  structured_output: { cases: [{ id: '1', verdict: 'broken', quote: 'git add -A' }] }, usage });

function setup({ session = true, claude = true, cached = false, replies = [answer] } = {}) {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  mkdirSync(repo);
  if (session) {
    writeSession(s.configDir, repo, 'a', [instructions([{ path: join(repo, 'CLAUDE.md'), type: 'Project', content }]),
      assistant({ id: 'm1', tool: { id: 'tu1', name: 'Bash', input: { command: 'git add -A' } } })]);
  }
  if (claude) installFakeClaude(s.bin);
  if (cached) save(s.cacheDir, sections(content)[0].hash, [gitAdd]);
  const log = join(s.root, 'claude.log');
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0);
  const heeded = async (args: string[],
    { terminal = false, reply = 'y' as string | Error | string[], columns = undefined as number | undefined, env = {} } = {}) => {
    let out = '';
    let err = '';
    const shown: string[] = [];
    const asked: string[] = [];
    const code = await main(args, {
      env: { ...s.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_REPLY: JSON.stringify(replies.map((stdout) => ({ stdout }))), ...env },
      cwd: repo,
      terminal, columns, out: (x) => (out += x), err: (x) => (err += x), status: (x) => shown.push(x),
      ask: async (q) => {
        asked.push(q);
        if (reply instanceof Error) throw reply;
        // One answer for every question, or one each, in turn.
        return Array.isArray(reply) ? reply[asked.length - 1] ?? '' : reply;
      },
    });
    return { code, out, err, shown, asked };
  };
  /** The judge's part, for tests about the report: every candidate waiting is confirmed broken. */
  const confirm = async () => {
    const c = counter(rulesOf(s.cacheDir));
    await read(s.configDir, repo, c.on);
    for (const k of c.waiting().tool.flat()) saveVerdict(s.cacheDir, k.id, { verdict: 'broken' });
  };
  return { s, repo, calls, heeded, confirm };
}

test('no transcripts for the folder: one line, exit 0', async () => {
  const { repo, heeded } = setup({ session: false });
  const { code, out } = await heeded([]);
  assert.equal(code, 0);
  assert.equal(out, `\n  no claude code transcripts for ${repo} in ~/.claude\n`);
});

test('a terminal, cases waiting: the cases and what they cost, judged on yes; a violation is not an error', async () => {
  const { heeded, calls } = setup({ cached: true, replies: [confirmed] });
  const { code, out, err, asked } = await heeded([], { terminal: true });
  assert.equal(code, 0);
  assert.equal(err, '1 case to judge · claude haiku · ~3k tokens\njudged 1 case · 4,000 tokens\n');
  assert.deepEqual(asked, ['go ahead? [y/N] ']);
  assert.equal(calls(), 1);
  assert.match(out, /\n {4}✗ never git add -A {2}kept 0% of 1 {2}broken 1× {2}last /);
});

test('a run with nothing waiting asks nothing and spends nothing', async () => {
  const { heeded, calls } = setup({ cached: true, replies: [confirmed] });
  await heeded([], { terminal: true });
  const { err, out, asked } = await heeded([], { terminal: true });
  assert.equal(err, '');
  assert.deepEqual(asked, []);
  assert.equal(calls(), 1);
  assert.match(out, /✗ never git add -A/);
});

test('not a terminal: nothing read or judged, the report says what waits', async () => {
  const { heeded, calls } = setup({ cached: true, replies: [confirmed] });
  const doc = JSON.parse((await heeded(['--json'])).out);
  assert.equal(calls(), 0);
  assert.equal(doc.toJudge, 1);
  assert.deepEqual([doc.rules[0].broken, doc.rules[0].toJudge], [0, 1]);
  const { out } = await heeded([]);
  assert.match(out, /\n {4}\? never git add -A {2}1 to confirm\n/);
  assert.match(out, /\n {2}1 case waiting for the judge, ~3k tokens: run heeded again\n/);
  assert.equal(calls(), 0);
});

test('not a terminal: new sections are never read, and the report says so', async () => {
  const { heeded, calls } = setup();
  const { code, out, asked } = await heeded([]);
  assert.equal(code, 0);
  assert.equal(calls(), 0);
  assert.deepEqual(asked, []);
  assert.match(out, /1 section not read yet/);
});

test('sections to read and cases: one question with the ceiling, then read, judge, count', async () => {
  const { s, heeded, calls } = setup({ replies: [answer, confirmed] });
  const { code, out, err, asked } = await heeded([], { terminal: true, reply: 'y' });
  assert.equal(code, 0);
  assert.equal(err, '1 rule section to read, then cases to judge · claude sonnet and haiku · up to ~156k tokens\n'
    + 'read 1 section · 4,000 tokens\njudged 1 case · 4,000 tokens\n');
  assert.deepEqual(asked, ['go ahead? [y/N] ']);
  assert.equal(calls(), 2);
  assert.ok(existsSync(join(s.cacheDir, 'heeded', `${sections(content)[0].hash}.json`)));
  assert.match(out, /✗ never git add -A/);
  assert.doesNotMatch(out, /not read yet/);
});

test('while it reads and judges, a status line says what it waits for and since when, then clears', async () => {
  const { heeded } = setup({ replies: [answer, confirmed] });
  const { shown } = await heeded([], { terminal: true, reply: 'y' });
  // Every second the line is shown again with the time so far: a slow machine may add a repeat.
  const lines = shown.map((l) => l.replace(/ · \d+:\d\d$/, ' · m:ss')).filter((l, i, all) => l !== all[i - 1]);
  assert.deepEqual(lines, ['reading 1 rule section · m:ss', '', 'judging 1 case · m:ss', '']);
  assert.match(shown[0], / · 0:00$/);
});

test('a terminal, and no: nothing read or judged, nothing spent', async () => {
  for (const cached of [false, true]) {
    const { heeded, calls } = setup({ cached });
    for (const reply of ['n', '', 'whatever']) {
      const { code, out } = await heeded([], { terminal: true, reply });
      assert.equal(code, 0);
      if (!cached) assert.match(out, /1 section not read yet/);
    }
    assert.equal(calls(), 0);
  }
});

test('judging fails: exit 1, one line, nothing cached, the report still prints', async () => {
  const { s, heeded } = setup({ cached: true });
  const { code, out, err } = await heeded([], { terminal: true, env: {
    FAKE_CLAUDE_REPLY: JSON.stringify([{ exit: 1, stderr: 'Error: rate limited\n' }]) } });
  assert.equal(code, 1);
  assert.match(err, /\nheeded: claude exited with code 1: Error: rate limited\n$/);
  assert.equal(existsSync(join(s.cacheDir, 'heeded', 'verdicts')), false);
  assert.match(out, /1 session/);
});

test('yes, and no claude to run: exit 1, one line saying what to do', async () => {
  const { heeded } = setup({ claude: false });
  const { code, err } = await heeded([], { terminal: true, reply: 'yes' });
  assert.equal(code, 1);
  assert.match(err, /\nheeded: claude not found\. install claude code, or run heeded where claude runs\.\n$/);
});

test('--json: the same document for both commands', async () => {
  const { heeded, confirm } = setup({ cached: true });
  await confirm();
  const report = await heeded(['--json']);
  const listed = await heeded(['rules', '--json']);
  assert.equal(report.out, listed.out);
  assert.equal(JSON.parse(report.out).rules[0].broken, 1);
});

test('heeded rules: the rules and how each is checked', async () => {
  const { heeded } = setup({ cached: true });
  const { code, out } = await heeded(['rules']);
  assert.equal(code, 0);
  assert.match(out, /CLAUDE\.md\n {4}✓ never git add -A {2}Bash command {2}when /);
});

test('heeded rules never judges: what it lists doesn\'t depend on verdicts', async () => {
  for (const all of [[], ['--all']]) {
    const { heeded, calls } = setup({ cached: true, replies: [confirmed] });
    const { code, err, asked } = await heeded(['rules', ...all], { terminal: true });
    assert.equal(code, 0);
    assert.deepEqual([err, asked, calls()], ['', [], 0], all.join(''));
  }
});

test('heeded rules on a terminal asks to read the new sections, and only that', async () => {
  const { heeded, calls } = setup({ replies: [answer, confirmed] });
  const { code, out, err, asked } = await heeded(['rules'], { terminal: true });
  assert.equal(code, 0);
  assert.equal(err, '1 rule section to read · claude sonnet · ~6k tokens\nread 1 section · 4,000 tokens\n');
  assert.deepEqual(asked, ['go ahead? [y/N] ']);
  assert.equal(calls(), 1);
  assert.match(out, /✓ never git add -A/);
});

test('colour only when stdout is a terminal and NO_COLOR is not set', async () => {
  const { heeded, confirm } = setup({ cached: true });
  await confirm();
  assert.match((await heeded([], { columns: 100 })).out, /\x1b\[31m✗/);
  assert.doesNotMatch((await heeded([], { columns: 100, env: { NO_COLOR: '1' } })).out, /\x1b\[/);
  assert.doesNotMatch((await heeded([])).out, /\x1b\[/);
});

test('the question left with ctrl-c or ctrl-d: no, and the report still prints', async () => {
  const { heeded, calls } = setup();
  const { code, out } = await heeded([], { terminal: true, reply: new Error('Aborted with Ctrl+C') });
  assert.equal(code, 0);
  assert.equal(calls(), 0);
  assert.match(out, /1 section not read yet/);
});

test('an unexpected error: one line, exit 1, no stack trace', async () => {
  const { s, heeded } = setup();
  const notAFolder = join(s.root, 'cache-file');
  writeFileSync(notAFolder, '');
  const { code, err } = await heeded([], { terminal: true, reply: 'y', env: { XDG_CACHE_HOME: notAFolder } });
  assert.equal(code, 1);
  assert.match(err, /\nheeded: [^\n]+\n$/);
});

test('an edited section is asked about again; until it is read, its rules from before still count', async () => {
  const { s, repo, calls, heeded } = setup({ session: false });
  const edited = `${content}\n- never force-push`;
  const md = (text: string) => instructions([{ path: join(repo, 'CLAUDE.md'), type: 'Project', content: text }]);
  const bash = (id: string, command: string) => assistant({ id, tool: { id: `t${id}`, name: 'Bash', input: { command } } });
  writeSession(s.configDir, repo, 'a', [md(content), bash('1', 'git add -A')]);
  writeSession(s.configDir, repo, 'b', [md(edited), bash('2', 'git add -A'), bash('3', 'git push --force')]);
  save(s.cacheDir, sections(content)[0].hash, [gitAdd]);
  remember(s.cacheDir, JSON.stringify([join(repo, 'CLAUDE.md'), [], '']), sections(content)[0].hash, '');
  const before = JSON.parse((await heeded(['--json'])).out);
  // Edited: to read again, its rules from before counting meanwhile.
  assert.deepEqual([before.notRead, before.toReread], [0, 1]);
  // The candidates each rule found: none is judged here.
  const candidates = (doc: { rules: { name: string; toJudge: number }[] }) => doc.rules.map((r) => [r.name, r.toJudge]).sort();
  assert.deepEqual(candidates(before), [['never git add -A', 2]]);

  const forcePush = { quote: 'never force-push', name: 'never force-push', kind: 'tool', trigger: 'pushing',
    check: { field: 'command', when: { tool: '^Bash$', value: '\\bgit\\s+push\\b' }, broken: { value: '\\s(--force|-f)\\b' } },
    breaking: [{ tool: 'Bash', value: 'git push --force' }], keeping: [{ tool: 'Bash', value: 'git push' }] };
  const both = JSON.stringify({ is_error: false, structured_output: { sections: [{ id: '1', rules: [gitAdd, forcePush] }] },
    usage: { input_tokens: 4400, output_tokens: 300 } });
  const nothing = JSON.stringify({ is_error: false, structured_output: { cases: [] }, usage: { input_tokens: 4400, output_tokens: 10 } });
  const after = JSON.parse((await heeded(['--json'], { terminal: true,
    env: { FAKE_CLAUDE_REPLY: JSON.stringify([{ stdout: both }, { stdout: nothing }]) } })).out);
  assert.equal(calls(), 2); // one to read, one to judge
  assert.deepEqual([after.notRead, after.toReread], [0, 0]);
  assert.deepEqual(candidates(after), [['never force-push', 1], ['never git add -A', 2]]);
});

test("a worktree's copy of a file is one section to read, not two", async () => {
  const { s, repo, calls, heeded } = setup({ session: false });
  const worktree = join(repo, '.claude', 'worktrees', 'w');
  for (const [folder, id] of [[repo, 'a'], [worktree, 'b']]) {
    writeSession(s.configDir, folder, id, [instructions([{ path: join(folder, 'CLAUDE.md'), type: 'Project', content }]),
      assistant({ id: `m${id}`, tool: { id: `t${id}`, name: 'Bash', input: { command: 'git add -A' } } })]);
  }
  const { err } = await heeded([], { terminal: true });
  assert.match(err, /^1 rule section to read/);
  assert.equal(calls(), 2); // one to read, one to judge
});

test('a version read, seen again later, moves what the cache remembers forward', async () => {
  const { s, repo, heeded } = setup({ cached: true });
  const id = JSON.stringify([join(repo, 'CLAUDE.md'), [], '']);
  remember(s.cacheDir, id, sections(content)[0].hash, '');
  await heeded([]);
  const older = rulesOf(s.cacheDir)({ path: join(repo, 'CLAUDE.md'), type: 'Project', content: `${content} at all` })!;
  assert.match(older.versions[0].readAt!, /^2026-/);
});

// heeded --all: every case judged, round after round.
const commitRule = { quote: 'commit only when asked', name: 'commit only when asked', kind: 'judgment', trigger: 'committing',
  check: { field: 'command', when: { tool: '^Bash$', value: '\\bgit\\s+commit\\b' } },
  keeping: [{ tool: 'Bash', value: 'git commit -m x' }] };
const asked = '- commit only when asked';
/** A session with `n` commits under the rule, read already. */
function commits(n: number, replies: string[]) {
  const t = setup({ session: false, replies });
  writeSession(t.s.configDir, t.repo, 'a', [instructions([{ path: join(t.repo, 'CLAUDE.md'), type: 'Project', content: asked }]),
    ...Array.from({ length: n }, (_, i) => assistant({ id: `m${i}`, tool: { id: `t${i}`, name: 'Bash', input: { command: `git commit -m c${i}` } } }))]);
  save(t.s.cacheDir, sections(asked)[0].hash, [commitRule]);
  return t;
}
const kept = JSON.stringify({ is_error: false, usage, structured_output: {
  cases: Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), verdict: 'kept', quote: 'git commit' })) } });

test('--all: the cases now and the most they can grow to; judged round after round until none waits', async () => {
  const { heeded, calls } = commits(12, [kept]);
  const { code, err, asked: questions, out } = await heeded(['--all'], { terminal: true });
  assert.equal(code, 0);
  assert.deepEqual(questions, ['go ahead? [y/N] ']);
  // 8 cases first; they apply, so the other 4 are taken in a second round.
  assert.match(err, /^8 cases to judge, more if their rules apply · claude haiku · ~\d+k tokens, at most ~\d+k\n/);
  assert.match(err, /\njudged 12 cases · 8,000 tokens\n$/);
  assert.equal(calls(), 2);
  assert.match(out, /· commit only when asked +kept 100% of 12 judged/);
  assert.doesNotMatch(out, /waiting for the judge/);
});

test('--all: a round that judges nothing ends the run', async () => {
  const { heeded, calls } = commits(12, [JSON.stringify({ is_error: true, result: 'nope', usage })]);
  const { code, err } = await heeded(['--all'], { terminal: true });
  assert.equal(code, 1);
  assert.equal(calls(), 1);
  assert.match(err, /\nheeded: claude: nope\n$/);
});

test('--all with a section to read: the reading first, then the judging, each asked; no to the second reads only', async () => {
  for (const [replies, spent] of [[['y', 'n'], 1], [['y', 'y'], 2]] as const) {
    const { heeded, calls } = setup({ replies: [answer, confirmed] });
    const { err, asked: questions } = await heeded(['--all'], { terminal: true, reply: [...replies] });
    assert.deepEqual(questions, ['go ahead? [y/N] ', 'go ahead? [y/N] ']);
    assert.match(err, /^1 rule section to read first · claude sonnet · ~6k tokens\nread 1 section · 4,000 tokens\n1 case to judge · claude haiku · ~3k tokens\n/);
    assert.equal(calls(), spent);
  }
});

test('without --all, more waiting than a run takes: the question says what all of them would cost', async () => {
  const { s, repo, heeded } = setup({ session: false, cached: true, replies: [confirmed] });
  writeSession(s.configDir, repo, 'a', [instructions([{ path: join(repo, 'CLAUDE.md'), type: 'Project', content }]),
    ...Array.from({ length: 50 }, (_, i) => assistant({ id: `m${i}`, tool: { id: `t${i}`, name: 'Bash', input: { command: `git add -A f${i}` } } }))]);
  const { err } = await heeded([], { terminal: true, reply: 'n' });
  // A tool rule lists 40 of its candidates at a time.
  assert.match(err, /^40 of 50 cases to judge · claude haiku · ~\d+k tokens · all of them ~\d+k: heeded --all\n$/);
});

test('--all off a terminal: nothing asked, nothing spent', async () => {
  const { heeded, calls } = commits(12, [kept]);
  const { asked: questions, out } = await heeded(['--all']);
  assert.deepEqual(questions, []);
  assert.equal(calls(), 0);
  assert.match(out, /8 cases waiting for the judge/);
});
