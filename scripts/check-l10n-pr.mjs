#!/usr/bin/env node
/**
 * Guard for the pull requests Crowdin opens (branches `l10n_*`).
 *
 * A translation pull request may only add or change translated texts:
 * `locales/<language>/<project>/<namespace>.json` of a language that is not
 * the source. Anything else — the source language, a `locale.json`, the
 * validator, the workflow, `crowdin.yml` — is not Crowdin's to touch, and is
 * exactly what a compromised Crowdin account or a wrong language mapping
 * (a regional Spanish written over `locales/es`) would touch.
 *
 * Usage: the changed paths, one per line or NUL-separated, on standard input.
 *
 *   git diff --name-only --no-renames -z HEAD^1 HEAD | node scripts/check-l10n-pr.mjs
 *
 * Exit code 0 when every path is allowed, 1 otherwise, 2 on a usage error.
 * Dependency-free, Node >= 22. Output in Spanish; no file content is read
 * other than i18n.config.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PROJECTS, DEFAULT_SOURCE_LOCALE, LOCALE_PATTERN, NAMESPACE_PATTERN, isReservedKey } from './validate.mjs';

/** The paths of `changed` a translation pull request must not touch. */
export function forbiddenPaths(changed, { sourceLocale = DEFAULT_SOURCE_LOCALE, projects = DEFAULT_PROJECTS } = {}) {
  return changed.filter((file) => {
    const parts = file.split('/');
    if (parts.length !== 4 || parts[0] !== 'locales') return true;
    const [, locale, project, name] = parts;
    if (!LOCALE_PATTERN.test(locale) || locale === sourceLocale) return true;
    if (!projects.includes(project)) return true;
    if (!name.endsWith('.json')) return true;
    const namespace = name.slice(0, -'.json'.length);
    return !NAMESPACE_PATTERN.test(namespace) || isReservedKey(namespace);
  });
}

export function parsePaths(input) {
  return input
    .split(/[\0\n]/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '');
}

function readConfig(root) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'i18n.config.json'), 'utf8'));
    if (typeof config.sourceLocale === 'string' && config.projects && typeof config.projects === 'object') {
      return { sourceLocale: config.sourceLocale, projects: Object.keys(config.projects) };
    }
  } catch {
    // The defaults are the strictest reading there is.
  }
  return {};
}

export function main(input, root, stdout = process.stdout) {
  const changed = parsePaths(input);
  const forbidden = forbiddenPaths(changed, readConfig(root));
  if (forbidden.length === 0) {
    stdout.write(`Petición de traducciones: ${changed.length} ${changed.length === 1 ? 'fichero cambiado' : 'ficheros cambiados'}, todos de idiomas traducidos.\n`);
    return 0;
  }
  stdout.write('Esta petición de cambios viene de la rama de Crowdin y toca ficheros que una petición de traducciones no puede tocar:\n');
  for (const file of forbidden) stdout.write(`  - ${file}\n`);
  stdout.write(
    '\nSolo se admiten locales/<idioma>/<proyecto>/<espacio>.json de idiomas que no sean la fuente.\n' +
      'Si aparece la carpeta del idioma fuente, lo más probable es que se haya añadido en Crowdin una variante regional\n' +
      'sin declararla antes en crowdin.yml (README.md, «Idiomas con región»). NO fusiones esta petición.\n',
  );
  return 1;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  if (process.argv.length > 2) {
    process.stderr.write('Uso: git diff --name-only --no-renames -z <base> <cabeza> | node scripts/check-l10n-pr.mjs\n');
    process.exitCode = 2;
  } else {
    process.exitCode = main(fs.readFileSync(0, 'utf8'), path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  }
}
