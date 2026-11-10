// Synthetic Claude Code transcripts: the line shapes heeded reads, written the way Claude Code writes them (one compact
// JSON object per line, under projects/<the folder's path with every non-alphanumeric character turned into `-`>).
// Nothing here comes from a real transcript.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Line = Record<string, unknown>;

interface File { path: string; type: string; content: string }

export const instructions = (files: File[]): Line => ({ type: 'attachment', attachment: { type: 'instructions', files } });
export const nested = (file: File): Line => ({
  type: 'attachment', attachment: { type: 'nested_memory', path: file.path, content: { ...file, contentDiffersFromDisk: false } },
});
export const compact = (preTokens: number): Line => ({
  type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens },
});
export const summary = (): Line => ({
  type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous one.' },
});
export const user = (text: string): Line => ({ type: 'user', message: { role: 'user', content: text } });
interface Tool { id: string; name: string; input: Record<string, unknown> }

/** One line of an assistant message: Claude Code writes each content block of a message on a line of its own. */
export const assistant = ({ id, text, tool, usage }: { id: string; text?: string; tool?: Tool; usage?: Record<string, number> }): Line => ({
  type: 'assistant',
  message: {
    model: 'claude-test', id, type: 'message', role: 'assistant',
    content: [text === undefined ? { type: 'tool_use', ...tool } : { type: 'text', text }],
    stop_reason: null, ...(usage ? { usage } : {}),
  },
});
export const noise = (type: string, bytes: number): Line => ({ type, data: 'x'.repeat(bytes) });

/** Lines of these types carry the session's cwd and the rest Claude Code stamps; the others carry their session only. */
const MESSAGES = new Set(['user', 'assistant', 'attachment', 'system']);
let clock = Date.parse('2026-11-01T09:00:00Z');
let count = 0;

function stamp(line: Line | string, cwd: string, sessionId: string, agentId: string | null): string {
  if (typeof line === 'string') return line; // a raw line, written as given
  if (!MESSAGES.has(line.type as string)) return JSON.stringify({ ...line, sessionId });
  const { cwd: ownCwd, timestamp, ...rest } = line;
  count++;
  return JSON.stringify({
    parentUuid: null, isSidechain: agentId !== null, ...(agentId ? { agentId } : {}), ...rest,
    uuid: `00000000-0000-4000-8000-${String(count).padStart(12, '0')}`,
    timestamp: timestamp ?? new Date((clock += 1000)).toISOString(),
    userType: 'external', cwd: ownCwd ?? cwd, sessionId, version: '2.1.322',
  });
}

/** Written a megabyte at a time: a large fixture never sits whole in memory. */
function write(file: string, lines: Iterable<Line | string>, cwd: string, id: string, agent: string | null) {
  writeFileSync(file, '');
  let chunk = '';
  for (const l of lines) {
    chunk += `${stamp(l, cwd, id, agent)}\n`;
    if (chunk.length > 1 << 20) {
      appendFileSync(file, chunk);
      chunk = '';
    }
  }
  appendFileSync(file, chunk);
}

/** Writes a session run in `folder` (a line's own `cwd` wins), and its subagents; returns the main file's path. */
export function writeSession(configDir: string, folder: string, id: string, lines: Iterable<Line | string>,
  subagents: Record<string, (Line | string)[]> = {}): string {
  const dir = join(configDir, 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  write(file, lines, folder, id, null);
  for (const [agent, agentLines] of Object.entries(subagents)) {
    const sub = join(dir, id, 'subagents');
    mkdirSync(sub, { recursive: true });
    write(join(sub, `agent-${agent}.jsonl`), agentLines, folder, id, agent);
    writeFileSync(join(sub, `agent-${agent}.meta.json`), JSON.stringify({ agentType: 'general-purpose' }));
  }
  return file;
}

/**
 * About `bytes` of lines in the proportions measured on real transcripts: assistant lines (the ones heeded parses) ~40%
 * of the bytes, tool results ~30%, request blobs ~12%, the rest attachments and bookkeeping. Every fourth assistant line
 * is an Italian reply, every fifth call runs `git add -A`.
 */
export function* mix(bytes: number): Generator<Line> {
  const reply = 'Ho controllato il test che fallisce e il problema è nel parser, quindi adesso lo sistemo. '.repeat(20);
  for (let size = 0, n = 0; size < bytes; size += 107_000) {
    for (let i = 0; i < 20; i++, n++) {
      const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: (n * 37) % 500_000, output_tokens: 50 };
      const command = `${n % 5 ? 'git status' : 'git add -A'} && echo ${'x'.repeat(1700)}`;
      yield i % 4 ? assistant({ id: `msg_${n}`, tool: { id: `toolu_${n}`, name: 'Bash', input: { command } }, usage })
        : assistant({ id: `msg_${n}`, text: reply, usage });
    }
    for (let i = 0; i < 3; i++) {
      yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${n}`, content: 'y'.repeat(10_000) }] } };
    }
    yield noise('api-request-blob', 12_000);
    yield user('z'.repeat(2_000));
    for (let i = 0; i < 4; i++) yield { type: 'attachment', attachment: { type: 'hook_success', stdout: 'h'.repeat(2_000) } };
    yield noise('file-history-snapshot', 2_000);
    yield noise('queue-operation', 1_000);
    yield noise('api-request', 2_000);
    yield noise('api-request', 2_000);
  }
}
