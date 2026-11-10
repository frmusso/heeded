# heeded

did your coding agent follow its instructions?

you write rules for your agent in `CLAUDE.md`, then hope they stick. heeded reads the transcripts claude code leaves on
disk, checks each rule it can against what the agent actually did, and tells you what happened.

```text
$ npx heeded

  ~/repos/app · 76 sessions, 412 subagents · oct 11 – nov 10
  3 files · 41 rules · 12 checked · 29 need a judge

  ✗ never git add -A   kept 95% of 214    broken 9×    last 2 days ago
      nov 8   19df6c20  git add -A && git commit -m "fix: …"
      nov 2   8c0e8fab  git add -A
      oct 29  4f1c22d0  git add -A
  ✗ answer in italian  kept 96% of 3,812  broken 152×  last today
      after compaction kept 69% of 410
      nov 10  e7128125  en: "Sure — here's the plan for the …"
  ✓ never force-push   kept 100% of 61
  ○ use pnpm, not npm  never applied      ~40 tokens every session

  kept by context depth   0–100k   100–200k   200–400k   400k+
                             98%        97%        91%     84%

  29 rules need a judge, not checked yet: heeded rules
```

<sub>a sketch: the numbers are invented.</sub>

- which rules are kept, which are broken, where and how often
- which rules never apply, yet cost tokens in every session
- how compliance moves as the context fills up and after it's compacted

## how it works

claude code records in each transcript the instruction files it loaded, word for word. heeded splits them into
sections and, once per section, asks your own `claude` (sonnet) to turn the rules in it into checks: a pattern over a
tool call, or the language a reply must be in. it shows the estimate and asks first; the answer is cached, and every
check must pass its own examples before it counts. rules a plain check can't decide are listed as needing a judge.

```text
$ npx heeded rules

  ~/repos/app · 2 files · 5 rules

  ~/.claude/CLAUDE.md
    ✓ clickup is read-only       tool mcp__.*clickup.*  broken tool _(create|update|delete)_
  CLAUDE.md
    ✓ never git add -A           Bash command  when \bgit\s+add\b  broken \s(-A|--all)\b
    ✓ answer in italian          language it
    · failing test first         needs a judge
    ! never kill the dev server  failed its examples: keeps "pkill -f vite-test"
```

## use

```sh
npx heeded           # the report on the claude code sessions run in this folder
npx heeded rules     # the rules found, and how each one is checked
npx heeded --json    # everything, as json
```

needs node 22 or later and claude code. reads `CLAUDE_CONFIG_DIR`, else `~/.claude`; caches rules in
`XDG_CACHE_HOME`, else `~/.cache`.

local and read-only on your files. the only thing that leaves your machine is the text of new instruction sections,
secrets redacted, through your own `claude`. no telemetry.

> **status:** v1, not published yet. a judge for the rules a plain check can't decide comes next.

## license

[mit](LICENSE)
