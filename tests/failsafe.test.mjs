// AT-11: the root watchdog bin/failsafe.sh (docs/CONTRACTS.md C7), run from a
// temporary copy whose tools are fakes (tests/helpers/sandbox.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access, constants, lutimes, mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {BIN, clearCalls, copyBin, makeSandbox, readCalls, run, setWorld, writeFakes} from './helpers/sandbox.mjs';
import {absoluteTools, bareTools, shellCode, sourcesCode} from './helpers/shell-scan.mjs';

const NOW = 1795100000;
const SHELLS = [];
for (const shell of ['/bin/sh', '/bin/dash']) {
  try {
    await access(shell, constants.X_OK);
    SHELLS.push(shell);
  } catch {
    // dash is optional
  }
}

const TOOLS = {
  '/usr/bin/pmset': 'pmset',
  '/usr/sbin/ioreg': 'ioreg',
  '/usr/sbin/sysctl': 'sysctl',
  '/usr/bin/touch': 'touch',
  '/usr/bin/stat': 'stat',
  '/bin/date': 'date',
  '/bin/rm': 'rm',
};

// pmset, ioreg and sysctl output in the shapes recorded in docs/spikes/S4.md.
const AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=23724131)\t100%; charged; 0:00 remaining present: true\n";
const acLow = (pct) => `Now drawing from 'AC Power'\n -InternalBattery-0 (id=23724131)\t${pct}%; charging; 2:10 remaining present: true\n`;
const battery = (pct) => `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=23724131)\t${pct}%; discharging; 0:20 remaining present: true\n`;
const lid = (state, causesSleep) => [
  '+-o IOPMrootDomain  <class IOPMrootDomain, id 0x100000201, registered, matched, active, busy 0 (0 ms), retain 52>',
  '    {',
  `      "AppleClamshellCausesSleep" = ${causesSleep}`,
  '      "SleepDisabled" = No',
  `      "AppleClamshellState" = ${state}`,
  '      "Last Sleep Reason" = "Maintenance Sleep"',
  '    }',
  '',
].join('\n');
const wake = (sec) => `{ sec = ${sec}, usec = 792285 } Thu Nov 19 22:28:10 2026\n`;

const CLAIM_REL = 'Users/tester/.herdr/herdr-caffeinate/claim';
const MTIME = {fresh: NOW - 10, stale: NOW - 100, future: NOW + 3600, armed: NOW - 50};
// `released` mtimes relative to `armed`.
const RELEASED_AT = {newer: NOW - 20, equal: MTIME.armed, older: NOW - 80};

