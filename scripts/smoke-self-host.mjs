import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Wallet } from 'ethers';
import { pathToFileURL } from 'node:url';
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
  server = spawn(process.execPath, ['--import', pathToFileURL(resolve('tests/fixtures/exchange-fetch.mjs')).href, 'server.js'], {
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
  assert.equal((await request('/api/withdrawals', 'POST', {})).status, 401);
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
  const apiWallet = Wallet.createRandom();
  const walletCredentials = { exchange: 'aster', walletAddress: apiWallet.address, privateKey: apiWallet.privateKey, includeSpot: true };
  assert.equal((await request('/api/connections', 'POST', { exchange: 'aster', apiKey: 'old-key', apiSecret: 'old-secret', includeSpot: false })).status, 400);
  const connectedResponse = await request('/api/connections', 'POST', walletCredentials);
  const connectedText = await connectedResponse.text();
  assert.equal(connectedResponse.status, 200);
  assert.equal(connectedText.includes(apiWallet.privateKey), false);
  const connected = JSON.parse(connectedText);
  assert.equal(connected.assets.find(a => a.mode === 'aster').value, 150);
  assert.equal(connected.connections.aster.configured, true);
  assert.equal(connected.connections.aster.label, apiWallet.address.slice(-4));
  const secureDb = new DatabaseSync(join(directory, 'ledger.sqlite'));
  const encrypted = secureDb.prepare("SELECT encrypted FROM connections WHERE exchange = 'aster'").get().encrypted;
  assert.equal(encrypted.includes(apiWallet.privateKey), false);
  const sealed = JSON.parse(encrypted), configuration = JSON.parse(originalConfig);
  const encryptionKey = await crypto.subtle.importKey('raw', Buffer.from(configuration.credentialKey, 'hex'), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(sealed.iv), additionalData: new TextEncoder().encode('owner:aster') }, encryptionKey, new Uint8Array(sealed.cipher));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), walletCredentials);
  const rejectedResponse = await request('/api/connections', 'POST', { ...walletCredentials, walletAddress: '0x' + '0'.repeat(40) });
  assert.equal(rejectedResponse.status, 400);
  assert.equal((await rejectedResponse.text()).includes(apiWallet.privateKey), false);
  assert.equal(secureDb.prepare("SELECT encrypted FROM connections WHERE exchange = 'aster'").get().encrypted, encrypted);
  secureDb.close();
  await stop(); await start();
  const syncedAfterRestart = await (await request('/api/sync', 'POST', {})).json();
  assert.equal(syncedAfterRestart.assets.find(a => a.mode === 'aster').value, 150);
  assert.equal(syncedAfterRestart.connections.aster.error, null);
  assert.equal(syncedAfterRestart.fx, 7.1234);
  assert.equal(syncedAfterRestart.fxStatus.source, 'Coinbase');
  assert.equal(syncedAfterRestart.fxStatus.error, null);
  assert.equal(syncedAfterRestart.history.find(p => p.id === 'E1').fx, source.periods[0].fx, 'Original history keeps its historical exchange rate');
  const dailyFx = syncedAfterRestart.history.find(p => p.id.startsWith('daily-') && !p.archived);
  assert.equal(dailyFx.fx, 7.1234);
  assert.equal(dailyFx.cny, dailyFx.total * 7.1234);
  assert.equal(dailyFx.fxStatus.source, 'Coinbase');
  const forceSync = async () => {
    const fxDb = new DatabaseSync(join(directory, 'ledger.sqlite'));
    fxDb.prepare("UPDATE settings SET value='0' WHERE owner='owner' AND key='last-attempt'").run();
    fxDb.close();
    const response = await request('/api/sync', 'POST', {});
    assert.equal(response.status, 200);
    return response.json();
  };
  writeFileSync(join(directory, 'fx-failure'), 'fixture');
  const failedFx = await forceSync();
  assert.equal(failedFx.fx, 7.1234, 'Provider failure preserves the rate');
  assert.equal(failedFx.fxStatus.fetchedAt, syncedAfterRestart.fxStatus.fetchedAt, 'Failure cannot renew the quote timestamp');
  assert.match(failedFx.fxStatus.error, /保留上次汇率/);
  assert.equal(failedFx.connections.aster.error, null, 'FX failure does not block exchange updates');
  await stop(); await start();
  assert.equal((await (await request('/api/ledger')).json()).fx, 7.1234, 'Auto rate persists across restart');
  rmSync(join(directory, 'fx-failure'));
  writeFileSync(join(directory, 'market-failure'), 'fixture');
  const independentFx = await forceSync();
  assert.equal(independentFx.fxStatus.error, null, 'FX refresh remains independent of crypto quote failures');
  assert.ok(independentFx.assets.find(a => a.mode === 'market').error);
  rmSync(join(directory, 'market-failure'));
  await forceSync();
  assert.equal(output.includes(apiWallet.privateKey), false);
  // Existing databases need no schema migration; old snapshots derive workbook withdrawals from their rows.
  const withdrawalDb = new DatabaseSync(join(directory, 'ledger.sqlite'));
  const oldRows = [{ id: 'row-999', project: '出金', value: 25 }];
  withdrawalDb.prepare('INSERT INTO snapshots(owner,date,data) VALUES(?,?,?)').run('owner', '2020-01-01', JSON.stringify({ id: 'daily-2020-01-01', date: '2020-01-01', total: 125, fx: 7, cny: 875, future: false, difference: 0, assets: oldRows }));
  withdrawalDb.close();
  const beforeWithdrawal = await (await request('/api/ledger')).json();
  assert.deepEqual(beforeWithdrawal.withdrawals, []);
  assert.equal(beforeWithdrawal.history.find(p => p.date === '2020-01-01').withdrawn, 25);
  const withdrawal = { id: crypto.randomUUID(), date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }), amount: 100.25, note: 'Synthetic withdrawal' };
  assert.equal((await request('/api/withdrawals', 'POST', withdrawal, { origin: 'https://untrusted.example' })).status, 403);
  for (const invalid of [{ amount: -1 }, { amount: 0.001 }, { date: '2099-01-01' }, { date: '2020-01-01' }, { date: '2026-02-30' }, { owner: 'other' }]) {
    assert.equal((await request('/api/withdrawals', 'POST', { ...withdrawal, ...invalid })).status, 400);
  }
  const createdResponse = await request('/api/withdrawals', 'POST', withdrawal);
  assert.equal(createdResponse.status, 200);
  const createdWithdrawal = await createdResponse.json();
  assert.equal(createdWithdrawal.withdrawals.length, 1);
  assert.equal(createdWithdrawal.withdrawals[0].amount, 100.25);
  assert.deepEqual(createdWithdrawal.assets, beforeWithdrawal.assets, 'Registering a withdrawal never debits holdings');
  assert.equal(createdWithdrawal.history.find(p => p.date === '2020-01-01').total, 125);
  assert.equal((await (await request('/api/withdrawals', 'POST', withdrawal)).json()).withdrawals.length, 1, 'Retries are idempotent');
  const editedWithdrawal = await (await request('/api/withdrawals', 'PATCH', { ...withdrawal, amount: 90.5 })).json();
  assert.equal(editedWithdrawal.withdrawals[0].amount, 90.5);
  await stop(); await start();
  assert.equal((await (await request('/api/ledger')).json()).withdrawals[0].amount, 90.5);
  const deletedWithdrawal = await (await request('/api/withdrawals', 'DELETE', { id: withdrawal.id })).json();
  assert.deepEqual(deletedWithdrawal.withdrawals, []);
  assert.equal((await request('/api/withdrawals', 'PATCH', withdrawal)).status, 400);
  assert.equal((await (await request('/api/withdrawals', 'DELETE', { id: withdrawal.id })).json()).withdrawals.length, 0);
  assert.equal((await request('/api/logout', 'POST', {})).status, 200);
  cookie = '';
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await request('/api/login', 'POST', { password: 'incorrect-test-password' })).status, 401);
  assert.equal((await request('/api/login', 'POST', { password })).status, 429);
  console.log('Production smoke passed: authentication, import and backup, edits/history, Aster API wallet encryption, automatic FX/failure preservation, restart synchronization, withdrawal CRUD/persistence and login throttling.');
} finally { await stop(); rmSync(directory, { recursive: true }); }
