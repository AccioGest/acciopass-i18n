#!/usr/bin/env node
/**
 * acciopass-i18n validator (format version 1).
 *
 * One dependency-free file (Node >= 22) with two faces:
 *
 *   - a library: `loadLocalesTree`, `validateTree`, `validateMessage`,
 *     `computeCompleteness`, `validateDirectory` and the small helpers they
 *     are made of, so the API and the app can vendor or mirror the very same
 *     rules for the texts they receive at run time;
 *   - a CLI: `node scripts/validate.mjs [dir] [--json]`, exit code 1 when the
 *     tree has errors, 2 on a usage error.
 *
 * Why the rules are strict: AccioPass is a zero-knowledge password manager.
 * A tampered translation is a phishing vector (it could tell a person to type
 * the master password somewhere else), so every text that does not come from
 * the build is treated as untrusted input. Messages are plain text with
 * `{name}` placeholders and nothing else.
 *
 * Human-readable output is Spanish (the project's source language); problem
 * `code`s are stable English identifiers meant for machines and tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT_VERSION = 1;
export const DEFAULT_SOURCE_LOCALE = 'es';
export const DEFAULT_PROJECTS = Object.freeze(['app', 'api']);

/** Lowercase BCP-47 language code, optionally with an uppercase region. */
export const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z]{2})?$/;
export const PROJECT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const NAMESPACE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** One segment of a dotted key. A dot would make the full key ambiguous. */
export const KEY_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
export const PLURAL_FORMS = Object.freeze(['zero', 'one', 'other']);
export const REQUIRED_PLURAL_FORMS = Object.freeze(['one', 'other']);

