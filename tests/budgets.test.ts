// Budgets, checked on the built package over generated transcripts; the sizes are printed on every run.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { save, sections } from '../src/rules.ts';
import { sandbox } from './support/sandbox.ts';
import { instructions, type Line, mix, writeSession } from './support/transcript.ts';

const root = join(import.meta.dirname, '..');
const cli = join(root, 'dist', 'cli.js');
before(() => execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json'], { cwd: root }));

test('startup: heeded --version under 150 ms, median of 5', (t) => {
  const times = Array.from({ length: 5 }, () => {
    const start = performance.now();
    const { stdout } = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
    const ms = performance.now() - start;
    assert.match(stdout, /^\d+\.\d+\.\d+\n$/);
    return ms;
  }).sort((a, b) => a - b);
  t.diagnostic(`startup ${times[2].toFixed(0)} ms`);
  assert.ok(times[2] < 150, `${times[2]} ms`);
});

test('100 MB of transcripts at 150 MB/s or more, under 150 MB of memory with a 60 MB file among them', (t) => {
  const s = sandbox();
  const repo = join(s.root, 'repo');
  mkdirSync(repo);
  const content = '- never `git add -A`\n- talk to the user in italian';
  save(s.cacheDir, sections(content)[0].hash, [
    { quote: 'never `git add -A`', name: 'never git add -A', kind: 'tool', trigger: 'staging files',
      check: { field: 'command', when: { tool: '^Bash$', value: '\\bgit\\s+add\\b' }, broken: { value: '\\s(-A|--all)\\b' } },
      breaking: [{ tool: 'Bash', value: 'git add -A' }], keeping: [{ tool: 'Bash', value: 'git add a.ts' }] },
    { quote: 'talk to the user in italian', name: 'talk in italian', kind: 'language', trigger: 'replying', check: { language: 'it' } },
  ]);
  function* session(bytes: number): Generator<Line> {
    yield instructions([{ path: join(repo, 'CLAUDE.md'), type: 'Project', content }]);
    yield* mix(bytes);
  }
  const files = [writeSession(s.configDir, repo, 'big', session(60e6))];
  for (let i = 0; i < 8; i++) files.push(writeSession(s.configDir, repo, `s${i}`, session(5e6)));
  const megabytes = files.reduce((n, f) => n + statSync(f).size, 0) / 1e6;

  // The child reports its own peak memory as it exits.
  const hook = 'data:text/javascript,process.on("exit",()=>process.stderr.write(`maxRSS ${process.resourceUsage().maxRSS}\\n`))';
  const start = performance.now();
  const run = spawnSync(process.execPath, ['--import', hook, cli], { cwd: repo, env: s.env, encoding: 'utf8' });
  const seconds = (performance.now() - start) / 1000;
  const rss = Number(/maxRSS (\d+)/.exec(run.stderr)?.[1]) / 1024;
  t.diagnostic(`${megabytes.toFixed(0)} MB in ${seconds.toFixed(2)} s: ${(megabytes / seconds).toFixed(0)} MB/s, peak ${rss.toFixed(0)} MB`);
  assert.equal(run.status, 0, run.stderr);
  // Candidates wait for the judge: the language rule shows the history was counted.
  assert.match(run.stdout, /✓ talk in italian/);
  assert.ok(megabytes >= 100, `${megabytes} MB`);
  assert.ok(megabytes / seconds >= 150, `${megabytes / seconds} MB/s`);
  assert.ok(rss < 150, `${rss} MB`);
});

test('the package: 50 kB or less, no dependencies', (t) => {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }));
  t.diagnostic(`package ${pack.size} bytes, ${pack.entryCount} files`);
  assert.ok(pack.size <= 50_000, `${pack.size} bytes`);
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies, undefined);
});
