import { execFileSync } from 'node:child_process';

// Revisions from before the move use public/; later revisions in the parent
// repository use app/public/. A standalone app repository uses public/ again.
export function readRuntimeAt(root, ref, name) {
  for (const prefix of ['app/', '']) {
    try {
      return execFileSync('git', ['show', `${ref}:${prefix}${name}`], {cwd: root, stdio: ['ignore', 'pipe', 'ignore']});
    } catch { /* Try the other repository layout. */ }
  }
  throw new Error(`Runtime file ${name} was not found at ${ref}.`);
}

export function listRuntimeAt(root, ref) {
  for (const prefix of ['app/', '']) {
    const path = `${prefix}public/`;
    const files = execFileSync('git', ['ls-tree', '-r', '--full-tree', '--name-only', ref, '--', path], {cwd: root, encoding: 'utf8'}).trim();
    if (files) return files.split('\n').map(name => name.slice(prefix.length));
  }
  throw new Error(`No public files found at ${ref}.`);
}
