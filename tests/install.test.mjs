// AT-19 and the C8 flow (docs/CONTRACTS.md C6-C8). bin/install.sh renders the
// sudoers rule and the plist without privilege; full install and uninstall
// runs use a temporary copy whose sudo, id, visudo, launchctl, install, pmset
// and sleep are fakes and whose root paths live in the sandbox
// (tests/helpers/sandbox.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access, constants, lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {BIN, LABEL, clearCalls, copyBin, makeSandbox, readCalls, run, setWorld, writeFakes} from './helpers/sandbox.mjs';
import {absoluteTools, bareTools, shellCode, sourcesCode} from './helpers/shell-scan.mjs';

const C6 = (user) => `${user} ALL = (root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1\n`;
const SUDOERS = '/etc/sudoers.d/herdr-caffeinate';
const HELPER = `/Library/PrivilegedHelperTools/${LABEL}`;
const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`;
const STATE = '/var/db/herdr-caffeinate';
const INSTALL = join(BIN, 'install.sh');

const renderSudoers = (...args) => run(['/bin/sh', INSTALL, '--render-sudoers', ...args]);
const renderPlist = (...args) => run(['/bin/sh', INSTALL, '--render-plist', ...args]);

async function plistJson(file) {
  const r = await run(['/usr/bin/plutil', '-convert', 'json', '-o', '-', file]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

const mode = async (path) => (await stat(path)).mode & 0o777;

test('renders the C6 sudoers rule byte for byte, and it passes visudo -cf', async (t) => {
  const sb = await makeSandbox('hc-render-');
  t.after(sb.cleanup);
  assert.equal(await readFile(join(BIN, 'sudoers.tmpl'), 'utf8'), C6('__USER__'));
  for (const user of ['lapis0875', '_svc', 'a-b_9']) {
    const r = await renderSudoers(user);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, C6(user));
    const file = join(sb.root, `sudoers-${user}`);
    await writeFile(file, r.stdout, {mode: 0o440});
    const checked = await run(['/usr/sbin/visudo', '-cf', file]);
    assert.equal(checked.code, 0, checked.stdout + checked.stderr);
  }
});

test('refuses hostile user names before rendering anything', async () => {
  for (const user of ['a b', 'root;', '../x', '', 'Root', '-x', '9x', 'a\nb', 'x,y', 'ALL', 'a:b', 'x)', 'a\tb']) {
    const r = await renderSudoers(user);
    assert.equal(r.code, 2, JSON.stringify(user));
    assert.equal(r.stdout, '', JSON.stringify(user));
  }
  for (const args of [[], ['a', 'b']]) {
    const r = await renderSudoers(...args);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.equal(r.stdout, '');
  }
});

test('renders the C7 LaunchDaemon plist, and it passes plutil -lint', async (t) => {
  const sb = await makeSandbox('hc-render-');
  t.after(sb.cleanup);
  const r = await renderPlist('/Users/tester');
  assert.equal(r.code, 0, r.stderr);
  const file = join(sb.root, 'failsafe.plist');
  await writeFile(file, r.stdout);
  const lint = await run(['/usr/bin/plutil', '-lint', file]);
  assert.equal(lint.code, 0, lint.stdout + lint.stderr);
  assert.deepEqual(await plistJson(file), {
    Label: LABEL,
    ProgramArguments: ['/bin/sh', HELPER, '/Users/tester/.herdr/herdr-caffeinate/claim'],
    StartInterval: 15,
    RunAtLoad: true,
    ProcessType: 'Background',
  });
});

test('refuses homes outside /Users/<name> before rendering anything', async () => {
  const bad = ['/Users/a b', '/Users/../etc', '/Users/..', '/Users/x/y', '/Users/x/', '/Users/', '/Users/.x', '/tmp/x',
    '/var/root', 'Users/x', '', '/Users/x&y', '/Users/x</string>', '/Users/x|y', '/Users/x\ny'];
  for (const home of bad) {
    const r = await renderPlist(home);
    assert.equal(r.code, 2, JSON.stringify(home));
    assert.equal(r.stdout, '', JSON.stringify(home));
  }
});

test('install.sh and uninstall.sh parse and call tools only by absolute path', async () => {
  for (const name of ['install.sh', 'uninstall.sh']) {
    const parsed = await run(['/bin/sh', '-n', join(BIN, name)]);
    assert.equal(parsed.code, 0, `${name}: ${parsed.stderr}`);
    const source = await readFile(join(BIN, name), 'utf8');
    assert.ok(source.startsWith('#!/bin/sh\n'), name);
    assert.match(source, /^set -u$/m, name);
    assert.match(source, /^PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/m, name);
    const code = shellCode(source);
    assert.equal(sourcesCode(code), false, name);
    assert.deepEqual(bareTools(code), [], name);
    for (const tool of absoluteTools(code)) await access(tool, constants.X_OK);
  }
});

// Tools that need privilege or change the system, per script.
const FAKED = {
  'install.sh': ['/usr/bin/sudo', '/usr/bin/id', '/usr/sbin/visudo', '/bin/launchctl', '/usr/bin/install', '/bin/sleep'],
  'uninstall.sh': ['/usr/bin/sudo', '/usr/bin/id', '/usr/sbin/visudo', '/bin/launchctl', '/usr/bin/pmset'],
};
const fakeName = (path) => path.slice(path.lastIndexOf('/') + 1);

// install.sh and uninstall.sh copies in a sandbox; `world` sets what the fakes
// report (uid, user, sd and failure switches). `run(name, env)` may override
// HOME or TMPDIR.
async function rootSide(t, {world = {}} = {}) {
  const sb = await makeSandbox('hc-install-');
  t.after(sb.cleanup);
  const roots = [
    ['/etc/sudoers.d/', `${sb.root}/etc/sudoers.d/`],
    ['/Library/', `${sb.root}/Library/`],
    [STATE, `${sb.root}${STATE}`],
    ['/Users/', `${sb.root}/Users/`],
  ];
  const bin = join(sb.root, 'mod/bin');
  await mkdir(bin, {recursive: true});
  const scripts = {};
  for (const [name, tools] of Object.entries(FAKED)) {
    scripts[name] = await copyBin(name, bin, [...tools.map((tool) => [tool, join(sb.fake, fakeName(tool))]), ...roots]);
  }
  for (const name of ['failsafe.sh', 'sudoers.tmpl', 'failsafe.plist.tmpl']) await copyBin(name, bin);
  await writeFakes(sb, [...new Set(Object.values(FAKED).flat().map(fakeName))]);
  for (const dir of ['etc/sudoers.d', 'Library/LaunchDaemons', 'var/db', 'tmp', 'Users/tester']) {
    await mkdir(join(sb.root, dir), {recursive: true});
  }
  await setWorld(sb, {uid: `${process.getuid()}\n`, user: 'tester\n', sd: '0\n', ...world});
  const baseEnv = {HOME: join(sb.root, 'Users/tester'), TMPDIR: join(sb.root, 'tmp')};
  return {
    sb,
    scripts,
    at: (path) => join(sb.root, path),
    world: (files) => setWorld(sb, files),
    async run(name, env = {}) {
      await clearCalls(sb);
      const r = await run(['/bin/sh', scripts[name]], {env: {...baseEnv, ...env}});
      const calls = (await readCalls(sb)).map((call) => call.replace(/\/tmp\/herdr-caffeinate\.[A-Za-z0-9]+/g, '<work>'));
      return {...r, calls, sudo: calls.filter((call) => call.startsWith('sudo ')).map((call) => call.slice(5))};
    },
  };
}

const INSTALL_STEPS = [
  `install -o root -g wheel -m 0440 <work>/sudoers ${SUDOERS}.new`,
  `/bin/mv -f ${SUDOERS}.new ${SUDOERS}`,
  `visudo -cf ${SUDOERS}`,
  '-n -l /usr/bin/pmset -a disablesleep 0',
  '-n -l /usr/bin/pmset -a disablesleep 1',
  '-n visudo -c',
  'install -d -o root -g wheel -m 0755 /Library/PrivilegedHelperTools',
  `install -S -o root -g wheel -m 0755 /mod/bin/failsafe.sh ${HELPER}`,
  `install -d -o root -g wheel -m 0755 ${STATE}`,
  `install -o root -g wheel -m 0644 <work>/failsafe.plist ${PLIST}`,
  `launchctl bootout system/${LABEL}`,
  `launchctl enable system/${LABEL}`,
  `launchctl bootstrap system ${PLIST}`,
];

// What `sudo visudo -c` printed on the owner's Mac: Amphetamine installs its
// rule with mode 0644, which fails the whole-config check while sudo still
// reads the file.
const AMPHETAMINE = 'amphetamine_PowerProtect';
const FOREIGN_WARNING = `/private/etc/sudoers.d/${AMPHETAMINE}: bad permissions, should be mode 0440\n`;
const FOREIGN_RULE = 'Cmnd_Alias PMSET_AMPHETAMINE= /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0\n%admin ALL=(ALL) NOPASSWD: PMSET_AMPHETAMINE\n';
const NOTE_LINE = /^note: {3}\/private\/etc\/sudoers\.d\/amphetamine_PowerProtect: bad permissions, should be mode 0440$/m;

test('the test copies call no privileged tool', async (t) => {
  const side = await rootSide(t);
  for (const [name, tools] of Object.entries(FAKED)) {
    const left = absoluteTools(shellCode(await readFile(side.scripts[name], 'utf8')));
    assert.deepEqual(left.filter((tool) => tools.includes(tool)), [], name);
  }
});

test('install: every C4 root path in order, with the C6/C7 contents and modes', async (t) => {
  const side = await rootSide(t);
  const r = await side.run('install.sh');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.sudo, INSTALL_STEPS);
  assert.doesNotMatch(r.stdout, /note:/);
  assert.ok(r.calls.includes('visudo -cf <work>/sudoers'), 'visudo -cf before sudo');
  assert.ok(r.calls.indexOf('visudo -cf <work>/sudoers') < r.calls.indexOf(`sudo ${INSTALL_STEPS[0]}`));
  assert.equal(await readFile(side.at(SUDOERS), 'utf8'), C6('tester'));
  assert.equal(await mode(side.at(SUDOERS)), 0o440);
  assert.equal(await exists(side.at(`${SUDOERS}.new`)), false);
  assert.equal(await readFile(side.at(HELPER), 'utf8'), await readFile(join(BIN, 'failsafe.sh'), 'utf8'));
  assert.equal(await mode(side.at(HELPER)), 0o755);
  assert.equal(await mode(side.at(STATE)), 0o755);
  assert.equal(await mode(side.at(PLIST)), 0o644);
  const plist = await plistJson(side.at(PLIST));
  assert.deepEqual(plist.ProgramArguments, ['/bin/sh', HELPER, side.at('Users/tester/.herdr/herdr-caffeinate/claim')]);
  assert.deepEqual(await readdir(side.at('tmp')), [], 'temporary files removed');
  assert.match(r.stdout, /^installed: /m);
});

test('install and uninstall refuse root before anything else', async (t) => {
  for (const name of ['install.sh', 'uninstall.sh']) {
    const side = await rootSide(t, {world: {uid: '0\n'}});
    const r = await side.run(name);
    assert.equal(r.code, 1, name);
    assert.match(r.stderr, /not as root/, name);
    assert.deepEqual(r.calls, ['id -u'], name);
  }
});

test('install refuses hostile user names before writing anything', async (t) => {
  for (const user of ['a b', 'root;', '../x', 'Root', '']) {
    const side = await rootSide(t, {world: {user: `${user}\n`}});
    const r = await side.run('install.sh');
    assert.equal(r.code, 1, JSON.stringify(user));
    assert.deepEqual(r.calls, ['id -u', 'id -un'], JSON.stringify(user));
    assert.deepEqual(await readdir(side.at('etc/sudoers.d')), []);
    assert.deepEqual(await readdir(side.at('tmp')), []);
  }
});

test('install refuses a HOME that is not a /Users/<name> directory owned by the user', async (t) => {
  const side = await rootSide(t);
  await symlink(side.at('Users/tester'), side.at('Users/link'));
  const other = await rootSide(t, {world: {uid: `${process.getuid() + 1000}\n`}});
  const cases = [
    ['outside /Users', side, {HOME: '/var/root'}],
    ['nested', side, {HOME: side.at('Users/tester/sub')}],
    ['symlink', side, {HOME: side.at('Users/link')}],
    ['missing', side, {HOME: side.at('Users/nobody')}],
    ['empty', side, {HOME: ''}],
    ['owned by someone else', other, {}],
  ];
  for (const [name, s, env] of cases) {
    const r = await s.run('install.sh', env);
    assert.equal(r.code, 1, `${name}: ${r.stderr}`);
    assert.deepEqual(r.calls, ['id -u', 'id -un'], name);
  }
});

test('install: a foreign file failing the whole-config visudo -c is printed as a note and does not fail', async (t) => {
  const side = await rootSide(t, {world: {'visudo-c-warning': FOREIGN_WARNING}});
  const foreign = side.at(`etc/sudoers.d/${AMPHETAMINE}`);
  await writeFile(foreign, FOREIGN_RULE, {mode: 0o644});
  const r = await side.run('install.sh');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.sudo, INSTALL_STEPS);
  assert.match(r.stdout, /^note: sudo visudo -c, which checks every sudoers file, reports the lines below/m);
  assert.match(r.stdout, NOTE_LINE);
  assert.doesNotMatch(r.stdout, /parsed OK/);
  assert.ok(r.stdout.indexOf('note:') < r.stdout.indexOf('2/3 fail-safe helper'), 'notes belong to the sudoers step');
  assert.equal(await readFile(side.at(SUDOERS), 'utf8'), C6('tester'));
  assert.equal(await readFile(foreign, 'utf8'), FOREIGN_RULE);
  assert.equal(await mode(foreign), 0o644);
  assert.match(r.stdout, /^installed: /m);
});

test('install: our file failing visudo -cf or a refused sudo -n -l exits 10 and removes only our file', async (t) => {
  const cases = [
    ['visudo -cf on our file', {'visudo-cf-fails': SUDOERS}, `visudo -cf ${SUDOERS}`],
    ['sudo -n -l … 0 refused', {'sudo-fails': '-l /usr/bin/pmset -a disablesleep 0'}, '-n -l /usr/bin/pmset -a disablesleep 0'],
    ['sudo -n -l … 1 refused', {'sudo-fails': '-l /usr/bin/pmset -a disablesleep 1'}, '-n -l /usr/bin/pmset -a disablesleep 1'],
  ];
  for (const [name, world, failing] of cases) {
    const side = await rootSide(t, {world: {...world, 'visudo-c-warning': FOREIGN_WARNING}});
    await writeFile(side.at(`etc/sudoers.d/${AMPHETAMINE}`), FOREIGN_RULE, {mode: 0o644});
    const r = await side.run('install.sh');
    assert.equal(r.code, 10, `${name}: ${r.stderr}`);
    const at = INSTALL_STEPS.indexOf(failing);
    assert.deepEqual(r.sudo, [...INSTALL_STEPS.slice(0, at + 1), `-n /bin/rm -f ${SUDOERS}`], name);
    assert.match(r.stderr, /; removed \S*\/etc\/sudoers\.d\/herdr-caffeinate$/m, name);
    assert.deepEqual(await readdir(side.at('etc/sudoers.d')), [AMPHETAMINE], name);
    assert.deepEqual(await readdir(side.at('tmp')), [], `${name}: temporary files removed`);
  }
});

test('the fake sudo -l grants exactly the commands of the installed rule', async (t) => {
  const side = await installed(t);
  const sudo = join(side.sb.fake, 'sudo');
  for (const [args, code] of [
    [['-n', '-l', '/usr/bin/pmset', '-a', 'disablesleep', '0'], 0],
    [['-n', '-l', '/usr/bin/pmset', '-a', 'disablesleep', '1'], 0],
    [['-n', '-l', '/usr/bin/pmset', '-a', 'disablesleep', '2'], 1],
    [['-n', '-l', '/usr/bin/pmset', 'sleepnow'], 1],
  ]) {
    assert.equal((await run([sudo, ...args])).code, code, args.join(' '));
  }
  await rm(side.at(SUDOERS));
  assert.equal((await run([sudo, '-n', '-l', '/usr/bin/pmset', '-a', 'disablesleep', '0'])).code, 1, 'no rule file');
});

test('install exit codes: 10 sudoers, 20 helper or state, 30 plist or daemon', async (t) => {
  const cases = [
    ['password refused', {'sudo-denied': ''}, 10],
    ['helper install fails', {'install-fails': 'failsafe.sh'}, 20],
    ['state directory fails', {'install-fails': STATE}, 20],
    ['plist install fails', {'install-fails': 'LaunchDaemons'}, 30],
    ['bootstrap fails', {'bootstrap-fails': ''}, 30],
    ['daemon never reports alive', {'daemon-silent': ''}, 30],
  ];
  for (const [name, world, code] of cases) {
    const side = await rootSide(t, {world});
    const r = await side.run('install.sh');
    assert.equal(r.code, code, `${name}: ${r.stderr}`);
    assert.deepEqual(await readdir(side.at('tmp')), [], `${name}: temporary files removed`);
    if (code === 10) assert.deepEqual(await readdir(side.at('etc/sudoers.d')), [], `${name}: sudoers removed`);
    if (code === 20) assert.equal(await exists(side.at(PLIST)), false, name);
  }
  const side = await rootSide(t, {world: {'bootstrap-fails': ''}});
  const r = await side.run('install.sh');
  assert.equal(r.sudo.filter((call) => call.startsWith('launchctl bootstrap ')).length, 3, 'bootstrap tried 3 times');
});

async function installed(t) {
  const side = await rootSide(t);
  const r = await side.run('install.sh');
  assert.equal(r.code, 0, r.stderr);
  return side;
}

const ROOT_PATHS = [SUDOERS, `${SUDOERS}.new`, HELPER, PLIST, STATE];

test('uninstall restores disablesleep 0 when armed, then removes every C4 root path', async (t) => {
  const side = await installed(t);
  await writeFile(side.at(`${STATE}/armed`), '');
  await side.world({sd: '1\n'});
  const r = await side.run('uninstall.sh');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.sudo, [
    'pmset -a disablesleep 0',
    `launchctl bootout system/${LABEL}`,
    `/bin/rm -f ${PLIST}`,
    `/bin/rm -f ${HELPER}`,
    `/bin/rm -rf ${STATE}`,
    `/bin/rm -f ${SUDOERS} ${SUDOERS}.new`,
    '-n visudo -c',
  ]);
  for (const path of ROOT_PATHS) assert.equal(await exists(side.at(path)), false, path);
  assert.equal(await readFile(join(side.sb.world, 'sd'), 'utf8'), '0\n');
  assert.doesNotMatch(r.stdout, /note:/);
  assert.match(r.stdout, /^uninstalled$/m);
});

test('uninstall restores disablesleep 0 when only the claim exists', async (t) => {
  const side = await installed(t);
  const claim = side.at('Users/tester/.herdr/herdr-caffeinate/claim');
  await mkdir(join(claim, '..'), {recursive: true});
  await writeFile(claim, '{}');
  await side.world({sd: '1\n'});
  const r = await side.run('uninstall.sh');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.sudo[0], 'pmset -a disablesleep 0');
  assert.equal(await readFile(join(side.sb.world, 'sd'), 'utf8'), '0\n');
});

test('uninstall leaves a foreign SleepDisabled 1 alone and says so', async (t) => {
  const side = await installed(t);
  await side.world({sd: '1\n'});
  const r = await side.run('uninstall.sh');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.sudo.filter((call) => call.startsWith('pmset')), []);
  assert.match(r.stdout, /note: SleepDisabled is still 1/);
  assert.equal(await readFile(join(side.sb.world, 'sd'), 'utf8'), '1\n');
  for (const path of ROOT_PATHS) assert.equal(await exists(side.at(path)), false, path);
});

test('uninstall with nothing installed exits 0', async (t) => {
  const side = await rootSide(t);
  const r = await side.run('uninstall.sh');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.sudo.filter((call) => call.startsWith('pmset')), []);
});

test('uninstall: a foreign file failing the whole-config visudo -c is printed as a note and does not fail', async (t) => {
  const side = await installed(t);
  const foreign = side.at(`etc/sudoers.d/${AMPHETAMINE}`);
  await writeFile(foreign, FOREIGN_RULE, {mode: 0o644});
  await side.world({'visudo-c-warning': FOREIGN_WARNING});
  const r = await side.run('uninstall.sh');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, NOTE_LINE);
  for (const path of ROOT_PATHS) assert.equal(await exists(side.at(path)), false, path);
  assert.equal(await readFile(foreign, 'utf8'), FOREIGN_RULE);
  assert.match(r.stdout, /^uninstalled$/m);
});

test('uninstall exits 40 when the daemon stays loaded or our sudoers file stays', async (t) => {
  const cases = [
    ['bootout fails', {'bootout-fails': ''}, /still loaded/],
    ['sudoers removal fails', {'sudo-fails': 'sudoers.d/herdr-caffeinate'}, /still present: .*\/etc\/sudoers\.d\/herdr-caffeinate$/m],
  ];
  for (const [name, world, message] of cases) {
    const side = await installed(t);
    await side.world(world);
    const r = await side.run('uninstall.sh');
    assert.equal(r.code, 40, `${name}: ${r.stderr}`);
    assert.match(r.stderr, message, name);
  }
});
