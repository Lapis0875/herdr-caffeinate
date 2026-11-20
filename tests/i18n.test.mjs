// UI text (core/i18n.js, core/catalog/): ko and en catalogs carry the same keys and placeholders,
// the C2 `language` setting resolves "system" from the injected system locale like lazuli, and
// lookups fall back ko → en → key.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AREAS, catalogs, fragments} from '../mods/herdr-caffeinate/core/catalog/index.js';
import {
  format,
  language,
  onLanguageChange,
  parseAppleLanguages,
  placeholders,
  resolveLanguage,
  setLanguage,
  t,
  translate,
} from '../mods/herdr-caffeinate/core/i18n.js';

test('every area has the same nonempty keys and placeholders in ko and en', () => {
  for (const area of AREAS) {
    const {en, ko} = fragments[area];
    assert.deepEqual(Object.keys(ko).sort(), Object.keys(en).sort(), area);
    for (const key of Object.keys(en)) {
      assert.ok(key.startsWith(`${area}.`), `${key} starts with ${area}.`);
      assert.ok(typeof en[key] === 'string' && en[key].trim() !== '', `en ${key}`);
      assert.ok(typeof ko[key] === 'string' && ko[key].trim() !== '', `ko ${key}`);
      assert.deepEqual(placeholders(ko[key]), placeholders(en[key]), key);
    }
  }
});

test('the merged tables hold every fragment key exactly once', () => {
  for (const lang of ['en', 'ko']) {
    const total = AREAS.reduce((n, area) => n + Object.keys(fragments[area][lang]).length, 0);
    assert.equal(Object.keys(catalogs[lang]).length, total, lang);
  }
  assert.deepEqual(Object.keys(fragments).sort(), [...AREAS].sort());
});

test('every contract value the views show has a text', () => {
  const keys = [
    ...['off', 'on', 'agent', 'timer'].map((m) => `mode.${m}`),
    ...['off', 'engaged', 'blocked', 'unavailable', 'external'].map((s) => `lid.status.${s}`),
    ...['ac', 'battery', 'thermal', 'unknown', 'other-instance', 'external', 'unavailable'].map((r) => `lid.block.${r}`),
    'toast.reengaged',
    'toast.override',
    'toast.external',
    'install.state.installed',
    'install.state.missing',
    'install.install',
    'install.uninstall',
    'timer.remaining',
    'error.timer.range',
  ];
  for (const key of keys) {
    assert.ok(catalogs.en[key], `en ${key}`);
    assert.ok(catalogs.ko[key], `ko ${key}`);
  }
});

test('lookup falls back ko → en → key and fills placeholders', () => {
  const table = {ko: {a: '안녕 {name}', b: ''}, en: {a: 'Hello {name}', b: 'English', c: 'Only English'}};
  assert.equal(translate('ko', 'a', {name: 'Kim'}, table), '안녕 Kim');
  assert.equal(translate('ko', 'b', {}, table), 'English');
  assert.equal(translate('ko', 'c', undefined, table), 'Only English');
  assert.equal(translate('ko', 'missing', {}, table), 'missing');
  assert.equal(translate('en', 'missing.key', undefined, table), 'missing.key');
  assert.equal(translate('en', 'a', {name: 'Kim'}, table), 'Hello Kim');
  assert.equal(translate('fr', 'a', {name: 'Kim'}, table), 'Hello Kim');
  assert.equal(format('{time} left', {}), '{time} left');
  assert.equal(format('{a}/{b}', {a: 1}), '1/{b}');
  assert.deepEqual(placeholders('{b} {a} {b}'), ['a', 'b']);
});

test('"system" resolves from the injected system locale; ko and en override it', () => {
  const korean = '(\n    "ko-KR",\n    en\n)';
  const english = '(\n    "en-US",\n    "ko-KR"\n)';
  assert.deepEqual(parseAppleLanguages(korean), ['ko-KR', 'en']);
  assert.equal(resolveLanguage('system', korean), 'ko');
  assert.equal(resolveLanguage('system', english), 'en');
  assert.equal(resolveLanguage('system', '(en, ko)'), 'en');
  assert.equal(resolveLanguage('system', 'ko_KR\n'), 'ko');
  assert.equal(resolveLanguage('system', 'ko'), 'ko');
  assert.equal(resolveLanguage('system', 'kok-IN'), 'en');
  assert.equal(resolveLanguage('system', ''), 'en');
  assert.equal(resolveLanguage('system', null), 'en');
  assert.equal(resolveLanguage('system', undefined), 'en');
  assert.equal(resolveLanguage('ko', english), 'ko');
  assert.equal(resolveLanguage('en', korean), 'en');
  assert.equal(resolveLanguage('fr', korean), 'ko');
  assert.equal(resolveLanguage(undefined, english), 'en');
});

test('setLanguage switches t and notifies listeners once per change', () => {
  const seen = [];
  const stop = onLanguageChange((lang) => seen.push(lang));
  try {
    assert.equal(language(), 'en');
    assert.equal(t('mode.on'), catalogs.en['mode.on']);
    assert.equal(setLanguage('ko'), true);
    assert.equal(setLanguage('ko'), false);
    assert.equal(language(), 'ko');
    assert.equal(t('mode.on'), catalogs.ko['mode.on']);
    assert.equal(t('timer.remaining', {time: '1:30'}), '1:30 남음');
    assert.equal(t('no.such.key'), 'no.such.key');
    assert.equal(setLanguage('fr'), true);
    assert.equal(language(), 'en');
    assert.equal(t('timer.remaining', {time: '1:30'}), '1:30 left');
    assert.deepEqual(seen, ['ko', 'en']);
  } finally {
    stop();
    setLanguage('en');
  }
});
