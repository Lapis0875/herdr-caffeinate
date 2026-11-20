// C5 probe: core/probe-parse.js against fixtures (real S4 captures and synthetic cases),
// plus static and live checks of bin/probe.sh.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {parseProbe, parseWaketime, secondsSinceWake} from '../mods/herdr-caffeinate/core/probe-parse.js';

const fixture = (name) => readFile(new URL(`./fixtures/probe/${name}`, import.meta.url), 'utf8');
const script = fileURLToPath(new URL('../mods/herdr-caffeinate/bin/probe.sh', import.meta.url));

const NONE = Object.freeze({
  ac: null, percent: null, sleepDisabled: null, lidClosed: null, lidCausesSleep: null,
  thermal: null, failsafeAliveAge: null, claimAge: null, lastRestore: null, now: null,
});
const facts = (fields) => ({...NONE, ...fields});

// The S4 capture: on AC, charged, lid open, SleepDisabled 0, fail-safe not installed.
const S4 = facts({
  ac: true, percent: 100, sleepDisabled: false, lidClosed: false, lidCausesSleep: true, now: 1795106918,
});

test('S4 capture keeps its literal tabs', async () => {
  const text = await fixture('s4-ac-thermal.txt');
  assert.match(text, /^ -InternalBattery-0 \(id=23724131\)\t100%; charged; 0:00 remaining present: true$/m);
  assert.match(text, /^ SleepDisabled\t\t0$/m);
  assert.match(text, /^ {6}"AppleClamshellCausesSleep" = Yes\n {6}"AppleClamshellState" = No$/m);
});

test('S4 capture with --thermal parses every fact', async () => {
  assert.deepEqual(parseProbe(await fixture('s4-ac-thermal.txt')), {...S4, thermal: 0});
});

test('S4 capture without --thermal has thermal null', async () => {
  assert.deepEqual(parseProbe(await fixture('s4-ac.txt')), S4);
});

test('empty thermal section is null', async () => {
  assert.deepEqual(parseProbe(await fixture('empty-thermal.txt')), S4);
});

test('missing SleepDisabled line is null, other facts still parse', async () => {
  assert.deepEqual(parseProbe(await fixture('missing-sleepdisabled.txt')), {...S4, sleepDisabled: null});
});

test('battery power below the floor: ac false, percent 19, fail-safe age', async () => {
  assert.deepEqual(parseProbe(await fixture('battery-discharging.txt')), facts({
    ac: false, percent: 19, sleepDisabled: false, lidClosed: false, lidCausesSleep: true,
    failsafeAliveAge: 10, now: 1795107000,
  }));
});

test('battery power with no estimate still reads the percent', async () => {
  assert.deepEqual(parseProbe(await fixture('battery-no-estimate.txt')), facts({
    ac: false, percent: 64, sleepDisabled: false, lidClosed: false, lidCausesSleep: true, thermal: 1,
    now: 1795107000,
  }));
});

test('SleepDisabled 1, clamshell Yes and causing sleep, claim and restore stamps', async () => {
  assert.deepEqual(parseProbe(await fixture('engaged-lid-closed.txt')), {
    ac: true, percent: 85, sleepDisabled: true, lidClosed: true, lidCausesSleep: true, thermal: 2,
    failsafeAliveAge: 10, claimAge: 5, lastRestore: 1795094890, now: 1795107000,
  });
});

test('clamshell Yes with an external display: lid closed, not causing sleep, no claim', async () => {
  assert.deepEqual(parseProbe(await fixture('lid-closed-external-display.txt')), facts({
    ac: true, percent: 80, sleepDisabled: true, lidClosed: true, lidCausesSleep: false, thermal: 0,
    failsafeAliveAge: 10, now: 1795107000,
  }));
});

test('missing lines: each absent fact is null, the rest parse', async () => {
  assert.deepEqual(parseProbe(await fixture('missing-lines.txt')), facts({
    ac: true, lidClosed: false, now: 1795107000,
  }));
});

