// Synthetic Claude Code transcripts: the line shapes heeded reads, written the way Claude Code writes them (one compact
// JSON object per line, under projects/<the folder's path with every non-alphanumeric character turned into `-`>).
// Nothing here comes from a real transcript.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Line = Record<string, unknown>;

export const user = (text: string): Line => ({ type: 'user', message: { role: 'user', content: text } });
export const noise = (type: string, bytes: number): Line => ({ type, data: 'x'.repeat(bytes) });

/** Lines of these types carry the session's cwd and the rest Claude Code stamps; the others carry their session only. */
const MESSAGES = new Set(['user', 'assistant', 'attachment', 'system']);
let clock = Date.parse('2026-11-01T09:00:00Z');
let count = 0;

function stamp(line: Line, cwd: string, sessionId: string, agentId: string | null): string {
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

const write = (file: string, lines: Line[], cwd: string, id: string, agent: string | null) =>
  writeFileSync(file, lines.map((l) => stamp(l, cwd, id, agent) + '\n').join(''));

/** Writes a session run in `folder` (a line's own `cwd` wins), and its subagents; returns the main file's path. */
export function writeSession(configDir: string, folder: string, id: string, lines: Line[],
  subagents: Record<string, Line[]> = {}): string {
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
