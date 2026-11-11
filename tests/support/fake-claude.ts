// A stand-in for `claude`, so no test ever reaches a model. Each call appends one JSON line to FAKE_CLAUDE_LOG
// ({ argv, stdin, cwd, cwdEntries, running }) and answers with an entry of FAKE_CLAUDE_REPLY, a JSON array of
// { match, stdout, exit, stderr }: the first whose `match` is in its stdin, else the n-th (the last entry answers every
// call after it). Calls may run at once: each takes its number atomically, and `running` is how many were running when
// it started, itself included. FAKE_CLAUDE_WAIT is how many milliseconds a call takes.
import { appendFileSync, chmodSync, closeSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** One answer of the fake `claude`. */
export interface Reply { match?: string; stdout?: string; exit?: number; stderr?: string }

/** Puts `claude` on the sandbox's PATH. */
export function installFakeClaude(bin: string) {
  const file = join(bin, 'claude');
  writeFileSync(file, `#!/bin/sh\nexec node '${import.meta.filename}' "$@"\n`);
  chmodSync(file, 0o755);
}

if (import.meta.main) {
  const log = process.env.FAKE_CLAUDE_LOG!;
  let n = 0;
  for (;; n++) {
    try {
      closeSync(openSync(`${log}.${n}`, 'wx'));
      break;
    } catch {}
  }
  const marker = `${log}.running.${n}`;
  writeFileSync(marker, '');
  const running = readdirSync(dirname(log)).filter((f) => f.startsWith(`${basename(log)}.running.`)).length;
  const stdin = readFileSync(0, 'utf8');
  appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), cwdEntries: readdirSync('.'), running })}\n`);
  const replies: Reply[] = JSON.parse(process.env.FAKE_CLAUDE_REPLY ?? '[]');
  const reply = replies.find((r) => r.match !== undefined && stdin.includes(r.match)) ?? replies[Math.min(n, replies.length - 1)] ?? {};
  await new Promise((done) => setTimeout(done, Number(process.env.FAKE_CLAUDE_WAIT ?? 0)));
  rmSync(marker);
  process.stdout.write(reply.stdout ?? '');
  process.stderr.write(reply.stderr ?? '');
  process.exitCode = reply.exit ?? 0;
}
