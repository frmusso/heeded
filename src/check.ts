// Applying rules to events: tool checks and, for replies, their language; counting what was kept and broken, by the
// judge's verdict where a pattern can't decide, and the cases still waiting for one.
import type { Event, InstructionFile } from './claude-code.ts';
import { type Case, type Excerpt, excerpts, type Verdict } from './judge.ts';
import { redact } from './redact.ts';
import { commands, type Simple } from './shell.ts';
import type { Pending, Rule, Version } from './rules.ts';

/** The most common words of each language a reply can be detected in. */
const STOPWORDS: Record<string, string> = {
  en: `the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an
    will my one all would there their what so up out if about who get which go me when make can like no just him know
    take into your some could them see other than then now only its also how our well way even because any these us is
    are was were been has had does did should here where why very`,
  it: `il lo la i gli le un uno una di da in con su per tra fra a e o ma che non come anche se più è sono era sia del della
    dei degli delle al alla allo ai agli alle dal dalla nel nella nei sul sulla questo questa questi quello quella ci si mi
    ti ne cosa perché quando dove tutto molto ancora già poi solo ho hai ha abbiamo hanno essere fare può adesso quindi ora`,
  es: `el la los las un una unos unas de del a al en con por para que y o pero no sí es son era fue ser está están estar
    como más muy también ya este esta estos estas ese esa eso lo le les se me te nos su sus mi tu cuando donde porque hay
    hacer puede todo nada algo bien entre sobre sin hasta desde ahora así luego aquí pues`,
  fr: `le la les un une des de du à au aux en dans par pour sur avec sans que qui et ou mais ne pas plus est sont était
    être avoir ai as ont ce cette ces cet il elle ils elles je tu nous vous on se me te lui leur son sa ses mon ma mes
    comme aussi très bien tout tous faire peut fait donc alors si quand où vais`,
  de: `der die das den dem des ein eine einen einem einer und oder aber nicht ist sind war waren sein haben hat habe ich du
    er sie es wir ihr mit von zu zum zur auf für bei aus nach über unter vor auch noch nur schon sehr wie wenn dass weil
    was wer wo hier dann jetzt kann muss soll mehr kein keine diese dieser dieses man sich im deshalb`,
  pt: `o a os as um uma uns umas de do da dos das em no na nos nas por para com sem que e ou mas não sim é são era foi ser
    estar está estão ter tem como mais muito também já este esta isso esse essa ele ela eles elas eu você nós se me te
    lhe seu sua quando onde porque há fazer pode tudo nada bem entre sobre até então agora vou depois ainda aqui pelo pela
    ao aos num numa`,
};

/** The languages a reply can be detected in. */
export const LANGUAGES = Object.keys(STOPWORDS);

/** Each stopword's language; a word shared by two languages (`de`, `que`, `a`) tells none apart, so it is left out. */
const WORDS = new Map<string, string | null>();
for (const [code, words] of Object.entries(STOPWORDS)) {
  for (const w of words.split(/\s+/)) WORDS.set(w, WORDS.has(w) && WORDS.get(w) !== code ? null : code);
}

/**
 * The language a reply is written in, or null when it can't be told: under 20 words once code, quoted blocks (someone
 * else's words), URLs and paths are removed, or no clear winner (at least 5 stopwords, twice the runner-up's).
 */
