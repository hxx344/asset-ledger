import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { configure } from './configure.mjs';
import { openDatabase } from '../lib/sqlite.ts';
import { tradingConnectionRevision } from '../lib/trading-export.ts';

// All configuration, keys and SQLite records below are generated test fixtures.
const directory = mkdtempSync(join(tmpdir(), 'asset-trading-export-smoke-'));
const runtime = resolve('.next/standalone');
const password = 'synthetic-asset-owner-password';
let database, server, output = '', cookie = '', origin;
const binance = { exchange: 'binance', apiKey: 'synthetic-binance-key-1234', apiSecret: 'synthetic-binance-secret-5678' };
const bybit = { exchange: 'bybit', apiKey: 'synthetic-bybit-key-4321', apiSecret: 'synthetic-bybit-secret-8765', region: 'global' };

async function request(path, method = 'GET', body, headers = {}) {
  return fetch(origin + path, {
    method, redirect: 'manual', headers: {
      ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function stop() {
  const running = server;
  server = undefined;
  if (running && running.exitCode === null && running.signalCode === null) {
    const stopped = new Promise(resolve => running.once('exit', resolve));
    running.kill(); await stopped;
  }
}

try {
  assert.ok(existsSync(join(runtime, 'server.js')), 'Run npm run build first');
  cpSync('drizzle', join(runtime, 'drizzle'), { recursive: true });
  configure(directory, { password });
  const configuration = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
  const encryptionKey = await crypto.subtle.importKey('raw', Buffer.from(configuration.credentialKey, 'hex'), 'AES-GCM', false, ['encrypt']);
  database = openDatabase(join(directory, 'ledger.sqlite'));
  const put = async (owner, exchange, value) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(owner + ':' + exchange) },
      encryptionKey, new TextEncoder().encode(JSON.stringify(value)));
    const encrypted = JSON.stringify({ iv: Array.from(iv), cipher: Array.from(new Uint8Array(cipher)) });
    await database.prepare(`INSERT INTO connections(owner,exchange,encrypted,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(owner,exchange) DO UPDATE SET encrypted=excluded.encrypted,updated_at=excluded.updated_at`)
      .bind(owner, exchange, encrypted, '2026-10-07T04:00:00.000Z').run();
    return tradingConnectionRevision(encrypted);
  };
  const revision = await put('owner', 'binance', binance);
  const bybitRevision = await put('owner', 'bybit', bybit);
  await put('other', 'binance', { ...binance, apiKey: 'synthetic-other-owner-key' });
  await put('owner', 'aster', { exchange: 'aster', privateKey: 'synthetic-aster-private-key' });
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: runtime,
    env: { ...process.env, ASSET_DATA_DIR: directory, NODE_ENV: 'production', PUBLIC_ORIGIN: origin,
      HOSTNAME: '127.0.0.1', PORT: String(port), NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  server.stdout.on('data', data => { output += data; });
  server.stderr.on('data', data => { output += data; });
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(server.exitCode, null, 'Fixture server must remain running');
    try { if ((await request('/api/health')).ok) { healthy = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(healthy, 'Fixture server must become healthy');

  const exportPath = '/api/hub/trading-connections/export';
  const input = { exchange: 'binance', revision, password };
  assert.equal((await request('/api/hub/trading-connections')).status, 401);
  assert.equal((await request(exportPath, 'POST', input)).status, 401);
  const login = await request('/api/login', 'POST', { password });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const catalogResponse = await request('/api/hub/trading-connections');
  assert.equal(catalogResponse.status, 200);
  assert.equal(catalogResponse.headers.get('cache-control'), 'no-store');
  const catalogText = await catalogResponse.text(), catalog = JSON.parse(catalogText);
  assert.deepEqual(catalog.connections.map(row => row.exchange), ['binance', 'bybit']);
  assert.equal(catalog.connections[0].revision, revision);
  assert.equal(catalog.connections[0].label, '1234');
  for (const secret of [binance.apiKey, binance.apiSecret, bybit.apiKey, bybit.apiSecret, 'synthetic-other-owner-key', 'synthetic-aster-private-key']) {
    assert.equal(catalogText.includes(secret), false);
  }
  assert.equal((await request(exportPath, 'POST', input, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request(exportPath, 'POST', input, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request(exportPath, 'POST', input, { 'content-type': 'text/plain' })).status, 400);
  assert.equal((await request(exportPath, 'POST', { ...input, password: undefined })).status, 400);
  assert.equal((await request(exportPath, 'POST', { ...input, exchange: 'aster' })).status, 400);
  assert.equal((await request(exportPath, 'POST', { ...input, owner: 'other' })).status, 400);
  assert.equal((await request(exportPath, 'POST', { ...input, password: 'wrong-password' })).status, 401);
  const exported = await request(exportPath, 'POST', input);
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await exported.json(), {
    schemaVersion: 1, exchange: 'binance', revision, region: 'global', credentials: { apiKey: binance.apiKey, apiSecret: binance.apiSecret },
  });
  const exportedBybit = await request(exportPath, 'POST', { ...input, exchange: 'bybit', revision: bybitRevision });
  assert.equal(exportedBybit.status, 200);
  assert.equal((await exportedBybit.json()).region, 'global');
  const unsupportedRevision = await put('owner', 'bybit', { ...bybit, region: 'eu' });
  const unsupported = (await (await request('/api/hub/trading-connections')).json()).connections[1];
  assert.equal(unsupported.configured, false);
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.reason, /global/);
  assert.equal((await request(exportPath, 'POST', { ...input, exchange: 'bybit', revision: unsupportedRevision })).status, 409);
  await put('owner', 'binance', binance);
  assert.equal((await request(exportPath, 'POST', input)).status, 409);
  const corrupt = 'synthetic-corrupt-vault-' + binance.apiSecret;
  await database.prepare("UPDATE connections SET encrypted = ? WHERE owner = 'owner' AND exchange = 'binance'").bind(corrupt).run();
  const corruptCatalogResponse = await request('/api/hub/trading-connections');
  const corruptCatalogText = await corruptCatalogResponse.text();
  assert.equal(JSON.parse(corruptCatalogText).connections[0].supported, false);
  assert.equal(corruptCatalogText.includes(binance.apiSecret), false);
  const corruptExport = await request(exportPath, 'POST', { ...input, revision: tradingConnectionRevision(corrupt) });
  assert.equal(corruptExport.status, 409);
  assert.equal((await corruptExport.text()).includes(binance.apiSecret), false);
  const latestRevision = await put('owner', 'binance', binance);
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal((await request(exportPath, 'POST', { ...input, revision: latestRevision, password: 'wrong-password' })).status, 401);
  }
  const limited = await request(exportPath, 'POST', { ...input, revision: latestRevision });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('cache-control'), 'no-store');
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM assets').first()).count, 0);
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM snapshots').first()).count, 0);
  await stop();
  for (const secret of [password, binance.apiKey, binance.apiSecret, bybit.apiKey, bybit.apiSecret, 'synthetic-aster-private-key']) {
    assert.equal(output.includes(secret), false, 'Server logs must not expose fixture credentials');
  }
  console.log('Asset trading-export route smoke passed: authorization, metadata, password, revision, region, rate limit and redaction.');
} finally {
  await stop();
  database?.close();
  // Only remove the fixture directory created by this run, after resolving its boundary.
  const target = resolve(directory), parent = resolve(tmpdir()) + sep;
  assert.ok(target.startsWith(parent) && target.slice(parent.length).startsWith('asset-trading-export-smoke-'));
  rmSync(target, { recursive: true, force: true });
}