export const LIMITS = Object.freeze({
  /** Absolute cap for any message text, in UTF-16 code units (`String.length`). */
  maxMessageLength: 4000,
  /** A translation may be at most max(factor × source, source + slack) long. */
  lengthFactor: 3,
  lengthSlack: 200,
  maxLocaleNameLength: 60,
  maxFileBytes: 1024 * 1024,
  maxDepth: 12,
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HTML_RE = /<[A-Za-z/]/;
/** C0 and C1 control characters except the newline (U+000A). */
const CONTROL_RE = /[\0-\x09\x0B-\x1F\x7F-\x9F]/;
/**
 * Bidirectional marks, embeddings, overrides and isolates: they can reorder
 * what a person reads ("evorppa" shown as "approve"). Written as code points
 * on purpose: the characters themselves would be invisible in this file.
 */
const BIDI_RE = /[\u{61C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;
/**
 * Characters that render as nothing or as a blank and have no place in an
 * interface text: soft hyphen, Hangul and Khmer fillers, Mongolian
 * selectors, zero-width space, line and paragraph separators, word joiner
 * and invisible operators, deprecated format characters, braille blank, BOM,
 * interlinear annotation, shorthand and musical format controls, the tag
 * block and the unassigned default-ignorable code points around it.
 */
const INVISIBLE_RE = /[\xAD\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180B}-\u{180F}\u{200B}\u{2028}\u{2029}\u{2060}-\u{2065}\u{206A}-\u{206F}\u{2800}\u{3164}\u{FEFF}\u{FFA0}\u{FFF0}-\u{FFFB}\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E00FF}\u{E01F0}-\u{E0FFF}]/u;
/**
 * Invisible characters with a legitimate use (joiners of Persian, Indic
 * scripts and emoji; variation selectors). Allowed in a text, but they do
 * not make a text non-empty and they are removed before looking for
 * addresses.
 */
const IGNORABLE_RE = /[\u{34F}\u{200C}\u{200D}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
const ICU_RE = /\{\s*\w+\s*,/;
const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

/**
 * What a person, a mail client or a phone would take for somewhere to go or
 * someone to contact. A translation may only carry the ones its source has.
 */
const ADDRESS_TRAILING_RE = /[.,;:!?)\]}»”’…"'>]+$/u;
const BARE_SCHEMES = 'javascript|vbscript|data|mailto|tel|sms|file|blob|about|intent|ftp|sftp|ws|wss|market|itms|itms-apps|itms-services|ms-settings|smb|ssh|view-source';
const ADDRESS_RES = [
  // any-scheme://…
  /[a-z][a-z0-9+.-]*:\/\/\S*/giu,
  // schemes that work without "//"
  new RegExp(`(?<![a-z0-9+.-])(?:${BARE_SCHEMES}):\\S+`, 'giu'),
  // //host (protocol-relative)
  /(?<![:/\w])\/\/[^\s/]\S*/gu,
  // anything@anything
  /\S*@[^\s@]\S*/gu,
  // label.label.tld (also "www.…"), with whatever is glued to it
  /(?<![\p{L}\p{N}.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,}(?![\p{L}\p{N}-])\S*/gu,
  // IPv4
  /(?<![\p{N}.])\p{Nd}{1,3}(?:\.\p{Nd}{1,3}){3}(?![\p{N}])\S*/gu,
];
/** Seven or more digits, alone or grouped as a telephone number is written. */
const DIGIT_RUN_RE = /\p{Nd}(?:[\s().+/-]{0,3}\p{Nd}){6,}/gu;
const NOT_DIGIT_RE = /\P{Nd}/gu;
/** Ideographic full stops between ASCII letters or digits act as the dot of a host name. */
const IDEOGRAPHIC_DOT_RE = /(?<=[A-Za-z0-9])[\u{3002}\u{FF61}](?=[A-Za-z0-9])/gu;
/** Names reserved for documentation (RFC 2606): nobody can own them, so they lead nowhere. */
const EXAMPLE_ADDRESS_RE = /^(?:[^\s@/:]+@)?example\.(?:com|net|org)$/i;
/** A telephone number may gain a country prefix in translation ("950 674 456" → "+34 950 674 456"). */
const MAX_PHONE_PREFIX = 3;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 'string' | 'plural' | 'group' | 'invalid'. An object is plural-shaped when
 * it has at least one key and all its keys are plural forms; whether it is a
 * complete plural (has "one" and "other", all strings) is checked separately.
 */
export function kindOf(value) {
  if (typeof value === 'string') return 'string';
  if (!isPlainObject(value)) return 'invalid';
  const keys = Object.keys(value);
  if (keys.length > 0 && keys.every((key) => PLURAL_FORMS.includes(key))) return 'plural';
  return 'group';
}

function textsOf(value) {
  if (typeof value === 'string') return [value];
  const texts = [];
  for (const form of PLURAL_FORMS) {
    if (Object.hasOwn(value, form) && typeof value[form] === 'string') texts.push(value[form]);
  }
  return texts;
}

/** The `{placeholders}` of a message; a plural message always has `count`. */
export function placeholdersOf(value) {
  const names = new Set();
  for (const text of textsOf(value)) {
    for (const match of text.matchAll(PLACEHOLDER_RE)) names.add(match[1]);
  }
  if (typeof value !== 'string') names.add('count');
  return [...names];
}

/** Whether `key` cannot be a key: it would name something every JavaScript object already has. */
export function isReservedKey(key) {
  return FORBIDDEN_KEYS.has(key) || key in Object.prototype;
}

/** The text as an address detector must see it: compatibility forms folded, joiners removed. */
function foldForAddresses(text) {
  return text.normalize('NFKC').replace(IGNORABLE_RE, '').replace(IDEOGRAPHIC_DOT_RE, '.');
}

/**
 * The addresses written in a text, without trailing punctuation: web
 * addresses with or without scheme, bare domains, e-mail addresses, IP
 * addresses and anything else with a scheme that opens something.
 */
export function addressesOf(text) {
  let rest = foldForAddresses(text);
  const found = new Set();
  for (const pattern of ADDRESS_RES) {
    // What one pattern took is not offered to the next: one address, one token.
    rest = rest.replace(pattern, (match) => {
      const token = match.replace(ADDRESS_TRAILING_RE, '');
      if (token !== '') found.add(token);
      return ' ';
    });
  }
  return [...found];
}

/** The long digit runs of a text (telephone numbers and the like), digits only. */
export function digitRunsOf(text) {
  const runs = new Set();
  for (const match of foldForAddresses(text).matchAll(DIGIT_RUN_RE)) runs.add(match[0].replace(NOT_DIGIT_RE, ''));
  return [...runs];
}

/**
 * The addresses and numbers of `text` that its source does not have. Allowed
 * without being in the source: the documentation domains (`example.com`,
 * `name@example.org`) and a source telephone number with a country prefix.
 */
export function foreignAddresses(text, sourceTexts) {
  const sourceAddresses = new Set(sourceTexts.flatMap(addressesOf));
  const sourceRuns = sourceTexts.flatMap(digitRunsOf);
  const foreign = addressesOf(text).filter((token) => !sourceAddresses.has(token) && !EXAMPLE_ADDRESS_RE.test(token));
  for (const run of digitRunsOf(text)) {
    const known = sourceRuns.some((source) => run === source || (run.endsWith(source) && run.length - source.length <= MAX_PHONE_PREFIX));
    if (!known) foreign.push(run);
  }
  return foreign;
}

export function maxTranslationLength(sourceLength) {
  return Math.min(
    LIMITS.maxMessageLength,
    Math.max(LIMITS.lengthFactor * sourceLength, sourceLength + LIMITS.lengthSlack),
  );
}

/** Nothing a person would see: only white space and invisible joiners. */
function isBlank(text) {
  return text.replace(IGNORABLE_RE, '').trim() === '';
}

function quote(text) {
  const short = text.length > 60 ? `${text.slice(0, 57)}...` : text;
  return JSON.stringify(short);
}

/**
 * Keys that appear twice in the same JSON object. `JSON.parse` silently keeps
 * the last one, so a duplicate could hide a text from a reviewer who reads the
 * first. `text` must already be valid JSON.
 */
export function findDuplicateKeys(text) {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/g) ?? [];
  const duplicates = [];
  const stack = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token[0] === '"' && tokens[index + 1] === ':') {
      const keys = stack[stack.length - 1];
      if (!keys) continue;
      const key = JSON.parse(token);
      if (keys.has(key)) duplicates.push(key);
      keys.add(key);
    }
  }
  return duplicates;
}

