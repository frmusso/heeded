// The Claude Code adapter, the only module that knows where Claude Code keeps its transcripts and what their lines look
// like: it finds the transcripts of the sessions run in a folder and streams them into neutral events.
import type { Dirent } from 'node:fs';
import { type FileHandle, lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export interface InstructionFile { path: string; type: string; content: string }
export type Event =
  | { kind: 'transcript'; session: string; agent: string | null }
  | { kind: 'instructions'; files: InstructionFile[]; replace: boolean }
  | { kind: 'compaction'; trigger: string; preTokens: number }
  | { kind: 'call'; id: string; tool: string; input: Record<string, unknown>; at: string; depth: number; compactions: number }
  | { kind: 'reply'; id: string; text: string; at: string; depth: number; compactions: number }
  // A prompt: by the user in a main session, answers to the agent's questions and plans included (`answer`); in a
  // subagent's, the task the agent that started it wrote.
  | { kind: 'prompt'; text: string; at: string; by: 'user' | 'agent'; answer: boolean };
type Reply = Extract<Event, { kind: 'reply' }>;

/** A folder's entries by name; none when it doesn't exist. */
async function entries(dir: string): Promise<Dirent[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch {
    return [];
  }
}

/** A file's lines as its bytes arrive, never the whole file in memory. */
async function* lines(file: FileHandle): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of file.createReadStream()) {
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

const isFile = (f: unknown): f is InstructionFile => typeof f === 'object' && f !== null
  && typeof (f as InstructionFile).path === 'string' && typeof (f as InstructionFile).type === 'string'
  && typeof (f as InstructionFile).content === 'string';

/** What a transcript's earlier lines tell its later ones; `reply` is the message being written, until it ends; `asked`
 * the ids of the calls whose result is the user's answer. */
interface State { compactions: number; replace: boolean; depth: number; replies: boolean; reply: Reply | null; asked: Set<string> }

/** The tools whose result is what the user answered: a choice among options, a plan approved or not. */
const ASKING = new Set(['AskUserQuestion', 'ExitPlanMode']);

function flush(state: State, emit: (e: Event) => void) {
  if (state.reply) emit(state.reply);
  state.reply = null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const tokens = (v: unknown) => (typeof v === 'number' ? v : 0);
/** A message's text: a string, or its text blocks joined (images and the rest left out). */
const textOf = (c: unknown) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '');

/** The events of one line; false when it should have parsed and didn't. Only the lines heeded needs are parsed, found
 * by a substring first: a tool result, the bulk of a transcript, only when it answers one of the agent's questions. */
function onLine(line: string, state: State, out: (e: Event) => void): boolean {
  const user = line.includes('"type":"user"');
  const result = user ? /"tool_use_id":"([^"]*)"/.exec(line) : null;
  if (!line.includes('"type":"assistant"') && !line.includes('"type":"instructions"')
    && !line.includes('"type":"nested_memory"') && !line.includes('"compact_boundary"')
    && !(user && (!result || state.asked.has(result[1])))) return true;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return false;
  }
  // A message's reply goes out before an event that changes the rules or the compactions; its own calls don't.
  const emit = (e: Event) => {
    flush(state, out);
    out(e);
  };
  const a = o.attachment;
  const meta = o.compactMetadata;
  const m = o.message;
  if (o.type === 'assistant' && isObject(m) && Array.isArray(m.content) && typeof o.timestamp === 'string'
    && !Number.isNaN(Date.parse(o.timestamp))) {
    // The context the request was sent with: every line of a message carries the same usage.
    const u = m.usage;
    if (isObject(u)) state.depth = tokens(u.input_tokens) + tokens(u.cache_creation_input_tokens) + tokens(u.cache_read_input_tokens);
    for (const b of m.content) {
      // Replies are what the user reads: a subagent's text goes to the agent that called it.
      if (b?.type === 'text' && typeof b.text === 'string' && typeof m.id === 'string' && state.replies) {
        if (state.reply?.id === m.id) {
          state.reply.text += `\n${b.text}`;
        } else {
          flush(state, out);
          state.reply = { kind: 'reply', id: m.id, text: b.text, at: o.timestamp, depth: state.depth, compactions: state.compactions };
        }
      } else if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string' && isObject(b.input)) {
        if (ASKING.has(b.name)) state.asked.add(b.id);
        out({ kind: 'call', id: b.id, tool: b.name, input: b.input, at: o.timestamp, depth: state.depth, compactions: state.compactions });
      }
    }
  } else if (o.type === 'user' && isObject(m) && !o.isMeta && !o.isCompactSummary && typeof o.timestamp === 'string'
    && !Number.isNaN(Date.parse(o.timestamp))) {
    const results = Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'tool_result') : [];
    for (const b of results) {
      const text = state.asked.has(b.tool_use_id) ? textOf(b.content) : '';
      if (text.trim()) emit({ kind: 'prompt', text, at: o.timestamp, by: 'user', answer: true });
    }
    // Lines starting with a tag are Claude Code's own (a command run, a notification), as is an interruption's note.
    const text = results.length ? '' : textOf(m.content);
    const start = text.trimStart();
    if (start && start[0] !== '<' && !start.startsWith('[Request interrupted')) {
      emit({ kind: 'prompt', text, at: o.timestamp, by: state.replies ? 'user' : 'agent', answer: false });
    }
  } else if (o.type === 'attachment' && a?.type === 'instructions' && Array.isArray(a.files)) {
    // After a compaction Claude Code records every file in effect again: they replace the ones before.
    emit({ kind: 'instructions', files: a.files.filter(isFile), replace: state.replace });
    state.replace = false;
  } else if (o.type === 'attachment' && a?.type === 'nested_memory' && isFile(a.content)) {
    const { path, type, content } = a.content;
    emit({ kind: 'instructions', files: [{ path, type, content }], replace: false });
  } else if (o.type === 'system' && o.subtype === 'compact_boundary' && typeof meta?.trigger === 'string'
    && typeof meta.preTokens === 'number') {
    emit({ kind: 'compaction', trigger: meta.trigger, preTokens: meta.preTokens });
    state.compactions++;
    state.replace = true;
  }
  return true;
}