test('garbage fixture parses to all null', async () => {
  assert.deepEqual(parseProbe(await fixture('garbage.txt')), NONE);
});

test('garbage input never throws and yields all null', () => {
  const inputs = [
    undefined, null, 0, 42, true, {}, [], () => 'x', Symbol('probe'), 10n, new String('@@stat\nnow=1'),
    '', '\n', '@@', '@@stat', 'now=1795107000', '@@ stat\nnow=1795107000', '@@STAT\nnow=1795107000',
    '\u0000\uffff\ud800', '@@batt\nNow drawing from \'constructor\'', '@@lid\n"AppleClamshellState" = constructor',
    '@@batt\n' + ' -InternalBattery-0 (id=1)\t9999%;\n'.repeat(1000), 'x'.repeat(100_000),
  ];
  for (const input of inputs) {
    let result;
    assert.doesNotThrow(() => { result = parseProbe(input); }, String(typeof input));
    assert.deepEqual(result, NONE, typeof input === 'string' ? JSON.stringify(input.slice(0, 60)) : typeof input);
  }
});

test('lid keys match by key in any order; a repeated section is ignored', () => {
  const text = [
    '@@lid', '      "AppleClamshellState" = Yes', '      "AppleClamshellCausesSleep" = No',
    '@@lid', '      "AppleClamshellState" = No', '      "AppleClamshellCausesSleep" = Yes',
  ].join('\n');
  assert.deepEqual(parseProbe(text), facts({lidClosed: true, lidCausesSleep: false}));
});

test('CRLF line endings parse', async () => {
  const text = (await fixture('s4-ac-thermal.txt')).replace(/\n/g, '\r\n');
  assert.deepEqual(parseProbe(text), {...S4, thermal: 0});
});

test('power sources: UPS is not AC, unknown source is null, percent above 100 is null', () => {
  assert.equal(parseProbe("@@batt\nNow drawing from 'UPS Power'").ac, false);
  assert.equal(parseProbe("@@batt\nNow drawing from 'USB Power'").ac, null);
  assert.equal(parseProbe('@@batt\n -InternalBattery-0 (id=1)\t101%; charged').percent, null);
  assert.equal(parseProbe('@@batt\n -InternalBattery-0 (id=1)\t0%; discharging').percent, 0);
});

test('stamps: ages need now; an mtime ahead of the clock gives a negative age', () => {
  assert.deepEqual(parseProbe('@@stat\nalive=1795107000\nclaim=1795106990\nrestore=1795106000\nnow='),
    facts({lastRestore: 1795106000}));
  assert.deepEqual(parseProbe('@@stat\nalive=1795107060\nclaim=1795107000\nnow=1795107000'),
    facts({failsafeAliveAge: -60, claimAge: 0, now: 1795107000}));
});

test('kern.waketime: the S4 capture parses to epoch seconds', async () => {
  assert.equal(parseWaketime(await fixture('kern-waketime.txt')), 1795094890);
  assert.equal(parseWaketime(
    'kern.boottime: { sec = 1794807763, usec = 121948 } Mon Nov 16 14:42:43 2026\n' +
    'kern.waketime: { sec = 1795094890, usec = 792285 } Thu Nov 19 22:28:10 2026\n'), 1795094890);
});

test('kern.waketime: zero, empty, garbage and other keys are null', () => {
  for (const input of [
    '{ sec = 0, usec = 0 } Thu Jan  1 09:00:00 1970', '', 'garbage', 'sec = 1795094890',
    'kern.sleeptime: { sec = 1795094415, usec = 254500 } Thu Nov 19 22:20:15 2026',
    '{ sec = -1, usec = 0 }', undefined, null, 1795094890, {},
  ]) assert.equal(parseWaketime(input), null, String(input));
});