export function language(text: string): string | null {
  const prose = text.replace(/(```|~~~)[\s\S]*?(\1|$)/g, ' ').replace(/^[ \t]*>.*$/gm, ' ').replace(/`[^`\n]*`/g, ' ')
    .replace(/\S*[/\\]\S*/g, ' ');
  const words = prose.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 20) return null;
  const hits = new Map<string, number>();
  for (const w of words) {
    const code = WORDS.get(w);
    if (code) hits.set(code, (hits.get(code) ?? 0) + 1);
  }
  const [first, second] = [...hits].sort((a, b) => b[1] - a[1]);
  return first && first[1] >= 5 && first[1] >= 2 * (second?.[1] ?? 0) ? first[0] : null;
}

/**
 * A rule's check as the extraction writes it: regular expressions over the tool's name and one input field. A shell
 * `command` is read one simple command at a time: `value` patterns see what it does, `data` patterns what it carries.
 * A judgment rule's check has no `broken`: it finds the calls a judge will read, or with `reply` every reply.
 */
export interface Check {
  field?: string;
  when?: { tool?: string; value?: string; data?: string };
  broken?: { tool?: string; value?: string; data?: string };
  ignoreCase?: boolean;
  reply?: boolean;
}

interface Patterns { tool?: RegExp; value?: RegExp; data?: RegExp }
interface Compiled { field?: string; when: Patterns; broken: Patterns }

/**
 * Whether a pattern repeats a group that holds a quantifier or an alternation, at any depth — `(a+)+`, `((a+))+`,
 * `(a|a)+` — the shapes that can take exponential time on a long value. Character classes are read as one atom.
 */
function exponential(source: string): boolean {
  const open: boolean[] = []; // per open group: whether it holds a quantifier or an alternation
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') i++;
    else if (c === '[') {
      for (i++; i < source.length && source[i] !== ']'; i++) if (source[i] === '\\') i++;
    } else if (c === '(') open.push(false);
    else if (c === ')') {
      const holds = open.pop() ?? false;
      const repeated = /[*+{]/.test(source[i + 1] ?? '');
      if (holds && repeated) return true;
      if (open.length && (holds || repeated)) open[open.length - 1] = true;
    } else if (/[*+{|]/.test(c) && open.length) open[open.length - 1] = true;
  }
  return false;
}

/**
 * The check's patterns as regular expressions, or why they can't be used. Never `g` or `y` (they keep state between
 * calls) nor `u` (model-written patterns often escape characters it rejects); `i` only when the check asks.
 */
export function compile(check: Check): Compiled | string {
  const flags = check.ignoreCase ? 'i' : '';
  const compiled: Compiled = { field: check.field, when: {}, broken: {} };
  for (const part of ['when', 'broken'] as const) {
    for (const key of ['tool', 'value', 'data'] as const) {
      const source = check[part]?.[key];
      if (source === undefined) continue;
      if (exponential(source)) return `regex may take exponential time: ${source}`;
      try {
        compiled[part][key] = new RegExp(source, flags);
      } catch {
        return `regex doesn't compile: ${source}`;
      }
    }
  }
  return compiled;
}

// The last command line read: every rule in effect looks at the same call in turn.
let last: { line: string; views: Simple[] } | undefined;

/** What a check's field shows: one view per simple command of a shell `command`, else the value whole; none when the
 * check has no field or the call's field isn't a string. */
function views(field: string | undefined, input: Record<string, unknown>): Simple[] {
  const value = field === undefined ? undefined : input[field];
  if (typeof value !== 'string') return [];
  if (field !== 'command') return [{ does: value, carries: '', text: value }];
  if (last?.line !== value) last = { line: value, views: commands(value) };
  return last.views;
}

/** Each view is matched on its first 4,096 characters: model-written patterns over a huge command or file stay cheap. */
const hits = (p: Patterns, v: Simple) => (!p.value || p.value.test(v.does.slice(0, 4096)))
  && (!p.data || p.data.test(v.carries.slice(0, 4096)));
const needs = (p: Patterns) => p.value !== undefined || p.data !== undefined;
/** Whether one of a call's views matches the patterns; a loop, not a closure: it runs for every rule on every call. */
function found(p: Patterns, all: Simple[]): boolean {
  if (!needs(p)) return true;
  for (const v of all) if (hits(p, v)) return true;
  return false;
}

/**
 * Whether the rule applies to a call and, when it does, the view that broke it: the call applies when its tool
 * matches and one view matches `when`; it is broken when, besides, that same view matches `broken`.
 */
function assess(c: Compiled, tool: string, input: Record<string, unknown>): { verdict: 'none' | 'kept' | 'broken'; by?: Simple } {
  if (c.when.tool && !c.when.tool.test(tool)) return { verdict: 'none' };
  const all = views(c.field, input);
  const applying = needs(c.when) ? all.filter((v) => hits(c.when, v)) : all;
  if (needs(c.when) && !applying.length) return { verdict: 'none' };
  if (c.broken.tool && !c.broken.tool.test(tool)) return { verdict: 'kept' };
  if (!needs(c.broken)) return { verdict: 'broken' };
  const by = applying.find((v) => hits(c.broken, v));
  return by ? { verdict: 'broken', by } : { verdict: 'kept' };
}

export function verdict(c: Compiled, tool: string, input: Record<string, unknown>): 'none' | 'kept' | 'broken' {
  return assess(c, tool, input).verdict;
}

/** Whether a call is one the check is about, whatever would break it: asked on every call, so it allocates nothing. */
export function applies(c: Compiled, tool: string, input: Record<string, unknown>): boolean {
  return (!c.when.tool || c.when.tool.test(tool)) && found(c.when, views(c.field, input));
}

/**
 * What broke the rule, as written: the simple command (followed by what it carries, when the check reads that and the
 * command as written doesn't show it: a heredoc's body), the field's value, or the tool when the check has no field.
 */
export function culprit(c: Compiled, tool: string, input: Record<string, unknown>): string {
  const by = assess(c, tool, input).by;
  if (by) return (c.when.data || c.broken.data) && !by.text.includes(by.carries) ? `${by.text} ${by.carries}` : by.text;
  const value = c.field === undefined ? undefined : input[c.field];
  return typeof value === 'string' ? value : tool;
}

interface Count { applied: number; broken: number }
/** A violation: where and what; `quote`, the judge's words for it. */
interface Evidence { at: string; session: string; agent: string | null; text: string; quote?: string }

/** Context depth buckets, in tokens: where the context window fills up. */
const DEPTHS = [0, 100_000, 200_000, 400_000];
const buckets = (counts: Count[]) => counts.map((c, i) => ({ from: DEPTHS[i], to: DEPTHS[i + 1] ?? null, ...c }));
const zero = (): Count => ({ applied: 0, broken: 0 });
const add = (c: Count, broken: boolean) => {
  c.applied++;
  if (broken) c.broken++;
};

/** A rule in the report: what it says, where it comes from, how it was checked and how often it was kept. */
export interface RuleData {
  id: string;
  name: string;
  quote: string;
  files: string[];
  status: 'broken' | 'kept' | 'to-confirm' | 'never-applied' | 'judgment' | 'demoted';
  reason?: string;
  check?: Rule['check'];
  applied: number;
  broken: number;
  /** Cases with a verdict, `none` included. */
  judged: number;
  /** A tool rule's candidates the judge hasn't seen: neither kept nor broken yet. */
  toConfirm: number;
  afterCompaction: Count;
  byDepth: { from: number; to: number | null; applied: number; broken: number }[];
  /** What the rule costs every session that loads it. */
  tokens: number;
  evidence: Evidence[];
}

export interface Data {
  from: string | null;
  to: string | null;
  sessions: number;
  subagents: number;
  /** The instruction files measured. */
  files: string[];
  /** Sections whose rules were never read: they can't be checked until they are. */
  notRead: number;
  /** The cases a judge would read now. */
  toJudge: number;
  rules: RuleData[];
  byDepth: RuleData['byDepth'];
}

/** A rule's counts so far; `compiled`, a checked tool rule's check or a judgment rule's `when`; `unjudged`, its cases
 * without a verdict, the latest of them `waiting`, as their excerpts (shared by every rule an event is a case of). */
interface Tally {
  rule: Rule; files: Set<string>; all: Count; after: Count; depth: Count[]; evidence: Evidence[]; compiled: Compiled | null;
  judged: number; unjudged: number; waiting: Excerpt[];
}

/** The cases a rule keeps waiting, at most: a run judges far fewer. */
const WAITING = 40;
/** A judgment rule's sample: judged until 20 of its cases are decided, or 40 judged in all, so a rule whose `when` is
 * too broad stops costing. */
const DECIDED = 20;
const JUDGED = 40;
const allowed = (t: Tally) => (t.rule.kind === 'judgment' ? Math.max(0, Math.min(JUDGED - t.judged, DECIDED - t.all.applied)) : Infinity);

/** A rule's cases waiting: latest first (ties by key), an excerpt once (two events can read alike), at most 40. */
function trim(list: Excerpt[]) {
  list.sort((a, b) => (a.at !== b.at ? (a.at > b.at ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const keys = new Set<string>();
  let n = 0;
  for (const x of list) {
    if (n === WAITING || keys.has(x.key)) continue;
    keys.add(x.key);
    list[n++] = x;
  }
  list.length = n;
}

/** Into a rule's cases waiting, trimmed now and then rather than kept in order: rules × events is the hot loop. */
function wait(list: Excerpt[], x: Excerpt) {
  list.push(x);
  if (list.length > 2 * WAITING) trim(list);
}

type Seen = Extract<Event, { kind: 'call' | 'reply' }>;

/** A violation in one line, secrets redacted: what in the call broke the rule, a reply's language and first words. */
function evidence(e: Seen, c: Compiled | null, detected: string | null): string {
  if (e.kind === 'reply') {
    const words = redact(e.text).split(/[\p{Cc}\s]+/u).filter(Boolean);
    return `${detected}: "${words.slice(0, 8).join(' ')}${words.length > 8 ? ' …' : ''}"`;
  }
  const line = redact(culprit(c!, e.tool, e.input)).replace(/[\p{Cc}\s]+/gu, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * Counts, over a stream of events, how often each rule applied and how often it was broken. Each transcript starts with
 * no file in effect; the rules in effect are those of the files its `instructions` events recorded. A call a tool
 * rule's patterns say broke it is a candidate, and a call or reply a judgment rule is about is a case of it: either
 * counts by the judge's verdict, and waits for one until then.
 */
export function counter(rulesOf: (file: InstructionFile) => { rules: Rule[]; versions: Version[] } | null,
  verdictOf: (rule: string, key: string) => Verdict | null = () => null) {
  const tallies = new Map<string, Tally>();
  let inEffect = new Map<string, InstructionFile>();
  let checked: Tally[] = []; // the tool and language rules in effect
  // The judgment rules in effect, by what finds their cases: a call's tool is tested once per tool pattern and its field
  // read once, then each `when` once however many rules share it; only replies are looked at for rules about replies.
  type Finder = { field?: string; tool?: RegExp; whens: { when: Patterns; tallies: Tally[] }[] };
  let finders: Finder[] = [];
  let replying: Tally[] = [];
  // Resumed and forked sessions copy history into new files: an event counts once. Only events a rule applied to are
  // remembered.
  const seen = new Set<string>();
  let session = '';
  let agent: string | null = null;
  // Every version of every section seen, with the last time it was in effect during a call or reply; and those of the
  // files in effect now.
  const versions = new Map<string, Version & { at: string }>();
  let current: (Version & { at: string })[] = [];
  const files = new Set<string>();
  let sessions = 0;
  let subagents = 0;
  let active = false;
  let from: string | null = null;
  let to: string | null = null;
  const excerpt = excerpts();

  function refresh() {
    const ids = new Set<string>();
    const groups = new Map<string, Finder>();
    const whens = new Map<string, { when: Patterns; tallies: Tally[] }>();
    checked = [];
    replying = [];
    current = [];
    for (const file of inEffect.values()) {
      const found = rulesOf(file);
      if (!found) continue;
      files.add(file.path);
      for (const v of found.versions) {
        const key = `${v.identity}\0${v.section.hash}`;
        let seen = versions.get(key);
        if (!seen) versions.set(key, (seen = { ...v, at: '' }));
        current.push(seen);
      }
      for (const rule of found.rules) {
        let t = tallies.get(rule.id);
        if (!t) {
          // verify demoted every tool rule, and gave no cases to every judgment rule, whose check doesn't compile
          const compiled = (rule.kind === 'tool' && !rule.demoted)
            || (rule.kind === 'judgment' && !rule.noCases && rule.check?.reply !== true)
            ? compile(rule.check!) as Compiled : null;
          t = { rule, files: new Set(), all: zero(), after: zero(), depth: DEPTHS.map(zero), evidence: [], compiled, judged: 0,
            unjudged: 0, waiting: [] };
          tallies.set(rule.id, t);
        }
        t.files.add(file.path);
        // A quote read two ways (two versions of a section) is one rule: it is counted as it was first read, which its
        // tally's check was compiled from.
        const { demoted, noCases, kind, check } = t.rule;
        if (!ids.has(rule.id) && !demoted && !noCases) {
          ids.add(rule.id);
          if (kind !== 'judgment') checked.push(t);
          else if (check?.reply === true) replying.push(t);
          else {
            const { field, when, ignoreCase } = check!;
            const key = JSON.stringify([field, when?.tool, ignoreCase === true]);
            let group = groups.get(key);
            if (!group) groups.set(key, (group = { field, tool: t.compiled!.when.tool, whens: [] }));
            const same = JSON.stringify([key, when?.value, when?.data]);
            const w = whens.get(same);
            if (w) w.tallies.push(t);
            else group.whens.push(whens.set(same, { when: t.compiled!.when, tallies: [t] }).get(same)!);
          }
        }
      }
    }
    finders = [...groups.values()];
  }

  /** Of each section, the version in effect latest. */
  function latest(): (Version & { at: string })[] {
    const last = new Map<string, Version & { at: string }>();
    for (const v of versions.values()) {
      const l = last.get(v.identity);
      if (!l || v.at > l.at || (v.at === l.at && v.read)) last.set(v.identity, v);
    }
    return [...last.values()];
  }

  /**
   * The sections to read: of each section, the version in effect latest when it wasn't read, unless a version of it
   * read already was in effect as late. The others take that version's rules meanwhile.
   */
  function pending(): Pending[] {
    return latest().filter((v) => !v.read && (v.readAt === null || v.at > v.readAt))
      .map(({ section, identity, at }) => ({ section, identity, at }));
  }

  /** The versions read, with when they were last in effect: what the cache remembers moves forward with them. */
  function readVersions(): Pending[] {
    return latest().filter((v) => v.read && v.at).map(({ section, identity, at }) => ({ section, identity, at }));
  }

  /** One more case a rule applied to; a violation's evidence, as `text` says it. */
  function record(t: Tally, e: Seen, broken: boolean, text: () => string, quote?: string) {
    add(t.all, broken);
    if (e.compactions > 0) add(t.after, broken);
    add(t.depth[DEPTHS.findLastIndex((d) => e.depth >= d)], broken);
    if (broken) t.evidence.push({ at: e.at, session, agent, text: text(), ...(quote ? { quote } : {}) });
  }

  /** A case the judge decides, a tool rule's candidate or a judgment rule's case: counted by its verdict, or waiting. */
  function decide(t: Tally, e: Seen) {
    seen.add(e.id);
    const x = excerpt.of(e); // its text is built only when read
    const v = verdictOf(t.rule.id, x.key);
    if (!v) {
      t.unjudged++;
      // A rule whose sample is full takes no more cases.
      if (allowed(t)) wait(t.waiting, x);
      return;
    }
    t.judged++;
    if (v.verdict === 'none') return;
    // A judgment rule's evidence is its case's own line; a tool rule's, what in the call broke it.
    const own = () => {
      const line = x.text.slice(x.text.lastIndexOf('\n') + 1);
      return line.length > 200 ? `${line.slice(0, 200)}…` : line;
    };
    record(t, e, v.verdict === 'broken', t.rule.kind === 'judgment' ? own : () => evidence(e, t.compiled, null), v.quote);
  }

  function count(e: Seen) {
    // A session or subagent counts once it did something: a transcript with no call or reply isn't one.
    if (!active) {
      active = true;
      if (agent) subagents++;
      else sessions++;
    }
    if (!from || e.at < from) from = e.at;
    if (!to || e.at > to) to = e.at;
    let detected: string | null | undefined;
    for (const t of checked) {
      let v: 'none' | 'kept' | 'broken' = 'none';
      if (e.kind === 'call' && t.compiled) v = verdict(t.compiled, e.tool, e.input);
      else if (e.kind === 'reply' && t.rule.kind === 'language') {
        detected ??= language(e.text);
        if (detected) v = detected === t.rule.check?.language ? 'kept' : 'broken';
      }
      if (v === 'none') continue;
      seen.add(e.id);
      // A tool rule's patterns find candidates: whether one broke the rule is the judge's to say.
      if (v === 'broken' && t.compiled) decide(t, e);
      else record(t, e, v === 'broken', () => evidence(e, null, detected ?? null));
    }
    if (e.kind === 'reply') for (const t of replying) decide(t, e);
    else {
      for (const f of finders) {
        if (f.tool && !f.tool.test(e.tool)) continue;
        const all = views(f.field, e.input);
        for (const w of f.whens) if (found(w.when, all)) for (const t of w.tallies) decide(t, e);
      }
    }
  }

  return {
    on(e: Event) {
      if (e.kind === 'transcript') {
        ({ session, agent } = e);
        active = false;
        inEffect = new Map();
        checked = [];
        finders = [];
        replying = [];
        current = [];
      } else if (e.kind === 'instructions') {
        if (e.replace) inEffect = new Map();
        for (const file of e.files) inEffect.set(file.path, file);
        refresh();
      } else if (e.kind === 'call' || e.kind === 'reply') {
        for (const c of current) if (e.at > c.at) c.at = e.at;
        if (!seen.has(e.id)) count(e);
      }
      // Copies are counted once, but their events still lead to the ones after them.
      excerpt.push(e);
    },

    /** Per rule, its latest cases without a verdict: for a judgment rule, only as many as its sample still takes. */
    waiting(): { tool: Case[][]; judgment: Case[][] } {
      const of = (kind: Rule['kind']) => [...tallies.values()].filter((t) => t.rule.kind === kind).map((t) => {
        trim(t.waiting);
        return t.waiting.slice(0, allowed(t)).map((x) => ({ id: `${t.rule.id}-${x.key}`, rule: t.rule, excerpt: x.text, at: x.at }));
      }).filter((l) => l.length);
      return { tool: of('tool'), judgment: of('judgment') };
    },

    pending,
    readVersions,

    result(): Data {
      const rules = [...tallies.values()].map(({ rule, files, all, after, depth, evidence, judged, unjudged }): RuleData => ({
        id: rule.id,
        name: rule.name,
        quote: rule.quote,
        files: [...files],
        status: rule.kind === 'judgment' ? 'judgment' : rule.demoted ? 'demoted'
          : all.broken ? 'broken' : all.applied ? 'kept' : unjudged ? 'to-confirm' : 'never-applied',
        ...(rule.demoted || rule.noCases ? { reason: rule.demoted ?? rule.noCases } : {}),
        ...(rule.check ? { check: rule.check } : {}),
        applied: all.applied,
        broken: all.broken,
        judged,
        toConfirm: rule.kind === 'tool' ? unjudged : 0,
        afterCompaction: after,
        byDepth: buckets(depth),
        tokens: Math.ceil(rule.quote.length / 4),
        evidence: evidence.toReversed().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)),
      }));
      // Broken rules first, the least kept leading; then kept, to confirm, never applied, judgment, demoted.
      const rank = ['broken', 'kept', 'to-confirm', 'never-applied', 'judgment', 'demoted'];
      const keptShare = (r: RuleData) => (r.applied ? (r.applied - r.broken) / r.applied : 0);
      rules.sort((a, b) => rank.indexOf(a.status) - rank.indexOf(b.status) || keptShare(a) - keptShare(b)
        || b.applied - a.applied);
      const sum = DEPTHS.map(zero);
      for (const t of tallies.values()) {
        t.depth.forEach((c, i) => {
          sum[i].applied += c.applied;
          sum[i].broken += c.broken;
        });
      }
      // Every candidate to confirm; of a judgment rule's cases, as many as its sample still takes.
      const toJudge = [...tallies.values()].reduce((n, t) => n + Math.min(allowed(t), t.unjudged), 0);
      return { from, to, sessions, subagents, files: [...files], notRead: new Set(pending().map((p) => p.section.hash)).size,
        toJudge, rules, byDepth: buckets(sum) };
    },
  };
}
