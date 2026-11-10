import assert from 'node:assert/strict';
import { test } from 'node:test';
import { language } from '../src/check.ts';
import { commands } from '../src/shell.ts';

const does = (line: string) => commands(line).map((c) => c.does);

test('a line splits into simple commands: what each does, what it carries, how it was written', () => {
  assert.deepEqual(commands('git add -A && git commit -m "fix: a; b"'), [
    { does: 'git add -A', carries: '', text: 'git add -A' },
    { does: 'git commit -m ""', carries: 'fix: a; b', text: 'git commit -m "fix: a; b"' },
  ]);
});

test('every separator splits; a redirection, an escaped separator and a comment do not', () => {
  assert.deepEqual(does('a && b || c ; d | e |& f & g\nh'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepEqual(does('ls 2>&1 | head >&2'), ['ls 2>&1', 'head >&2']);
  assert.deepEqual(does('npm test &> log.txt'), ['npm test &> log.txt']);
  assert.deepEqual(does('find . -exec rm {} \\; && ls'), ['find . -exec rm {} \\;', 'ls']);
  assert.deepEqual(does('a # b; kill c\nd'), ['a', 'd']);
  assert.deepEqual(does('echo a#b $#'), ['echo a#b $#']);
});

test('quoted text is emptied in what a command does, and carried', () => {
  assert.deepEqual(commands(`grep -n 'store-submit' a "b \\" c" $'d\\'e'`), [{
    does: `grep -n '' a "" $''`, carries: `store-submit\nb \\" c\nd\\'e`, text: `grep -n 'store-submit' a "b \\" c" $'d\\'e'`,
  }]);
  assert.deepEqual(commands('echo "abc && rm x'), [{ does: 'echo "', carries: 'abc && rm x', text: 'echo "abc && rm x' }]);
});

test('a heredoc body is carried by the command that opens it, never read as commands', () => {
  assert.deepEqual(commands("cat > t.ts <<'EOF'\nkill billingd && git push -f\nEOF\nls"), [
    { does: 'cat > t.ts <<EOF', carries: 'kill billingd && git push -f', text: 'cat > t.ts <<EOF' },
    { does: 'ls', carries: '', text: 'ls' },
  ]);
  assert.deepEqual(commands('cat <<EOF > a && echo hi\nbody\nEOF').map((c) => c.carries), ['body', '']);
  assert.deepEqual(commands('cat <<-END\n\tx\n\tEND\necho done').map((c) => [c.does, c.carries]), [['cat <<-END', '\tx'], ['echo done', '']]);
  assert.deepEqual(commands('paste <<A <<B\n1\nA\n2\nB').map((c) => c.carries), ['1\n2']);
  assert.deepEqual(commands('cat <<EOF\r\nx\r\nEOF\r\nls').map((c) => [c.does, c.carries]), [['cat <<EOF', 'x'], ['ls', '']]);
});

test("claude code's commit form: the message is carried, whatever quotes it holds", () => {
  const [commit, ...rest] = commands(`git commit -m "$(cat <<'EOF'\nfix: the "kill billingd" case\nEOF\n)" && git push`);
  assert.equal(commit.does, 'git commit -m ""');
  assert.match(commit.carries, /fix: the "kill billingd" case/);
  assert.deepEqual(rest.map((c) => c.does), ['cat <<EOF', 'git push']);
});

test('a << without its closing line is not a heredoc', () => {
  assert.deepEqual(does('echo $((1 << 2))\nls'), ['echo $((1 << 2))', 'ls']);
  assert.deepEqual(does('cat <<< "word"'), ['cat <<< ""']);
});

test('a shell run on a string reads the string as commands too: sh -c, bash -c, ssh, eval', () => {
  assert.deepEqual(does("ssh host 'pkill billingd'"), ["ssh host ''", 'pkill billingd']);
  assert.deepEqual(does('sudo bash -c "cd x && git push -f"'), ['sudo bash -c ""', 'cd x', 'git push -f']);
  assert.deepEqual(does('FOO=1 nohup zsh -lc "make"; eval "rm -rf y"'), ['FOO=1 nohup zsh -lc ""', 'make', 'eval ""', 'rm -rf y']);
  assert.deepEqual(does("bash <<'EOF'\npkill billingd\nEOF"), ['bash <<EOF', 'pkill billingd']);
  assert.deepEqual(does('ssh -i k host <<EOF\ngit push -f\nEOF'), ['ssh -i k host <<EOF', 'git push -f']);
  assert.deepEqual(does('bash script.sh "pkill x"; bash -x run.sh'), ['bash script.sh ""', 'bash -x run.sh']);
});

test('a line continued with a backslash is one command', () => {
  assert.deepEqual(does('rm \\\n  -rf build && docker run \\\n  --rm x'), ['rm   -rf build', 'docker run   --rm x']);
});

test('a command substitution is read as commands, in quotes or not, with its own quotes inside', () => {
  assert.deepEqual(does('OUT="$(git push --force 2>&1)"'), ['OUT=""', 'git push --force 2>&1']);
  assert.deepEqual(does('x="`git push -f`"'), ['x=""', 'git push -f']);
  assert.deepEqual(does('cd "$(dirname "$0")" && ls'), ['cd ""', 'dirname ""', 'ls']);
  assert.deepEqual(does('x=$(cd a; ls) && git push -f'), ['x=$(cd a; ls)', 'cd a', 'ls', 'git push -f']);
  assert.deepEqual(does('git commit -m "$(printf "feat: x; rm -rf /tmp/y")"'), ['git commit -m ""', 'printf ""']);
});

test('what a commit carries is its message, in either form', () => {
  assert.equal(commands(`git commit -m "$(cat <<'EOF'\nfeat: add x\nEOF\n)"`)[0].carries, 'feat: add x');
  assert.equal(commands('git commit -m "$(printf "feat: add x")"')[0].carries, 'feat: add x');
  assert.equal(commands('git commit -m "feat: add x"')[0].carries, 'feat: add x');
});

test('a shell given a string is found wherever it sits in the command', () => {
  for (const line of ['/bin/bash -c "git push -f"', '/usr/bin/env bash -c "git push -f"', 'docker exec app sh -c "git push -f"',
    'timeout 60 bash -c "git push -f"', 'sudo -u www bash -c "git push -f"', 'bash -o pipefail -c "git push -f"',
    'xargs -I{} sh -c "git push -f"']) {
    assert.ok(does(line).includes('git push -f'), line);
  }
  assert.deepEqual(does('bash script.sh "git push -f" --check'), ['bash script.sh "" --check']);
});

test('shell syntax before a command is not part of what it does', () => {
  assert.deepEqual(does('(git push --force)'), ['git push --force)']);
  assert.deepEqual(does('if git push -f; then echo ok; fi'), ['git push -f', 'echo ok', 'fi']);
  assert.deepEqual(does('{ git push -f; }; ! git push -f'), ['git push -f', '}', 'git push -f']);
  assert.deepEqual(does('for x in a; do npm i; done'), ['for x in a', 'npm i', 'done']);
});

test('more heredoc and redirection forms: <<\\EOF, a commented-out heredoc, >|', () => {
  assert.deepEqual(commands('cat <<\\EOF > notes.md\nnever rm -rf /\nEOF').map((c) => [c.does, c.carries]),
    [['cat <<EOF > notes.md', 'never rm -rf /']]);
  assert.deepEqual(does('# cat <<EOF\nls\nEOF'), ['ls', 'EOF']);
  assert.deepEqual(does('echo x >| f && ls'), ['echo x >| f', 'ls']);
});

test('pathological lines stay fast', () => {
  const start = performance.now();
  commands('cat <<A\n'.repeat(20_000));
  language(`${'\n'.repeat(80_000)}ok`);
  assert.ok(performance.now() - start < 1000, `${performance.now() - start} ms`);
});
