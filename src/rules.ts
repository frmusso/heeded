// From instruction files to rules: sections, the extraction call, verification, the cache.
import { createHash } from 'node:crypto';

/** Part of every section's hash: a new prompt or model reads every section again. */
const PROMPT_VERSION = 1;
const MODEL = 'sonnet';

/** A heading and its text up to the next heading, with its ancestors' headings as context; the unit rules are read and
 * cached by. */
export interface Section { path: string[]; text: string; hash: string }

const hash = (path: string[], text: string) =>
  createHash('sha256').update(JSON.stringify([PROMPT_VERSION, MODEL, path, text])).digest('hex');

export function sections(content: string): Section[] {
  const out: Section[] = [];
  const ancestors: { level: number; title: string }[] = [];
  let path: string[] = [];
  let lines: string[] = [];
  let heading = '';
  // A heading with nothing under it holds no rule: it is context for its subsections.
  const close = () => {
    const text = lines.join('\n').trim();
    if (text && text !== heading) out.push({ path, text, hash: hash(path, text) });
  };
  let fence = false;
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^ {0,3}(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,6})[ \t]+(.+)$/.exec(line);
    if (h) {
      close();
      const level = h[1].length;
      while (ancestors.length && ancestors[ancestors.length - 1].level >= level) ancestors.pop();
      path = ancestors.map((a) => a.title);
      ancestors.push({ level, title: h[2].trim() });
      heading = line.trim();
      lines = [];
    }
    lines.push(line);
  }
  close();
  return out;
}