/** The canonical serialisation: 2-space indent, trailing newline, no escapes. */
export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Per-message validation
// ---------------------------------------------------------------------------

function problem(level, code, message) {
  return { level, code, message };
}

/** Plain-text rules shared by every text of every locale. */
function checkText(text, label, problems) {
  if (HTML_RE.test(text)) {
    problems.push(problem('error', 'html', `${label}contiene marcado HTML ("<" seguido de una letra o de "/"); solo se admite texto plano`));
  }
  if (CONTROL_RE.test(text)) {
    problems.push(problem('error', 'control-character', `${label}contiene caracteres de control (solo se admite el salto de línea)`));
  }
  if (text.length > LIMITS.maxMessageLength) {
    problems.push(problem('error', 'too-long', `${label}mide ${text.length} caracteres; el máximo es ${LIMITS.maxMessageLength}`));
  }
  if (BIDI_RE.test(text)) {
    problems.push(problem('error', 'bidi-control', `${label}contiene caracteres de control bidireccional (marcas, incrustaciones o inversiones), que alteran el orden en que se lee el texto`));
  }
  if (INVISIBLE_RE.test(text)) {
    problems.push(problem('error', 'invisible-character', `${label}contiene caracteres invisibles o en blanco (espacio de anchura cero, separador de línea, relleno…); solo se admite texto que se vea`));
  }
  if (ICU_RE.test(text)) {
    problems.push(problem('warning', 'icu-syntax', `${label}parece usar sintaxis ICU ("{nombre, ...}"), que no se interpreta: se mostraría tal cual`));
  }
}

/** Rules that compare one translated text with its source text. */
function checkAgainstSource(text, sourceText, sourceTexts, label, problems) {
  for (const token of foreignAddresses(text, sourceTexts)) {
    problems.push(problem('error', 'url', `${label}contiene ${quote(token)}, una dirección, un dominio, un correo o un número que no está en el texto original`));
  }
  const limit = maxTranslationLength(sourceText.length);
  if (text.length > limit && text.length <= LIMITS.maxMessageLength) {
    problems.push(problem('error', 'too-long-for-source', `${label}mide ${text.length} caracteres; el original mide ${sourceText.length} y admite como mucho ${limit}`));
  }
}

function formLabel(form) {
  return form ? `la forma "${form}" ` : '';
}

/**
 * Checks the structure of a plural object: only known forms, all strings,
 * "one" and "other" present. Returns false when it cannot be used at all.
 */
function checkPluralShape(value, problems) {
  let usable = true;
  for (const key of Object.keys(value)) {
    if (!PLURAL_FORMS.includes(key)) {
      problems.push(problem('error', 'plural-unknown-form', `forma de plural desconocida ${quote(key)}; solo existen "zero", "one" y "other"`));
      usable = false;
    } else if (typeof value[key] !== 'string') {
      problems.push(problem('error', 'invalid-type', `la forma "${key}" debe ser un texto`));
      usable = false;
    }
  }
  for (const form of REQUIRED_PLURAL_FORMS) {
    if (!Object.hasOwn(value, form)) {
      problems.push(problem('error', 'plural-missing-form', `al plural le falta la forma "${form}" ("one" y "other" son obligatorias)`));
      usable = false;
    }
  }
  return usable;
}

/**
 * Validates one message.
 *
 * With `source === undefined` the candidate IS a source message. Otherwise
 * `source` must be a valid source message (string or plural) and `candidate`
 * is its translation.
 *
 * Returns `{ status, problems, value }`:
 *   - status 'ok': `value` is the message to use (a string, or a plural with
 *     an empty "zero" removed);
 *   - status 'untranslated': an empty translation, which is how Crowdin
 *     exports an untranslated string in nested JSON; use the source instead;
 *   - status 'invalid': at least one error; use the source instead.
 */
