import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { applicationKey } from './release-inputs.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, 'release-output'));
const commit = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Package a fixed commit on its native Linux architecture');
const workspace = await mkdtemp(join(tmpdir(), 'asset-release-'));
const stage = join(workspace, 'package');
await mkdir(stage);
async function checkLinks(directory, boundary = directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === '.bin') continue;
    const file = join(directory, item.name);
    if (item.isSymbolicLink()) {
      const target = await realpath(file);
      if (target !== boundary && !target.startsWith(boundary + sep)) throw new Error(`Release symlink escapes traced tree: ${file}`);
    } else if (item.isDirectory()) await checkLinks(file, boundary);
  }
}
async function copy(name, destination = name) {
  const source = join(root, name);
  if ((await stat(source)).isDirectory()) await checkLinks(source);
  await cp(source, join(stage, destination), { recursive: true, dereference: true, filter: path => path.split(sep).at(-1) !== '.bin' && path !== join(root, '.next/standalone/.next/cache') });
}
try {
  for (const name of ['.next/standalone', '.next/BUILD_ID', 'scripts/configure.mjs', 'scripts/backup.mjs', 'scripts/import-workbook.py']) await copy(name);
  await copy('.next/static', '.next/standalone/.next/static');
  await copy('public', '.next/standalone/public');
  await copy('drizzle', '.next/standalone/drizzle');
  const key = applicationKey(root, process.arch);
  await writeFile(join(stage, '.release-commit'), commit + '\n');
  await writeFile(join(stage, '.release-application-key'), key + '\n');
  // Standalone keeps its own package type. Root-level operational scripts use ESM.
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'asset-ledger-runtime', private: true, type: 'module' }) + '\n');
  await mkdir(output, { recursive: true });
  const file = `asset-ledger-${commit}-linux-${process.arch}.tar.gz`;
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', join(output, file), '-C', stage, '.']);
  const artifact = { file, sha256: createHash('sha256').update(await readFile(join(output, file))).digest('hex'), application_key: key };
  await writeFile(join(output, `release-manifest-${process.arch}.json`), JSON.stringify({ schema: 1, repository: 'hxx344/asset-ledger', commit, tag: `deploy-${commit}`, node_version: '24.15.0', artifacts: { [`linux-${process.arch}`]: artifact } }, null, 2) + '\n');
  console.log(`Prepared ${file}; application key ${key}`);
} finally { await rm(workspace, { recursive: true, force: true }); }
