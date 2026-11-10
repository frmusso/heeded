import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  assert.deepEqual(rest.map((c) => c.does), ['git push']);
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
