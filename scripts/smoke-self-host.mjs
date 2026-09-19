import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { configure } from './configure.mjs';

const directory = mkdtempSync(join(tmpdir(), 'asset-ledger-smoke-'));
const runtime = resolve('.next/standalone');
assert.ok(existsSync(join(runtime, 'server.js')), 'Run npm run build first');
cpSync('public', join(runtime, 'public'), { recursive: true });
cpSync('.next/static', join(runtime, '.next/static'), { recursive: true });
cpSync('drizzle', join(runtime, 'drizzle'), { recursive: true });
const password = 'smoke-test-password-12345';
configure(directory, { password });
const originalConfig = readFileSync(join(directory, 'config.json'), 'utf8');
let server, port, output = '';
async function start() {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  server = spawn(process.execPath, ['server.js'], {
    cwd: runtime, env: { ...process.env, NODE_ENV: 'production', ASSET_DATA_DIR: directory, ASSET_RELEASE: 'smoke', HOSTNAME: '127.0.0.1', PORT: String(port), NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  server.stdout.on('data', data => { output += data; });
  server.stderr.on('data', data => { output += data; });
  for (let count = 0; count < 100; count++) {
    if (server.exitCode !== null) throw new Error('Server exited: ' + output);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {}
    await delay(200);
  }
  throw new Error('Server did not become healthy: ' + output);
}
async function stop() {
  if (server && server.exitCode === null) {
    const stopped = new Promise(resolve => server.once('exit', resolve));
    server.kill(); await stopped;
  }
}
let cookie = '';
async function request(path, method = 'GET', body, extra = {}) {
  const origin = `http://127.0.0.1:${port}`;
  return fetch(origin + path, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin, 'Content-Type': 'application/json' } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
}
try {
  await start();
  assert.equal((await request('/')).status, 307);
  assert.equal((await request('/api/ledger', 'GET', undefined, { 'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'spoof@example.test' })).status, 401);
  assert.equal((await request('/api/import', 'POST', {})).status, 401);
  assert.equal((await request('/api/login', 'POST', { password }, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('/api/login', 'POST', { password: 'wrong-password-123' })).status, 401);
  const login = await request('/api/login', 'POST', { password });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /SameSite=strict/i);
  cookie = setCookie.split(';')[0];
  const ledger = await (await request('/api/ledger')).json();
  assert.equal(ledger.assets.length, 5);
  assert.equal(ledger.dataKind, 'example');
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/api/ledger', 'PATCH', { id: 'row-5', quantity: 789, price: 1 })).status, 200);
  assert.equal((await request('/api/ledger', 'PATCH', { fx: 7.2 }, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('/api/ledger', 'PATCH', { fx: 7.2 })).status, 200);
  await stop();
  configure(directory);
  await start();
  assert.equal(readFileSync(join(directory, 'config.json'), 'utf8'), originalConfig);
  const restored = await (await request('/api/ledger')).json();
  assert.equal(restored.assets.find(asset => asset.id === 'row-5').value, 789);
  assert.equal(restored.fx, 7.2);
  assert.ok(restored.history.some(period => period.id.startsWith('daily-')));

  // A migrated example ledger may already have edits, API connections and snapshots.
  // Seed synthetic encrypted bytes directly; importing must never decrypt or replace them.
  const database = new DatabaseSync(join(directory, 'ledger.sqlite'));
  const bybit = { ...restored.assets.find(a => a.mode === 'bybit'), quantity: 4321, price: 1, value: 4321, status: '只读同步', updatedAt: new Date().toISOString() };
  database.prepare('UPDATE assets SET data = ? WHERE owner = ? AND id = ?').run(JSON.stringify(bybit), 'owner', bybit.id);
  database.prepare('INSERT INTO connections(owner,exchange,encrypted,updated_at) VALUES(?,?,?,?)').run('owner', 'bybit', 'synthetic-encrypted-fixture', bybit.updatedAt);
  database.prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?)').run('owner', 'bybit-status', JSON.stringify({ lastSync: bybit.updatedAt, scope: 'test' }));
  database.close();
  const source = JSON.parse(readFileSync('lib/example-ledger.json', 'utf8'));
  source.source = 'synthetic-workbook.xlsx';
  const base = source.periods[0];
  base.rows = base.rows.slice(0, 3).map((asset, i) => ({ ...asset, id: `row-${20 + i}`, cell: `E${20 + i}`, quantity: 10 * (i + 1), price: 1, value: 10 * (i + 1), formula: '=' + '1+'.repeat(1500) + '1' }));
  base.rows.push({ id: 'row-23', cell: 'E23', project: 'Imported manual', kind: '资产', quantity: 80, price: 2, value: 160, formula: '=C23*D23' });
  base.total = base.rowSum = 220; base.cny = 1540;
  assert.ok(Buffer.byteLength(JSON.stringify(source)) > 8192, 'Exercise full workbook request size');
  assert.equal((await request('/api/import', 'POST', { source, apply: true }, { origin: 'https://untrusted.example' })).status, 403);
  const invalid = structuredClone(source); invalid.periods[0].total = 9999;
  assert.equal((await request('/api/import', 'POST', { source: invalid, apply: true })).status, 400);
  assert.equal((await request('/api/import', 'POST', { source, apply: false, padding: 'x'.repeat(5 * 1024 * 1024) })).status, 400);
  const previewResponse = await request('/api/import', 'POST', { source, apply: false });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.summary.rows, 4);
  assert.equal(preview.summary.resultingRows, 5, 'Keep edited unmatched asset');
  assert.equal((await (await request('/api/ledger')).json()).dataKind, 'example');
  assert.equal(existsSync(join(directory, 'backups')), false, 'Preview does not back up or mutate');
  const importedResponse = await request('/api/import', 'POST', { source, apply: true });
  assert.equal(importedResponse.status, 200);
  const imported = await importedResponse.json();
  assert.equal(imported.ledger.dataKind, 'personal');
  assert.equal(imported.ledger.assets.length, 5);
  assert.equal(imported.ledger.assets.find(a => a.mode === 'market').quantity, 10, 'Use original workbook quantity');
  assert.equal(imported.ledger.assets.find(a => a.mode === 'bybit').id, 'row-21', 'Map by project, not example row number');
  assert.equal(imported.ledger.assets.find(a => a.mode === 'bybit').value, 4321);
  assert.equal(imported.ledger.assets.find(a => a.project === '手动资产示例').value, 789);
  assert.equal(imported.ledger.assets.some(a => a.project === '积分示例'), false, 'Remove unchanged example');
  assert.equal(imported.ledger.fx, 7.2);
  assert.equal(imported.ledger.connections.bybit.configured, true);
  const archive = imported.ledger.history.find(p => p.archived && p.total !== 3610);
  assert.ok(archive);
  const archivedRows = await (await request('/api/history?id=' + archive.id)).json();
  assert.equal(archivedRows.rows.find(a => a.project === '手动资产示例').value, 789);
  assert.equal((await (await request('/api/history?id=E1')).json()).rows.length, 4);
  const saved = new DatabaseSync(join(directory, 'ledger.sqlite'));
  assert.equal(saved.prepare('SELECT encrypted FROM connections WHERE owner = ?').get('owner').encrypted, 'synthetic-encrypted-fixture');
  saved.close();
  const backup = new DatabaseSync(join(directory, 'backups', imported.backupName));
  assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 5);
  assert.equal(JSON.parse(backup.prepare("SELECT value FROM settings WHERE key = 'source-ledger'").get().value).source, '示例数据（非真实资产）');
  backup.close();
  assert.equal((await request('/api/ledger', 'PATCH', { id: 'row-23', quantity: 123, price: 2 })).status, 200);
  const repeated = await (await request('/api/import', 'POST', { source, apply: true })).json();
  assert.equal(repeated.alreadyImported, true);
  assert.equal(repeated.ledger.assets.find(a => a.id === 'row-23').value, 246);
  const changed = structuredClone(source); changed.source = 'different-workbook.xlsx';
  assert.equal((await request('/api/import', 'POST', { source: changed, apply: true })).status, 400);
  assert.equal(readdirSync(join(directory, 'backups')).length, 1);
  await stop(); await start();
  const afterImportRestart = await (await request('/api/ledger')).json();
  assert.equal(afterImportRestart.dataKind, 'personal');
  assert.equal(afterImportRestart.assets.find(a => a.id === 'row-23').value, 246);
  assert.equal((await request('/api/logout', 'POST', {})).status, 200);
  cookie = '';
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await request('/api/login', 'POST', { password: 'incorrect-test-password' })).status, 401);
  assert.equal((await request('/api/login', 'POST', { password })).status, 429);
  console.log('Production smoke passed: authentication, edit, validated import, automatic backup, connection/edit/history preservation, idempotency, restart persistence and login throttling.');
} finally { await stop(); rmSync(directory, { recursive: true }); }
