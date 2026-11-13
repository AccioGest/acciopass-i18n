/** Tests of the guard for Crowdin's pull requests. No network, no git. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { forbiddenPaths, main, parsePaths } from './check-l10n-pr.mjs';

const SCRIPT = fileURLToPath(new URL('./check-l10n-pr.mjs', import.meta.url));
const REPOSITORY = path.dirname(path.dirname(SCRIPT));

describe('check-l10n-pr', () => {
  test('allows translated texts of any language but the source', () => {
    assert.deepEqual(forbiddenPaths(['locales/en/app/common.json', 'locales/pt-BR/api/emails.json', 'locales/fr/app/vault.json']), []);
  });

  test('refuses the source language: a regional Spanish written over it', () => {
    assert.deepEqual(forbiddenPaths(['locales/en/app/common.json', 'locales/es/app/common.json', 'locales/es/api/emails.json']), [
      'locales/es/app/common.json',
      'locales/es/api/emails.json',
    ]);
  });

  test('refuses everything that is not a translated text', () => {
    const outside = [
      'README.md',
      'crowdin.yml',
      'i18n.config.json',
      'scripts/validate.mjs',
      '.github/workflows/validate.yml',
      'fixtures/validation-cases.json',
      'locales/en/locale.json',
      'locales/fr/locale.json',
      'locales/en/app/deep/common.json',
      'locales/en/web/common.json',
      'locales/en/app/common.txt',
      'locales/en/app/toString.json',
      'locales/EN/app/common.json',
      'locales/../scripts/app/validate.json',
      'package.json',
    ];
    assert.deepEqual(forbiddenPaths(outside), outside);
  });

  test('reads NUL- and newline-separated lists', () => {
    assert.deepEqual(parsePaths('a\0b c\0'), ['a', 'b c']);
    assert.deepEqual(parsePaths('a\r\nb\n\n'), ['a', 'b']);
  });

  test('main reports in Spanish and returns the exit code', () => {
    let output = '';
    const sink = { write: (text) => (output += text) };
    assert.equal(main('locales/en/app/common.json\n', REPOSITORY, sink), 0);
    assert.match(output, /1 fichero cambiado/);
    output = '';
    assert.equal(main('locales/en/app/common.json\0locales/es/app/common.json\0', REPOSITORY, sink), 1);
    assert.match(output, /- locales\/es\/app\/common\.json/);
    assert.match(output, /NO fusiones/);
  });

  test('command line: paths on standard input', () => {
    const good = spawnSync(process.execPath, [SCRIPT], { input: 'locales/en/api/errors.json\n', encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
    const bad = spawnSync(process.execPath, [SCRIPT], { input: 'crowdin.yml\n', encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.equal(spawnSync(process.execPath, [SCRIPT, 'x'], { input: '', encoding: 'utf8' }).status, 2);
  });
});
