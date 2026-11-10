# CLAUDE.md

heeded measures whether coding agents follow their instruction files (`CLAUDE.md`, `AGENTS.md`…) by reading the
transcripts they leave on disk. this file is for anyone working on its code, and for their agents: [README.md](README.md)
is for users. personal instructions go in `CLAUDE.local.md`, which git ignores.

**status:** design stage, no code yet.

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

not decided yet: filled in when the first code lands.

## commands

none yet.
