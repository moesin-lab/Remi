import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

export function trustedPath(path, directory = false) {
  if (typeof path !== 'string' || realpathSync(path) !== path) throw Error('noncanonical supervisor path');
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.uid !== 0 || (stat.mode & 0o022) || !(current === path && !directory ? stat.isFile() : stat.isDirectory())) {
      throw Error('untrusted supervisor path');
    }
    if (dirname(current) === current) return path;
  }
}

export function approvedJson(path) {
  const fd = openSync(trustedPath(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > 1024 * 1024) throw Error('untrusted supervisor config');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
