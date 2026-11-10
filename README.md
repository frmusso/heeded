# heeded

did your coding agent follow its instructions?

you write rules for your agents in `CLAUDE.md` and `AGENTS.md`, then hope they stick. heeded reads the transcripts
your agents leave on disk, checks them against those rules, and tells you what actually happened.

```text
$ npx heeded

  CLAUDE.md · 24 rules · 312 sessions

  ✗ never run git add -A          broken 9×        last 2 days ago
  ✗ answer in italian             kept 96%         after compaction 69%
  ○ use pnpm, not npm             never applied    140 tokens every session
  ✓ failing test first            kept 98%
```

<sub>a sketch of the report, not real output yet.</sub>

- which rules are kept, which are broken, where and how often
- which rules never apply, yet cost tokens in every session
- which rules contradict each other
- how compliance moves as the context fills up and after it's compacted

local, read-only on your files, and a model call only where a plain check can't decide.

> **status:** early design. nothing to install yet.

## license

[mit](LICENSE)
