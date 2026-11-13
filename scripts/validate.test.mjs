/**
 * Tests of the validator. They only use temporary directories and in-memory
 * trees: no network, and nothing here depends on the real locales/ folder
 * (other than the small "this repository" block at the end, which checks the
 * hand-written configuration files).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LIMITS,
  LOCALE_PATTERN,
  addressesOf,
  computeCompleteness,
  digitRunsOf,
  findDuplicateKeys,
  foreignAddresses,
  formatReport,
  isReservedKey,
  kindOf,
  loadLocalesTree,
  main,
  maxTranslationLength,
  placeholdersOf,
  serialize,
  validateDirectory,
  validateMessage,
  validateTree,
} from './validate.mjs';

const SCRIPT = fileURLToPath(new URL('./validate.mjs', import.meta.url));
const REPOSITORY = path.dirname(path.dirname(SCRIPT));
const temporary = [];

after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

const CONFIG = { formatVersion: 1, sourceLocale: 'es', projects: { app: {}, api: {} } };
const ES_META = { name: 'Español', englishName: 'Spanish' };
const EN_META = { name: 'English', englishName: 'English' };

/**
 * Writes a tree of files. Object values are written as canonical JSON, string
 * values verbatim (to produce broken files), Buffers as they are.
 */
function makeRepository(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acciopass-i18n-test-'));
  temporary.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (Buffer.isBuffer(content)) fs.writeFileSync(absolute, content);
    else fs.writeFileSync(absolute, typeof content === 'string' ? content : serialize(content));
  }
  return root;
}

/** A valid two-locale repository; `extra` adds or replaces files. */
function repository(extra = {}) {
  return makeRepository({
    'i18n.config.json': CONFIG,
    'locales/es/locale.json': ES_META,
    'locales/en/locale.json': EN_META,
    'locales/es/app/common.json': {
      actions: { save: 'Guardar', cancel: 'Cancelar' },
      greeting: 'Hola, {name}',
      items: { zero: 'Sin elementos', one: '{count} elemento', other: '{count} elementos' },
      help: 'Más información en https://acciopass.com/ayuda.',
    },
    'locales/es/api/emails.json': { welcome: { subject: 'Te damos la bienvenida a AccioPass', body: 'Hola, {name}:\ntu cuenta ya está lista.' } },
    'locales/en/app/common.json': {
      actions: { save: 'Save', cancel: 'Cancel' },
      greeting: 'Hello, {name}',
      items: { zero: 'No items', one: '{count} item', other: '{count} items' },
      help: 'More information at https://acciopass.com/ayuda.',
    },
    'locales/en/api/emails.json': { welcome: { subject: 'Welcome to AccioPass', body: 'Hello {name},\nyour account is ready.' } },
    ...extra,
  });
}

function codes(problems) {
  return problems.map((item) => item.code);
}

/** Validates a repository whose English common.json is `english`. */
function withEnglish(english, extra = {}) {
  return validateDirectory(repository({ 'locales/en/app/common.json': english, ...extra }));
}

describe('helpers', () => {
  test('LOCALE_PATTERN accepts language and language-REGION only', () => {
    for (const code of ['es', 'en', 'pt-BR', 'fil', 'zh-CN']) assert.ok(LOCALE_PATTERN.test(code), code);
    for (const code of ['ES', 'e', 'es_ES', 'es-es', 'es-ESP', 'english', '', 'es-', '../es', 'es/..', 'zh-Hans']) {
      assert.ok(!LOCALE_PATTERN.test(code), code);
    }
  });

  test('kindOf tells strings, plurals, groups and garbage apart', () => {
    assert.equal(kindOf('x'), 'string');
    assert.equal(kindOf({ one: 'a', other: 'b' }), 'plural');
    assert.equal(kindOf({ zero: 'z', one: 'a', other: 'b' }), 'plural');
    assert.equal(kindOf({ one: 'a' }), 'plural');
    assert.equal(kindOf({ one: 'a', other: 'b', few: 'c' }), 'group');
    assert.equal(kindOf({}), 'group');
    for (const value of [1, true, null, undefined, ['a'], 1.5]) assert.equal(kindOf(value), 'invalid');
  });

  test('placeholdersOf finds {names}; a plural always has count', () => {
    assert.deepEqual(placeholdersOf('Hola, {name}. {name} tiene {total_2} avisos'), ['name', 'total_2']);
    assert.deepEqual(placeholdersOf('sin marcadores { } {a b} {é}'), []);
    assert.deepEqual(placeholdersOf({ one: 'Un elemento de {owner}', other: 'Varios' }).sort(), ['count', 'owner']);
  });

  test('addressesOf finds everything that reads as somewhere to go, without trailing punctuation', () => {
    assert.deepEqual(addressesOf('Ve a https://a.example/x. O a (http://b.example), o www.c.example!').sort(), [
      'http://b.example',
      'https://a.example/x',
      'www.c.example',
    ]);
    assert.deepEqual(addressesOf('nada que ver. Ni esto: 3.5 mm, a.m., v1.2, 10:30 o «y/o».'), []);
    for (const [text, token] of [
      ['Entra en acciopass-login.com/unlock ahora', 'acciopass-login.com/unlock'],
      ['Escribe a security@acciopass-support.com.', 'security@acciopass-support.com'],
      ['Mira //evil.example/login', '//evil.example/login'],
      ['ftp://x', 'ftp://x'],
      ['intent://scan/#Intent;end', 'intent://scan/#Intent;end'],
      ['javascript:alert(1)', 'javascript:alert(1'],
      ['mailto:a', 'mailto:a'],
      ['[Abrir](evil.example/unlock)', 'evil.example/unlock'],
      ["https://ejemplo.com'@evil.example/", "https://ejemplo.com'@evil.example/"],
      ['Abre 10.0.0.1/login', '10.0.0.1/login'],
      // A zero-width joiner inside the scheme, full-width letters, an ideographic full stop.
      [`h\u{200D}ttps://evil.example`, 'https://evil.example'],
      ['\u{FF48}\u{FF54}\u{FF54}\u{FF50}\u{FF53}\u{FF1A}\u{FF0F}\u{FF0F}evil.example', 'https://evil.example'],
      ['evil\u{3002}example', 'evil.example'],
    ]) {
      assert.ok(addressesOf(text).includes(token), `${JSON.stringify(text)} -> ${JSON.stringify(addressesOf(text))}`);
    }
    // An ideographic full stop between sentences is a full stop.
    assert.deepEqual(addressesOf('\u{4F60}\u{597D}\u{3002}\u{518D}\u{89C1}\u{3002}'), []);
  });

  test('digitRunsOf finds telephone-like numbers', () => {
    assert.deepEqual(digitRunsOf('Llama al 950 674 456 o al +34 (950) 67-44-56.'), ['950674456', '34950674456']);
    assert.deepEqual(digitRunsOf('04700 El Ejido, planta 21, 463 y 123456'), []);
  });

  test('foreignAddresses allows what the source has, documentation domains and a country prefix', () => {
    assert.deepEqual(foreignAddresses('Go to https://acciopass.com/ayuda.', ['Ve a https://acciopass.com/ayuda']), []);
    assert.deepEqual(foreignAddresses('Like name@example.com or example.org', ['Como nombre@ejemplo.com']), []);
    assert.deepEqual(foreignAddresses('On +34 950 674 456', ['En el 950 674 456']), []);
    assert.deepEqual(foreignAddresses('On +3491 950 674 456', ['En el 950 674 456']), ['3491950674456']);
    assert.deepEqual(foreignAddresses('Call 900 123 456', ['Llama']), ['900123456']);
    assert.deepEqual(foreignAddresses('example.com/unlock', ['Hola']), ['example.com/unlock']);
    assert.deepEqual(foreignAddresses('https://example.com', ['Hola']).sort(), ['https://example.com']);
  });

  test('isReservedKey refuses every name an object already has', () => {
    for (const key of ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf', 'isPrototypeOf', 'toLocaleString', '__defineGetter__']) {
      assert.equal(isReservedKey(key), true, key);
    }
    for (const key of ['title', 'call', 'length', 'name', 'one']) assert.equal(isReservedKey(key), false, key);
  });

  test('maxTranslationLength is max(3x, x + 200), capped at 4000', () => {
    assert.equal(maxTranslationLength(0), 200);
    assert.equal(maxTranslationLength(10), 210);
    assert.equal(maxTranslationLength(100), 300);
    assert.equal(maxTranslationLength(500), 1500);
    assert.equal(maxTranslationLength(3000), 4000);
  });

  test('findDuplicateKeys only reports keys repeated inside the same object', () => {
    assert.deepEqual(findDuplicateKeys('{"a":"1","b":{"a":"2"},"c":[{"a":"3"},{"a":"4"}]}'), []);
    assert.deepEqual(findDuplicateKeys('{"a":"1","a":"2"}'), ['a']);
    assert.deepEqual(findDuplicateKeys('{"x":{"k":"1","\\u006b":"2"}}'), ['k']);
    assert.deepEqual(findDuplicateKeys('{"a":"\\"a\\": {","b":"a"}'), []);
  });

  test('serialize is the canonical format', () => {
    assert.equal(serialize({ a: 'ñ €', b: { c: 'x' } }), '{\n  "a": "ñ €",\n  "b": {\n    "c": "x"\n  }\n}\n');
  });
});

