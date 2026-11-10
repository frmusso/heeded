// The report: the terminal's text and the json document, from the same data.
import type { Data } from './check.ts';

/** The counts, and where they were read from. */
export interface Report extends Data { folder: string; configDir: string; unrecognized: string[] }

export function json(r: Report): string {
  const { folder, configDir, from, to, sessions, subagents, unrecognized, notRead, files, rules, byDepth } = r;
  return `${JSON.stringify({ heeded: 1, folder, configDir, from, to, sessions, subagents, unrecognized, notRead, files, rules,
    byDepth }, null, 2)}\n`;
}
