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

/** A command substitution: `$( … )` or a backtick pair, as written, and the command line inside it. */
interface Substitution { text: string; inner: string }

/** Where the substitution opened at `i` ends: past its closing `)` or backtick, its quotes and nested parentheses read
 * as a shell reads them; the end of the line when it is left open. */
function substitution(line: string, i: number): Substitution & { end: number } {
  let j = i + 1;
  if (line[i] === '`') {
    while (j < line.length && line[j] !== '`') j += line[j] === '\\' ? 2 : 1;
  } else {
    for (let depth = 0; j < line.length; j++) {
      const c = line[j];
      if (c === '\\') j++;
      else if (c === "'" || c === '"') j = quoted(line, j).end - 1;
      else if (c === '`') j = substitution(line, j).end - 1;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
  }
  const end = Math.min(j + 1, line.length);
  // $(( … )) is arithmetic, not a command.
  const inner = line.startsWith('$((', i) ? '' : line.slice(line[i] === '`' ? i + 1 : i + 2, j);
  return { end, text: line.slice(i, end), inner };
}

/** The quoted text opened at `i`: where it ends (past its closing quote, or the end of the line), its content, the
 * quotes as they stay in what the command does (one when it is left open), and the substitutions in a `"…"`. */
function quoted(line: string, i: number): { end: number; content: string; quotes: string; subs: Substitution[] } {
  const open = line[i] === '$' ? "$'" : line[i];
  const close = open.at(-1)!;
  const subs: Substitution[] = [];
  let j = i + open.length;
  while (j < line.length && line[j] !== close) {
    // In "…" a backslash escapes only these, and $( … ) and backticks run commands; in $'…' a backslash escapes
    // anything; in '…' nothing is special.
    if (open === '"' && (line.startsWith('$(', j) || line[j] === '`')) {
      const sub = substitution(line, j);
      subs.push(sub);
      j = sub.end;
      continue;
    }
    if (line[j] === '\\' && (open === "$'" || (open === '"' && '"\\$`'.includes(line[j + 1] ?? '')))) j++;
    j++;
  }
  const closed = j < line.length;
  return { end: closed ? j + 1 : line.length, content: line.slice(i + open.length, j), quotes: closed ? open + close : open, subs };
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
  // A closing line not found from some line on is not found from any later one: each is looked for once.
  const missing = new Map<string, number>();
  const closing = (word: string, tabs: boolean, from: number) => {
    const key = `${tabs}${word}`;
    if ((missing.get(key) ?? Infinity) <= from) return -1;
    for (let k = from; k < lines.length; k++) if ((tabs ? lines[k].replace(/^\t+/, '') : lines[k]) === word) return k;
    missing.set(key, from);
    return -1;
  };
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    let next = i + 1;
    let line = '';
    let from = 0;
    // `\EOF` is a heredoc like `'EOF'`; a line that is a comment opens none.
    const markers = /^\s*#/.test(lines[i]) ? [] : lines[i].matchAll(/(?<!<)<<(?!<)(-?)\s*\\?(['"]?)([\w.-]+)\2/g);
    for (const m of markers) {
      const end = closing(m[3], m[1] === '-', next);
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
 * A command that runs what it carries: a shell given `-c` (`bash -c '…'`, `docker exec app sh -c '…'`) or only options
 * and a heredoc (`sh <<EOF`), `ssh`, `eval`; wherever it sits in the command, its path optional. A shell given a script
 * (`bash run.sh "x"`) is not one.
 */
const SHELL = String.raw`(?:^|\s)(?:\S*/)?(?:sh|bash|zsh|dash)`;
const WRAPPER = new RegExp(String.raw`${SHELL}\s(?:.*\s)?-[a-zA-Z]*c\b|${SHELL}(?:\s+-\S+)*\s*(?:$|<<)|(?:^|\s)(?:ssh|eval)\s`);

/** Shell syntax that may open a simple command without being part of what it runs. */
const SYNTAX = /^(?:[({!]\s*|(?:if|then|else|elif|do|while|until)\s+)+/;

export function commands(raw: string): Simple[] {
  const { text: line, bodies } = heredocs(raw);
  const out: Simple[] = [];
  let does = '';
  let carried: string[] = [];
  let inner: Simple[] = []; // the commands of its substitutions
  let start = 0;
  const close = (end: number, next: number) => {
    // Heredoc bodies first: a commit message written through one is what the command carries, from its first line.
    const carries = [...bodies.filter((b) => b.at >= start && b.at < end).map((b) => b.body), ...carried].filter(Boolean);
    const command = does.trim().replace(SYNTAX, '');
    if (command) {
      out.push({ does: command, carries: carries.join('\n'), text: line.slice(start, end).trim() });
      if (WRAPPER.test(command)) for (const c of carries) out.push(...commands(c));
      out.push(...inner);
    }
    does = '';
    carried = [];
    inner = [];
    start = next;
  };
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    const two = line.slice(i, i + 2);
    if (c === "'" || c === '"' || two === "$'") {
      const q = quoted(line, i);
      does += q.quotes;
      for (const sub of q.subs) inner.push(...commands(sub.inner));
      // A quoted text that is one substitution carries what its commands carry: `"$(printf 'feat: x')"` carries the
      // message, not the command that prints it.
      const only = q.subs.length === 1 && q.content.trim() === q.subs[0].text;
      carried.push(only ? commands(q.subs[0].inner).map((x) => x.carries).filter(Boolean).join('\n') : q.content);
      i = q.end;
    } else if (two === '$(' || c === '`') {
      const sub = substitution(line, i);
      does += sub.text;
      inner.push(...commands(sub.inner));
      i = sub.end;
    } else if (c === '\\') {
      // A backslash before a line break continues the line; before anything else it escapes it.
      if (line[i + 1] !== '\n') does += two;
      i += 2;
    } else if (c === '#' && (i === start || /\s/.test(line[i - 1]))) {
      // A comment runs to the end of its line.
      while (i < line.length && line[i] !== '\n') i++;
    } else if (two === '&&' || two === '||' || two === '|&') {
      close(i, i + 2);
      i += 2;
    } else if (c === ';' || c === '\n' || (c === '|' && line[i - 1] !== '>')
      || (c === '&' && !/[<>]/.test(line[i - 1] ?? '') && line[i + 1] !== '>')) {
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