describe('validateMessage: source messages', () => {
  test('a plain string and a plural are valid', () => {
    assert.deepEqual(validateMessage(undefined, 'Guardar'), { status: 'ok', problems: [], value: 'Guardar' });
    const plural = validateMessage(undefined, { other: '{count} cosas', one: 'Una cosa' });
    assert.equal(plural.status, 'ok');
    assert.deepEqual(Object.keys(plural.value), ['one', 'other']);
  });

  test('rejects empty texts, HTML, control characters and over-long texts', () => {
    assert.deepEqual(codes(validateMessage(undefined, '').problems), ['empty']);
    assert.deepEqual(codes(validateMessage(undefined, '  \n ').problems), ['empty']);
    assert.deepEqual(codes(validateMessage(undefined, 'Pulsa <b>aquí</b>').problems), ['html']);
    assert.deepEqual(codes(validateMessage(undefined, 'a\tb').problems), ['control-character']);
    assert.deepEqual(codes(validateMessage(undefined, 'x'.repeat(4001)).problems), ['too-long']);
    assert.equal(validateMessage(undefined, 'x'.repeat(4000)).status, 'ok');
  });

  test('a source message may contain a URL, a newline and comparison signs', () => {
    assert.equal(validateMessage(undefined, 'Visita https://acciopass.com\nGracias').status, 'ok');
    assert.equal(validateMessage(undefined, 'Longitud < 12 o > 64; 3 <3').status, 'ok');
  });

  test('rejects broken plurals and non-text values', () => {
    assert.deepEqual(codes(validateMessage(undefined, { one: 'Uno' }).problems), ['plural-missing-form']);
    assert.deepEqual(codes(validateMessage(undefined, { other: 'Varios' }).problems), ['plural-missing-form']);
    assert.deepEqual(codes(validateMessage(undefined, { one: 'Uno', other: 3 }).problems), ['invalid-type']);
    assert.deepEqual(codes(validateMessage(undefined, { one: 'Uno', other: '' }).problems), ['empty']);
    for (const value of [3, null, true, ['a']]) assert.deepEqual(codes(validateMessage(undefined, value).problems), ['invalid-type']);
  });
});

