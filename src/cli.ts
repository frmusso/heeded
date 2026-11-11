#!/usr/bin/env node
// The heeded command: arguments, the two commands, the question before spending, exit codes.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { counter } from './check.ts';
import { read } from './claude-code.ts';
import { BUDGET, type Case, estimate as judgingEstimate, JUDGE_MODEL, judge, select, verdicts } from './judge.ts';
import { json, type Report, rules, text } from './report.ts';
import { estimate, extract, MODEL, type Pending, remember, rulesOf } from './rules.ts';

const HELP = `heeded — did your coding agent follow its instructions?

usage
  heeded            report on the claude code sessions run in this folder
  heeded rules      the rules found, and how each one is checked

options
  --json            the report as json
  --help, --version

reads CLAUDE_CONFIG_DIR, else ~/.claude. caches rules and verdicts in XDG_CACHE_HOME, else ~/.cache.
`;

/** What the command needs from its process, so tests can drive every path in-process. */
interface IO {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Whether a question can be asked: stdin and stderr are terminals. */
  terminal: boolean;
  /** The width of stdout when it is a terminal. */
  columns: number | undefined;
  ask: (question: string) => Promise<string>;
  out: (s: string) => void;
  err: (s: string) => void;
  /** Shows a line on the terminal in place of the one shown last; an empty line clears it. */
  status: (line: string) => void;
}

/** One pass over the folder's transcripts with the rules and verdicts cached so far: the report, the sections to read,
 * the cases waiting for the judge. */
async function scan(configDir: string, folder: string, cacheDir: string):
  Promise<{ report: Report; pending: Pending[]; waiting: { tool: Case[][]; judgment: Case[][] } }> {
  const count = counter(rulesOf(cacheDir), verdicts(cacheDir));
  const { unrecognized } = await read(configDir, folder, count.on);
  for (const v of count.readVersions()) remember(cacheDir, v.identity, v.section.hash, v.at);
  return { report: { folder, configDir, unrecognized, ...count.result() }, pending: count.pending(), waiting: count.waiting() };
}

const thousands = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, word: string) => `${thousands(n)} ${word}${n === 1 ? '' : 's'}`;
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** Runs a step that calls claude, with a status line meanwhile: what it does, the call it waits for, the time so far,
 * shown again every second. A call takes up to a minute or two: without it the run looks stuck. */
async function step<T>(io: IO, doing: string, work: (onCall: (n: number, of: number) => void) => Promise<T>):
  Promise<T> {
  const start = Date.now();
  let call = '';
  const show = () => io.status(`${doing}${call} · ${clock(Date.now() - start)}`);
  const timer = setInterval(show, 1000);
  try {
    return await work((n, of) => {
      call = ` · call ${n} of ${of}`;
      show();
    });
  } finally {
    clearInterval(timer);
    io.status('');
  }
}

/** Runs heeded; resolves to the exit code: 0 done (violations included), 1 an error, 2 wrong usage. */
export async function main(argv: string[], io: IO): Promise<number> {
  const usage = (what: string) => {
    io.err(`heeded: ${what}. see heeded --help.\n`);
    return 2;
  };
  let args;
  try {
    args = parseArgs({ args: argv, allowPositionals: true,
      options: { json: { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' } } });
  } catch (e) {
    return usage(`unknown option ${/'([^']*)'/.exec((e as Error).message)?.[1] ?? ''}`.trim());
  }
  const [command, ...rest] = args.positionals;
  if (command !== undefined && command !== 'rules') return usage(`unknown command ${command}`);
  if (rest.length) return usage(`unexpected ${rest.join(' ')}`);
  if (args.values.help) {
    io.out(HELP);
    return 0;
  }
  if (args.values.version) {
    io.out(`${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}\n`);
    return 0;
  }

  try {
    return await run(command, args.values.json === true, io);
  } catch (e) {
    io.err(`heeded: ${String((e as Error).message).split('\n')[0]}\n`);
    return 1;
  }
}

/** The report, after reading new sections and judging cases if the user says so. */
async function run(command: string | undefined, asJson: boolean, io: IO): Promise<number> {
  const home = io.env.HOME || homedir();
  const configDir = io.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const cacheDir = io.env.XDG_CACHE_HOME || join(home, '.cache');
  let { report, pending, waiting } = await scan(configDir, io.cwd, cacheDir);
  let code = 0;
  const failed = (errors: string[]) => {
    for (const e of errors) io.err(`heeded: ${e}\n`);
    if (errors.length) code = 1;
  };
  // Reading sections and judging cases spend the user's quota: only when asked on a terminal, once, after the most the
  // run may spend. Every call costs ~4k tokens: an estimate is never under a thousand.
  if (io.terminal && (pending.length || report.toJudge > 0)) {
    const distinct = [...new Map(pending.map((p) => [p.section.hash, p.section])).values()];
    let picked = select(waiting.tool, waiting.judgment, BUDGET);
    if (distinct.length) {
      // The cases of the rules about to be read aren't known yet: the question shows the ceiling.
      const models = [...new Set([MODEL, JUDGE_MODEL])].join(' and ');
      const k = Math.round((estimate(distinct).tokens + BUDGET) / 1000);
      io.err(`${plural(distinct.length, 'rule section')} to read, then cases to judge · claude ${models} · up to ~${k}k tokens\n`);
    } else {
      const cases = picked.length === report.toJudge ? plural(picked.length, 'case')
        : `${thousands(picked.length)} of ${plural(report.toJudge, 'case')}`;
      io.err(`${cases} to judge · claude ${JUDGE_MODEL} · ~${Math.round(judgingEstimate(picked).tokens / 1000)}k tokens\n`);
    }
    // ctrl-c or ctrl-d at the question is a no.
    const answer = await io.ask('go ahead? [y/N] ').catch(() => '');
    if (/^y(es)?$/i.test(answer.trim())) {
      let judging = true;
      if (distinct.length) {
        const found = await step(io, `reading ${plural(distinct.length, 'rule section')}`,
          (onCall) => extract(pending, io.env, cacheDir, onCall));
        if (found.read) io.err(`read ${plural(found.read, 'section')} · ${thousands(found.tokens)} tokens\n`);
        failed(found.errors);
        // The rules just read have cases of their own, chosen with the others.
        if (found.read) {
          ({ report, waiting } = await scan(configDir, io.cwd, cacheDir));
          picked = select(waiting.tool, waiting.judgment, BUDGET);
        } else judging = false;
      }
      if (judging && picked.length) {
        const done = await step(io, `judging ${plural(picked.length, 'case')}`,
          (onCall) => judge(picked, io.env, cacheDir, onCall));
        if (done.judged) io.err(`judged ${plural(done.judged, 'case')} · ${thousands(done.tokens)} tokens\n`);
        failed(done.errors);
        if (done.judged) ({ report } = await scan(configDir, io.cwd, cacheDir));
      }
    }
  }

  const color = io.columns !== undefined && !io.env.NO_COLOR;
  if (asJson) io.out(json(report));
  else if (command === 'rules' && report.sessions && report.files.length) io.out(rules(report, { color, home }));
  else io.out(text(report, { columns: io.columns ?? 80, color, now: new Date(), home }));
  return code;
}

// Run as the `heeded` bin (npm links it, so its real path is compared), not when imported.
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  const ask = async (question: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env, cwd: process.cwd(), terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    columns: process.stdout.isTTY ? process.stdout.columns : undefined, ask,
    out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s),
    status: (line) => process.stderr.write(`\r\x1b[K${line}`),
  });
}
