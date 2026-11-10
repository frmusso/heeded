// Applying rules to events: tool checks and, for replies, their language.

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
