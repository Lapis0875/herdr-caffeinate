// Language-neutral countdown labels (node T1, F5): m:ss under an hour, h:mm:ss from an hour, rounded up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRemaining, formatUntil, remainingMs } from '../mods/herdr-caffeinate/core/format.js';

const T0 = 1763568000000;

test('formatRemaining: m:ss under an hour, h:mm:ss from an hour, rounded up like a countdown', () => {
  const cases = [
    [0, '0:00'], [1, '0:01'], [999, '0:01'], [1000, '0:01'], [1001, '0:02'], [59000, '0:59'], [60000, '1:00'],
    [61000, '1:01'], [119000, '1:59'], [120000, '2:00'], [3599000, '59:59'], [3599001, '1:00:00'], [3600000, '1:00:00'],
    [3601000, '1:00:01'], [3660000, '1:01:00'], [5400000, '1:30:00'], [7199000, '1:59:59'], [86400000, '24:00:00'],
    [-5000, '0:00'],
  ];
  for (const [ms, label] of cases) assert.equal(formatRemaining(ms), label, String(ms));
  for (const bad of [NaN, Infinity, null, undefined, '60000']) assert.equal(formatRemaining(bad), '', String(bad));
});

test('a minute and an hour left never read the same', () => {
  assert.equal(formatRemaining(60000), '1:00');
  assert.equal(formatRemaining(3600000), '1:00:00');
  assert.notEqual(formatRemaining(60000), formatRemaining(3600000));
  // No label under an hour has the h:mm:ss shape, none from an hour has the m:ss shape.
  for (let ms = 0; ms < 3600000; ms += 7001) assert.match(formatRemaining(ms), /^\d{1,2}:\d{2}$/, String(ms));
  for (let ms = 3600000; ms <= 86400000; ms += 600013) assert.match(formatRemaining(ms), /^\d{1,2}:\d{2}:\d{2}$/, String(ms));
});

test('a 2-minute timer reads between 1:00 and 2:00 after it starts (AT-04)', () => {
  for (let ms = 60001; ms <= 120000; ms += 997) assert.match(formatRemaining(ms), /^(1:[0-5]\d|2:00)$/, String(ms));
});

test('remainingMs and formatUntil count down to endsAt and never below zero', () => {
  assert.equal(remainingMs(T0 + 1000, T0), 1000);
  assert.equal(remainingMs(T0, T0 + 5), 0);
  assert.equal(remainingMs(null, T0), null);
  assert.equal(remainingMs(T0, undefined), null);
  assert.equal(formatUntil(T0 + 90000, T0), '1:30');
  assert.equal(formatUntil(T0 + 24 * 3600000, T0), '24:00:00');
  assert.equal(formatUntil(T0, T0 + 1), '0:00');
  assert.equal(formatUntil(null, T0), '');
});
