// The judge: the cases a rule may apply to, each with an excerpt of its session for a model to read.
import { createHash } from 'node:crypto';
import type { Event } from './claude-code.ts';
import { redact } from './redact.ts';

/** Part of every case's key: a new prompt or model judges every case again. */
export const JUDGE_VERSION = 1;
export const JUDGE_MODEL = 'sonnet';

/** An excerpt's size in characters: the whole; a call's or a reply's line; the user's words (they hold the
 * permissions) and the case itself. */
const WHOLE = 6000;
const LINE = 300;
const WORDS = 2000;

type Seen = Extract<Event, { kind: 'call' | 'reply' }>;

/** The characters secrets are made of. */
const TOKEN = /[\w+/=.-]/;

/** Text on one line, secrets redacted, cut at `limit` characters with `…` last. Only its head is redacted, for speed; a
 * word the head cuts in two is left out, since a secret cut short may escape the patterns that find it. */
function cut(text: string, limit: number): string {
  let end = Math.min(text.length, limit + 200);
  if (end < text.length && TOKEN.test(text[end])) while (end > 0 && TOKEN.test(text[end - 1])) end--;
  const line = redact(text.slice(0, end)).replace(/[\p{Cc}\s]+/gu, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** A call shows its command, else its file, else its whole input. */
function line(e: Seen, limit: number): string {
  if (e.kind === 'reply') return `reply: ${cut(e.text, limit)}`;
  const { command, file_path } = e.input;
  const detail = typeof command === 'string' ? command : typeof file_path === 'string' ? file_path : JSON.stringify(e.input);
  return `call ${e.tool}: ${cut(detail, limit)}`;
}

/** Whose words a prompt holds: `you` for the user's, `task` for what another agent asked. */
const words = (e: Extract<Event, { kind: 'prompt' }>) => `${e.by === 'user' ? 'you' : 'task'}: ${cut(e.text, WORDS)}`;

/**
 * The excerpts of a stream of events: `push` takes every event in order; `of` gives the excerpt of a call or reply not
 * pushed yet, which ends with it. An excerpt is the prompt that started the turn, then the events since, one per line,
 * at most 6,000 characters: when over, the events nearest the case stay, the user's words before the others, and a
 * line `…` stands for those left out.
 */
export function excerpts() {
  let start: string | null = null;
  // The lines since the start, oldest first, each kind bounded by what an excerpt can hold.
  let since: { text: string; you: boolean }[] = [];
  let sizes = [0, 0]; // characters of the lines since: the others', the user's words'
  let dropped = false;
  // Every rule in effect asks about the same event in turn.
  let memo: { e: Seen; result: { text: string; key: string } } | null = null;

  const restart = (line: string | null) => {
    start = line;
    since = [];
    sizes = [0, 0];
    dropped = false;
  };

  return {
    push(e: Event) {
      memo = null;
      if (e.kind === 'transcript') restart(null);
      else if (e.kind === 'prompt' && !e.answer) restart(words(e));
      else if (e.kind === 'prompt' || e.kind === 'call' || e.kind === 'reply') {
        const you = e.kind === 'prompt' && e.by === 'user';
        const text = e.kind === 'prompt' ? words(e) : line(e, LINE);
        since.push({ text, you });
        const k = Number(you);
        sizes[k] += text.length + 1;
        while (sizes[k] > WHOLE) {
          const i = since.findIndex((l) => l.you === you);
          sizes[k] -= since[i].text.length + 1;
          since.splice(i, 1);
          dropped = true;
        }
      }
    },

    of(e: Seen): { text: string; key: string } {
      if (memo?.e === e) return memo.result;
      const last = line(e, WORDS);
      let size = (start === null ? 0 : start.length + 1) + sizes[0] + sizes[1] + last.length + (dropped ? 2 : 0);
      const drop = new Set<number>();
      if (size > WHOLE && !dropped) size += 2;
      for (const you of [false, true]) {
        for (let i = 0; i < since.length && size > WHOLE; i++) {
          if (since[i].you !== you) continue;
          drop.add(i);
          size -= since[i].text.length + 1;
        }
      }
      const kept = since.filter((_, i) => !drop.has(i)).map((l) => l.text);
      const text = [...(start === null ? [] : [start]), ...(dropped || drop.size ? ['…'] : []), ...kept, last].join('\n');
      const key = createHash('sha256').update(JSON.stringify([JUDGE_VERSION, JUDGE_MODEL, text])).digest('hex');
      memo = { e, result: { text, key } };
      return memo.result;
    },
  };
}
