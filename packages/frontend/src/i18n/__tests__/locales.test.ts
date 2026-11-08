/**
 * Guards the translation files against drift. A key missing from one language
 * renders as its raw key there (en is also the fallback, so nothing rescues it),
 * and a key the code reads but neither file defines renders raw everywhere.
 */
import { describe, it, expect } from 'vitest';
import { load } from 'js-yaml';
// Vite raw imports, same as i18n/index.ts — the frontend tsconfig has no Node types.
import jaYaml from '../../locales/ja.yaml?raw';
import enYaml from '../../locales/en.yaml?raw';
import backendDefaultAgents from '../../../../backend/src/config/data/default-agents.ts?raw';

const SOURCES = import.meta.glob<string>(
  ['../../**/*.{ts,tsx}', '!../../**/__tests__/**', '!../../**/*.{test,spec}.{ts,tsx}'],
  { query: '?raw', import: 'default', eager: true }
);

type Tree = { [key: string]: Tree | string | string[] };
const flatten = (tree: Tree, prefix = '', out: Record<string, string> = {}) => {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    // Arrays (read with returnObjects) are one value, not nested keys.
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? v.join('\n') : String(v);
  }
  return out;
};
const ja = flatten(load(jaYaml) as Tree);
const en = flatten(load(enYaml) as Tree);

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const baseKey = (k: string) => k.replace(PLURAL_SUFFIX, '');
const baseKeys = (dict: Record<string, string>) => new Set(Object.keys(dict).map(baseKey));
/** A base key resolves if it exists as-is or in any plural form. */
const resolves = (dict: Record<string, string>, key: string) =>
  key in dict || Object.keys(dict).some((k) => baseKey(k) === key && k !== key);

const variables = (dict: Record<string, string>, base: string) =>
  new Set(
    Object.entries(dict)
      .filter(([k]) => baseKey(k) === base)
      .flatMap(([, v]) => [...v.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]))
  );

describe('locale files', () => {
  it('define the same keys in ja and en (plural forms aside)', () => {
    const jaKeys = baseKeys(ja);
    const enKeys = baseKeys(en);
    expect(
      [...jaKeys].filter((k) => !enKeys.has(k)),
      'missing in en.yaml'
    ).toEqual([]);
    expect(
      [...enKeys].filter((k) => !jaKeys.has(k)),
      'missing in ja.yaml'
    ).toEqual([]);
  });

  it('use the same interpolation variables in both languages', () => {
    const mismatched = [...baseKeys(ja)]
      .filter((k) => baseKeys(en).has(k))
      .filter((k) => {
        const a = variables(ja, k);
        const b = variables(en, k);
        return a.size !== b.size || [...a].some((v) => !b.has(v));
      });
    expect(mismatched).toEqual([]);
  });

  it('give every English plural key an _other form', () => {
    const plural = Object.keys(en).filter((k) => PLURAL_SUFFIX.test(k));
    const missingOther = [...new Set(plural.map(baseKey))].filter((b) => !(`${b}_other` in en));
    expect(missingOther).toEqual([]);
  });

  it('have no empty values', () => {
    const empty = [...Object.entries(ja), ...Object.entries(en)]
      .filter(([, v]) => v.trim() === '')
      .map(([k]) => k);
    expect(empty).toEqual([]);
  });
});

describe('keys referenced from code', () => {
  // Static t('a.b') / i18n.t("a.b") calls; template-literal keys are dynamic and skipped.
  const T_CALL = /\b(?:i18n\.)?t\(\s*['"]([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)['"]/g;

  const referenced = Object.entries(SOURCES).flatMap(([file, code]) =>
    [...code.matchAll(T_CALL)].map((m) => ({ key: m[1], at: file.replace('../../', '') }))
  );

  it('finds call sites (sanity check for the scanner)', () => {
    expect(referenced.length).toBeGreaterThan(100);
  });

  it.each(['ja', 'en'] as const)('all exist in %s.yaml', (lng) => {
    const dict = lng === 'ja' ? ja : en;
    const missing = referenced
      .filter((r) => !resolves(dict, r.key))
      .map((r) => `${r.key} (${r.at})`);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('include the default agent keys the backend seeds', () => {
    const keys = [...backendDefaultAgents.matchAll(/'(defaultAgents\.[\w.]+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    const missing = keys.filter((k) => !resolves(ja, k) || !resolves(en, k));
    expect(missing).toEqual([]);
  });
});