export function validateMessage(source, candidate) {
  const problems = [];
  const isSource = source === undefined;
  const fail = () => ({ status: 'invalid', problems, value: undefined });
  const kind = kindOf(candidate);

  if (kind === 'invalid') {
    problems.push(problem('error', 'invalid-type', 'un mensaje debe ser un texto o un plural ({ "one", "other" }), no un número, una lista, un booleano ni null'));
    return fail();
  }
  if (!isSource) {
    const sourceKind = kindOf(source);
    const expected = sourceKind === 'plural' ? 'un plural' : 'un texto simple';
    if (kind === 'string' && sourceKind !== 'string') {
      problems.push(problem('error', 'kind-mismatch', `el original es ${expected} y la traducción es un texto simple`));
      return fail();
    }
    if (kind !== 'string' && sourceKind !== 'plural') {
      problems.push(problem('error', 'kind-mismatch', `el original es ${expected} y la traducción es un objeto`));
      return fail();
    }
  }

  let value = candidate;
  if (kind === 'string') {
    if (isBlank(candidate)) {
      if (!isSource) return { status: 'untranslated', problems, value: undefined };
      problems.push(problem('error', 'empty', 'el texto está vacío'));
      return fail();
    }
    checkText(candidate, '', problems);
    if (!isSource) checkAgainstSource(candidate, source, [source], '', problems);
  } else {
    if (kind === 'group' && isSource) {
      // Only reachable when a caller hands a group to this function.
      problems.push(problem('error', 'invalid-type', 'un grupo de mensajes no es un mensaje'));
      return fail();
    }
    if (!checkPluralShape(candidate, problems)) return fail();
    const forms = Object.keys(candidate);
    const blank = forms.filter((form) => isBlank(candidate[form]));
    if (isSource) {
      if (blank.length > 0) {
        for (const form of blank) problems.push(problem('error', 'empty', `la forma "${form}" está vacía`));
        return fail();
      }
    } else {
      if (blank.length === forms.length) return { status: 'untranslated', problems, value: undefined };
      const missing = REQUIRED_PLURAL_FORMS.filter((form) => blank.includes(form));
      if (missing.length > 0) {
        problems.push(problem('warning', 'plural-incomplete', `plural a medio traducir (falta ${missing.map((form) => `"${form}"`).join(' y ')}); se usa el original hasta que esté completo`));
        return { status: 'untranslated', problems, value: undefined };
      }
    }
    // Rebuilt in canonical form order, without an empty optional "zero".
    value = {};
    for (const form of PLURAL_FORMS) {
      if (Object.hasOwn(candidate, form) && !isBlank(candidate[form])) value[form] = candidate[form];
    }
    const sourceTexts = isSource ? null : textsOf(source);
    for (const form of Object.keys(value)) {
      checkText(value[form], formLabel(form), problems);
      if (!isSource) {
        const sourceText = Object.hasOwn(source, form) ? source[form] : source.other;
        checkAgainstSource(value[form], sourceText, sourceTexts, formLabel(form), problems);
      }
    }
  }

  if (!isSource && kind !== 'string' && source.one.includes('{count}') && value.other.includes('{count}') && !value.one.includes('{count}')) {
    problems.push(problem('warning', 'plural-one-without-count', 'la forma "one" no lleva {count} y el original sí: "one" se usa solo cuando la cantidad es exactamente 1; compruébalo'));
  }

  if (!isSource) {
    const allowed = new Set(placeholdersOf(source));
    const invented = textsOf(value)
      .flatMap((text) => [...text.matchAll(PLACEHOLDER_RE)].map((match) => match[1]))
      .filter((name, index, all) => !allowed.has(name) && all.indexOf(name) === index);
    for (const name of invented) {
      const known = allowed.size > 0 ? [...allowed].map((item) => `{${item}}`).join(', ') : 'ninguno';
      problems.push(problem('error', 'placeholder-unknown', `usa el marcador {${name}}, que el original no tiene (admitidos: ${known})`));
    }
  }

  if (problems.some((item) => item.level === 'error')) return fail();
  return { status: 'ok', problems, value };
}

// ---------------------------------------------------------------------------
// Tree validation
// ---------------------------------------------------------------------------

function fileOf(locale, project, namespace) {
  return `locales/${locale}/${project}/${namespace}.json`;
}

function checkKeyName(key) {
  if (isReservedKey(key)) {
    return problem('error', 'key-forbidden', `la clave ${quote(key)} está prohibida: es un nombre que todo objeto de JavaScript ya tiene ("__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"…)`);
  }
  if (!KEY_PATTERN.test(key)) {
    return problem('error', 'key-invalid', `la clave ${quote(key)} no es válida (solo letras sin acento, cifras, "_" y "-"; sin puntos)`);
  }
  return null;
}

/** Walks a source namespace; fills `index` with its messages and groups. */
function walkSource(node, parts, index, report, depth) {
  for (const key of Object.keys(node)) {
    const full = [...parts, key].join('.');
    const bad = checkKeyName(key);
    if (bad) {
      report({ ...bad, key: full });
      index.invalid.add(full);
      continue;
    }
    const value = node[key];
    const kind = kindOf(value);
    if (kind === 'group') {
      if (Object.keys(value).length === 0) {
        report({ ...problem('error', 'empty-group', 'el grupo está vacío'), key: full });
        index.invalid.add(full);
      } else if (depth >= LIMITS.maxDepth) {
        report({ ...problem('error', 'too-deep', `demasiados niveles de anidamiento (máximo ${LIMITS.maxDepth})`), key: full });
        index.invalid.add(full);
      } else {
        index.groups.add(full);
        walkSource(value, [...parts, key], index, report, depth + 1);
      }
      continue;
    }
    const result = validateMessage(undefined, value);
    for (const item of result.problems) report({ ...item, key: full });
    if (result.status === 'ok') index.messages.set(full, result.value);
    else index.invalid.add(full);
  }
}

/** Walks a translated namespace guided by the source index. */
function walkTranslation(node, parts, index, accepted, report) {
  for (const key of Object.keys(node)) {
    const full = [...parts, key].join('.');
    const bad = checkKeyName(key);
    if (bad) {
      report({ ...bad, key: full });
      continue;
    }
    const value = node[key];
    if (index.messages.has(full)) {
      const result = validateMessage(index.messages.get(full), value);
      for (const item of result.problems) report({ ...item, key: full });
      if (result.status === 'ok') accepted.set(full, result.value);
    } else if (index.groups.has(full)) {
      if (isPlainObject(value)) walkTranslation(value, [...parts, key], index, accepted, report);
      else report({ ...problem('error', 'kind-mismatch', 'el original es un grupo de mensajes y la traducción no'), key: full });
    } else if (!index.invalid.has(full)) {
      report({ ...problem('error', 'unknown-key', 'la clave no existe en el idioma fuente'), key: full });
    }
  }
}

