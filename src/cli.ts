#!/usr/bin/env node
// The heeded command: arguments, the two commands, the question before spending, exit codes.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { counter } from './check.ts';
import { read } from './claude-code.ts';
import { json, type Report, rules, text } from './report.ts';
import { estimate, extract, rulesOf, save, type Section } from './rules.ts';

const HELP = `heeded — did your coding agent follow its instructions?

usage
  heeded            report on the claude code sessions run in this folder
  heeded rules      the rules found, and how each one is checked

options
  --json            the report as json
  --help, --version

reads CLAUDE_CONFIG_DIR, else ~/.claude. caches rules in XDG_CACHE_HOME, else ~/.cache.
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
}

/** One pass over the folder's transcripts with the rules cached so far; the sections no rule was read from yet. */
async function scan(configDir: string, folder: string, cacheDir: string): Promise<{ report: Report; missing: Section[] }> {
  const of = rulesOf(cacheDir);
  const missing = new Map<string, Section>();
  const count = counter((file) => {
    const found = of(file);
    for (const s of found.missing) missing.set(s.hash, s);
    return found;
  });
  const { unrecognized } = await read(configDir, folder, count.on);
  return { report: { folder, configDir, unrecognized, ...count.result() }, missing: [...missing.values()] };
}

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

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

  const home = io.env.HOME || homedir();
  const configDir = io.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const cacheDir = io.env.XDG_CACHE_HOME || join(home, '.cache');
  let { report, missing } = await scan(configDir, io.cwd, cacheDir);
  let code = 0;
  // Reading new sections spends the user's quota: only when asked on a terminal, after the estimate.
  if (missing.length && io.terminal) {
    // Every call costs ~4k tokens: the estimate is never under a thousand.
    const k = Math.round(estimate(missing).tokens / 1000);
    io.err(`${plural(missing.length, 'rule section')} not read yet · claude sonnet · ~${k}k tokens\n`);
    if (/^y(es)?$/i.test((await io.ask('read them now? [y/N] ')).trim())) {
      const found = await extract(missing, io.env);
      for (const [hash, list] of found.rules) save(cacheDir, hash, list);
      if (found.rules.size) io.err(`read ${plural(found.rules.size, 'section')} · ${found.tokens.toLocaleString('en-US')} tokens\n`);
      for (const e of found.errors) io.err(`heeded: ${e}\n`);
      if (found.errors.length) code = 1;
      if (found.rules.size) ({ report } = await scan(configDir, io.cwd, cacheDir));
    }
  }

  const color = io.columns !== undefined && !io.env.NO_COLOR;
  if (args.values.json) io.out(json(report));
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
  });
}
