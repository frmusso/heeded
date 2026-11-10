import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Check, compile, language, verdict } from '../src/check.ts';

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

const replies: [string, string][] = [
  ['en', 'I checked the failing test and the problem is in the parser. It reads the whole file into memory, so it breaks on large inputs. I will change it to stream the lines and run the tests again.'],
  ['it', 'Ho controllato il test che fallisce e il problema è nel parser. Legge tutto il file in memoria, quindi si rompe con input grandi. Adesso lo cambio per leggere le righe una alla volta e poi rilancio i test.'],
  ['es', 'He revisado la prueba que falla y el problema está en el analizador. Lee todo el archivo en memoria, así que se rompe con entradas grandes. Ahora lo cambio para leer las líneas una por una y vuelvo a ejecutar las pruebas.'],
  ['fr', 'J\'ai vérifié le test qui échoue et le problème est dans l\'analyseur. Il lit tout le fichier en mémoire, donc il casse avec de grandes entrées. Je vais le changer pour lire les lignes une par une et relancer les tests.'],
  ['de', 'Ich habe den fehlschlagenden Test geprüft und das Problem liegt im Parser. Er liest die ganze Datei in den Speicher, deshalb bricht er bei großen Eingaben. Ich ändere es jetzt so, dass die Zeilen einzeln gelesen werden, und starte die Tests neu.'],
  ['pt', 'Verifiquei o teste que falha e o problema está no analisador. Ele lê o arquivo inteiro na memória, então quebra com entradas grandes. Agora vou mudar para ler as linhas uma de cada vez e rodar os testes de novo.'],
];

for (const [code, text] of replies) {
  test(`a reply in ${code}`, () => {
    assert.equal(language(text), code);
  });
}

test('code, URLs and paths are not words: an Italian reply around English code is Italian', () => {
  const text = 'Ho sistemato il parser in `src/claude-code.ts`: adesso legge le righe una alla volta, quindi non carica più tutto '
    + 'il file in memoria. Ecco la parte che è cambiata:\n```ts\n// read the file line by line so that the whole of it is '
    + 'never in memory at once, which is what the old code did when it was given a large file to read\nfor await (const '
    + 'line of lines(path)) yield line;\n```\nVedi https://nodejs.org/api/fs.html and the docs at /Users/someone/the/project/'
    + 'is/where/it/is/and/what/it/does';
  assert.equal(language(text), 'it');
});

test('half English, half Italian: no verdict', () => {
  const text = 'I checked the failing test and the problem is in the parser. Ho controllato il test che fallisce e il problema è nel parser.';
  assert.equal(language(text), null);
});

test('under 20 words: no verdict', () => {
  assert.equal(language('Ho controllato il test che fallisce e il problema è nel parser, ora lo sistemo.'), null);
});

test('a reply that is mostly a command: no verdict', () => {
  assert.equal(language('Run this:\n\n```sh\nnpm install && npm run build && npm test -- --watch\n```\n\nthen `git status` in /Users/x/repo.'), null);
});

test('words shared by languages tell none apart: a Spanish reply full of them is still Spanish', () => {
  const text = 'Creo que no es para hoy: lo que pasa es que el código de la parte de arriba no se carga, y por eso la página se '
    + 'queda en blanco cuando la abres desde el móvil.';
  assert.equal(language(text), 'es');
});

test('a reply of names and terms with few common words: no verdict', () => {
  const text = 'Parser sistemato: test verdi, build pulita, lint ok, typecheck ok, budget rispettati, pacchetto piccolo, avvio '
    + 'rapido, memoria bassa, throughput alto, tutto pronto per la review.';
  assert.equal(language(text), null);
});
