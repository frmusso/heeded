// From instruction files to rules: sections, the extraction call, verification, the cache.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applies, type Check, compile, LANGUAGES, verdict } from './check.ts';
import type { InstructionFile } from './claude-code.ts';
import { ask, batches } from './model.ts';
import { redact } from './redact.ts';

/** Part of every section's hash: a new prompt or model reads every section again. */
const PROMPT_VERSION = 3;
export const MODEL = 'sonnet';

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
  /** The headings of its section, ancestors first, its own last, joined by ` › `; `''` when it has none. */
  heading: string;
  /** The words around it in its section, secrets redacted, on one line: a rule's quote alone can read wrong. */
  context?: string;
  /** The instruction file it was read from: a rule meant for one folder is told by where it is written. */
  file?: string;
  kind: 'tool' | 'language' | 'judgment';
  trigger: string;
  check?: Check & { language?: string };
  breaking?: Example[];
  keeping?: Example[];
  /** Why a rule with a check is not checked. */
  demoted?: string;
  /** Why a judgment rule has no cases to judge. */
  noCases?: string;
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
  const own = /^#{1,6}[ \t]+(.+)$/.exec(section.text.split('\n')[0])?.[1].trim();
  const heading = [...section.path, ...(own ? [own] : [])].join(' › ');
  // What the section says around the rule: from 500 characters before its words to 1,000 after.
  const text = collapse(redact(section.text));
  const at = text.indexOf(collapse(r.quote));
  const [from, to] = [Math.max(0, at - 500), Math.min(text.length, at + collapse(r.quote).length + 1000)];
  const context = `${from ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
  const rule: Rule = { ...(r as unknown as Rule), id, name, heading, context };
  if (rule.kind === 'judgment') {
    // What breaks a judgment rule is for the judge to say: its check only finds the cases.
    const { broken: _, ...check } = rule.check ?? {};
    const judged = rule.check ? { ...rule, check } : rule;
    const noCases = casesless(judged);
    return noCases ? { ...judged, noCases } : judged;
  }
  const language = rule.check?.language;
  const demoted = rule.kind === 'tool' ? demotion(rule)
    : rule.kind === 'language' && !LANGUAGES.includes(String(language)) ? `language ${language} not supported` : undefined;
  return demoted ? { ...rule, demoted } : rule;
}

function demotion(rule: Rule): string | undefined {
  const b = rule.check?.broken;
  if (b?.tool === undefined && b?.value === undefined && b?.data === undefined) return 'no broken pattern';
  const compiled = compile(rule.check!);
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

/** Why a judgment rule has no case a judge could read, if so: a rule about replies has every reply; another needs a
 * `when` that compiles and finds each of its keeping examples. */
function casesless(rule: Rule): string | undefined {
  const c = rule.check;
  if (c?.reply === true) return;
  if (c?.when?.tool === undefined && c?.when?.value === undefined && c?.when?.data === undefined) return 'no case to judge it on';
  const compiled = compile(c);
  if (typeof compiled === 'string') return compiled;
  if (!rule.keeping?.length) return 'no example of a case';
  const missed = rule.keeping.find((e) => !applies(compiled, e.tool, compiled.field === undefined ? {} : { [compiled.field]: e.value }));
  if (missed) return `failed its examples: "${missed.value}" is not a case`;
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
export function write(dir: string, name: string, value: unknown) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${name}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, join(dir, `${name}.json`));
}

export function save(cacheDir: string, hash: string, rules: unknown[]) {
  write(join(cacheDir, 'heeded'), hash, rules);
}

/** A section waiting to be read: when its file was last in effect during a call or a reply (`''` when never). */
export interface Pending { section: Section; identity: string; at: string }
/** One version of a section: whether it was read itself, and when the version of it remembered as read last was in
 * effect (null: none was read). */
export interface Version { section: Section; identity: string; read: boolean; readAt: string | null }

/** The same section across versions of its file: the file, the headings above it, its own heading, and which one of
 * that name it is when a file repeats a heading. */
function identity(path: string, s: Section, seen: Map<string, number>): string {
  const key = JSON.stringify([s.path, /^#{1,6}[ \t]/.test(s.text) ? s.text.split('\n')[0] : '']);
  const n = seen.get(key) ?? 0;
  seen.set(key, n + 1);
  return JSON.stringify([path, ...JSON.parse(key), ...(n ? [n] : [])]);
}

const latest = (cacheDir: string) => join(cacheDir, 'heeded', 'latest');
// Under the prompt's version and the model, like each section's hash: a new prompt reads every section again.
const idHash = (id: string) => createHash('sha256').update(JSON.stringify([PROMPT_VERSION, MODEL, id])).digest('hex');

/** The version of a section read last, by the time it was in effect: the one older versions take their rules from. */
function recall(cacheDir: string, id: string): { hash: string; at: string } | null {
  try {
    const known = JSON.parse(readFileSync(join(latest(cacheDir), `${idHash(id)}.json`), 'utf8'));
    return typeof known?.hash === 'string' && typeof known.at === 'string' ? known : null;
  } catch {
    return null;
  }
}

/** Remembers a read version of a section, unless one in effect as late or later is remembered already: the cache is
 * shared by every folder and config dir, whose histories interleave. */
export function remember(cacheDir: string, id: string, hash: string, at: string) {
  const known = recall(cacheDir, id);
  if (!known || at > known.at) write(latest(cacheDir), idHash(id), { hash, at });
}

/**
 * A file's rules from the cache, and its sections never read, memoized by path and content: worktrees and sessions
 * record the same files over and over. A section never read takes the rules of the version of it read last, each kept
 * only where its words are written. Null for a file not measured: `AutoMem` is Claude Code's memory index, one-line
 * pointers edited constantly.
 */
export function rulesOf(cacheDir: string): (file: InstructionFile) => { rules: Rule[]; versions: Version[] } | null {
  const seen = new Map<string, Map<string, { rules: Rule[]; versions: Version[] }>>();
  return (file) => {
    if (file.type === 'AutoMem') return null;
    let byContent = seen.get(file.path);
    if (!byContent) seen.set(file.path, (byContent = new Map()));
    let found = byContent.get(file.content);
    if (!found) {
      found = { rules: [], versions: [] };
      const names = new Map<string, number>();
      for (const section of sections(file.content)) {
        const id = identity(file.path, section, names);
        const known = recall(cacheDir, id);
        let raw = load(cacheDir, section.hash);
        found.versions.push({ section, identity: id, read: raw !== null, readAt: known?.at ?? null });
        if (raw === null && known) raw = load(cacheDir, known.hash);
        for (const r of raw ?? []) {
          const rule = verify(r, section);
          if (rule) found.rules.push({ ...rule, file: file.path });
        }
      }
      byContent.set(file.content, found);
    }
    return found;
  };
}

/** Sections go to claude in calls of at most 30,000 characters of their text. */
const BATCH = 30_000;

/** What reading `sections` would cost: each call carries ~4.4k tokens of prompt and schema; the text is read once and
 * answered with about twice as much (a JSON object per rule). Fitted on real calls; the real count is shown after. */
export function estimate(sections: Section[]): { calls: number; tokens: number } {
  const calls = batches(sections, (s) => s.text.length, BATCH).length;
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
                    language: { type: 'string' }, reply: { type: 'boolean' },
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

// Raw: the regexes in it reach the model as written.
const PROMPT = String.raw`You read the instruction files a coding agent (Claude Code) is given, and list the rules in them, so that a tool
can check later whether the agent followed each one. Below are sections of those files. Return every section by its id
with the rules it states: an empty list when it states none. A rule tells the agent to do or not to do something;
descriptions, explanations and context are not rules.