// A watchdog copy in a sandbox: `opts` sets what the fakes report, the claim
// (none | fresh | stale | future | symlink | dir), `released` next to it
// (null | newer | equal | older | symlink | dir; symlink points at a file
// newer than `armed`) and state files (`armed` has mtime MTIME.armed).
async function watchdog(t, shell, opts = {}) {
  const {
    sd = '0', batt = AC, ioreg = lid('No', 'Yes'), waketime = wake(NOW - 3600), claim = 'fresh',
    armed = false, handled, pmsetWriteFails = false, released = null,
  } = opts;
  const sb = await makeSandbox('hc-failsafe-');
  t.after(sb.cleanup);
  const pairs = [
    ...Object.entries(TOOLS).map(([path, name]) => [path, join(sb.fake, name)]),
    ['/var/db/herdr-caffeinate', join(sb.root, 'var/db/herdr-caffeinate')],
    ['/Users/', `${sb.root}/Users/`],
  ];
  await mkdir(join(sb.root, 'bin'));
  const script = await copyBin('failsafe.sh', join(sb.root, 'bin'), pairs);
  await writeFakes(sb, Object.values(TOOLS));
  await setWorld(sb, {
    now: `${NOW}\n`, sd: sd === null ? null : `${sd}\n`, batt, ioreg, waketime,
    'pmset-write-fails': pmsetWriteFails ? '' : null,
  });
  const state = join(sb.root, 'var/db/herdr-caffeinate');
  await mkdir(state, {recursive: true});
  if (armed) {
    await writeFile(join(state, 'armed'), '');
    await utimes(join(state, 'armed'), MTIME.armed, MTIME.armed);
  }
  if (handled !== undefined) await writeFile(join(state, 'handled'), handled);
  const claimPath = join(sb.root, CLAIM_REL);
  await mkdir(join(claimPath, '..'), {recursive: true});
  if (claim === 'symlink') {
    const target = join(claimPath, '../claim-target');
    await writeFile(target, '{}');
    await utimes(target, MTIME.fresh, MTIME.fresh);
    await symlink(target, claimPath);
    await lutimes(claimPath, MTIME.fresh, MTIME.fresh);
  } else if (claim === 'dir') {
    await mkdir(claimPath);
  } else if (claim !== 'none') {
    await writeFile(claimPath, '{}');
    await utimes(claimPath, MTIME[claim], MTIME[claim]);
  }
  const releasedPath = join(claimPath, '../released');
  if (released === 'symlink') {
    const target = join(claimPath, '../released-target');
    await writeFile(target, '');
    await utimes(target, RELEASED_AT.newer, RELEASED_AT.newer);
    await symlink(target, releasedPath);
    await lutimes(releasedPath, RELEASED_AT.newer, RELEASED_AT.newer);
  } else if (released === 'dir') {
    await mkdir(releasedPath);
  } else if (released !== null) {
    await writeFile(releasedPath, '');
    await utimes(releasedPath, RELEASED_AT[released], RELEASED_AT[released]);
  }
  return {
    sb,
    claimPath,
    releasedPath,
    async run(args = [claimPath]) {
      await clearCalls(sb);
      const result = await run([shell, script, ...args]);
      const calls = await readCalls(sb);
      return {...result, calls, writes: calls.filter((call) => /^pmset (-a |sleepnow)/.test(call))};
    },
    async files() {
      return (await readdir(state)).sort();
    },
    async read(name) {
      try {
        return await readFile(join(state, name), 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    // mtime in whole seconds of a state file.
    async mtime(name) {
      return Math.floor((await stat(join(state, name))).mtimeMs / 1000);
    },
    world: (files) => setWorld(sb, files),
  };
}

const RESTORE = ['pmset -a disablesleep 0'];

for (const shell of SHELLS) {
  test(`[${shell}] fresh claim with SleepDisabled 0 writes nothing`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'fresh', sd: '0'});
    const r = await w.run();
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.writes, []);
    assert.deepEqual(await w.files(), ['alive']);
  });

  test(`[${shell}] fresh claim with SleepDisabled 1 arms without writing`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'fresh', sd: '1'});
    const r = await w.run();
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.writes, []);
    assert.deepEqual(await w.files(), ['alive', 'armed']);
  });

  test(`[${shell}] stale claim restores once and a second run writes nothing`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'stale', sd: '1', armed: true});
    const first = await w.run();
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(first.writes, RESTORE);
    assert.equal(await w.read('last-restore'), `${NOW} stale-claim\n`);
    assert.equal(await w.read('handled'), `${MTIME.stale}\n`);
    assert.deepEqual(await w.files(), ['alive', 'handled', 'last-restore']);
    await w.world({now: `${NOW + 15}\n`});
    const second = await w.run();
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(second.writes, []);
    assert.equal(await w.read('last-restore'), `${NOW} stale-claim\n`);
  });

  test(`[${shell}] stale claim restores even when it was never armed`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'stale', sd: '1'});
    const r = await w.run();
    assert.deepEqual(r.writes, RESTORE);
    assert.equal(await w.read('last-restore'), `${NOW} stale-claim\n`);
  });

  test(`[${shell}] stale claim already handled exits without writing`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'stale', sd: '1', handled: `${MTIME.stale}\n`});
    const r = await w.run();
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.writes, []);
    assert.equal(await w.read('last-restore'), null);
  });

  test(`[${shell}] stale claim with SleepDisabled already 0 records the restore without a pmset write`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'stale', sd: '0'});
    const r = await w.run();
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.writes, []);
    assert.equal(await w.read('last-restore'), `${NOW} stale-claim\n`);
    assert.equal(await w.read('handled'), `${MTIME.stale}\n`);
  });

  test(`[${shell}] a claim dated in the future (clock set back) counts as stale`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'future', sd: '1', armed: true});
    const r = await w.run();
    assert.deepEqual(r.writes, RESTORE);
    assert.equal(await w.read('last-restore'), `${NOW} stale-claim\n`);
  });

  test(`[${shell}] no claim and nothing armed leaves a foreign SleepDisabled 1 alone`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'none', sd: '1', batt: battery(5)});
    for (let i = 0; i < 2; i++) {
      const r = await w.run();
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.writes, []);
      assert.deepEqual(await w.files(), ['alive']);
    }
  });

  test(`[${shell}] claim gone while armed restores claim-gone once`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'none', sd: '1', armed: true});
    const first = await w.run();
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(first.writes, RESTORE);
    assert.equal(await w.read('last-restore'), `${NOW} claim-gone\n`);
    assert.deepEqual(await w.files(), ['alive', 'last-restore']);
    await w.world({sd: '1\n'});
    const second = await w.run();
    assert.deepEqual(second.writes, []);
  });

  test(`[${shell}] AT-09 race: released at least as new as armed only disarms; a foreign SleepDisabled 1 stays`, async (t) => {
    for (const released of ['newer', 'equal']) {
      const w = await watchdog(t, shell, {claim: 'none', sd: '1', armed: true, released});
      const first = await w.run();
      assert.equal(first.code, 0, `${released}: ${first.stderr}`);
      assert.deepEqual(first.writes, [], released);
      assert.deepEqual(await w.files(), ['alive'], released);
      // Only the mtime of `released` is read; it is not changed.
      const reads = first.calls.filter((call) => call.includes('/released'));
      assert.deepEqual(reads, ['stat -f %m /Users/tester/.herdr/herdr-caffeinate/released'], released);
      assert.equal(Math.floor((await stat(w.releasedPath)).mtimeMs / 1000), RELEASED_AT[released], released);
      const second = await w.run();
      assert.deepEqual(second.writes, [], released);
      assert.deepEqual(await w.files(), ['alive'], released);
    }
  });

  test(`[${shell}] released older than armed, symlinked or not a file: restore claim-gone`, async (t) => {
    for (const released of ['older', 'symlink', 'dir']) {
      const w = await watchdog(t, shell, {claim: 'none', sd: '1', armed: true, released});
      const r = await w.run();
      assert.equal(r.code, 0, `${released}: ${r.stderr}`);
      assert.deepEqual(r.writes, RESTORE, released);
      assert.equal(await w.read('last-restore'), `${NOW} claim-gone\n`, released);
      assert.deepEqual(await w.files(), ['alive', 'last-restore'], released);
      if (released === 'symlink') {
        assert.deepEqual(r.calls.filter((call) => call.includes('/released')), [], 'a symlinked released is not even read');
      }
    }
  });

  test(`[${shell}] released without armed writes nothing`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'none', sd: '1', released: 'newer'});
    const r = await w.run();
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.writes, []);
    assert.deepEqual(await w.files(), ['alive']);
  });

  test(`[${shell}] a new arm after a release refreshes armed, so a later claim loss still restores`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'fresh', sd: '1', armed: true, released: 'newer'});
    const armedAgain = await w.run();
    assert.equal(armedAgain.code, 0, armedAgain.stderr);
    assert.deepEqual(armedAgain.writes, []);
    assert.ok(await w.mtime('armed') > RELEASED_AT.newer, 'armed is newer than released again');
    await rm(w.claimPath);
    const lost = await w.run();
    assert.deepEqual(lost.writes, RESTORE);
    assert.equal(await w.read('last-restore'), `${NOW} claim-gone\n`);
  });

  test(`[${shell}] an arm newer than released is left as it is`, async (t) => {
    for (const released of [null, 'older']) {
      const w = await watchdog(t, shell, {claim: 'fresh', sd: '1', armed: true, released});
      const r = await w.run();
      assert.equal(r.code, 0, r.stderr);
      assert.equal(await w.mtime('armed'), MTIME.armed, String(released));
    }
  });

  test(`[${shell}] symlinked claim is ignored`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'symlink', sd: '1'});
    const r = await w.run();
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.writes, []);
    assert.deepEqual(r.calls.filter((call) => call.startsWith('stat ')), []);
    assert.deepEqual(await w.files(), ['alive']);
  });

  test(`[${shell}] symlinked claim counts as no claim when armed`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'symlink', sd: '1', armed: true});
    const r = await w.run();
    assert.deepEqual(r.writes, RESTORE);
    assert.equal(await w.read('last-restore'), `${NOW} claim-gone\n`);
  });

  test(`[${shell}] a directory at the claim path counts as no claim`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'dir', sd: '1'});
    const r = await w.run();
    assert.deepEqual(r.writes, []);
    assert.deepEqual(await w.files(), ['alive']);
  });

  test(`[${shell}] lid shut with clamshell sleep: sleepnow after the restore`, async (t) => {
    for (const claim of ['stale', 'none']) {
      const w = await watchdog(t, shell, {claim, sd: '1', armed: true, ioreg: lid('Yes', 'Yes')});
      const r = await w.run();
      assert.deepEqual(r.writes, [...RESTORE, 'pmset sleepnow'], claim);
    }
  });

  test(`[${shell}] no sleepnow with the lid open, clamshell sleep off or unreadable lid`, async (t) => {
    for (const ioreg of [lid('No', 'Yes'), lid('Yes', 'No'), lid('No', 'No'), '{}\n', null]) {
      const w = await watchdog(t, shell, {claim: 'stale', sd: '1', ioreg});
      const r = await w.run();
      assert.deepEqual(r.writes, RESTORE, JSON.stringify(ioreg));
    }
  });

  test(`[${shell}] wake grace: a stale claim within 60 s of a wake waits`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'stale', sd: '1', armed: true, waketime: wake(NOW - 20)});
    const r = await w.run();
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.writes, []);
    assert.deepEqual(await w.files(), ['alive', 'armed']);
    await w.world({waketime: wake(NOW - 60)});
    const later = await w.run();
    assert.deepEqual(later.writes, RESTORE);
    assert.equal(await w.read('last-restore'), `${NOW} stale-claim\n`);
  });

  test(`[${shell}] no wake grace without a usable wake time`, async (t) => {
    for (const waketime of [null, wake(0), wake(NOW + 30), 'garbage\n', `${NOW - 5}\n`, '']) {
      const w = await watchdog(t, shell, {claim: 'stale', sd: '1', waketime});
      const r = await w.run();
      assert.deepEqual(r.writes, RESTORE, JSON.stringify(waketime));
    }
  });

  test(`[${shell}] battery floor restores an armed claim below 10 % on battery`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'fresh', sd: '1', armed: true, batt: battery(9)});
    const r = await w.run();
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.writes, RESTORE);
    assert.equal(await w.read('last-restore'), `${NOW} battery-floor\n`);
    assert.deepEqual(await w.files(), ['alive', 'last-restore']);
    const again = await w.run();
    assert.deepEqual(again.writes, []);
  });

  test(`[${shell}] battery floor: SleepDisabled 1 under a fresh claim arms and restores in one run`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'fresh', sd: '1', batt: battery(5)});
    const r = await w.run();
    assert.deepEqual(r.writes, RESTORE);
    assert.equal(await w.read('last-restore'), `${NOW} battery-floor\n`);
  });

  test(`[${shell}] battery floor needs armed, battery power and a percent below 10`, async (t) => {
    const cases = [
      ['10 % on battery', {sd: '1', armed: true, batt: battery(10)}],
      ['5 % on AC', {sd: '1', armed: true, batt: acLow(5)}],
      ['not armed', {sd: '0', batt: battery(5)}],
      ['unreadable battery', {sd: '1', armed: true, batt: null}],
    ];
    for (const [name, opts] of cases) {
      const w = await watchdog(t, shell, {claim: 'fresh', ...opts});
      const r = await w.run();
      assert.equal(r.code, 0, `${name}: ${r.stderr}`);
      assert.deepEqual(r.writes, [], name);
      assert.equal(await w.read('last-restore'), null, name);
    }
  });

  test(`[${shell}] unreadable SleepDisabled keeps the state for the next run`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'none', sd: null, armed: true});
    const r = await w.run();
    assert.equal(r.code, 1);
    assert.deepEqual(r.writes, []);
    assert.deepEqual(await w.files(), ['alive', 'armed']);
    await w.world({sd: '1\n'});
    const retry = await w.run();
    assert.deepEqual(retry.writes, RESTORE);
    assert.equal(await w.read('last-restore'), `${NOW} claim-gone\n`);
  });

  test(`[${shell}] a failed pmset write keeps the state for the next run`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'stale', sd: '1', armed: true, pmsetWriteFails: true});
    const r = await w.run();
    assert.equal(r.code, 1);
    assert.deepEqual(r.writes, RESTORE);
    assert.deepEqual(await w.files(), ['alive', 'armed']);
  });

  test(`[${shell}] a bad argument does nothing`, async (t) => {
    const w = await watchdog(t, shell, {claim: 'stale', sd: '1', armed: true});
    const users = `${w.sb.root}/Users`;
    const bad = [
      [],
      [''],
      [w.claimPath, 'extra'],
      ['/tmp/claim'],
      [`/${CLAIM_REL}`],
      [`${users}/x/../tester/.herdr/herdr-caffeinate/claim`],
      [`${users}/../Users/tester/.herdr/herdr-caffeinate/claim`],
      [`${users}/a/b/.herdr/herdr-caffeinate/claim`],
      [`${users}/a b/.herdr/herdr-caffeinate/claim`],
      [`${users}/.x/.herdr/herdr-caffeinate/claim`],
      [`${users}/x\n/.herdr/herdr-caffeinate/claim`],
      [`${users}//.herdr/herdr-caffeinate/claim`],
      [`${users}/tester/.herdr/herdr-caffeinate/claim2`],
    ];
    for (const args of bad) {
      const r = await w.run(args);
      assert.equal(r.code, 64, JSON.stringify(args));
      assert.deepEqual(r.calls, [], JSON.stringify(args));
      assert.deepEqual(await w.files(), ['armed'], JSON.stringify(args));
    }
  });
}

