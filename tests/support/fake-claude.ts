// A stand-in for `claude`, so no test ever reaches a model. Each call appends one JSON line to FAKE_CLAUDE_LOG
// ({ argv, stdin, cwd, cwdEntries }) and answers with the n-th entry of FAKE_CLAUDE_REPLY, a JSON array of
// { stdout, exit, stderr } (the last entry answers every call after it).
import { appendFileSync, chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Puts `claude` on the sandbox's PATH. */
export function installFakeClaude(bin: string) {
  const file = join(bin, 'claude');
  writeFileSync(file, `#!/bin/sh\nexec node '${import.meta.filename}' "$@"\n`);
  chmodSync(file, 0o755);
}

if (import.meta.main) {
  const log = process.env.FAKE_CLAUDE_LOG!;
  let calls = 0;
  try {
    calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
  } catch {}
  const stdin = readFileSync(0, 'utf8');
  appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), cwdEntries: readdirSync('.') })}\n`);
  const replies = JSON.parse(process.env.FAKE_CLAUDE_REPLY ?? '[]');
  const reply = replies[Math.min(calls, replies.length - 1)] ?? {};
  process.stdout.write(reply.stdout ?? '');
  process.stderr.write(reply.stderr ?? '');
  process.exitCode = reply.exit ?? 0;
}