function checkLocaleMeta(meta, report) {
  if (!isPlainObject(meta)) {
    report(problem('error', 'locale-meta', 'locale.json debe ser un objeto { "name", "englishName" }'));
    return null;
  }
  let valid = true;
  for (const key of Object.keys(meta)) {
    if (key !== 'name' && key !== 'englishName') {
      report(problem('error', 'locale-meta', `locale.json tiene una clave desconocida ${quote(key)}; solo admite "name" y "englishName"`));
      valid = false;
    }
  }
  for (const key of ['name', 'englishName']) {
    const text = Object.hasOwn(meta, key) ? meta[key] : undefined;
    if (typeof text !== 'string' || isBlank(text)) {
      report(problem('error', 'locale-meta', `locale.json necesita "${key}" con un texto no vacío`));
      valid = false;
      continue;
    }
    const problems = [];
    checkText(text, `"${key}" `, problems);
    if (foreignAddresses(text, []).length > 0) problems.push(problem('error', 'url', `"${key}" contiene una dirección o un número`));
    if (text.includes('\n')) problems.push(problem('error', 'control-character', `"${key}" contiene un salto de línea`));
    if (text.length > LIMITS.maxLocaleNameLength) {
      problems.push(problem('error', 'too-long', `"${key}" mide ${text.length} caracteres; el máximo es ${LIMITS.maxLocaleNameLength}`));
    }
    for (const item of problems) {
      report(item);
      if (item.level === 'error') valid = false;
    }
  }
  return valid ? { name: meta.name, englishName: meta.englishName } : null;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Validates a whole tree (as returned by `loadLocalesTree`, or built in
 * memory with the same shape: `{ sourceLocale, projects, locales: { <code>:
 * { meta, projects: { <project>: { <namespace>: <parsed json> } } } } }`).
 *
 * Returns:
 *   ok            no errors
 *   errors        [{ level, code, message, locale?, project?, namespace?, key?, file? }]
 *   warnings      same shape
 *   sourceLocale, projects
 *   locales       [{ code, name, englishName, published, completeness: { <project>: { translated, total, ratio } } }]
 *                 `published` is whether the API offers the language: it has a
 *                 valid locale.json and, unless it is the source, at least one
 *                 valid text of the app
 *   messages      Map<locale, Map<project, Map<fullKey, string | plural>>> with
 *                 the messages that passed; invalid and untranslated ones are
 *                 simply absent, so the caller falls back to the source
 */
export function validateTree(tree) {
  const sourceLocale = tree.sourceLocale ?? DEFAULT_SOURCE_LOCALE;
  const projects = [...(tree.projects ?? DEFAULT_PROJECTS)];
  const locales = tree.locales ?? {};
  const errors = [];
  const warnings = [];
  const add = (item) => (item.level === 'error' ? errors : warnings).push(item);
  for (const item of tree.problems ?? []) add(item);

  const codes = Object.keys(locales).sort(compareText);
  const messages = new Map();
  const sourceIndex = new Map();

  if (!Object.hasOwn(locales, sourceLocale)) {
    add({ ...problem('error', 'source-missing', `no existe el idioma fuente (locales/${sourceLocale})`), locale: sourceLocale });
  }

  // The source goes first: every other locale is checked against it.
  const sourceProjects = Object.hasOwn(locales, sourceLocale) ? (locales[sourceLocale].projects ?? {}) : {};
  messages.set(sourceLocale, new Map());
  for (const project of projects) {
    const index = { messages: new Map(), groups: new Set(), invalid: new Set(), namespaces: new Set() };
    sourceIndex.set(project, index);
    const namespaces = Object.hasOwn(sourceProjects, project) ? sourceProjects[project] : {};
    for (const namespace of Object.keys(namespaces)) {
      const where = { locale: sourceLocale, project, namespace, file: fileOf(sourceLocale, project, namespace) };
      const root = namespaces[namespace];
      if (!isPlainObject(root)) {
        add({ ...problem('error', 'namespace-not-object', 'el fichero debe contener un objeto JSON'), ...where });
        continue;
      }
      index.namespaces.add(namespace);
      walkSource(root, [namespace], index, (item) => add({ ...item, ...where }), 1);
    }
    messages.get(sourceLocale).set(project, new Map(index.messages));
    if (index.messages.size === 0 && Object.hasOwn(locales, sourceLocale)) {
      add({ ...problem('warning', 'project-empty', `el proyecto "${project}" no tiene ningún texto en el idioma fuente`), locale: sourceLocale, project });
    }
  }

  const summary = [];
  for (const code of codes) {
    const locale = locales[code];
    if (!LOCALE_PATTERN.test(code)) {
      add({ ...problem('error', 'locale-name', `"${code}" no es un código de idioma válido (ejemplos: "en", "pt-BR")`), locale: code });
      continue;
    }
    const metaWhere = { locale: code, file: `locales/${code}/locale.json` };
    let meta = null;
    let unpublished = false;
    if (locale.meta === undefined || locale.meta === null) {
      // A file that exists but could not be read was already reported.
      if (!locale.metaUnreadable) {
        if (code === sourceLocale) {
          add({ ...problem('error', 'locale-meta', 'falta locale.json ({ "name", "englishName" }) en el idioma fuente'), ...metaWhere });
        } else {
          // The publish switch: Crowdin never writes this file, a person does.
          unpublished = true;
          add({ ...problem('warning', 'locale-unpublished', 'idioma sin publicar: no tiene locale.json ({ "name", "englishName" }). Sus textos se validan, pero ni la API ni la aplicación lo ofrecen hasta que una persona del equipo añada ese fichero'), ...metaWhere });
        }
      }
    } else {
      meta = checkLocaleMeta(locale.meta, (item) => add({ ...item, ...metaWhere }));
    }

    const completeness = {};
    if (code !== sourceLocale) messages.set(code, new Map());
    for (const project of projects) {
      const index = sourceIndex.get(project);
      const total = index.messages.size;
      if (code !== sourceLocale) {
        const accepted = new Map();
        const namespaces = Object.hasOwn(locale.projects ?? {}, project) ? locale.projects[project] : {};
        for (const namespace of Object.keys(namespaces)) {
          const where = { locale: code, project, namespace, file: fileOf(code, project, namespace) };
          const root = namespaces[namespace];
          if (!index.namespaces.has(namespace)) {
            add({ ...problem('error', 'unknown-namespace', `el fichero no existe en el idioma fuente (${fileOf(sourceLocale, project, namespace)})`), ...where });
            continue;
          }
          if (!isPlainObject(root)) {
            add({ ...problem('error', 'namespace-not-object', 'el fichero debe contener un objeto JSON'), ...where });
            continue;
          }
          walkTranslation(root, [namespace], index, accepted, (item) => add({ ...item, ...where }));
        }
        // Stored in source order, whatever the order of the translated file.
        const ordered = new Map();
        for (const key of index.messages.keys()) if (accepted.has(key)) ordered.set(key, accepted.get(key));
        messages.get(code).set(project, ordered);
      }
      const translated = messages.get(code).get(project).size;
      completeness[project] = { translated, total, ratio: total === 0 ? 1 : translated / total };
    }
    // What the API offers: the source, and every language with a name and at least one text of the app.
    const gauge = completeness.app ?? Object.values(completeness)[0];
    const hasTexts = code === sourceLocale || (gauge !== undefined && gauge.translated > 0);
    if (meta && !hasTexts) {
      add({ ...problem('warning', 'locale-empty', 'idioma sin publicar: todavía no tiene ningún texto traducido y válido de la aplicación; aparecerá en el selector cuando tenga el primero'), locale: code });
    }
    summary.push({ code, name: meta?.name ?? null, englishName: meta?.englishName ?? null, published: Boolean(meta) && hasTexts && !unpublished, completeness });
  }

  return { ok: errors.length === 0, errors, warnings, sourceLocale, projects, locales: summary, messages };
}

/** `{ <locale>: { <project>: { translated, total, ratio } } }` for a tree. */
export function computeCompleteness(tree) {
  const result = Object.create(null);
  for (const locale of validateTree(tree).locales) result[locale.code] = locale.completeness;
  return result;
}

// ---------------------------------------------------------------------------
// Reading a tree from a directory
// ---------------------------------------------------------------------------

function readJsonFile(absolute, relative, report, { canonical }) {
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return { found: false };
  }
  if (!stat.isFile()) {
    report(problem('error', 'unexpected-entry', `${relative} debe ser un fichero normal (no un enlace ni una carpeta)`), relative);
    return { found: true };
  }
  if (stat.size > LIMITS.maxFileBytes) {
    report(problem('error', 'file-too-large', `el fichero ocupa ${stat.size} bytes; el máximo es ${LIMITS.maxFileBytes}`), relative);
    return { found: true };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(absolute));
  } catch {
    report(problem('error', 'invalid-encoding', 'el fichero no es UTF-8 válido'), relative);
    return { found: true };
  }
  if (text.charCodeAt(0) === 0xfeff) {
    report(problem('error', 'invalid-encoding', 'el fichero empieza con una marca BOM; guárdalo como UTF-8 sin BOM'), relative);
    return { found: true };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    report(problem('error', 'invalid-json', `JSON no válido: ${error.message}`), relative);
    return { found: true };
  }
  const duplicates = findDuplicateKeys(text);
  if (duplicates.length > 0) {
    report(problem('error', 'duplicate-key', `claves repetidas en un mismo objeto: ${[...new Set(duplicates)].map(quote).join(', ')}`), relative);
    return { found: true };
  }
  if (canonical !== 'off' && serialize(value) !== text) {
    report(
      problem(
        canonical,
        'format',
        'el fichero no está en el formato canónico (sangría de 2 espacios, salto de línea final, sin escapar caracteres no ASCII)',
      ),
      relative,
    );
  }
  return { found: true, value };
}