test('the watchdog accepts the claim path of exactly the homes the installer accepts', async (t) => {
  const w = await watchdog(t, SHELLS[0], {claim: 'none', sd: '0'});
  const homes = ['/Users/tester', '/Users/john.doe', '/Users/a_b-c', '/Users/a b', '/Users/.x', '/Users/x/y', '/Users/..', '/var/root'];
  for (const home of homes) {
    const rendered = await run(['/bin/sh', join(BIN, 'install.sh'), '--render-plist', home]);
    const claim = home.startsWith('/Users/') ? `${w.sb.root}${home}/.herdr/herdr-caffeinate/claim` : `${home}/.herdr/herdr-caffeinate/claim`;
    const watched = await w.run([claim]);
    assert.equal(rendered.code === 0, watched.code !== 64, home);
  }
});

test('the shipped watchdog parses, keeps the C7 constants and calls tools only by absolute path', async () => {
  const source = await readFile(join(BIN, 'failsafe.sh'), 'utf8');
  const parsed = await run(['/bin/sh', '-n', join(BIN, 'failsafe.sh')]);
  assert.equal(parsed.code, 0, parsed.stderr);
  assert.ok(source.startsWith('#!/bin/sh\n'));
  for (const line of ['set -u', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'STALE=45', 'WAKE_GRACE=60', 'FLOOR=10', 'STATE=/var/db/herdr-caffeinate']) {
    assert.match(source, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), line);
  }
  const code = shellCode(source);
  assert.equal(sourcesCode(code), false, 'no eval, source or .');
  assert.deepEqual(bareTools(code), []);
  assert.deepEqual(absoluteTools(code), Object.keys(TOOLS).sort());
  for (const tool of Object.keys(TOOLS)) await access(tool, constants.X_OK);
});

test('the test copy of the watchdog calls no real tool', async (t) => {
  const w = await watchdog(t, SHELLS[0]);
  const copy = await readFile(join(w.sb.root, 'bin/failsafe.sh'), 'utf8');
  assert.deepEqual(absoluteTools(shellCode(copy)), []);
});

test('the shell scan flags bare tools, sourcing and lists absolute tools', () => {
  const code = shellCode('#!/bin/sh\n# pmset in a comment\necho "sudo in a string $(pmset -g)"\nx=$(/usr/bin/stat -f %m f) ; rm -f y\n. ./lib.sh\n');
  assert.deepEqual(bareTools(code), ['pmset', 'rm']);
  assert.deepEqual(absoluteTools(code), ['/usr/bin/stat']);
  assert.equal(sourcesCode(code), true);
  assert.equal(sourcesCode(shellCode("case $x in '' | .*) ;; esac\n")), false);
  assert.equal(sourcesCode(shellCode('eval "$x"\n')), true);
});
