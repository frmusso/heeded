// A shell command line read the way a shell reads it, without running one: its simple commands, each with what it
// does (its quoted text emptied, heredoc bodies out) and what it carries (that quoted text and those bodies). Rules
// about running something look at the first; rules about a commit message look at the second; a search for a word, or
// a file written with it, does neither.

export interface Simple {
  /** The simple command with its quoted texts emptied, the quotes kept. */
  does: string;
  /** Its quoted texts and heredoc bodies, one after the other. */
  carries: string;
  /** As written. */
  text: string;
}

/** The quoted text opened at `i`: where it ends (past its closing quote, or the end of the line), its content, and the
 * quotes as they stay in what the command does (one when it is left open). */
function quoted(line: string, i: number): { end: number; content: string; quotes: string } {
  const open = line[i] === '$' ? "$'" : line[i];
  const close = open.at(-1)!;
  let j = i + open.length;
  while (j < line.length && line[j] !== close) {
    // In "…" a backslash escapes only these; in $'…' it escapes anything; in '…' nothing.
    if (line[j] === '\\' && (open === "$'" || (open === '"' && '"\\$`'.includes(line[j + 1] ?? '')))) j++;
    j++;
  }
  const closed = j < line.length;
  return { end: closed ? j + 1 : line.length, content: line.slice(i + open.length, j), quotes: closed ? open + close : open };
}

/**
 * Heredoc bodies taken out of the raw lines, each with the offset of its `<<` in the text left. Found before quotes
 * are read, since a heredoc inside `"$( … )"` (how commit messages are often written) holds any quotes; and only with
 * its closing line, so `$((1 << 2))` is not one.
 */
function heredocs(line: string): { text: string; bodies: { at: number; body: string }[] } {
  const lines = line.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  const bodies: { at: number; body: string }[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    let next = i + 1;
    let line = '';
    let from = 0;
    for (const m of lines[i].matchAll(/(?<!<)<<(?!<)(-?)\s*(['"]?)([\w.-]+)\2/g)) {
      const end = lines.findIndex((l, k) => k >= next && (m[1] ? l.replace(/^\t+/, '') : l) === m[3]);
      if (end < 0) continue;
      // The marker is kept without its quotes: they only say how the body is expanded.
      line += lines[i].slice(from, m.index);
      bodies.push({ at: offset + line.length, body: lines.slice(next, end).join('\n') });
      line += `<<${m[1]}${m[3]}`;
      from = m.index + m[0].length;
      next = end + 1;
    }
    line += lines[i].slice(from);
    kept.push(line);
    offset += line.length + 1;
    i = next - 1;
  }
  return { text: kept.join('\n'), bodies };
}

/**
 * A command that runs what it carries: a shell given only options (`bash -c '…'`, `sh <<EOF`), `ssh` or `eval`, after
 * optional assignments and `sudo`, `env`, `nohup` or `time`. A shell given a script (`bash run.sh "x"`) is not one.
 */
const WRAPPER = /^(?:\w+=\S*\s+|(?:sudo|env|nohup|time)\s+)*(?:(?:sh|bash|zsh|dash)(?:\s+-[a-zA-Z]+)*\s*(?:$|[<'"$])|ssh\s|eval\s)/;

export function commands(raw: string): Simple[] {
  const { text: line, bodies } = heredocs(raw);
  const out: Simple[] = [];
  let does = '';
  let carried: string[] = [];
  let start = 0;
  const close = (end: number, next: number) => {
    for (const b of bodies) if (b.at >= start && b.at < end) carried.push(b.body);
    if (does.trim()) {
      out.push({ does: does.trim(), carries: carried.join('\n'), text: line.slice(start, end).trim() });
      if (WRAPPER.test(does.trim())) for (const c of carried) out.push(...commands(c));
    }
    does = '';
    carried = [];
    start = next;
  };
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    const two = line.slice(i, i + 2);
    if (c === "'" || c === '"' || two === "$'") {
      const q = quoted(line, i);
      does += q.quotes;
      carried.push(q.content);
      i = q.end;
    } else if (c === '\\') {
      does += two;
      i += 2;
    } else if (c === '#' && (i === start || /\s/.test(line[i - 1]))) {
      // A comment runs to the end of its line.
      while (i < line.length && line[i] !== '\n') i++;
    } else if (two === '&&' || two === '||' || two === '|&') {
      close(i, i + 2);
      i += 2;
    } else if (c === ';' || c === '|' || c === '\n' || (c === '&' && !/[<>]/.test(line[i - 1] ?? '') && line[i + 1] !== '>')) {
      close(i, i + 1);
      i++;
    } else {
      does += c;
      i++;
    }
  }
  close(line.length, line.length);
  return out;
}