function listDirectory(absolute) {
  return fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name));
}

/**
 * Reads `<root>/i18n.config.json` and `<root>/locales/**` into a tree for
 * `validateTree`. Nothing here throws for a problem in the content: every
 * problem found while reading is collected in `tree.problems`.
 *
 * Options: `sourceLocale` and `projects` override the config file (useful for
 * a bundled snapshot that only carries `locales/`).
 */
export function loadLocalesTree(rootDirectory, options = {}) {
  const root = path.resolve(rootDirectory);
  const problems = [];
  const report = (item, file, extra = {}) => problems.push({ ...item, ...extra, ...(file ? { file } : {}) });
  const tree = {
    root,
    formatVersion: FORMAT_VERSION,
    sourceLocale: options.sourceLocale ?? DEFAULT_SOURCE_LOCALE,
    projects: [...(options.projects ?? DEFAULT_PROJECTS)],
    configFound: false,
    locales: Object.create(null),
    problems,
  };

  const config = readJsonFile(path.join(root, 'i18n.config.json'), 'i18n.config.json', report, { canonical: 'error' });
  tree.configFound = config.found;
  if (!config.found) {
    if (!options.sourceLocale && !options.projects) {
      report(problem('warning', 'config-missing', `no hay i18n.config.json; se asume idioma fuente "${tree.sourceLocale}" y proyectos ${tree.projects.join(', ')}`), 'i18n.config.json');
    }
  } else if (config.value !== undefined) {
    const value = config.value;
    const bad = (message) => report(problem('error', 'config-invalid', message), 'i18n.config.json');
    if (!isPlainObject(value)) bad('i18n.config.json debe ser un objeto');
    else {
      if (value.formatVersion !== FORMAT_VERSION) bad(`"formatVersion" debe ser ${FORMAT_VERSION}`);
      if (typeof value.sourceLocale !== 'string' || !LOCALE_PATTERN.test(value.sourceLocale)) bad('"sourceLocale" debe ser un código de idioma válido');
      else if (!options.sourceLocale) tree.sourceLocale = value.sourceLocale;
      const names = isPlainObject(value.projects) ? Object.keys(value.projects) : [];
      if (names.length === 0) bad('"projects" debe ser un objeto con al menos un proyecto');
      else if (names.some((name) => !PROJECT_PATTERN.test(name) || !isPlainObject(value.projects[name]))) {
        bad('cada proyecto de "projects" necesita un nombre en minúsculas y un objeto como valor');
      } else if (!options.projects) tree.projects = names;
    }
  }

  const localesDirectory = path.join(root, 'locales');
  let localeEntries;
  try {
    localeEntries = listDirectory(localesDirectory);
  } catch {
    report(problem('error', 'locales-missing', 'no existe la carpeta locales/'), 'locales');
    return tree;
  }

  for (const entry of localeEntries) {
    const localePath = `locales/${entry.name}`;
    if (!entry.isDirectory()) {
      report(problem('error', 'unexpected-entry', 'en locales/ solo puede haber una carpeta por idioma'), localePath);
      continue;
    }
    if (!LOCALE_PATTERN.test(entry.name)) {
      report(problem('error', 'locale-name', `"${entry.name}" no es un nombre de carpeta de idioma válido (minúsculas, región opcional en mayúsculas: "en", "pt-BR")`), localePath);
      continue;
    }
    const code = entry.name;
    const locale = { meta: null, metaUnreadable: false, projects: Object.create(null) };
    tree.locales[code] = locale;
    const isSource = code === tree.sourceLocale;
    // Crowdin writes the translated files: one line per language, not one per file.
    const offFormat = [];
    const reportIn = (item, file, extra = {}) => {
      if (item.code === 'format' && item.level === 'warning') offFormat.push(file);
      else report(item, file, { locale: code, ...extra });
    };

    for (const child of listDirectory(path.join(localesDirectory, code))) {
      const childPath = `${localePath}/${child.name}`;
      if (child.name === 'locale.json') {
        const meta = readJsonFile(path.join(localesDirectory, code, child.name), childPath, reportIn, { canonical: 'error' });
        if (meta.value === undefined) locale.metaUnreadable = true;
        else locale.meta = meta.value;
        continue;
      }
      if (!child.isDirectory() || !tree.projects.includes(child.name)) {
        reportIn(problem('error', 'unexpected-entry', `entrada desconocida; en la carpeta de un idioma solo caben locale.json y las carpetas ${tree.projects.join(', ')}`), childPath);
        continue;
      }
      const project = child.name;
      const namespaces = Object.create(null);
      locale.projects[project] = namespaces;
      for (const file of listDirectory(path.join(localesDirectory, code, project))) {
        const filePath = `${childPath}/${file.name}`;
        const namespace = file.name.endsWith('.json') ? file.name.slice(0, -'.json'.length) : '';
        if (!NAMESPACE_PATTERN.test(namespace) || isReservedKey(namespace)) {
          reportIn(problem('error', 'unexpected-entry', 'entrada desconocida; aquí solo caben ficheros <espacio>.json (letras, cifras, "_" y "-")'), filePath, { project });
          continue;
        }
        const loaded = readJsonFile(path.join(localesDirectory, code, project, file.name), filePath, (item, where) => reportIn(item, where, { project, namespace }), {
          canonical: isSource ? 'error' : 'warning',
        });
        if (loaded.value !== undefined) namespaces[namespace] = loaded.value;
        else if (isSource) {
          // Keeps translations of an unreadable source file from being
          // reported one by one as "unknown namespace".
          (tree.unreadableSources ??= []).push(`${project}/${namespace}`);
        }
      }
    }
    if (offFormat.length > 0) {
      const count = offFormat.length === 1 ? '1 fichero no está' : `${offFormat.length} ficheros no están`;
      report(
        problem('warning', 'format', `${count} en el formato canónico (sangría de 2 espacios, salto de línea final, sin escapar caracteres no ASCII). Es inocuo: se leen igual`),
        localePath,
        { locale: code, files: offFormat },
      );
    }
  }
  return tree;
}

