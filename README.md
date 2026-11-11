# heeded

did your coding agent follow its instructions?

you write rules for your agent in `CLAUDE.md` and hope they stick. heeded reads the transcripts claude code keeps on
disk and tells you which rules were kept, which were broken, when and where.

```text
$ npx heeded

  ~/repos/app · 76 sessions, 412 subagents · oct 11 – nov 10
  3 files · 41 rules · 12 checked · 29 need a judge

  CLAUDE.md
    ✗ :30  failing test first  kept 80% of 20 judged      broken 4×    last 3 days ago
        nov 7   4d2e9a10  call Edit: src/parser.ts
    ✗ :12  never git add -A    kept 95% of 214            broken 9×    last 2 days ago
        nov 8   19df6c20  git add -A && git commit -m "fix: …"
        nov 2   8c0e8fab  git add -A
    ✓ :14  never force-push    kept 100% of 61
    ○ :21  use pnpm, not npm   never applied              ~40 tokens every session
  ~/.claude/CLAUDE.md
    ✗ :3   answer in italian   kept 96% of 3,812          broken 152×  last today
        after compaction kept 69% of 410
    ○ :17  ask before deploys  never applied in 8 judged  ~30 tokens every session

  kept by context depth   0–100k   100–200k   200–400k   400k+
                             98%        97%        91%     84%

  6 rules no call or reply shows: heeded rules
  up to date: new sessions and changes to instruction files are read on the next run
```

<sub>a sketch: the numbers are invented.</sub>

| mark | the rule |
| --- | --- |
| `✗` | was broken: every case confirmed by the judge, listed with its date, session and call |
| `✓` | was kept every time it applied |
| `?` | has candidates only: a pattern flagged them, the judge hasn't looked yet |
| `○` | never applied in these sessions: it sits in every session's context all the same |

- `kept 95% of 214`: the rule applied 214 times and was kept in 95% of them.
- `of 20 judged`: no pattern can decide the rule, so the judge read a sample of its cases: 20 of them applied.
- `after compaction`: the same rule, counted only after claude code compacted the context.
- each rule is under the file it is written in: the folder's files first, then the others (`~/.claude/CLAUDE.md` is
  loaded in every project, so a rule there can be never applied here and needed elsewhere).
- `:12`: the line the rule starts on in that file, as the file is now. no number: its words aren't in the file any
  more.
- `kept by context depth`: every rule together, by how full the context was at the time.
- `never applied in 8 judged`: none of the 8 cases the judge read was about the rule.
- `rules no call or reply shows`: rules about how to work ("plan before coding"), which no single call or reply can
  show; `heeded rules` lists them.

## use

needs node 22 or later and claude code, signed in: heeded calls your own `claude` to read rules and to judge.

1. **run it in a project** you've worked on with claude code:

   ```sh
   cd ~/code/my-app
   npx heeded
   ```

2. **say yes, or not yet.** reading the rules and judging cost tokens from your claude account, so heeded shows the
   estimate and asks before spending anything:

   ```text
   11 rule sections to read, then cases to judge · claude sonnet and haiku · up to ~175k tokens
   go ahead? [y/N]
   ```

   `y` reads the rules, judges a first round of cases and prints the report. enter spends nothing: the report shows
   what is already cached, on a first run the sessions found and the sections still to read.

3. **act on the report.** each rule is under its file, with its line (`:12`). a rule broken often may need
   rewriting, or saying why it matters. a rule never applied costs its tokens in every session: move it to the project
   it's for, or remove it. `heeded rules` shows how each rule is checked, and the ones no call or reply can show.

4. **run it again** whenever you like: after more sessions, or after editing an instruction file. every run reads the
   transcripts again, for free, and asks only when something new costs tokens. what was read or judged is cached and
   never paid for twice; with nothing new, the report ends `up to date`.

```sh
npx heeded           # the report, for the claude code sessions run in this folder
npx heeded rules     # the rules found, and how each one is checked
npx heeded --all     # judge every case waiting, not one run's 150k tokens
npx heeded --json    # everything, as json
```

to type `heeded` instead of `npx heeded`, install it: `npm install -g heeded`.

## how it works

1. **find the sessions.** the transcripts of the sessions run in this folder and its worktrees, subagents included,
   under `~/.claude/projects/`.
2. **read the rules.** claude code writes into each transcript the instruction files it loaded, word for word. heeded
   splits them into sections and asks `claude` (sonnet) for each section's rules, each with a check:
   - a pattern over a tool call, like `git add -A` in a bash command;
   - the language replies must be in;
   - otherwise, the calls or replies the rule is about, left to the judge.

   a check that fails its own examples is set aside. a section is read once, then cached.
3. **check every call.** one pass over the transcripts: each call and reply against the rules in effect at that point.
   a shell command is read the way a shell reads it, so `echo "rm -rf"` isn't running `rm`.
4. **judge.** a pattern finds candidates, not violations. each candidate, and a sample of the cases no pattern can
   decide, goes to `claude` (haiku) with an excerpt of its session: your prompt, what the agent did since, the call
   itself. it answers broken, kept, or doesn't apply. only your words grant a permission; an agent's never do. an
   excerpt goes once, with every rule it is a case of (an edit of a component is a case of every rule about
   components), and each verdict is cached. a rule the judge decides is tried on 8 of its cases first: if none is
   about it, it stops there; if some are, it goes on to 20 cases that applied, or 40 judged. up to 3 calls run at
   once.
5. **report.** each rule under its file, at its line in the file as it is now: kept, broken with the evidence, never
   applied; by context depth and after compaction.

steps 2 and 4 cost tokens: heeded asks once, before spending anything. a run judges within 150k tokens and nothing is
paid for twice, so coverage grows run after run. `heeded --all` goes to the end instead: its question shows what waits
now and the most it can reach, then it judges round after round until nothing waits. off a terminal (ci, a script) it
never spends.

`heeded rules` shows what each rule became:

```text
$ npx heeded rules

  ~/repos/app · 1 file · 5 rules

  CLAUDE.md
    ✓ :8   never git add -A           Bash command  when (^|\s)git\s+add(\s|$)  broken \s(-A|--all)\b
    ✓ :12  answer in italian          language it
    · :15  commit only when asked     judged on Bash command  when (^|\s)git\s+commit(\s|$)
    · :19  say what you changed       judged on replies
    ! :23  never kill the dev server  failed its examples: keeps "pkill -f vite-test"
```

`✓` a pattern decides it: `when` picks the calls it applies to, `broken` the ones that break it. `·` the judge
decides, on the calls or replies shown. `!` its check was set aside, and why.

## privacy

local and read-only: heeded never changes your transcripts, instruction files or settings, and writes only to its own
cache (`~/.cache/heeded`, or under `$XDG_CACHE_HOME`). two things leave your machine, through your own `claude`: the
text of instruction sections not read before, and the excerpts the judge reads. both have secrets redacted first, and
what is written to files like `.env` is never sent. no telemetry.

`CLAUDE_CONFIG_DIR` points heeded at another claude code folder (default `~/.claude`).

## license

[mit](LICENSE)
