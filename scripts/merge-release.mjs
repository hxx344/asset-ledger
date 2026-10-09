import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'release-output');
let manifest;
for (const architecture of ['x64', 'arm64']) {
  const part = JSON.parse(await readFile(join(directory, `release-manifest-${architecture}.json`), 'utf8'));
  if (part.schema !== 1 || part.repository !== 'hxx344/asset-ledger' || part.commit !== process.env.GITHUB_SHA || part.tag !== `deploy-${part.commit}` || part.node_version !== '24.15.0') throw new Error('Release metadata mismatch');
  const artifact = part.artifacts[`linux-${architecture}`];
  if (!artifact || !/^[a-f0-9]{64}$/.test(artifact.application_key) || artifact.file !== `asset-ledger-${part.commit}-linux-${architecture}.tar.gz`) throw new Error('Missing architecture artifact');
  if (createHash('sha256').update(await readFile(join(directory, artifact.file))).digest('hex') !== artifact.sha256) throw new Error('Artifact digest mismatch');
  manifest ??= { ...part, artifacts: {} };
  manifest.artifacts[`linux-${architecture}`] = artifact;
}
await writeFile(join(directory, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