/** Loads and validates a directory in one call. */
export function validateDirectory(rootDirectory, options = {}) {
  const tree = loadLocalesTree(rootDirectory, options);
  const result = validateTree(tree);
  const unreadable = new Set(tree.unreadableSources ?? []);
  if (unreadable.size > 0) {
    result.errors = result.errors.filter((item) => item.code !== 'unknown-namespace' || !unreadable.has(`${item.project}/${item.namespace}`));
    result.ok = result.errors.length === 0;
  }
  return { root: tree.root, formatVersion: tree.formatVersion, ...result };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function formatRatio({ translated, total, ratio }) {
  const percent = (Math.floor(ratio * 1000) / 10).toFixed(1).replace('.', ',');
  return `${percent} % (${translated}/${total})`;
}

function formatProblem(item) {
  const where = [item.file, item.key].filter(Boolean).join(' · ');
  return `  - ${where ? `${where}: ` : ''}${item.message} [${item.code}]`;
}

/** The Spanish report the CLI prints. */
export function formatReport(result) {
  const lines = [];
  lines.push(`Validación de traducciones: ${result.root ?? '(árbol en memoria)'}`);
  lines.push(`Idioma fuente: ${result.sourceLocale} · proyectos: ${result.projects.join(', ')} · idiomas: ${result.locales.map((locale) => locale.code).join(', ') || 'ninguno'}`);
  lines.push('');
  if (result.errors.length > 0) {
    lines.push(`Errores (${result.errors.length}):`);
    for (const item of result.errors) lines.push(formatProblem(item));
    lines.push('');
  }
  if (result.warnings.length > 0) {
    lines.push(`Avisos (${result.warnings.length}):`);
    for (const item of result.warnings) lines.push(formatProblem(item));
    lines.push('');
  }
  const header = ['Idioma', 'Nombre', ...result.projects];
  const rows = result.locales.map((locale) => [
    locale.code + (locale.code === result.sourceLocale ? ' (fuente)' : locale.published === false ? ' (sin publicar)' : ''),
    locale.name ?? '?',
    ...result.projects.map((project) => formatRatio(locale.completeness[project])),
  ]);
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  const line = (cells) => `  ${cells.map((cell, column) => cell.padEnd(widths[column])).join('  ')}`.trimEnd();
  lines.push('Completitud (mensajes traducidos y válidos / mensajes del idioma fuente):');
  lines.push(line(header));
  lines.push(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) lines.push(line(row));
  lines.push('');
  lines.push(
    result.ok
      ? `Resultado: correcto (${result.warnings.length} ${result.warnings.length === 1 ? 'aviso' : 'avisos'}).`
      : `Resultado: ${result.errors.length} ${result.errors.length === 1 ? 'error' : 'errores'}. Las traducciones NO son válidas.`,
  );
  return `${lines.join('\n')}\n`;
}

const USAGE = `Uso: node scripts/validate.mjs [carpeta] [--json]

  carpeta   raíz del repositorio de traducciones (donde están i18n.config.json
            y locales/). Por defecto, la carpeta actual.
  --json    salida para máquinas (JSON) en lugar del informe en español.
  --help    muestra esta ayuda.

Código de salida: 0 sin errores, 1 con errores, 2 si el uso es incorrecto.
`;

export function main(argv, stdout = process.stdout, stderr = process.stderr) {
  let directory;
  let json = false;
  for (const argument of argv) {
    if (argument === '--json') json = true;
    else if (argument === '--help' || argument === '-h') {
      stdout.write(USAGE);
      return 0;
    } else if (argument.startsWith('-') || directory !== undefined) {
      stderr.write(`Argumento no reconocido: ${argument}\n\n${USAGE}`);
      return 2;
    } else directory = argument;
  }
  const root = path.resolve(directory ?? '.');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    stderr.write(`No existe la carpeta ${root}\n`);
    return 2;
  }
  const { messages: _messages, ...result } = validateDirectory(root);
  stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatReport(result));
  return result.ok ? 0 : 1;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = main(process.argv.slice(2));
