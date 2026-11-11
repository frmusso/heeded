// The user's own claude, asked one question with a schema: the call the extraction and the judge share.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Items grouped into calls of at most `limit` characters; a bigger item goes alone. */
export function batches<T>(items: T[], size: (item: T) => number, limit: number): T[][] {
  const out: T[][] = [];
  let used = Infinity;
  for (const item of items) {
    const n = size(item);
    if (used + n > limit) {
      out.push([]);
      used = 0;
    }
    out[out.length - 1].push(item);
    used += n;
  }
  return out;
}

/** Calls running at once: a long run takes a third of the time for the same tokens, and the machine runs three claude
 * processes, not dozens. */
const CALLS = 3;

/** Runs `work` on each item, in order, at most 3 at once; after `stop()`, or once an item throws, no other item
 * starts. */
export async function pool<T>(items: T[], work: (item: T, i: number, stop: () => void) => Promise<void>): Promise<void> {
  let next = 0;
  let stopped = false;
  const stop = () => (stopped = true);
  const lane = async () => {
    while (!stopped && next < items.length) {
      const i = next++;
      try {
        await work(items[i], i, stop);
      } catch (e) {
        stop();
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CALLS, items.length) }, lane));
}

/** How long a call may take: the slowest measured take about 2 minutes, and one that hangs would hang heeded for
 * good. */
const LIMIT = 5 * 60_000;

/** Runs claude in an empty folder of its own, removed after, so no project instruction file is loaded with it; killed
 * past `limit` milliseconds (`late`). Null when there is no claude to run. */
async function claude(args: string[], prompt: string, env: NodeJS.ProcessEnv, limit: number):
  Promise<{ code: number | null; stdout: string; stderr: string; late: boolean } | null> {
  const cwd = mkdtempSync(join(tmpdir(), 'heeded-'));
  try {
    return await new Promise((resolve) => {
      const child = spawn('claude', args, { cwd, env });
      let stdout = '';
      let stderr = '';
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        child.kill('SIGKILL');
      }, limit);
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, late });
      });
      child.stdin.on('error', () => {}); // claude may stop reading, or never start
      child.stdin.end(prompt);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** The first line with something on it. */
const firstLine = (text: string) => text.split('\n').find((l) => l.trim())?.trim() ?? '';

/**
 * One `claude -p` call, isolated: no tools, no session saved, no settings, hooks, MCP servers or slash commands of the
 * user's. The prompt goes on stdin; the answer is its structured output, to be checked by the caller. `fatal` when
 * there is no claude to run, so no other call is tried. A call past `limit` milliseconds (5 minutes) is stopped.
 */
export async function ask(model: string, schema: string, prompt: string, env: NodeJS.ProcessEnv, limit = LIMIT):
  Promise<{ tokens: number; output?: unknown; error?: string; fatal?: boolean }> {
  const run = await claude(['-p', '--model', model, '--output-format', 'json', '--json-schema', schema,
    '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}'], prompt, env, limit);
  if (!run) return { tokens: 0, error: 'claude not found. install claude code, or run heeded where claude runs.', fatal: true };
  // Its batch waits for the next run; the others go on.
  if (run.late) return { tokens: 0, error: `claude took more than ${limit / 60_000} minutes: stopped` };
  if (run.code !== 0) return { tokens: 0, error: `claude exited with code ${run.code}: ${firstLine(run.stderr) || firstLine(run.stdout)}` };
  let out;
  try {
    out = JSON.parse(run.stdout);
  } catch {}
  const u = out?.usage ?? {};
  const tokens = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens, u.output_tokens]
    .reduce((n: number, t) => n + (typeof t === 'number' ? t : 0), 0);
  if (out?.is_error === true) return { tokens, error: `claude: ${firstLine(String(out.result ?? ''))}` };
  return { tokens, output: out?.structured_output };
}
