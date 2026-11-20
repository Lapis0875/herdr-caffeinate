// Static checks for the root-side POSIX sh scripts: which external tools they
// call, and whether each one is called by absolute path.

// The script's code: comments and the literal text of quoted strings become
// spaces; command substitutions inside double quotes stay code.
export function shellCode(source) {
  let out = '';
  const modes = ['code'];
  const depths = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const mode = modes.at(-1);
    if (mode === 'dq') {
      if (c === '\\') {
        i++;
      } else if (c === '"') {
        modes.pop();
        out += ' ';
      } else if (c === '$' && source[i + 1] === '(') {
        modes.push('subst');
        depths.push(0);
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '\\') {
      out += ' ';
      i++;
      continue;
    }
    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      i = end < 0 ? source.length : end;
      out += ' ';
      continue;
    }
    if (c === '"') {
      modes.push('dq');
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;&|()]/.test(source[i - 1]))) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end - 1;
      continue;
    }
    if (mode === 'subst') {
      if (c === '(') {
        depths[depths.length - 1]++;
      } else if (c === ')') {
        if (depths.at(-1) === 0) {
          modes.pop();
          depths.pop();
          out += ' ';
          continue;
        }
        depths[depths.length - 1]--;
      }
    }
    out += c;
  }
  return out;
}

// External utilities a script might call; none is a sh builtin.
const UTILITIES = [
  'awk', 'basename', 'caffeinate', 'cat', 'chmod', 'chown', 'cp', 'cut', 'date', 'defaults', 'dirname',
  'dscl', 'env', 'find', 'grep', 'head', 'id', 'install', 'ioreg', 'launchctl', 'ln', 'ls', 'mkdir',
  'mktemp', 'mv', 'osascript', 'perl', 'plutil', 'pmset', 'python3', 'readlink', 'rm', 'rmdir', 'sed',
  'sleep', 'sort', 'stat', 'sudo', 'sysctl', 'tail', 'tee', 'test', 'touch', 'tr', 'uniq', 'visudo', 'xargs',
];
const BARE = new RegExp(`(?<![\\w/.$-])(${UTILITIES.join('|')})(?![\\w.-])`, 'g');

// Utility names used in code without a directory in front.
export const bareTools = (code) => [...code.matchAll(BARE)].map((match) => match[1]);

// Every /bin, /sbin, /usr/bin or /usr/sbin path used in code, deduplicated.
export const absoluteTools = (code) =>
  [...new Set([...code.matchAll(/(?<![\w.-])\/(?:usr\/)?s?bin\/[\w.-]+/g)].map((match) => match[0]))].sort();

// eval, source or `.` would let a root script run code it was handed.
export const sourcesCode = (code) => /(?<![\w.-])(?:eval|source)(?![\w.-])|(?:^|[;&|\s])\.\s+\S/m.test(code);