/**
 * Streams one transcript into events, after its `transcript` event. A main transcript (`inside` given) is read only
 * when it ran in the folder: decided by the first line that records a `cwd`, the only line parsed for it; a file that
 * never records one stays in scope, since its project folder's name already matched. Events of the lines before that
 * one wait for the decision.
 *
 * A file read whole is unrecognized when, from 20 lines on, more than half don't parse (a line that isn't `{…}`, or one
 * heeded parses and can't) or none is an assistant or user line: Claude Code may have changed its format, and an empty
 * result would hide it.
 */
async function readFile(path: string, session: string, agent: string | null, inside: ((cwd: string) => boolean) | null,
  emit: (e: Event) => void, unrecognized: string[]): Promise<boolean> {
  const file = await open(path).catch(() => null);
  if (!file) return false; // deleted since it was listed, or not readable: skipped
  let decided = inside === null;
  const held: Event[] = [];
  if (decided) emit({ kind: 'transcript', session, agent });
  const out = (e: Event) => (decided ? emit(e) : held.push(e));
  const state: State = { compactions: 0, replace: false, depth: 0, replies: agent === null, reply: null, asked: new Set() };
  let total = 0;
  let bad = 0;
  let messages = false;
  for await (const line of lines(file)) {
    if (!line) continue;
    total++;
    if (!decided && line.includes('"cwd":"')) {
      let cwd: unknown;
      try {
        cwd = JSON.parse(line).cwd;
      } catch {}
      if (typeof cwd === 'string') {
        if (!inside!(cwd)) return false;
        decided = true;
        emit({ kind: 'transcript', session, agent });
        held.forEach(emit);
      }
    }
    if (line.includes('"type":"assistant"') || line.includes('"type":"user"')) messages = true;
    if (line[0] !== '{' || !line.endsWith('}') || !onLine(line, state, out)) bad++;
  }
  flush(state, out);
  if (total >= 20 && (bad * 2 > total || !messages)) unrecognized.push(path);
  if (!decided && total > 0) {
    emit({ kind: 'transcript', session, agent });
    held.forEach(emit);
  }
  return true;
}

/** Claude Code names a project's folder after its path, every character but a letter or a digit turned into `-`. */
const encode = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');

export async function read(configDir: string, folder: string, emit: (e: Event) => void): Promise<{ unrecognized: string[] }> {
  const unrecognized: string[] = [];
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
      if (!(await readFile(join(project, file.name), session, null, inside, emit, unrecognized))) continue;
      const subagents = join(project, session, 'subagents');
      const real = async (dir: string) => (await lstat(dir).catch(() => null))?.isDirectory();
      if (!(await real(join(project, session))) || !(await real(subagents))) continue;
      for (const sub of await entries(subagents)) {
        if (!sub.isFile() || !sub.name.startsWith('agent-') || !sub.name.endsWith('.jsonl')) continue;
        await readFile(join(subagents, sub.name), session, sub.name.slice('agent-'.length, -'.jsonl'.length), null, emit,
          unrecognized);
      }
    }
  }
  return { unrecognized };
}
