import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function releaseInput(name) {
  if (/^(?:docs|tests|\.github|\.openai|\.codex|\.agents)\//.test(name)) return false;
  if (!name.includes('/') && (/\.md$/i.test(name) || /^\.git/.test(name))) return false;
  if (/^deploy\/(?:release-common\.sh|test-release\.py)$/.test(name) || /^scripts\/(?:publish|merge)-release\.mjs$/.test(name)) return false;
  return name !== 'install.sh' && name !== 'lib/imported-ledger.json';
}

export function applicationKey(root, architecture) {
  if (!['x64', 'arm64'].includes(architecture)) throw new Error('Unsupported release architecture');
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(name => name && releaseInput(name)).sort();
  const hash = createHash('sha256').update(`asset-ci-standalone-v1\0node-24.15.0\0linux-${architecture}\0`);
  for (const name of paths) {
    const data = readFileSync(join(root, name));
    hash.update(`${name}\0${data.length}\0`).update(data);
  }
  return hash.digest('hex');
}