test('secondsSinceWake: S4 values, grace boundary, negative and unknown are null', () => {
  assert.equal(secondsSinceWake(1795094890, 1795106918), 12028);
  assert.equal(secondsSinceWake(1795094890, 1795094890), 0);
  assert.equal(secondsSinceWake(1795094890, 1795094949), 59);
  assert.equal(secondsSinceWake(1795094890, 1795094950), 60);
  assert.equal(secondsSinceWake(1795094890, 1795094889), null);
  assert.equal(secondsSinceWake(null, 1795106918), null);
  assert.equal(secondsSinceWake(0, 1795106918), null);
  assert.equal(secondsSinceWake(1795094890, null), null);
  assert.equal(secondsSinceWake(1795094890, 1795094949.5), 59.5);
  assert.equal(secondsSinceWake(1795094890, NaN), null);
  assert.equal(secondsSinceWake(1795094890.5, 1795106918), null);
});

test('probe.sh: fixed PATH, absolute tool paths, read-only, ends with exit 0', async () => {
  const code = (await readFile(script, 'utf8')).split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.match(code, /^PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/m);
  for (const call of [
    '/usr/bin/pmset -g batt', '/usr/bin/pmset -g |', '/usr/bin/grep SleepDisabled',
    '/usr/sbin/ioreg -r -k AppleClamshellState -d 1', "/usr/bin/grep -E '\"AppleClamshell(State|CausesSleep)\"'",
    '/usr/bin/osascript -l JavaScript', '/usr/bin/stat -f %m', '/bin/date +%s',
    '/var/db/herdr-caffeinate/alive', '$HOME/.herdr/herdr-caffeinate/claim', '/var/db/herdr-caffeinate/last-restore',
  ]) assert.ok(code.includes(call), call);
  // Section labels (`section pmset …`) are header names, not tool calls.
  const calls = code.replace(/^(\s*section) \w+/gm, '$1');
  assert.doesNotMatch(calls, /(?<![\w/.-])(pmset|ioreg|grep|osascript|date|sysctl)\b/);
  assert.doesNotMatch(calls, /(?<![\w/.-])stat -/);
  assert.doesNotMatch(code, /\b(touch|rm|mv|cp|mkdir|tee|chmod|chown|ln|sudo|kill|launchctl|disablesleep|sleepnow)\b/);
  assert.doesNotMatch(code, /pmset\s+-a\b/);
  for (const [, target] of code.matchAll(/\d?>+\s*([^\s;|)&]+)/g)) assert.equal(target, '/dev/null');
  assert.equal(code.trimEnd().split('\n').at(-1), 'exit 0');
});

const headers = (stdout) => stdout.split('\n').filter((line) => line.startsWith('@@'));

function assertLiveFacts(f) {
  assert.equal(typeof f.ac, 'boolean');
  assert.ok(f.percent === null || (Number.isInteger(f.percent) && f.percent >= 0 && f.percent <= 100));
  assert.equal(typeof f.sleepDisabled, 'boolean');
  for (const key of ['lidClosed', 'lidCausesSleep']) assert.ok(f[key] === null || typeof f[key] === 'boolean', key);
  for (const key of ['failsafeAliveAge', 'claimAge', 'lastRestore']) {
    assert.ok(f[key] === null || Number.isInteger(f[key]), key);
  }
  assert.ok(Math.abs(f.now - Date.now() / 1000) < 10, `now=${f.now}`);
}

test('probe.sh on this Mac exits 0 and its output parses', {skip: process.platform !== 'darwin'}, async () => {
  const run = promisify(execFile);

  const full = await run('/bin/sh', [script, '--thermal']);
  assert.equal(full.stderr, '');
  assert.deepEqual(headers(full.stdout), ['@@batt', '@@pmset', '@@lid', '@@thermal', '@@stat']);
  const withThermal = parseProbe(full.stdout);
  assertLiveFacts(withThermal);
  assert.ok(Number.isInteger(withThermal.thermal), `thermal=${withThermal.thermal}`);

  const plain = await run('/bin/sh', [script]);
  assert.equal(plain.stderr, '');
  assert.deepEqual(headers(plain.stdout), ['@@batt', '@@pmset', '@@lid', '@@stat']);
  const withoutThermal = parseProbe(plain.stdout);
  assertLiveFacts(withoutThermal);
  assert.equal(withoutThermal.thermal, null);
});