describe('validateMessage: translations', () => {
  test('accepts a faithful translation', () => {
    assert.deepEqual(validateMessage('Hola, {name}', 'Hello, {name}'), { status: 'ok', problems: [], value: 'Hello, {name}' });
  });

  test('a translation may drop a placeholder but never invent one', () => {
    assert.equal(validateMessage('Hola, {name}', 'Hello').status, 'ok');
    const invented = validateMessage('Hola, {name}', 'Hello, {name} {password}');
    assert.equal(invented.status, 'invalid');
    assert.deepEqual(codes(invented.problems), ['placeholder-unknown']);
    assert.match(invented.problems[0].message, /\{password\}/);
    assert.deepEqual(codes(validateMessage('Hola', 'Hello {name}').problems), ['placeholder-unknown']);
  });

  test('{count} is always allowed in a plural, other names are not', () => {
    const source = { one: 'Un elemento', other: 'Varios elementos' };
    assert.equal(validateMessage(source, { one: '{count} item', other: '{count} items' }).status, 'ok');
    assert.deepEqual(codes(validateMessage(source, { one: '{n} item', other: '{count} items' }).problems), ['placeholder-unknown']);
  });

  test('the kind must match the source', () => {
    assert.deepEqual(codes(validateMessage('Hola', { one: 'a', other: 'b' }).problems), ['kind-mismatch']);
    assert.deepEqual(codes(validateMessage('Hola', { nested: 'a' }).problems), ['kind-mismatch']);
    assert.deepEqual(codes(validateMessage({ one: 'a', other: 'b' }, 'Hello').problems), ['kind-mismatch']);
    for (const value of [3, null, false, ['a']]) assert.deepEqual(codes(validateMessage('Hola', value).problems), ['invalid-type']);
  });

  test('a plural needs "one" and "other" and nothing but plural forms', () => {
    const source = { one: '{count} elemento', other: '{count} elementos' };
    assert.deepEqual(codes(validateMessage(source, { one: '{count} item' }).problems), ['plural-missing-form']);
    assert.deepEqual(codes(validateMessage(source, { other: '{count} items' }).problems), ['plural-missing-form']);
    assert.deepEqual(codes(validateMessage(source, { one: 'a', other: 'b', many: 'c' }).problems), ['plural-unknown-form']);
    assert.deepEqual(codes(validateMessage(source, { one: 'a', other: ['b'] }).problems), ['invalid-type']);
    assert.deepEqual(codes(validateMessage(source, {}).problems), ['plural-missing-form', 'plural-missing-form']);
  });

  test('a translation may add "zero" even when the source has none', () => {
    const result = validateMessage({ one: '{count} elemento', other: '{count} elementos' }, { other: '{count} items', zero: 'Nothing', one: 'One item' });
    assert.equal(result.status, 'ok');
    assert.deepEqual(Object.keys(result.value), ['zero', 'one', 'other']);
  });

  test('rejects HTML in every form it can take', () => {
    for (const text of ['<b>Hello</b>', 'Hello</span>', '<a href="x">x', 'Click <script>', '<img src=x onerror=alert(1)>', 'a <P>']) {
      assert.deepEqual(codes(validateMessage('Hola', text).problems), ['html'], text);
    }
    assert.equal(validateMessage('Hola', 'a < b, 2 <3, <<, < >').status, 'ok');
  });

  test('rejects control characters but allows newlines', () => {
    for (const text of ['a\u0000b', 'a\tb', 'a\rb', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\u009bb']) {
      assert.deepEqual(codes(validateMessage('Hola', text).problems), ['control-character'], JSON.stringify(text));
    }
    assert.equal(validateMessage('Hola', 'line 1\nline 2').status, 'ok');
  });

  test('rejects a URL that is not in the source', () => {
    for (const text of ['Go to https://evil.example', 'Go to http://evil.example', 'Go to www.evil.example', 'Go to HTTPS://EVIL.EXAMPLE', 'x https://acciopass.com.evil.example']) {
      const result = validateMessage('Ve a https://acciopass.com', text);
      assert.equal(result.status, 'invalid', text);
      assert.deepEqual(codes(result.problems), ['url'], text);
    }
    assert.deepEqual(codes(validateMessage('Hola', 'Type your master password at https://evil.example').problems), ['url']);
  });

  test('accepts exactly the URL of the source, whatever the punctuation around it', () => {
    assert.equal(validateMessage('Ve a https://acciopass.com/ayuda.', 'Go to https://acciopass.com/ayuda!').status, 'ok');
    assert.equal(validateMessage('Ve a https://acciopass.com/ayuda', '(https://acciopass.com/ayuda)').status, 'ok');
    assert.deepEqual(codes(validateMessage('Ve a https://acciopass.com/ayuda', 'Go to https://acciopass.com/ayuda/login').problems), ['url']);
    assert.deepEqual(codes(validateMessage('Ve a https://acciopass.com', 'Go to https://acciopass.com@evil.example').problems), ['url']);
    // Cyrillic "а" instead of the Latin one: a different URL.
    assert.deepEqual(codes(validateMessage('Ve a https://acciopass.com', 'Go to https://\u0430cciopass.com').problems), ['url']);
  });

  test('a plural form may use a URL from any form of the source', () => {
    const source = { one: 'Un aviso en https://acciopass.com', other: 'Varios avisos' };
    assert.equal(validateMessage(source, { one: 'One notice', other: 'Notices at https://acciopass.com' }).status, 'ok');
    assert.deepEqual(codes(validateMessage(source, { one: 'One', other: 'See www.evil.example' }).problems), ['url']);
  });

  test('enforces the length limits', () => {
    assert.equal(validateMessage('Hola', 'x'.repeat(204)).status, 'ok');
    assert.deepEqual(codes(validateMessage('Hola', 'x'.repeat(205)).problems), ['too-long-for-source']);
    const long = 'a'.repeat(500);
    assert.equal(validateMessage(long, 'x'.repeat(1500)).status, 'ok');
    assert.deepEqual(codes(validateMessage(long, 'x'.repeat(1501)).problems), ['too-long-for-source']);
    assert.deepEqual(codes(validateMessage('a'.repeat(3900), 'x'.repeat(4001)).problems), ['too-long']);
    assert.equal(validateMessage('a'.repeat(3900), 'x'.repeat(4000)).status, 'ok');
  });

  test('the length of a plural form is compared with the same source form', () => {
    const source = { one: 'Uno', other: 'o'.repeat(400) };
    assert.equal(validateMessage(source, { one: 'One', other: 'x'.repeat(1200) }).status, 'ok');
    assert.deepEqual(codes(validateMessage(source, { one: 'x'.repeat(204), other: 'ok' }).problems), ['too-long-for-source']);
    // "zero" without a source "zero" is compared with "other".
    assert.equal(validateMessage(source, { zero: 'x'.repeat(1200), one: 'One', other: 'Many' }).status, 'ok');
  });

  test('an empty translation is "untranslated", not an error', () => {
    assert.deepEqual(validateMessage('Hola', ''), { status: 'untranslated', problems: [], value: undefined });
    assert.equal(validateMessage('Hola', '   ').status, 'untranslated');
    assert.equal(validateMessage({ one: 'a', other: 'b' }, { one: '', other: '' }).status, 'untranslated');
  });

  test('a half-translated plural is ignored with a warning', () => {
    const result = validateMessage({ one: 'a', other: 'b' }, { one: 'One', other: '' });
    assert.equal(result.status, 'untranslated');
    assert.deepEqual(result.problems.map((item) => [item.level, item.code]), [['warning', 'plural-incomplete']]);
  });

  test('an empty "zero" is dropped from an otherwise complete plural', () => {
    const result = validateMessage({ zero: 'Nada', one: 'a', other: 'b' }, { zero: '', one: 'One', other: 'Many' });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.value, { one: 'One', other: 'Many' });
  });

  test('rejects bidirectional controls and invisible characters; ICU syntax is only a warning', () => {
    for (const point of [0x202e, 0x202a, 0x2066, 0x2069, 0x200e, 0x200f, 0x61c]) {
      const bidi = validateMessage('Hola', `Hello ${String.fromCodePoint(point)}dlrow`);
      assert.equal(bidi.status, 'invalid', point.toString(16));
      assert.deepEqual(bidi.problems.map((item) => [item.level, item.code]), [['error', 'bidi-control']]);
    }
    for (const point of [0x200b, 0x2060, 0x2800, 0x3164, 0x115f, 0x1160, 0xad, 0x2028, 0x2029, 0xe0041, 0xfeff]) {
      const hidden = validateMessage('Hola', `He${String.fromCodePoint(point)}llo`);
      assert.equal(hidden.status, 'invalid', point.toString(16));
      assert.deepEqual(codes(hidden.problems), ['invisible-character'], point.toString(16));
      // Alone it says nothing at all: never a valid text.
      assert.notEqual(validateMessage('Hola', String.fromCodePoint(point)).status, 'ok', point.toString(16));
      assert.equal(validateMessage(undefined, String.fromCodePoint(point)).status, 'invalid', point.toString(16));
    }
    // Joiners are legitimate inside a word, but they are not a text.
    assert.equal(validateMessage('Hola', `\u{645}\u{6CC}\u{200C}\u{62E}\u{648}\u{627}\u{647}\u{645}`).status, 'ok');
    assert.equal(validateMessage('Hola', '\u{200D}\u{FE0F}').status, 'untranslated');
    assert.equal(validateMessage(undefined, ' \u{200C} ').status, 'invalid');
    const icu = validateMessage('{count} cosas', '{count, plural, one {# thing} other {# things}}');
    assert.deepEqual(icu.problems.map((item) => [item.level, item.code]), [['warning', 'icu-syntax']]);
  });

  test('warns when "one" loses the {count} its source has', () => {
    const source = { one: '{count} elemento', other: '{count} elementos' };
    const result = validateMessage(source, { one: 'One item', other: '{count} items' });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.problems.map((item) => [item.level, item.code]), [['warning', 'plural-one-without-count']]);
    assert.deepEqual(validateMessage(source, { one: '{count} item', other: '{count} items' }).problems, []);
    assert.deepEqual(validateMessage({ one: 'Un elemento', other: '{count} elementos' }, { one: 'One item', other: '{count} items' }).problems, []);
  });

  test('never throws on hostile objects', () => {
    const hostile = JSON.parse('{"__proto__": "x", "one": "a", "other": "b"}');
    assert.deepEqual(codes(validateMessage({ one: 'a', other: 'b' }, hostile).problems), ['plural-unknown-form']);
    const constructorKey = JSON.parse('{"constructor": "x"}');
    assert.equal(validateMessage('Hola', constructorKey).status, 'invalid');
    assert.equal(validateMessage({ one: 'a', other: 'b' }, JSON.parse('{"one": {"toString": "x"}, "other": "b"}')).status, 'invalid');
  });
});

