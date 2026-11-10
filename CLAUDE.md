# CLAUDE.md

heeded measures whether coding agents follow their instruction files (`CLAUDE.md`, `AGENTS.md`…) by reading the
transcripts they leave on disk. this file is for anyone working on its code, and for their agents: [README.md](README.md)
is for users. personal instructions go in `CLAUDE.local.md`, which git ignores.

**status:** v1 implemented, not published yet.

## principles

- **minimal.** the least code that does the job. no speculative options, layers, abstractions or settings. three
  similar lines beat a premature helper; a flag nobody asked for is a cost, not a feature.
- **ablative.** every piece of work ends with a removal pass: dead code, unused exports, parameters, branches, files,
  dependencies. deleting is progress. work isn't done until that pass is.
- **light and fast.** zero runtime dependencies unless one is justified in writing (what it saves against what it costs:
  size, install time, supply chain). stream transcripts, never load a whole file; one pass per file; cache what's
  expensive by content hash. budgets (startup, throughput, memory, package size) are checked by tests, not hoped for.
- **cheap with the user's money.** deterministic checks first; a model call only where they can't decide. show the
  estimated cost before spending, and cache verdicts so a rerun costs nothing.
- **read-only on the user's data.** transcripts, instruction files and agent settings are never modified: heeded writes
  only to its own cache and output.
- **private by default.** transcripts hold secrets and personal data. everything runs locally; nothing leaves the
  machine except the excerpts sent to the judge model the user chose, with secrets redacted first. no telemetry.
- **vendor neutral.** claude code first, but the core assumes no particular agent: each agent's transcript format is an
  adapter. those formats are internal to each agent, so they're read leniently (an unknown line is skipped, never a
  crash).

## voice

- **lowercase, always:** the name (`heeded`, never "Heeded"), headings, the readme, cli output, help, errors, package
  metadata, the website. names that are code keep their casing (`CLAUDE.md`, `AGENTS.md`, `--json`).
- **modern and plain:** short sentences, no marketing words, no exclamation marks. say what happened and what to do.
- **code-based:** show, don't describe. examples are real commands and real output in code blocks; the terminal is the
  interface, and the report reads like a well-made cli.

## working rules

- **english everywhere:** code, identifiers, comments, test names, commit messages, docs. other languages appear only as
  data (test samples of rules written in other languages).
- **a failing test first**, for every change, small fixes included. check that a new test catches the bug it's about
  (break the code, watch it fail).
- **never touch the developer's real agent data in tests.** every root heeded reads (`~/.claude`, `CLAUDE_CONFIG_DIR`,
  other agents' folders) has an override that tests point at fixtures. fixtures are synthetic or scrubbed: a real
  transcript is never committed.
- **known locations only.** heeded never searches the disk for transcripts; it reads the folders agents document (and
  the config-dir variables they honour). on macos a broad scan floods the user with privacy prompts.
- **comments stand on their own.** a comment says what the code does and why, by itself: no references to documents,
  tickets or notes a reader can't open, no notes on who decided what. tests and fixtures hold no personal paths,
  accounts or addresses.
- **commits:** a short lowercase summary with a prefix (`feat:`, `fix:`, `perf:`, `chore:`, `test:`, `docs:`), then the
  why.

## architecture

```text
transcripts ──▶ claude-code.ts ──events──▶ check.ts (counter) ──▶ report.ts ──▶ text | rules | json
                                              ▲
instruction files (from the events) ──▶ rules.ts: sections → cache → verify;  new sections → claude -p
```

- `src/cli.ts`: arguments, the two commands, the question before spending, exit codes. `main(argv, io)` takes its
  process as `io`, so tests drive every path in-process.
- `src/claude-code.ts`: the only module that knows claude code. finds the transcripts of the sessions run in a folder
  and streams them, one pass per file, into neutral events (`transcript`, `instructions`, `compaction`, `call`,
  `reply`). another agent is another adapter emitting the same events.
- `src/rules.ts`: instruction files into sections; the extraction call (`claude -p`, isolated, one per batch of new
  sections); local verification of what it returns; the cache, one file per section hash.
- `src/check.ts`: tool checks, reply language, and the counter: events in, report data out.
- `src/report.ts`: the terminal report, `heeded rules`, the json document.
- `src/redact.ts`: secrets out of anything sent or printed.
- `scripts/public-tree.ts`: the guard that keeps private notes, notes on who decided what and personal data out of the
  tree.
- `tests/`: one file per module, plus budgets, the live call and the guard. `tests/support/` holds the sandbox (every
  root heeded reads, and a `PATH` with only a fake `claude`) and the synthetic transcript builder.

## commands

the sources are typescript run as is: node 22.18 or later. no runtime dependencies; two dev ones, `typescript` and
`@types/node` (without it `tsc` can't check the `node:` imports).

```sh
npm install
npm test                                      # every test file, one at a time
node --test tests/rules.test.ts               # one file
npm run typecheck
npm run build                                 # dist/, what the package ships
node scripts/public-tree.ts                   # the public-tree guard
HEEDED_LIVE=1 node --test tests/live.test.ts  # the real claude call: a few cents
```
