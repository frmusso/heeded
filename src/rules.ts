// From instruction files to rules: sections, the extraction call, verification, the cache.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Check, compile, LANGUAGES, verdict } from './check.ts';
import type { InstructionFile } from './claude-code.ts';
import { redact } from './redact.ts';

/** Part of every section's hash: a new prompt or model reads every section again. */
const PROMPT_VERSION = 2;
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
  let fence = ''; // the marker of the open code block: it closes with its own kind, at least as long
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !fence) fence = marker;
    else if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = '';
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
 * A rule as the extraction returned it, checked here: its quote must be in its section as the model read it (secrets
 * redacted), word for word (spacing aside), or the rule is dropped; a check that can't be trusted is demoted, with the reason, and never gives a violation.
 */
export function verify(raw: unknown, section: Section): Rule | null {
  const r = raw as Record<string, unknown>;
  if (typeof r?.quote !== 'string' || !collapse(redact(section.text)).includes(collapse(r.quote))) return null;
  const id = createHash('sha256').update(collapse(r.quote).toLowerCase()).digest('hex').slice(0, 8);
  const name = [...String(r.name).replace(/[\p{Cc}\s]+/gu, ' ').trim()].slice(0, 40).join('').trimEnd();
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
  // A keeping example may be a near miss the rule doesn't apply to (a search for the forbidden word); none may break it.
  const keeps = rule.keeping.find((e) => call(e) === 'broken');
  if (keeps) return `failed its examples: keeps "${keeps.value}"`;
  if (!rule.keeping.some((e) => call(e) === 'kept')) return 'failed its examples: none of the keeping examples applies';
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
 * same files over and over. Null for a file not measured: `AutoMem` is Claude Code's memory index, one-line pointers
 * edited constantly.
 */
export function rulesOf(cacheDir: string): (file: InstructionFile) => { rules: Rule[]; missing: Section[] } | null {
  const seen = new Map<string, { rules: Rule[]; missing: Section[] }>();
  return (file) => {
    if (file.type === 'AutoMem') return null;
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

/** Sections grouped into calls of at most 30,000 characters of text; a bigger section goes alone. */
function batches(sections: Section[]): Section[][] {
  const out: Section[][] = [];
  let size = Infinity;
  for (const section of sections) {
    if (size + section.text.length > 30_000) {
      out.push([]);
      size = 0;
    }
    out[out.length - 1].push(section);
    size += section.text.length;
  }
  return out;
}

/** What reading `sections` would cost: each call carries ~4.4k tokens of prompt and schema; the text is read once and
 * answered with about twice as much (a JSON object per rule). Fitted on real calls; the real count is shown after. */
export function estimate(sections: Section[]): { calls: number; tokens: number } {
  const calls = batches(sections).length;
  const chars = sections.reduce((n, s) => n + s.text.length, 0);
  return { calls, tokens: 4400 * calls + 3 * Math.ceil(chars / 4) };
}

const PATTERNS = { type: 'object', properties: { tool: { type: 'string' }, value: { type: 'string' }, data: { type: 'string' } } };
const EXAMPLES = {
  type: 'array',
  items: { type: 'object', properties: { tool: { type: 'string' }, value: { type: 'string' } }, required: ['tool', 'value'] },
};
const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                quote: { type: 'string' },
                name: { type: 'string' },
                kind: { enum: ['tool', 'language', 'judgment'] },
                trigger: { type: 'string' },
                check: {
                  type: 'object',
                  properties: {
                    field: { type: 'string' }, when: PATTERNS, broken: PATTERNS, ignoreCase: { type: 'boolean' },
                    language: { type: 'string' },
                  },
                },
                breaking: EXAMPLES,
                keeping: EXAMPLES,
              },
              required: ['quote', 'name', 'kind', 'trigger'],
            },
          },
        },
        required: ['id', 'rules'],
      },
    },
  },
  required: ['sections'],
});

