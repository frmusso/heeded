import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact } from '../src/redact.ts';

// Each key is built from pieces so secret scanners don't take the fixture for a real one.
const secrets: [string, string][] = [
  ['a JWT', 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJl'],
  ['an sk- key', 'sk' + '-ant-api03-Zx9_Qw8-Er7Ty6Ui5Op4'],
  ['a Stripe key', 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc'],
  ['a GitHub token', 'gh' + 'p_' + 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78'],
  ['a fine-grained GitHub token', 'github' + '_pat_' + '11ABCDEFG0123456789_abcdefghijk'],
  ['an AWS key id', 'AK' + 'IAZ7XQ4MPLRT2WK9BV'],
  ['a Slack token', 'xo' + 'xb-1234567890-abcdefghij'],
  ['32 hex digits', 'a3f9' + 'c2e17b4d0f8a6e5c3b2a1d0f9e8c7b6a'],
  ['a base64 run of 40+ mixing digits and cases', 'dGhpc0lzQVNlY3JldEJsb2JXaXRoMTIzNDU2Nzg5MEFCQ0RFRg=='],
  ['a base64 run holding slashes', 'q8Zr2LmN0pX4vT7wY1aB3cD5eF6gH9jK/L2mN4pQ6rS8tU0vW2xY4zA6bC8dE0'],
];

for (const [what, secret] of secrets) {
  test(`redacts ${what}`, () => {
    assert.equal(redact(`key ${secret} here`), 'key … here');
  });
}

for (const text of [
  '/Users/someone/Documents/repos/heeded/src/claude-code.ts',
  'git add /Users/someone/Documents/repos/project2/src/components/Button2.tsx',
  'see https://github.com/someone/app/blob/main/src/Report2View/Totals3Panel.ts',
  'Run the tests before you commit, one file at a time.',
  'fixed in 8c0e8fab',
  'abcdefghijklmnopqrstuvwxyzabcdefghijklmn',
  '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b',
]) {
  test(`leaves alone: ${text}`, () => {
    assert.equal(redact(text), text);
  });
}
