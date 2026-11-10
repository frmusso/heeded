// From instruction files to rules: sections, the extraction call, verification, the cache.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Check, compile, LANGUAGES, verdict } from './check.ts';
import type { InstructionFile } from './claude-code.ts';

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

/** An example call the extraction gives for a tool rule: the tool and the value of the checked field. */
interface Example { tool: string; value: string }

export interface Rule {
  id: string;
  quote: string;
  name: string;
  kind: 'tool' | 'language' | 'judgment';
  trigger: string;
  check?: Check & { language?: string };
  breaking?: Example[];
  keeping?: Example[];
  /** Why a rule with a check is not checked. */
  demoted?: string;
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * A rule as the extraction returned it, checked here: its quote must be in its section, word for word (spacing aside),
 * or the rule is dropped; a check that can't be trusted is demoted, with the reason, and never gives a violation.
 */
export function verify(raw: unknown, section: Section): Rule | null {
  const r = raw as Record<string, unknown>;
  if (typeof r?.quote !== 'string' || !collapse(section.text).includes(collapse(r.quote))) return null;
  const id = createHash('sha256').update(collapse(r.quote).toLowerCase()).digest('hex').slice(0, 8);
  const name = [...String(r.name)].slice(0, 40).join('').trimEnd();
  const rule: Rule = { ...(r as unknown as Rule), id, name };
  const language = rule.check?.language;
  const demoted = rule.kind === 'tool' ? demotion(rule)
    : rule.kind === 'language' && !LANGUAGES.includes(String(language)) ? `language ${language} not supported` : undefined;
  return demoted ? { ...rule, demoted } : rule;
}

function demotion(rule: Rule): string | undefined {
  const compiled = compile(rule.check ?? {});
  if (typeof compiled === 'string') return compiled;
  if (!rule.breaking?.length) return 'no breaking example';
  if (!rule.keeping?.length) return 'no keeping example';
  const call = (e: Example) => verdict(compiled, e.tool, compiled.field === undefined ? {} : { [compiled.field]: e.value });
  const breaks = rule.breaking.find((e) => call(e) !== 'broken');
  if (breaks) return `failed its examples: breaks "${breaks.value}"`;
  const keeps = rule.keeping.find((e) => call(e) !== 'kept');
  if (keeps) return `failed its examples: keeps "${keeps.value}"`;
}

/** A section's rules as the extraction returned them, or null when they were never read (or the file is damaged). */
export function load(cacheDir: string, hash: string): unknown[] | null {
  try {
    const rules = JSON.parse(readFileSync(join(cacheDir, 'heeded', `${hash}.json`), 'utf8'));
    return Array.isArray(rules) ? rules : null;
  } catch {
    return null;
  }
}

/** Written whole or not at all: a temporary file, then a rename. */
export function save(cacheDir: string, hash: string, rules: unknown[]) {
  const dir = join(cacheDir, 'heeded');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${hash}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(rules));
  renameSync(tmp, join(dir, `${hash}.json`));
}

/**
 * A file's rules from the cache, and its sections never read, memoized by content: worktrees and sessions record the
 * same files over and over. `AutoMem` is Claude Code's memory index, one-line pointers edited constantly: not measured.
 */
export function rulesOf(cacheDir: string): (file: InstructionFile) => { rules: Rule[]; missing: Section[] } {
  const seen = new Map<string, { rules: Rule[]; missing: Section[] }>();
  const none = { rules: [], missing: [] };
  return (file) => {
    if (file.type === 'AutoMem') return none;
    let found = seen.get(file.content);
    if (!found) {
      found = { rules: [], missing: [] };
      for (const section of sections(file.content)) {
        const raw = load(cacheDir, section.hash);
        if (raw === null) found.missing.push(section);
        else for (const r of raw) {
          const rule = verify(r, section);
          if (rule) found.rules.push(rule);
        }
      }
      seen.set(file.content, found);
    }
    return found;
  };
}
