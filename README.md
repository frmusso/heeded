# heeded

did your coding agent follow its instructions?

you write rules for your agent in `CLAUDE.md`, then hope they stick. heeded reads the transcripts claude code leaves on
disk, checks each rule it can against what the agent actually did, and tells you what happened.

```text
$ npx heeded

  ~/repos/app · 76 sessions, 412 subagents · oct 11 – nov 10
  3 files · 41 rules · 12 checked · 29 need a judge

  ✗ never git add -A    kept 95% of 214        broken 9×    last 2 days ago
      nov 8   19df6c20  git add -A && git commit -m "fix: …"
      nov 2   8c0e8fab  git add -A
  ✗ answer in italian   kept 96% of 3,812      broken 152×  last today
      after compaction kept 69% of 410
      nov 10  e7128125  en: "Sure — here's the plan for the …"
  ✓ never force-push    kept 100% of 61        2 to confirm
  ? never push to main  3 to confirm
  ○ use pnpm, not npm   never applied          ~40 tokens every session
  · failing test first  kept 80% of 20 judged  broken 4×    last 3 days ago
      nov 7   1a2b3c4d  call Edit: src/parser.ts

  kept by context depth   0–100k   100–200k   200–400k   400k+
                             98%        97%        91%     84%

  21 rules not judged yet: heeded rules
  37 cases waiting for the judge
```

<sub>a sketch: the numbers are invented.</sub>

- which rules are kept, which are broken, where and how often: a violation only once a judge confirmed it
- which rules never apply, yet cost tokens in every session
- how compliance moves as the context fills up and after it's compacted

## how it works

claude code records in each transcript the instruction files it loaded, word for word. heeded splits them into
sections and asks your own `claude` (sonnet) to turn the rules in each into checks: a pattern over a tool call, or the
language a reply must be in. it reads only the latest version of a section, and older versions keep the rules whose
words they hold. it shows the estimate and asks first; the answer is cached, and every check must pass its own examples
before it counts. a rule a plain check can't decide gets the calls or replies it is about instead.

a pattern written by a model finds candidates, not violations. every call a pattern says broke its rule, and every case
of a rule no pattern can decide, goes to a judge: your own `claude` again, reading an excerpt of the session, the prompt
that started the turn and what followed, secrets redacted. only your words grant a permission, typed or picked from a
question; an agent's never do. a run judges within 150k tokens, asked for with the rest. verdicts are cached, so a case
is paid for once and coverage grows run after run; a judgment rule is judged until 20 of its cases are decided.

a shell command is read the way the shell reads it, one command at a time: what it runs is checked apart from what it
carries (a file written through a heredoc, a commit message, the pattern of a search), so writing about `rm -rf` is not
running it, and a rule about commit messages can still read them.

```text
$ npx heeded rules

  ~/repos/app · 2 files · 6 rules

  ~/.claude/CLAUDE.md
    ✓ clickup is read-only       tool mcp__.*clickup.*  broken tool _(create|update|delete)_
  CLAUDE.md
    ✓ never git add -A           Bash command  when (^|\s)git\s+add(\s|$)  broken \s(-A|--all)\b
    ✓ answer in italian          language it
    · commit only when asked     judged on Bash command  when (^|\s)git\s+commit(\s|$)
    · say what you changed       judged on replies
    ! never kill the dev server  failed its examples: keeps "pkill -f vite-test"
```

## use

```sh
npx heeded           # the report on the claude code sessions run in this folder
npx heeded rules     # the rules found, and how each one is checked
npx heeded --json    # everything, as json
```

needs node 22 or later and claude code. reads `CLAUDE_CONFIG_DIR`, else `~/.claude`; caches rules and verdicts in
`XDG_CACHE_HOME`, else `~/.cache`.

local and read-only on your files. the only things that leave your machine are the text of new instruction sections and
the excerpts the judge reads, secrets redacted, through your own `claude`. no telemetry.

> **status:** v2, not published yet.

## license

[mit](LICENSE)
