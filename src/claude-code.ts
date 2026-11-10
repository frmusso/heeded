// The Claude Code adapter, the only module that knows where Claude Code keeps its transcripts and what their lines look
// like: it finds the transcripts of the sessions run in a folder and streams them into neutral events.
import { createReadStream, type Dirent } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export type Event =
  | { kind: 'transcript'; session: string; agent: string | null };

/** A folder's entries by name; none when it doesn't exist. */
async function entries(dir: string): Promise<Dirent[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch {
    return [];
  }
}

/** A file's lines as its bytes arrive, never the whole file in memory. */
async function* lines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of createReadStream(path)) {
    const text = decoder.decode(chunk as Buffer, { stream: true });
    let start = 0;
    for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n', start)) {
      yield rest + text.slice(start, end);
      rest = '';
      start = end + 1;
    }
    rest += text.slice(start);
  }
  rest += decoder.decode();
  if (rest) yield rest;
}

/**
 * Emits the session's events when it ran in the folder: decided by the first line that records a `cwd`, the only line
 * parsed for it. A file that never records one stays in scope, since its project folder's name already matched.
 */
async function readMain(path: string, session: string, inside: (cwd: string) => boolean, emit: (e: Event) => void) {
  for await (const line of lines(path)) {
    if (!line.includes('"cwd":"')) continue;
    let cwd: unknown;
    try {
      cwd = JSON.parse(line).cwd;
    } catch {
      continue;
    }
    if (typeof cwd !== 'string') continue;
    if (!inside(cwd)) return false;
    break;
  }
  emit({ kind: 'transcript', session, agent: null });
  return true;
}

/** Claude Code names a project's folder after its path, every character but a letter or a digit turned into `-`. */
const encode = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');

export async function read(configDir: string, folder: string, emit: (e: Event) => void): Promise<void> {
  // Claude Code records the path it was started from, which may be the folder's real path or a symlink to it.
  const folders = [...new Set([folder, await realpath(folder).catch(() => folder)])];
  const names = folders.map(encode);
  const inside = (cwd: string) => folders.some((f) => cwd === f || cwd.startsWith(`${f}/`));
  const projects = join(configDir, 'projects');
  for (const dir of await entries(projects)) {
    if (!dir.isDirectory() || !names.some((n) => dir.name === n || dir.name.startsWith(`${n}-`))) continue;
    const project = join(projects, dir.name);
    for (const file of await entries(project)) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const session = file.name.slice(0, -'.jsonl'.length);
      if (!(await readMain(join(project, file.name), session, inside, emit))) continue;
      for (const sub of await entries(join(project, session, 'subagents'))) {
        if (!sub.isFile() || !sub.name.startsWith('agent-') || !sub.name.endsWith('.jsonl')) continue;
        emit({ kind: 'transcript', session, agent: sub.name.slice('agent-'.length, -'.jsonl'.length) });
      }
    }
  }
}
