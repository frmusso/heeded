import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
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
  --json            the report as json
  --help, --version

reads CLAUDE_CONFIG_DIR, else ~/.claude. caches rules in XDG_CACHE_HOME, else ~/.cache.
`);
});

test('heeded --version', () => {
  const { status, stdout } = run('--version');
  assert.equal(status, 0);
  assert.equal(stdout, '0.0.0\n');
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
const answer = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { sections: [{ id: '1', rules: [gitAdd] }] },
  usage: { input_tokens: 3800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200 } });

function setup({ session = true, claude = true, cached = false } = {}) {
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
    { terminal = false, reply = 'y' as string | Error, columns = undefined as number | undefined, env = {} } = {}) => {
    let out = '';
    let err = '';
    const asked: string[] = [];
    const code = await main(args, {
      env: { ...s.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_REPLY: JSON.stringify([{ stdout: answer }]), ...env }, cwd: repo,
      terminal, columns, out: (x) => (out += x), err: (x) => (err += x),
      ask: async (q) => {
        asked.push(q);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    });
    return { code, out, err, asked };
  };
  return { s, repo, calls, heeded };
}

test('no transcripts for the folder: one line, exit 0', async () => {
  const { repo, heeded } = setup({ session: false });
  const { code, out } = await heeded([]);
  assert.equal(code, 0);
  assert.equal(out, `\n  no claude code transcripts for ${repo} in ~/.claude\n`);
});

test('the report over the cached rules; a violation is not an error', async () => {
  const { heeded, calls } = setup({ cached: true });
  const { code, out } = await heeded([], { terminal: true });
  assert.equal(code, 0);
  assert.match(out, /\n {2}✗ never git add -A {2}kept 0% of 1 {2}broken 1× {2}last /);
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

test('a terminal, and yes: the estimate, one call, the rules cached and in the report', async () => {
  const { s, heeded, calls } = setup();
  const { code, out, err, asked } = await heeded([], { terminal: true, reply: 'y' });
  assert.equal(code, 0);
  assert.equal(err, '1 rule section not read yet · claude sonnet · ~4k tokens\nread 1 section · 4,000 tokens\n');
  assert.deepEqual(asked, ['read them now? [y/N] ']);
  assert.equal(calls(), 1);
  assert.ok(existsSync(join(s.cacheDir, 'heeded', `${sections(content)[0].hash}.json`)));
  assert.match(out, /✗ never git add -A/);
  assert.doesNotMatch(out, /not read yet/);
});

test('a terminal, and no: nothing read, nothing spent', async () => {
  const { heeded, calls } = setup();
  for (const reply of ['n', '', 'whatever']) {
    const { code, out } = await heeded([], { terminal: true, reply });
    assert.equal(code, 0);
    assert.match(out, /1 section not read yet/);
  }
  assert.equal(calls(), 0);
});

test('yes, and no claude to run: exit 1, one line saying what to do', async () => {
  const { heeded } = setup({ claude: false });
  const { code, err } = await heeded([], { terminal: true, reply: 'yes' });
  assert.equal(code, 1);
  assert.match(err, /\nheeded: claude not found\. install claude code, or run heeded where claude runs\.\n$/);
});

test('--json: the same document for both commands', async () => {
  const { heeded } = setup({ cached: true });
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

test('colour only when stdout is a terminal and NO_COLOR is not set', async () => {
  const { heeded } = setup({ cached: true });
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
  assert.equal(before.notRead, 1);
  assert.deepEqual(before.rules.map((r: { name: string; broken: number }) => [r.name, r.broken]), [['never git add -A', 2]]);

  const forcePush = { quote: 'never force-push', name: 'never force-push', kind: 'tool', trigger: 'pushing',
    check: { field: 'command', when: { tool: '^Bash$', value: '\\bgit\\s+push\\b' }, broken: { value: '\\s(--force|-f)\\b' } },
    breaking: [{ tool: 'Bash', value: 'git push --force' }], keeping: [{ tool: 'Bash', value: 'git push' }] };
  const both = JSON.stringify({ is_error: false, structured_output: { sections: [{ id: '1', rules: [gitAdd, forcePush] }] },
    usage: { input_tokens: 4400, output_tokens: 300 } });
  const after = JSON.parse((await heeded(['--json'], { terminal: true, env: { FAKE_CLAUDE_REPLY: JSON.stringify([{ stdout: both }]) } })).out);
  assert.equal(calls(), 1);
  assert.equal(after.notRead, 0);
  assert.deepEqual(after.rules.map((r: { name: string; broken: number }) => [r.name, r.broken]).sort(),
    [['never force-push', 1], ['never git add -A', 2]]);
});

test("a worktree's copy of a file is one section to read, not two", async () => {
  const { s, repo, calls, heeded } = setup({ session: false });
  const worktree = join(repo, '.claude', 'worktrees', 'w');
  for (const [folder, id] of [[repo, 'a'], [worktree, 'b']]) {
    writeSession(s.configDir, folder, id, [instructions([{ path: join(folder, 'CLAUDE.md'), type: 'Project', content }]),
      assistant({ id: `m${id}`, tool: { id: `t${id}`, name: 'Bash', input: { command: 'git add -A' } } })]);
  }
  const { err } = await heeded([], { terminal: true });
  assert.match(err, /^1 rule section not read yet/);
  assert.equal(calls(), 1);
});

test('a version read, seen again later, moves what the cache remembers forward', async () => {
  const { s, repo, heeded } = setup({ cached: true });
  const id = JSON.stringify([join(repo, 'CLAUDE.md'), [], '']);
  remember(s.cacheDir, id, sections(content)[0].hash, '');
  await heeded([]);
  const older = rulesOf(s.cacheDir)({ path: join(repo, 'CLAUDE.md'), type: 'Project', content: `${content} at all` })!;
  assert.match(older.versions[0].readAt!, /^2026-/);
});
