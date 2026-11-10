// Applying rules to events: tool checks and, for replies, their language.

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
 * The language a reply is written in, or null when it can't be told: under 20 words once code, URLs and paths are
 * removed, or no clear winner (at least 5 stopwords, twice the runner-up's).
 */
export function language(text: string): string | null {
  const prose = text.replace(/(```|~~~)[\s\S]*?(\1|$)/g, ' ').replace(/`[^`\n]*`/g, ' ')
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

/** A tool rule as the extraction writes it: regular expressions over the tool's name and one input field. */
export interface Check {
  field?: string;
  when?: { tool?: string; value?: string };
  broken?: { tool?: string; value?: string };
  ignoreCase?: boolean;
}

interface Patterns { tool?: RegExp; value?: RegExp }
export interface Compiled { field?: string; when: Patterns; broken: Patterns }

/** A group holding a quantifier, itself quantified — `(a+)+`, `(\\w+\\s?)*` — can take exponential time on a long value. */
const NESTED = /\((?:[^()\\]|\\.)*[*+}](?:[^()\\]|\\.)*\)[*+{]/;

/**
 * The check's patterns as regular expressions, or why they can't be used. Never `g` or `y` (they keep state between
 * calls) nor `u` (model-written patterns often escape characters it rejects); `i` only when the check asks.
 */
export function compile(check: Check): Compiled | string {
  if (check.broken?.tool === undefined && check.broken?.value === undefined) return 'no broken pattern';
  const flags = check.ignoreCase ? 'i' : '';
  const compiled: Compiled = { field: check.field, when: {}, broken: {} };
  for (const part of ['when', 'broken'] as const) {
    for (const key of ['tool', 'value'] as const) {
      const source = check[part]?.[key];
      if (source === undefined) continue;
      if (NESTED.test(source)) return `regex repeats a quantified group: ${source}`;
      try {
        compiled[part][key] = new RegExp(source, flags);
      } catch {
        return `regex doesn't compile: ${source}`;
      }
    }
  }
  return compiled;
}

/** Whether the rule applies to a call and, when it does, whether the call broke it. A value is matched on its first
 * 4,096 characters: model-written patterns over a huge command or file stay cheap. */
export function verdict(c: Compiled, tool: string, input: Record<string, unknown>): 'none' | 'kept' | 'broken' {
  const field = c.field === undefined ? undefined : input[c.field];
  const value = typeof field === 'string' ? field.slice(0, 4096) : undefined;
  const matches = (p: Patterns) => (!p.tool || p.tool.test(tool)) && (!p.value || (value !== undefined && p.value.test(value)));
  if (!matches(c.when)) return 'none';
  return matches(c.broken) ? 'broken' : 'kept';
}