For each rule:
- quote: the rule's own words, copied exactly from the section: never reworded, typos and formatting (backticks) kept.
- name: a summary of at most 40 characters, in the rule's own language.
- kind: "tool" when a single tool call shows, without doubt and whatever came before it, whether the rule was kept or
  broken; "language" for the language the agent must use in its replies to the user (not in code, commits or files);
  "judgment" for everything else. A rule with an exception, or a condition one call can't show (the user's go or
  request, being asked first, a folder or a sub-project, a time, before or after something else), is "judgment".
- trigger: when the rule applies, in a few words ("staging files with git").

A "language" rule has check: { "language": "<two-letter ISO 639-1 code>" }.

A "tool" rule has a check over one call: its tool name and one top-level string field of its input.
- Claude Code tools: Bash (field "command"), Edit (file_path, old_string, new_string), Write (file_path, content),
  Read (file_path); MCP tools are named mcp__<server>__<tool>. A file_path is absolute: match a folder in it
  (/vendor/) or its end (\.lock$), not its start.
- field: the input field matched; left out to match on the tool name alone.
- A "command" is read the way a shell reads it, one simple command at a time (split on &&, ||, ;, |, & and line
  breaks). "value" sees what a simple command does: its words, with quoted text emptied ('' and "" stay) and heredoc
  bodies left out; it may start with assignments (CI=1), sudo, env, time or nohup. Match a program or a subcommand as
  a whole word of the command, (^|\s)tsc(\s|$) or (^|\s)git\s+push(\s|$), never with \b: it matches inside paths and
  hyphenated words (tsc-after.txt, git merge-base). "data" sees what it carries: its heredoc bodies, then its quoted
  texts, one per line, such as a commit message; it is empty when there are none, and ^ and $ anchor the whole of it.
  A rule on a message's form needs a "data" in "when" too, like \S, so a command without a message is not counted.
  What sh -c, bash -c, ssh, eval and $( … ) run is read as commands too. Any other field is matched whole by "value".
