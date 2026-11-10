import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Check, compile, verdict } from '../src/check.ts';

function compiled(check: Check) {
  const c = compile(check);
  assert.ok(typeof c !== 'string', c as string);
  return c;
}

const gitAdd: Check = {
  field: 'command',
  when: { tool: '^Bash$', value: '\\bgit\\s+add\\b' },
  broken: { value: '\\s(-A|--all)\\b' },
  ignoreCase: false,
};

test('a tool check: applies to its tool and value, broken by its broken pattern', () => {
  const c = compiled(gitAdd);
  const bash = (command: string) => verdict(c, 'Bash', { command });
  assert.equal(bash('git add -A'), 'broken');
  assert.equal(bash('git add --all && git commit'), 'broken');
  assert.equal(bash('git add src/a.ts'), 'kept');
  assert.equal(bash('git add -p'), 'kept');
  assert.equal(bash('ls -A'), 'none');
  assert.equal(verdict(c, 'Edit', { command: 'git add -A' }), 'none');
  assert.equal(verdict(c, 'Bash', {}), 'none');
  assert.equal(verdict(c, 'Bash', { command: 42 }), 'none');
});

test('a check on the tool name alone', () => {
  const c = compiled({ when: { tool: 'mcp__.*clickup.*' }, broken: { tool: '_(create|update|delete)_' } });
  assert.equal(verdict(c, 'mcp__clickup__create_task', { name: 'x' }), 'broken');
  assert.equal(verdict(c, 'mcp__clickup__get_task', { id: '1' }), 'kept');
  assert.equal(verdict(c, 'Bash', { command: 'clickup_create_' }), 'none');
});

test('case is ignored only when the check says so', () => {
  const check = { field: 'command', when: { tool: '^Bash$' }, broken: { value: 'git push --force' } };
  assert.equal(verdict(compiled({ ...check, ignoreCase: true }), 'Bash', { command: 'GIT PUSH --FORCE' }), 'broken');
  assert.equal(verdict(compiled(check), 'Bash', { command: 'GIT PUSH --FORCE' }), 'kept');
});

test('the same call gets the same verdict every time', () => {
  const c = compiled(gitAdd);
  for (let i = 0; i < 3; i++) assert.equal(verdict(c, 'Bash', { command: 'git add -A' }), 'broken');
});

test('a value is matched on its first 4,096 characters', () => {
  const c = compiled(gitAdd);
  assert.equal(verdict(c, 'Bash', { command: `git add ${'x'.repeat(4080)} -A` }), 'broken');
  assert.equal(verdict(c, 'Bash', { command: `git add ${'x'.repeat(4090)} -A` }), 'kept');
});

test("a pattern that doesn't compile is refused, with the pattern", () => {
  assert.equal(compile({ ...gitAdd, broken: { value: '(-A' } }), "regex doesn't compile: (-A");
  assert.equal(compile({ ...gitAdd, when: { tool: '[Bash' } }), "regex doesn't compile: [Bash");
});

test('a pattern that repeats a quantified group is refused: it can take exponential time', () => {
  for (const p of ['(a+)+', '(\\w+\\s?)*', '(x{2,})+']) {
    assert.equal(compile({ ...gitAdd, broken: { value: p } }), `regex repeats a quantified group: ${p}`);
  }
  for (const p of ['(?:ab)+', '\\(a+\\)+', '--force\\b|\\-f\\b']) assert.equal(typeof compile({ ...gitAdd, broken: { value: p } }), 'object', p);
});

test('a check nothing can break is refused', () => {
  assert.equal(compile({ field: 'command', when: { tool: '^Bash$' } }), 'no broken pattern');
  assert.equal(compile({ field: 'command', when: { tool: '^Bash$' }, broken: {} }), 'no broken pattern');
});