const PROMPT = `You read the instruction files a coding agent (Claude Code) is given, and list the rules in them, so that a tool
can check later whether the agent followed each one. Below are sections of those files. Return every section by its id
with the rules it states: an empty list when it states none. A rule tells the agent to do or not to do something;
descriptions, explanations and context are not rules.

For each rule:
- quote: the rule's own words, copied exactly from the section: never reworded, typos and formatting (backticks) kept.
- name: a summary of at most 40 characters, in the rule's own language.
- kind: "tool" when a single tool call shows, without doubt, whether the rule was kept or broken; "language" for the
  language the agent must use in its replies to the user (not in code, commits or files); "judgment" for everything
  else.
- trigger: when the rule applies, in a few words ("staging files with git").

A "language" rule has check: { "language": "<two-letter ISO 639-1 code>" }.

A "tool" rule has a check over one call: its tool name and one top-level string field of its input.
- Claude Code tools: Bash (field "command"), Edit (file_path, old_string, new_string), Write (file_path, content),
  Read (file_path); MCP tools are named mcp__<server>__<tool>.
- field: the input field matched; left out to match on the tool name alone.
- A "command" is read the way a shell reads it, one simple command at a time (split on &&, ||, ;, |, & and line
  breaks). "value" sees what a simple command does: its words, with quoted text emptied ('' and "" stay) and heredoc
  bodies left out. "data" sees what it carries: its quoted text and heredoc bodies, such as a commit message. What
  sh -c, bash -c, ssh or eval are given to run is read as commands too. Any other field is matched whole by "value".
- when: the calls the rule is about: "tool", a regex over the tool name (anchored, like ^Bash$), and "value" and "data",
  regexes as above; any may be left out.
- broken: what makes such a call break the rule: a "tool", "value" or "data" regex, at least one. For a command, when
  and broken must match the same simple command.
- ignoreCase: true when letter case doesn't matter.
- The regexes are JavaScript, without flags, and never repeat a group that holds a quantifier or an alternation, like
  (a+)+ or (a|b)+.
- breaking: two or three example calls { "tool", "value" } that break the rule; keeping: two or three calls that keep
  it, at least one the rule is about, and one near miss that names the forbidden thing without doing it (a search for
  it, an echo of it, a commit message naming it). A value is the field's whole value: for Bash, a whole command line.
`;

/** `claude -p` isolated: no tools, no session saved, no settings, hooks, MCP servers or slash commands of the user's. */
const ARGS = ['-p', '--model', MODEL, '--output-format', 'json', '--json-schema', SCHEMA, '--no-session-persistence',
  '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--settings',
  '{"disableAllHooks":true}'];

/** Runs claude in an empty folder of its own, removed after, so no project instruction file is loaded with it; null
 * when there is no claude to run. */
async function claude(prompt: string, env: NodeJS.ProcessEnv):
  Promise<{ code: number | null; stdout: string; stderr: string } | null> {
  const cwd = mkdtempSync(join(tmpdir(), 'heeded-'));
  try {
    return await new Promise((resolve) => {
      const child = spawn('claude', ARGS, { cwd, env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
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
 * Reads the rules of `sections` through the user's own claude, sonnet, one call per batch, and caches each batch as it
 * comes: an interrupted run keeps what it paid for. Only the sections' text leaves the machine, secrets redacted; never
 * a file's path. A batch that fails is reported and nothing of it is cached.
 */
export async function extract(sections: Section[], env: NodeJS.ProcessEnv, cacheDir: string):
  Promise<{ read: number; tokens: number; errors: string[] }> {
  const errors: string[] = [];
  let read = 0;
  let tokens = 0;
  for (const batch of batches(sections)) {
    const body = batch.map((s, i) =>
      `<section id="${i + 1}" path="${redact(s.path.join(' › ')).replaceAll('"', "'")}">\n${redact(s.text)}\n</section>`);
    const run = await claude(`${PROMPT}\n${body.join('\n\n')}\n`, env);
    if (!run) {
      errors.push('claude not found. install claude code, or run heeded where claude runs.');
      break;
    }
    if (run.code !== 0) {
      errors.push(`claude exited with code ${run.code}: ${firstLine(run.stderr) || firstLine(run.stdout)}`);
      continue;
    }
    let out;
    try {
      out = JSON.parse(run.stdout);
    } catch {}
    const u = out?.usage ?? {};
    tokens += [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens, u.output_tokens]
      .reduce((n: number, t) => n + (typeof t === 'number' ? t : 0), 0);
    if (out?.is_error === true) {
      errors.push(`claude: ${firstLine(String(out.result ?? ''))}`);
      continue;
    }
    // Every section must be answered: one left out would be cached as holding no rule, and never read again.
    const answered = out?.structured_output?.sections;
    const byId = new Map(Array.isArray(answered) ? answered.map((a) => [a?.id, a?.rules]) : []);
    if (!batch.every((_, i) => Array.isArray(byId.get(String(i + 1))))) {
      errors.push("claude's answer didn't match the schema");
      continue;
    }
    batch.forEach((s, i) => save(cacheDir, s.hash, byId.get(String(i + 1))));
    read += batch.length;
  }
  return { read, tokens, errors };
}
