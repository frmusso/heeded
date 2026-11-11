# contributing

thanks for looking. heeded is small and meant to stay small. a pull request is welcome as it is, no issue needed first.
for a bigger change, a quick issue to talk it over can save you some work, but that's up to you.

## run it from a clone

```sh
git clone https://github.com/frmusso/heeded && cd heeded
npm install                 # dev dependencies only: typescript and @types/node
node src/cli.ts             # the report on the claude code sessions you ran in this folder
```

node 22.18 or later runs the typescript sources as they are, no build step. to try it on another project, run it from
that project's folder:

```sh
cd ~/code/my-app
node ~/code/heeded/src/cli.ts rules
```

or build it once and link it, then use `heeded` anywhere:

```sh
npm run build && npm link
```

a run asks before it calls `claude`: press enter (no is the default) and it spends nothing.

## check a change

```sh
npm test                               # every test file, one at a time
node --test tests/judge.test.ts        # one file
npm run typecheck
node scripts/public-tree.ts            # no private notes or personal data in the tree
```

`HEEDED_LIVE=1 node --test tests/live.test.ts` runs the real `claude` calls on your account: a few cents. a pull
request doesn't need it.

## how the code is written

[CLAUDE.md](CLAUDE.md) has the principles and the architecture, and reads fine for people too. in short:

- a failing test first, for every change, then the fix;
- no runtime dependencies;
- tests never read your real `~/.claude`: they use the sandbox in `tests/support/`, and fixtures are synthetic, never a
  real transcript;
- lowercase in everything heeded prints and in the docs, english in code and commits;
- commit messages like `fix: a line cut before it renders is marked cut`, then why.

## bugs

open an issue with the command you ran, what you expected and what you got. heeded's output can show paths, commands
and pieces of your sessions: read it before you paste it.

security problems go to [SECURITY.md](SECURITY.md), not to an issue.