describe('validateDirectory: a healthy repository', () => {
  test('passes and reports full completeness', () => {
    const result = validateDirectory(repository());
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.ok, true);
    assert.equal(result.sourceLocale, 'es');
    assert.deepEqual(result.projects, ['app', 'api']);
    assert.deepEqual(result.locales, [
      { code: 'en', name: 'English', englishName: 'English', published: true, completeness: { app: { translated: 5, total: 5, ratio: 1 }, api: { translated: 2, total: 2, ratio: 1 } } },
      { code: 'es', name: 'Español', englishName: 'Spanish', published: true, completeness: { app: { translated: 5, total: 5, ratio: 1 }, api: { translated: 2, total: 2, ratio: 1 } } },
    ]);
  });

  test('exposes the accepted messages per locale and project, in source order', () => {
    const result = withEnglish({ items: { one: '{count} item', other: '{count} items' }, actions: { cancel: 'Cancel', save: 'Save' } });
    assert.deepEqual([...result.messages.get('en').get('app')], [
      ['common.actions.save', 'Save'],
      ['common.actions.cancel', 'Cancel'],
      ['common.items', { one: '{count} item', other: '{count} items' }],
    ]);
    assert.equal(result.messages.get('es').get('api').get('emails.welcome.subject'), 'Te damos la bienvenida a AccioPass');
  });

  test('missing keys are allowed and lower the completeness', () => {
    const result = withEnglish({ actions: { save: 'Save' } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.locales[0].completeness.app, { translated: 1, total: 5, ratio: 0.2 });
    assert.deepEqual(result.locales[0].completeness.api, { translated: 2, total: 2, ratio: 1 });
  });

  test('a locale with no files at all is valid with completeness 0', () => {
    const result = validateDirectory(repository({ 'locales/pt-BR/locale.json': { name: 'Português (Brasil)', englishName: 'Portuguese (Brazil)' } }));
    assert.equal(result.ok, true);
    const portuguese = result.locales.find((locale) => locale.code === 'pt-BR');
    assert.deepEqual(portuguese.completeness, { app: { translated: 0, total: 5, ratio: 0 }, api: { translated: 0, total: 2, ratio: 0 } });
  });

  test('empty strings (how Crowdin exports untranslated texts) count as missing', () => {
    const result = withEnglish({ actions: { save: 'Save', cancel: '' }, greeting: '', items: { zero: '', one: '', other: '' }, help: '' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.locales[0].completeness.app, { translated: 1, total: 5, ratio: 0.2 });
    assert.deepEqual([...result.messages.get('en').get('app').keys()], ['common.actions.save']);
  });

  test('computeCompleteness returns the ratios per locale and project', () => {
    const tree = loadLocalesTree(repository({ 'locales/en/app/common.json': { greeting: 'Hello, {name}' } }));
    const completeness = computeCompleteness(tree);
    assert.deepEqual(completeness.es, { app: { translated: 5, total: 5, ratio: 1 }, api: { translated: 2, total: 2, ratio: 1 } });
    assert.deepEqual(completeness.en.app, { translated: 1, total: 5, ratio: 0.2 });
  });

  test('an invalid message does not count as translated', () => {
    const result = withEnglish({ actions: { save: '<b>Save</b>', cancel: 'Cancel' } });
    assert.equal(result.ok, false);
    assert.deepEqual(result.locales[0].completeness.app, { translated: 1, total: 5, ratio: 0.2 });
    assert.equal(result.messages.get('en').get('app').has('common.actions.save'), false);
  });
});

describe('validateDirectory: hostile and broken translations', () => {
  const cases = [
    ['HTML', { greeting: 'Hello, <a href="https://evil.example">{name}</a>' }, ['html', 'url'], 'common.greeting'],
    ['a new URL', { greeting: 'Hello {name}, confirm your master password at https://evil.example/login' }, ['url'], 'common.greeting'],
    ['a www. URL', { actions: { save: 'Save at www.evil.example' } }, ['url'], 'common.actions.save'],
    ['a changed URL', { help: 'More information at https://acciopass.com/ayuda/../../evil' }, ['url'], 'common.help'],
    ['an invented placeholder', { greeting: 'Hello, {name}. Your password is {masterPassword}' }, ['placeholder-unknown'], 'common.greeting'],
    ['a plural without "other"', { items: { one: '{count} item' } }, ['plural-missing-form'], 'common.items'],
    ['a plural with an unknown form', { items: { one: 'a', other: 'b', few: 'c' } }, ['plural-unknown-form'], 'common.items'],
    ['a key missing from the source', { actions: { save: 'Save', destroy: 'Destroy' } }, ['unknown-key'], 'common.actions.destroy'],
    ['a whole group missing from the source', { extra: { a: 'A', b: 'B' } }, ['unknown-key'], 'common.extra'],
    ['a string where the source has a plural', { items: '{count} items' }, ['kind-mismatch'], 'common.items'],
    ['a plural where the source has a string', { greeting: { one: 'Hi', other: 'Hi all' } }, ['kind-mismatch'], 'common.greeting'],
    ['a string where the source has a group', { actions: 'Actions' }, ['kind-mismatch'], 'common.actions'],
    ['a group where the source has a string', { greeting: { formal: 'Good morning' } }, ['kind-mismatch'], 'common.greeting'],
    ['an over-long text', { actions: { save: 'S'.repeat(300) } }, ['too-long-for-source'], 'common.actions.save'],
    ['a text over the absolute limit', { actions: { save: 'S'.repeat(4001) } }, ['too-long'], 'common.actions.save'],
    ['a control character', { actions: { save: 'Save\u0007' } }, ['control-character'], 'common.actions.save'],
    ['a carriage return', { actions: { save: 'Save\r\nnow' } }, ['control-character'], 'common.actions.save'],
    ['a number', { actions: { save: 42 } }, ['invalid-type'], 'common.actions.save'],
    ['null', { actions: { save: null } }, ['invalid-type'], 'common.actions.save'],
    ['a list', { actions: { save: ['Save'] } }, ['invalid-type'], 'common.actions.save'],
    ['a key with a dot', { 'actions.save': 'Save' }, ['key-invalid'], 'common.actions.save'],
    ['an empty key', { '': 'Save' }, ['key-invalid'], 'common.'],
  ];
  for (const [name, english, expected, key] of cases) {
    test(`rejects ${name}`, () => {
      const result = withEnglish(english);
      assert.equal(result.ok, false);
      assert.deepEqual(codes(result.errors), expected);
      for (const item of result.errors) {
        assert.equal(item.key, key);
        assert.equal(item.locale, 'en');
        assert.equal(item.project, 'app');
        assert.equal(item.namespace, 'common');
        assert.equal(item.file, 'locales/en/app/common.json');
      }
    });
  }

  test('one bad message does not hide the good ones nor other bad ones', () => {
    const result = withEnglish({ actions: { save: '<i>Save</i>', cancel: 'Cancel' }, greeting: 'Hello {user}', items: { one: '{count} item', other: '{count} items' } });
    assert.deepEqual(codes(result.errors), ['html', 'placeholder-unknown']);
    assert.deepEqual([...result.messages.get('en').get('app').keys()], ['common.actions.cancel', 'common.items']);
  });

  for (const key of ['__proto__', 'constructor', 'prototype']) {
    test(`rejects the prototype-pollution key "${key}" at any depth`, () => {
      const top = withEnglish(`{\n  "${key}": {\n    "polluted": "yes"\n  }\n}\n`);
      assert.deepEqual(codes(top.errors), ['key-forbidden']);
      const nested = withEnglish(`{\n  "actions": {\n    "${key}": "Save"\n  }\n}\n`);
      assert.deepEqual(codes(nested.errors), ['key-forbidden']);
      const inPlural = withEnglish(`{\n  "items": {\n    "one": "a",\n    "other": "b",\n    "${key}": "c"\n  }\n}\n`);
      assert.deepEqual(codes(inPlural.errors), ['plural-unknown-form']);
      assert.equal({}.polluted, undefined);
      assert.equal(Object.prototype.polluted, undefined);
    });

    test(`rejects "${key}" in the source too`, () => {
      const result = validateDirectory(repository({ 'locales/es/app/common.json': `{\n  "${key}": {\n    "polluted": "sí"\n  },\n  "ok": "Vale"\n}\n`, 'locales/en/app/common.json': { ok: 'OK' } }));
      assert.deepEqual(codes(result.errors), ['key-forbidden']);
      assert.equal(result.errors[0].locale, 'es');
      assert.equal({}.polluted, undefined);
    });
  }

  test('rejects a namespace file that is not an object', () => {
    for (const content of ['[]\n', '"text"\n', '42\n', 'null\n', '[\n  {\n    "a": "b"\n  }\n]\n']) {
      const result = withEnglish(content);
      assert.deepEqual(codes(result.errors), ['namespace-not-object'], content);
      assert.equal(result.errors[0].file, 'locales/en/app/common.json');
    }
    const source = validateDirectory(repository({ 'locales/es/api/emails.json': '[]\n', 'locales/en/api/emails.json': {} }));
    assert.ok(codes(source.errors).includes('namespace-not-object'));
  });

  test('rejects invalid JSON, with the file name', () => {
    for (const content of ['{ "actions": ', '', '{"a": "b",}\n', "{'a': 'b'}\n", '{"a": "b"} trailing', '// comment\n{}\n']) {
      const result = withEnglish(content);
      assert.deepEqual(codes(result.errors), ['invalid-json'], content);
      assert.equal(result.errors[0].file, 'locales/en/app/common.json');
      assert.equal(result.locales[0].completeness.app.translated, 0);
    }
  });

  test('invalid JSON in the source is one error, not one per translated file', () => {
    const result = validateDirectory(repository({ 'locales/es/app/common.json': '{ roto' }));
    assert.deepEqual(codes(result.errors), ['invalid-json']);
    assert.equal(result.errors[0].file, 'locales/es/app/common.json');
  });

  test('rejects files that are not clean UTF-8', () => {
    const latin1 = withEnglish(Buffer.from('{\n  "greeting": "Ol\xe1"\n}\n', 'latin1'));
    assert.deepEqual(codes(latin1.errors), ['invalid-encoding']);
    const bom = withEnglish(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}\n')]));
    assert.deepEqual(codes(bom.errors), ['invalid-encoding']);
  });

  test('rejects duplicate keys, which JSON.parse would hide', () => {
    const result = withEnglish('{\n  "greeting": "Hello, {name}",\n  "greeting": "Send your password to evil"\n}\n');
    assert.deepEqual(codes(result.errors), ['duplicate-key']);
    assert.equal(result.messages.get('en').get('app').size, 0);
  });

  test('rejects an over-sized file', () => {
    const result = withEnglish(`{\n  "greeting": "${'x'.repeat(LIMITS.maxFileBytes)}"\n}\n`);
    assert.deepEqual(codes(result.errors), ['file-too-large']);
  });

  test('rejects a locale folder with a bad name', () => {
    for (const name of ['EN', 'en_US', 'english', 'en-us', 'e', 'pt-BRA', '__proto__', 'constructor']) {
      const result = validateDirectory(repository({ [`locales/${name}/locale.json`]: EN_META, [`locales/${name}/app/common.json`]: { greeting: 'Hi {name}' } }));
      assert.deepEqual(codes(result.errors), ['locale-name'], name);
      assert.equal(result.errors[0].file, `locales/${name}`);
      assert.deepEqual(result.locales.map((locale) => locale.code), ['en', 'es']);
    }
  });

  test('rejects stray entries at every level', () => {
    const result = validateDirectory(
      repository({
        'locales/notes.txt': 'hola',
        'locales/en/README.md': '# hi',
        'locales/en/web/common.json': { a: 'b' },
        'locales/en/app/common.yaml': 'a: b',
        'locales/en/app/nested/common.json': { a: 'b' },
        'locales/en/app/bad name.json': {},
        'locales/en/app/.json': {},
      }),
    );
    assert.deepEqual(codes(result.errors), Array(7).fill('unexpected-entry'));
    assert.deepEqual(result.errors.map((item) => item.file).sort(), [
      'locales/en/README.md',
      'locales/en/app/.json',
      'locales/en/app/bad name.json',
      'locales/en/app/common.yaml',
      'locales/en/app/nested',
      'locales/en/web',
      'locales/notes.txt',
    ]);
  });

  test('rejects a namespace that the source does not have', () => {
    const result = validateDirectory(repository({ 'locales/en/app/phishing.json': { title: 'Enter your master password' } }));
    assert.deepEqual(codes(result.errors), ['unknown-namespace']);
    assert.equal(result.errors[0].file, 'locales/en/app/phishing.json');
    assert.equal(result.messages.get('en').get('app').has('phishing.title'), false);
  });

  test('a namespace of one project is unknown in the other', () => {
    const result = validateDirectory(repository({ 'locales/en/api/common.json': { greeting: 'Hello, {name}' } }));
    assert.deepEqual(codes(result.errors), ['unknown-namespace']);
  });

  test('rejects a symbolic link in place of a file', () => {
    const root = repository();
    const target = path.join(root, 'locales/en/app/common.json');
    fs.renameSync(target, path.join(root, 'elsewhere.json'));
    fs.symlinkSync(path.join(root, 'elsewhere.json'), target);
    const result = validateDirectory(root);
    assert.deepEqual(codes(result.errors), ['unexpected-entry']);
  });

  test('warns when a translated file is not in canonical format', () => {
    const result = withEnglish('{"greeting":"Hello, {name}"}');
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings.map((item) => [item.code, item.file, item.files]), [['format', 'locales/en', ['locales/en/app/common.json']]]);
    const escaped = withEnglish('{\n  "greeting": "Hello, {name} \\u00f1"\n}\n');
    assert.deepEqual(codes(escaped.warnings), ['format']);
  });
});