- when: the calls the rule is about: "tool", a regex over the tool name (anchored, like ^Bash$), and "value" and "data",
  regexes as above; any may be left out.
- broken: what makes such a call break the rule: a "tool", "value" or "data" regex, at least one. For a command, when
  and broken must match the same simple command.
- ignoreCase: true when letter case doesn't matter.
- The regexes are JavaScript, without flags, and never repeat a group that holds a quantifier or an alternation, like
  (a+)+ or (a|b)+.
- breaking: two or three example calls { "tool", "value" } that break the rule; keeping: two or three calls that keep
  it, at least one the rule is about, and near misses chosen for the rule that must not break it: a path or a file
  name holding the forbidden word, a read-only form of the command (git tag alone lists tags), its --help, a search or
  an echo naming it. A value is the field's whole value: for Bash, a whole command line.

A "judgment" rule has a check that finds the cases a judge will read: { "reply": true } for a rule about what the
agent tells the user; else the calls it may be about, as a tool rule's "field" and "when", without "broken", and
keeping: one or two calls it is about, which "when" must match. Leave the check out when no single call or reply is
a case of the rule (how to plan, what to remember).
`;

/**
 * Reads the rules of the pending sections through the user's own claude, sonnet, one call per batch, and caches each
 * batch as it comes, each section remembered as its section's latest read version: an interrupted run keeps what it
 * paid for. Only the sections' text leaves the machine, secrets redacted; never
 * a file's path. A batch that fails is reported and nothing of it is cached.
 */
export async function extract(pending: Pending[], env: NodeJS.ProcessEnv, cacheDir: string):
  Promise<{ read: number; tokens: number; errors: string[] }> {
  const errors: string[] = [];
  let read = 0;
  let tokens = 0;
  // A text under several paths (a worktree's copy of a file) is sent once, and remembered for each.
  const byHash = new Map<string, Pending[]>();
  for (const p of pending) byHash.set(p.section.hash, [...(byHash.get(p.section.hash) ?? []), p]);
  for (const batch of batches([...byHash.values()], (group) => group[0].section.text.length, BATCH)) {
    const body = batch.map(([{ section: s }], i) =>
      `<section id="${i + 1}" path="${redact(s.path.join(' › ')).replaceAll('"', "'")}">\n${redact(s.text)}\n</section>`);
    const run = await ask(MODEL, SCHEMA, `${PROMPT}\n${body.join('\n\n')}\n`, env);
    tokens += run.tokens;
    if (run.error) {
      errors.push(run.error);
      if (run.fatal) break;
      continue;
    }
    const answered = (run.output as { sections?: unknown } | undefined)?.sections;
    if (!Array.isArray(answered) || !answered.every((a) => typeof a?.id === 'string' && Array.isArray(a.rules))) {
      errors.push("claude's answer didn't match the schema");
      continue;
    }
    // A section left out of the answer is not cached as holding no rule: it is asked about again.
    const byId = new Map(answered.map((a) => [a?.id, a?.rules]));
    let left = 0;
    batch.forEach((group, i) => {
      const rules = byId.get(String(i + 1));
      if (!Array.isArray(rules)) return void left++;
      save(cacheDir, group[0].section.hash, rules);
      for (const p of group) remember(cacheDir, p.identity, p.section.hash, p.at);
    });
    if (left) errors.push(`claude's answer left out ${left} of ${batch.length} sections: they will be asked about again`);
    read += batch.length - left;
  }
  return { read, tokens, errors };
}