describe('validateDirectory: the source locale', () => {
  function withSpanish(spanish, english = {}) {
    return validateDirectory(repository({ 'locales/es/app/common.json': spanish, 'locales/en/app/common.json': english }));
  }

  test('rejects bad source messages and says where', () => {
    const result = withSpanish({ ok: 'Vale', html: 'Pulsa <b>aquí</b>', empty: '', number: 7, plural: { one: 'Uno' }, group: {}, tab: 'a\tb' });
    assert.deepEqual(codes(result.errors), ['html', 'empty', 'invalid-type', 'plural-missing-form', 'empty-group', 'control-character']);
    assert.deepEqual(result.errors.map((item) => item.key), ['common.html', 'common.empty', 'common.number', 'common.plural', 'common.group', 'common.tab']);
    for (const item of result.errors) assert.equal(item.file, 'locales/es/app/common.json');
  });

  test('a translation of an invalid source message is not reported twice', () => {
    const result = withSpanish({ ok: 'Vale', html: 'Pulsa <b>aquí</b>' }, { ok: 'OK', html: 'Press here' });
    assert.deepEqual(codes(result.errors), ['html']);
    assert.equal(result.errors[0].locale, 'es');
  });

  test('the source must be in canonical format', () => {
    const result = withSpanish('{"ok":"Vale"}\n', { ok: 'OK' });
    assert.deepEqual(codes(result.errors), ['format']);
    assert.equal(result.errors[0].file, 'locales/es/app/common.json');
  });

  test('rejects nesting deeper than the limit', () => {
    let deep = 'fondo';
    for (let level = 0; level < LIMITS.maxDepth + 2; level += 1) deep = { n: deep };
    assert.deepEqual(codes(withSpanish(deep).errors), ['too-deep']);
  });

  test('the source folder must exist', () => {
    const result = validateDirectory(makeRepository({ 'i18n.config.json': CONFIG, 'locales/en/locale.json': EN_META }));
    assert.ok(codes(result.errors).includes('source-missing'));
  });

  test('warns when a project has no source texts', () => {
    const result = validateDirectory(makeRepository({ 'i18n.config.json': CONFIG, 'locales/es/locale.json': ES_META, 'locales/es/app/common.json': { ok: 'Vale' } }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings.map((item) => [item.code, item.project]), [['project-empty', 'api']]);
    assert.deepEqual(result.locales[0].completeness.api, { translated: 0, total: 0, ratio: 1 });
  });
});

describe('validateDirectory: locale.json and i18n.config.json', () => {
  test('a language without locale.json is validated but not published', () => {
    const root = repository();
    fs.rmSync(path.join(root, 'locales/en/locale.json'));
    const result = validateDirectory(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings.map((item) => [item.code, item.file]), [['locale-unpublished', 'locales/en/locale.json']]);
    assert.equal(result.locales[0].name, null);
    assert.equal(result.locales[0].published, false);
    assert.equal(result.locales[1].published, true);
    // Its texts are still checked.
    fs.writeFileSync(path.join(root, 'locales/en/app/common.json'), serialize({ greeting: '<b>{name}</b>' }));
    assert.deepEqual(codes(validateDirectory(root).errors), ['html']);
  });

  test('the source language needs its locale.json', () => {
    const root = repository();
    fs.rmSync(path.join(root, 'locales/es/locale.json'));
    assert.deepEqual(validateDirectory(root).errors.map((item) => [item.code, item.file]), [['locale-meta', 'locales/es/locale.json']]);
  });

  test('a language with locale.json and no text of the app is not published yet', () => {
    const empty = { actions: { save: '', cancel: '' }, greeting: '', items: { zero: '', one: '', other: '' }, help: '' };
    const result = validateDirectory(
      repository({ 'locales/fr/locale.json': { name: 'Français', englishName: 'French' }, 'locales/fr/app/common.json': empty, 'locales/fr/api/emails.json': { welcome: { subject: 'Bienvenue' } } }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings.map((item) => [item.code, item.locale]), [['locale-empty', 'fr']]);
    assert.deepEqual(result.locales.map((locale) => [locale.code, locale.published]), [['en', true], ['es', true], ['fr', false]]);
    assert.match(formatReport(result), /fr \(sin publicar\)/);
  });

  test('one format line per language, however many files Crowdin wrote its own way', () => {
    const loose = (value) => JSON.stringify(value, null, 4);
    const result = validateDirectory(
      repository({ 'locales/en/app/common.json': loose({ greeting: 'Hello, {name}' }), 'locales/en/api/emails.json': loose({ welcome: { subject: 'Welcome' } }) }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings.map((item) => [item.code, item.file, item.files.length]), [['format', 'locales/en', 2]]);
    assert.match(formatReport(result), /Avisos \(1\):\n {2}- locales\/en: 2 ficheros no están en el formato canónico/);
  });

  test('rejects a locale.json with the wrong shape or hostile names', () => {
    const bad = [
      { name: 'English' },
      { name: '', englishName: 'English' },
      { name: 'English', englishName: 7 },
      { name: 'English', englishName: 'English', flag: 'gb' },
      { name: '<b>English</b>', englishName: 'English' },
      { name: 'English www.evil.example', englishName: 'English' },
      { name: 'Eng\nlish', englishName: 'English' },
      { name: 'E'.repeat(61), englishName: 'English' },
      ['English'],
    ];
    for (const meta of bad) {
      const result = validateDirectory(repository({ 'locales/en/locale.json': meta }));
      assert.equal(result.ok, false, JSON.stringify(meta));
      for (const item of result.errors) assert.equal(item.file, 'locales/en/locale.json');
      assert.equal(result.locales[0].name, null);
    }
  });

  test('invalid JSON in locale.json is reported once', () => {
    const result = validateDirectory(repository({ 'locales/en/locale.json': '{' }));
    assert.deepEqual(codes(result.errors), ['invalid-json']);
  });

  test('rejects a broken i18n.config.json', () => {
    const bad = [
      '{',
      { formatVersion: 2, sourceLocale: 'es', projects: { app: {}, api: {} } },
      { formatVersion: 1, sourceLocale: 'ES', projects: { app: {}, api: {} } },
      { formatVersion: 1, sourceLocale: 'es', projects: {} },
      { formatVersion: 1, sourceLocale: 'es', projects: ['app'] },
      { formatVersion: 1, sourceLocale: 'es', projects: { '../x': {} } },
      { formatVersion: 1, sourceLocale: 'es', projects: { app: true } },
      ['x'],
    ];
    for (const config of bad) {
      const result = validateDirectory(repository({ 'i18n.config.json': config }));
      assert.equal(result.ok, false, JSON.stringify(config));
      assert.ok(result.errors.some((item) => item.file === 'i18n.config.json'), JSON.stringify(config));
    }
  });

  test('the config decides the source locale and the projects', () => {
    const root = makeRepository({
      'i18n.config.json': { formatVersion: 1, sourceLocale: 'en', projects: { web: {} } },
      'locales/en/locale.json': EN_META,
      'locales/es/locale.json': ES_META,
      'locales/en/web/home.json': { title: 'Home' },
      'locales/es/web/home.json': { title: 'Inicio' },
    });
    const result = validateDirectory(root);
    assert.equal(result.ok, true);
    assert.equal(result.sourceLocale, 'en');
    assert.deepEqual(result.projects, ['web']);
    assert.equal(result.locales.find((locale) => locale.code === 'es').completeness.web.ratio, 1);
  });

  test('without a config it assumes es / app + api and says so', () => {
    const root = repository();
    fs.rmSync(path.join(root, 'i18n.config.json'));
    const result = validateDirectory(root);
    assert.equal(result.ok, true);
    assert.deepEqual(codes(result.warnings), ['config-missing']);
    const silent = validateDirectory(root, { sourceLocale: 'es', projects: ['app', 'api'] });
    assert.deepEqual(silent.warnings, []);
  });

  test('a directory without locales/ is an error, not a crash', () => {
    const result = validateDirectory(makeRepository({ 'i18n.config.json': CONFIG }));
    assert.deepEqual(codes(result.errors), ['locales-missing', 'source-missing']);
  });
});

describe('validateTree: in-memory trees', () => {
  test('validates a tree that never touched the disk', () => {
    const result = validateTree({
      sourceLocale: 'es',
      projects: ['app'],
      locales: {
        es: { meta: ES_META, projects: { app: { common: { hello: 'Hola' } } } },
        en: { meta: EN_META, projects: { app: { common: { hello: 'Hello', bye: 'Bye' } } } },
      },
    });
    assert.deepEqual(result.errors.map((item) => [item.code, item.key]), [['unknown-key', 'common.bye']]);
    assert.equal(result.messages.get('en').get('app').get('common.hello'), 'Hello');
  });

  test('rejects a bad locale code and tolerates missing parts', () => {
    const result = validateTree({ locales: { es: { meta: ES_META, projects: {} }, 'EN-us': { meta: EN_META, projects: {} }, fr: { meta: null } } });
    assert.deepEqual(codes(result.errors), ['locale-name']);
    assert.deepEqual(codes(result.warnings), ['project-empty', 'project-empty', 'locale-unpublished']);
    assert.deepEqual(result.projects, ['app', 'api']);
  });

  test('does not mutate its input', () => {
    const tree = {
      sourceLocale: 'es',
      projects: ['app'],
      locales: {
        es: { meta: ES_META, projects: { app: { c: { items: { other: 'Varios', one: 'Uno' } } } } },
        en: { meta: EN_META, projects: { app: { c: { items: { zero: '', one: 'One', other: 'Many' } } } } },
      },
    };
    const before = JSON.stringify(tree);
    validateTree(tree);
    assert.equal(JSON.stringify(tree), before);
  });
});

describe('command line', () => {
  function run(...args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  }

  test('exits 0 and prints a Spanish report with the completeness table', () => {
    const result = run(repository({ 'locales/en/app/common.json': { actions: { save: 'Save' } } }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Idioma fuente: es · proyectos: app, api · idiomas: en, es/);
    assert.match(result.stdout, /en\s+English\s+20,0 % \(1\/5\)\s+100,0 % \(2\/2\)/);
    assert.match(result.stdout, /es \(fuente\)\s+Español\s+100,0 % \(5\/5\)\s+100,0 % \(2\/2\)/);
    assert.match(result.stdout, /Resultado: correcto \(0 avisos\)\./);
  });

  test('exits 1 and lists the errors with file, key and code', () => {
    const result = run(repository({ 'locales/en/app/common.json': { greeting: 'Hello {name}, go to https://evil.example' } }));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Errores \(1\):/);
    assert.match(result.stdout, /locales\/en\/app\/common\.json · common\.greeting: .*https:\/\/evil\.example.* \[url\]/);
    assert.match(result.stdout, /Resultado: 1 error\. Las traducciones NO son válidas\./);
  });

  test('--json prints machine-readable output with the same verdict', () => {
    const good = run(repository(), '--json');
    assert.equal(good.status, 0);
    const parsed = JSON.parse(good.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.formatVersion, 1);
    assert.equal(parsed.sourceLocale, 'es');
    assert.deepEqual(parsed.locales.map((locale) => [locale.code, locale.completeness.app.ratio]), [['en', 1], ['es', 1]]);
    assert.equal(parsed.messages, undefined);

    const bad = run('--json', repository({ 'locales/en/app/common.json': { items: { one: '{count} item' } } }));
    assert.equal(bad.status, 1);
    const errors = JSON.parse(bad.stdout).errors;
    assert.deepEqual(errors.map((item) => [item.code, item.locale, item.project, item.namespace, item.key, item.level]), [
      ['plural-missing-form', 'en', 'app', 'common', 'common.items', 'error'],
    ]);
  });

  test('uses the current directory by default', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', cwd: repository() });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  });

  test('exits 2 on a usage error', () => {
    assert.equal(run('--nope').status, 2);
    assert.equal(run('a', 'b').status, 2);
    const missing = run(path.join(os.tmpdir(), 'acciopass-i18n-no-existe'));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /No existe la carpeta/);
    assert.equal(run('--help').status, 0);
  });

  test('main() can be called in-process', () => {
    let output = '';
    const sink = { write: (text) => (output += text) };
    assert.equal(main([repository()], sink, sink), 0);
    assert.match(output, /Resultado: correcto/);
  });

  test('formatReport shows warnings and unnamed locales', () => {
    const root = repository({ 'locales/en/app/common.json': '{"greeting":"Hello, {name}"}' });
    fs.rmSync(path.join(root, 'locales/en/locale.json'));
    const report = formatReport(validateDirectory(root));
    assert.match(report, /Avisos \(2\):/);
    assert.match(report, /en \(sin publicar\)\s+\?\s+20,0 %/);
  });
});

describe('this repository', () => {
  const read = (relative) => fs.readFileSync(path.join(REPOSITORY, relative), 'utf8');

  test('i18n.config.json is valid and in canonical format', () => {
    const text = read('i18n.config.json');
    const config = JSON.parse(text);
    assert.equal(serialize(config), text);
    assert.equal(config.formatVersion, 1);
    assert.equal(config.sourceLocale, 'es');
    assert.deepEqual(Object.keys(config.projects), ['app', 'api']);
  });

  test('the hand-written locale.json files are valid', () => {
    assert.deepEqual(JSON.parse(read('locales/es/locale.json')), { name: 'Español', englishName: 'Spanish' });
    assert.deepEqual(JSON.parse(read('locales/en/locale.json')), { name: 'English', englishName: 'English' });
  });

  test('crowdin.yml covers every project, carries no credentials and keeps CI running', () => {
    const crowdin = read('crowdin.yml');
    const config = JSON.parse(read('i18n.config.json'));
    for (const project of Object.keys(config.projects)) {
      assert.ok(crowdin.includes(`source: /locales/${config.sourceLocale}/${project}/*.json`), `falta el proyecto ${project} en crowdin.yml`);
      assert.ok(crowdin.includes(`translation: /locales/%two_letters_code%/${project}/%original_file_name%`), project);
    }
    const settings = crowdin.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    assert.doesNotMatch(settings, /api_token|project_id/);
    assert.doesNotMatch(settings, /ci skip|skip ci/i);
    assert.match(settings, /^append_commit_message: false$/m);
    assert.match(settings, /^preserve_hierarchy: true$/m);
    assert.doesNotMatch(settings, /locale\.json/);
  });

  test('crowdin.yml gives regional variants their own folder in every files block', () => {
    const crowdin = read('crowdin.yml');
    const blocks = crowdin.split(/^ {2}- source: /m).slice(1);
    assert.equal(blocks.length, 2);
    for (const block of blocks) {
      assert.match(block, /^ {4}languages_mapping:\n {6}two_letters_code:$/m);
      const pairs = [...block.matchAll(/^ {8}([A-Za-z-]+): ([A-Za-z-]+)$/gm)].map((match) => [match[1], match[2]]);
      assert.ok(pairs.length >= 3);
      for (const [crowdinCode, folder] of pairs) {
        assert.match(folder, LOCALE_PATTERN);
        assert.equal(folder, crowdinCode);
        // No variant may be written over the source, nor over the plain language of another.
        assert.match(folder, /-/);
      }
      for (const variant of ['es-MX', 'pt-BR', 'zh-CN', 'zh-TW']) assert.ok(pairs.some(([code]) => code === variant), variant);
    }
    // No YAML anchors: nothing says Crowdin's parser follows them.
    assert.doesNotMatch(crowdin.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n'), /[&*]\w+\s*$/m);
  });

  test('the workflow validates main and every pull request once, and guards the pull requests of Crowdin', () => {
    const workflow = read('.github/workflows/validate.yml');
    assert.match(workflow, /^ {2}push:\n {4}branches:\n {6}- main$/m);
    assert.match(workflow, /^ {2}pull_request:$/m);
    assert.match(workflow, /^ {2}merge_group:$/m);
    assert.match(workflow, /run: npm test/);
    assert.match(workflow, /run: npm run validate/);
    assert.match(workflow, /contents: read/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /if: github\.event_name == 'pull_request' && startsWith\(github\.head_ref, 'l10n_'\)\n\s+run: git diff --name-only --no-renames -z HEAD\^1 HEAD \| node scripts\/check-l10n-pr\.mjs/);
    assert.match(workflow, /fetch-depth: 2/);
  });
});

/*
 * The cases shared with the API (acciopass-backend) and the app
 * (acciopass-frontend): fixtures/validation-cases.json. Each of those
 * repositories keeps a copy and runs it against its own implementation of the
 * rules; here it is run against the reference. A verdict that has to change
 * changes in that file, and then in the three places.
 */
describe('shared cases (fixtures/validation-cases.json)', () => {
  const shared = JSON.parse(fs.readFileSync(path.join(REPOSITORY, 'fixtures', 'validation-cases.json'), 'utf8'));

  test('the file has the three kinds of cases, each with a unique name', () => {
    assert.equal(shared.formatVersion, 1);
    for (const list of [shared.messages, shared.sourceMessages, shared.bundles]) {
      assert.ok(list.length > 0);
      assert.equal(new Set(list.map((item) => item.name)).size, list.length);
    }
  });

  test('the protected prefixes name texts that exist in this repository', () => {
    const { messages } = validateDirectory(REPOSITORY);
    assert.deepEqual(Object.keys(shared.protectedKeys), ['app', 'api']);
    for (const [project, prefixes] of Object.entries(shared.protectedKeys)) {
      const keys = [...messages.get('es').get(project).keys()];
      for (const prefix of prefixes) {
        assert.match(prefix, /^[A-Za-z][A-Za-z0-9_.-]*\.$/);
        assert.ok(keys.some((key) => key.startsWith(prefix)), `${project}: ningún texto empieza por ${prefix}`);
      }
    }
  });

  for (const item of shared.messages) {
    test(`translation: ${item.name}`, () => {
      const result = validateMessage(item.source, item.candidate);
      assert.equal(result.status, item.status, JSON.stringify(result.problems));
      if (item.status === 'ok') assert.deepEqual(result.value, item.value);
      // A plural comes back rebuilt in canonical order.
      if (item.status === 'ok' && typeof item.value === 'object') assert.deepEqual(Object.keys(result.value), Object.keys(item.value));
    });
  }

  for (const item of shared.sourceMessages) {
    test(`source: ${item.name}`, () => {
      assert.equal(validateMessage(undefined, item.candidate).status, item.status);
    });
  }

  for (const item of shared.bundles) {
    test(`bundle: ${item.name}`, () => {
      const files = { ...shared.base, ...item.files };
      for (const key of Object.keys(files)) if (files[key] === null) delete files[key];
      const result = validateDirectory(makeRepository(files));
      assert.equal(result.ok ? 'ok' : 'error', item.expect.validator, JSON.stringify(result.errors));
      for (const [locale, keys] of Object.entries(item.expect.messages ?? {})) {
        assert.deepEqual([...(result.messages.get(locale)?.get('app')?.keys() ?? [])], keys, locale);
      }
      if (item.expect.locales) {
        const offered = result.locales.filter((locale) => locale.published).map((locale) => locale.code);
        assert.deepEqual([result.sourceLocale, ...offered.filter((code) => code !== result.sourceLocale)], item.expect.locales);
      }
    });
  }
});
