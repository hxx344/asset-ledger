// Standalone production integration checks. Every account and credential is synthetic.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { configure } from '../../scripts/configure.mjs';

const credentials = { exchange: 'variational', vrToken: 'synthetic-var-token' };
const replacement = { exchange: 'variational', vrToken: 'synthetic-var-token-replacement' };
const password = 'synthetic-var-password-12345';
const rowOf = ledger => ledger.assets.find(asset => asset.mode === 'variational');
const assertNoSecrets = text => {
  for (const value of [credentials.vrToken, replacement.vrToken, 'synthetic-var-returned-token', 'PRIVATE_DIAGNOSTIC_ACCOUNT']) assert.equal(text.includes(value), false, 'Session values cannot appear in responses or logs');
};
const diagnosticCases = [
  { fixture: { failure: 401 }, kind: 'unauthorized' },
  { fixture: { failure: 403 }, kind: 'forbidden' },
  ...[403, 401, 200].map(status => ({ fixture: { challenge: true, status }, kind: 'challenge' })),
  { fixture: { html: true, status: 200 }, kind: 'html' },
];
function assertDiagnostic(message, kind) {
  assert.equal(typeof message, 'string');
  assertNoSecrets(message);
  if (kind === 'challenge') {
    assert.match(message, /Cloudflare/);
    assert.match(message, /浏览器验证/);
  } else if (kind === 'unauthorized') {
    assert.match(message, /HTTP 401/);
    assert.match(message, /更新 vr-token/);
  } else if (kind === 'forbidden') {
    assert.match(message, /HTTP 403/);
    assert.doesNotMatch(message, /Cloudflare/);
  } else if (kind === 'html') {
    assert.match(message, /网页/);
    assert.doesNotMatch(message, /Cloudflare/);
  }
  if (kind !== 'unauthorized') assert.doesNotMatch(message, /更新 vr-token|已失效|已过期/);
}
function assertPreserved(actual, before) {
  for (const field of ['id', 'value', 'quantity', 'price', 'updatedAt', 'details']) assert.deepEqual(actual[field], before[field], `Preserve Var ${field}`);
}
function sourceFor(alias) {
  const source = JSON.parse(readFileSync(resolve('lib/example-ledger.json'), 'utf8'));
  source.source = `synthetic-${alias}-workbook.xlsx`;
  const period = source.periods[0];
  period.rows = period.rows.slice(0, 3);
  period.rows.push({ id: 'row-40', cell: 'E40', project: alias, kind: '资产', quantity: 999, price: 1, value: 999 });
  period.total = period.rowSum = period.rows.reduce((sum, row) => sum + row.value, 0);
  period.cny = period.total * period.fx;
  return source;
}

async function scenario(runtime, sourceAlias, full) {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, 'asset-var-smoke-'));
  configure(directory, { password });
  const configuration = readFileSync(join(directory, 'config.json'), 'utf8');
  let server, port, cookie = '', output = '';
  const fixture = value => writeFileSync(join(directory, 'variational-fixture.json'), JSON.stringify(value));
  const database = action => {
    const db = new DatabaseSync(join(directory, 'ledger.sqlite'));
    try { return action(db); } finally { db.close(); }
  };
  const encrypted = () => database(db => db.prepare("SELECT encrypted FROM connections WHERE owner='owner' AND exchange='variational'").get()?.encrypted);
  const diagnosticRequests = () => {
    const file = join(directory, 'variational-diagnostic-requests.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  const assertReport = (report, portfolioOutcome, pythonOutcome = 'ok') => {
    assert.deepEqual(Object.keys(report).sort(), ['checkedAt', 'clients']);
    assert.ok(Number.isFinite(Date.parse(report.checkedAt)));
    assert.deepEqual(report.clients.map(client => client.client), ['asset-node', 'grid-python']);
    assert.deepEqual(report.clients[0].results.map(result => [result.endpoint, result.path, result.outcome]), [
      ['session', '/api/me', 'ok'], ['portfolio', '/api/portfolio?compute_margin=true', portfolioOutcome],
    ]);
    assert.deepEqual(report.clients[1].results.map(result => [result.endpoint, result.path, result.outcome]), [
      ['session', '/api/me', pythonOutcome],
    ]);
    for (const client of report.clients) {
      assert.deepEqual(Object.keys(client).sort(), ['checkedAt', 'client', 'results']);
      assert.ok(Number.isFinite(Date.parse(client.checkedAt)));
      for (const result of client.results) {
        assert.deepEqual(Object.keys(result).sort(), ['challenge', 'contentType', 'elapsedMs', 'endpoint', 'outcome', 'path', 'status', 'structureOk']);
        assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
      }
    }
    assertNoSecrets(JSON.stringify(report));
  };
  const expectedDiagnosticRequests = ['asset-node /api/me', 'asset-node /api/portfolio?compute_margin=true', 'grid-python /api/me'];
  const requestLabels = requests => requests.map(({ client, path }) => `${client} ${path}`).sort();
  async function start() {
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    server = spawn(process.execPath, ['--import', pathToFileURL(resolve('tests/fixtures/exchange-fetch.mjs')).href, 'server.js'], {
      cwd: runtime,
      env: { ...process.env, NODE_ENV: 'production', ASSET_DATA_DIR: directory, ASSET_RELEASE: 'var-smoke', HOSTNAME: '127.0.0.1', PORT: String(port), NEXT_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    server.stdout.on('data', data => { output += data; });
    server.stderr.on('data', data => { output += data; });
    for (let count = 0; count < 100; count++) {
      if (server.exitCode !== null) throw new Error('Var smoke server exited: ' + output);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {}
      await delay(200);
    }
    throw new Error('Var smoke server did not become healthy: ' + output);
  }
  async function stop() {
    if (server && server.exitCode === null) {
      const stopped = new Promise(resolve => server.once('exit', resolve));
      server.kill(); await stopped;
    }
  }
  async function request(path, method = 'GET', body, extra = {}) {
    const origin = `http://127.0.0.1:${port}`;
    return fetch(origin + path, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin, 'Content-Type': 'application/json' } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function json(path, method = 'GET', body, status = 200, extra = {}) {
    const response = await request(path, method, body, extra);
    const text = await response.text();
    assertNoSecrets(text);
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    return JSON.parse(text);
  }
  const ledger = () => json('/api/ledger');
  const connect = (value = credentials, status = 200) => json('/api/connections', 'POST', value, status);
  async function forceSync() {
    database(db => db.prepare("UPDATE settings SET value='0' WHERE owner='owner' AND key='last-attempt'").run());
    return json('/api/sync', 'POST', {});
  }
  async function restart() { await stop(); configure(directory); await start(); }

  try {
    await start();
    for (const method of ['POST', 'DELETE']) await json('/api/connections', method, credentials, 401);
    if (full) await json('/api/connections/variational-test', 'POST', { vrToken: credentials.vrToken }, 401);
    const login = await request('/api/login', 'POST', { password });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    const initial = await ledger();
    const initialCount = initial.assets.length;
    assert.equal(initial.connections.variational.configured, false);
    assert.equal(rowOf(initial), undefined, 'Reading an existing ledger must not add a placeholder');
    for (const method of ['POST', 'DELETE']) await json('/api/connections', method, credentials, 403, { origin: 'https://untrusted.example' });

    if (full) {
      const diagnosticPath = '/api/connections/variational-test';
      fixture({ diagnosticOnly: true, challenge: true, status: 403 });
      await json(diagnosticPath, 'POST', { vrToken: credentials.vrToken }, 403, { origin: 'https://untrusted.example' });
      await json(diagnosticPath, 'POST', { vrToken: credentials.vrToken }, 400, { 'Content-Type': 'text/plain' });
      for (const body of [
        { vrToken: 123 }, { vrToken: '' }, { vrToken: credentials.vrToken, exchange: 'variational' },
        { vrToken: credentials.vrToken, url: 'https://untrusted.example' }, { vrToken: 'a'.repeat(9000) },
      ]) await json(diagnosticPath, 'POST', body, 400);
      assert.deepEqual(diagnosticRequests(), [], 'Rejected diagnostics cannot make any upstream request');
      const diagnostic = await json(diagnosticPath, 'POST', { vrToken: credentials.vrToken });
      assertReport(diagnostic, 'challenge');
      assert.equal(diagnostic.clients[0].results[0].structureOk, true);
      assert.equal(diagnostic.clients[0].results[1].status, 403);
      assert.equal(diagnostic.clients[0].results[1].challenge, true);
      assert.equal(diagnostic.clients[0].results[1].structureOk, null);
      assert.deepEqual(requestLabels(diagnosticRequests()), expectedDiagnosticRequests);
      const afterDiagnostic = await ledger();
      assert.deepEqual(afterDiagnostic.assets, initial.assets, 'Diagnostics cannot create or modify ledger assets');
      assert.deepEqual(afterDiagnostic.connections, initial.connections);
      assert.equal(encrypted(), undefined, 'A diagnostic cannot save the supplied session');
      const limited = await json(diagnosticPath, 'POST', { vrToken: credentials.vrToken }, 429);
      assert.deepEqual(Object.keys(limited), ['error']);
      assert.equal(diagnosticRequests().length, 3, 'Cooldown cannot make extra upstream requests');

      for (const invalid of [
        { ...credentials, vrToken: '' }, { ...credentials, vrToken: 'vr-token=' + credentials.vrToken },
        { ...credentials, vrToken: credentials.vrToken + '; extra=value' },
        { ...credentials, apiKey: 'unused-key', apiSecret: 'unused-secret' },
        { ...credentials, url: 'https://untrusted.example' },
      ]) await connect(invalid, 400);
      for (const item of diagnosticCases) {
        fixture(item.fixture);
        const error = await connect(credentials, 400);
        assertDiagnostic(error.error, item.kind);
        const rejected = await ledger();
        assert.equal(rejected.assets.length, initialCount, 'Failed first verification cannot add a row');
        assert.equal(rowOf(rejected), undefined, 'Failed first verification cannot create an asset');
        assert.deepEqual(rejected.connections.variational, initial.connections.variational);
        assert.equal(encrypted(), undefined, 'Failed first verification cannot save a credential');
      }

      fixture({ balance: '0', quote: 0.98 });
      const zero = await connect();
      assert.equal(zero.assets.length, initialCount + 1);
      assert.equal(rowOf(zero).value, 0);
      assert.equal(rowOf(zero).details[0].quantity, 0);
      assert.equal(zero.connections.variational.configured, true);
      assert.equal(zero.connections.variational.label, undefined, 'No session suffix may be exposed as a label');
      await json('/api/ledger', 'PATCH', { id: rowOf(zero).id, quantity: 1000, price: 1 }, 400);
      const sealed = JSON.parse(encrypted());
      assertNoSecrets(encrypted());
      const key = await crypto.subtle.importKey('raw', Buffer.from(JSON.parse(configuration).credentialKey, 'hex'), 'AES-GCM', false, ['decrypt']);
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(sealed.iv), additionalData: new TextEncoder().encode('owner:variational') }, key, new Uint8Array(sealed.cipher));
      assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), credentials);
      await assert.rejects(crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(sealed.iv), additionalData: new TextEncoder().encode('owner:bybit') }, key, new Uint8Array(sealed.cipher)));

      fixture({ balance: -50, quote: 0.98 });
      const negative = await connect();
      assert.equal(negative.assets.length, initialCount + 1);
      assert.equal(negative.assets.filter(asset => asset.mode === 'variational').length, 1);
      assert.equal(rowOf(negative).id, rowOf(zero).id);
      assert.equal(rowOf(negative).value, -49, 'Negative USDC net equity is retained and converted');
      assert.equal(rowOf(negative).details[0].quantity, -50);
      assert.equal(rowOf(negative).details[0].price, 0.98);
      const savedCipher = encrypted();
      await restart();
      fixture({ diagnosticOnly: true, balance: '982174.625', pythonSession: { challenge: true, status: 403 } });
      const healthyDiagnostic = await json(diagnosticPath, 'POST', { vrToken: replacement.vrToken });
      assertReport(healthyDiagnostic, 'ok', 'challenge');
      assert.equal(JSON.stringify(healthyDiagnostic).includes('982174.625'), false, 'Diagnostics cannot return account values');
      assert.deepEqual(requestLabels(diagnosticRequests().slice(3)), expectedDiagnosticRequests);
      const unchanged = await ledger();
      assert.deepEqual(rowOf(unchanged), rowOf(negative), 'Diagnostic success cannot modify amounts, details or updatedAt');
      assert.deepEqual(unchanged.connections.variational, negative.connections.variational);
      assert.equal(encrypted(), savedCipher, 'Testing a replacement token cannot replace the encrypted connection');
      for (const item of [...diagnosticCases, { fixture: { failure: 503 } }]) {
        fixture(item.fixture);
        const error = await connect(replacement, 400);
        if (item.kind) assertDiagnostic(error.error, item.kind);
        const failedReplacement = await ledger();
        assert.deepEqual(rowOf(failedReplacement), rowOf(negative));
        assert.deepEqual(failedReplacement.connections.variational, negative.connections.variational);
        assert.equal(encrypted(), savedCipher, 'Rejected replacement cannot overwrite the saved session');
      }

      for (const item of [...diagnosticCases, ...[
        { failure: 503 }, { portfolio: { balance: null } }, { balance: '300', geckoFailure: true, coinbaseFailure: true },
      ].map(value => ({ fixture: value }))]) {
        fixture(item.fixture);
        const failed = await forceSync();
        assertPreserved(rowOf(failed), rowOf(negative));
        assert.equal(failed.connections.variational.lastSync, negative.connections.variational.lastSync);
        assert.equal(failed.connections.variational.configured, true);
        assert.ok(failed.connections.variational.error);
        assert.ok(rowOf(failed).error);
        if (item.kind) {
          assertDiagnostic(failed.connections.variational.error, item.kind);
          assertDiagnostic(rowOf(failed).error, item.kind);
        }
        assert.equal(encrypted(), savedCipher);
      }
      fixture({ balance: '200', geckoFailure: true, coinbaseRate: '0.5' });
      const fallback = await forceSync();
      assert.equal(rowOf(fallback).value, 100, 'Coinbase USDC/USD is used when CoinGecko fails');
      assert.equal(fallback.connections.variational.error, null);

      for (const suffix of ['', '?include=okx']) {
        const catalog = await json('/api/hub/trading-connections' + suffix);
        assert.deepEqual(catalog.connections.map(item => item.exchange), suffix ? ['binance', 'bybit', 'okx'] : ['binance', 'bybit']);
      }
      const revision = createHash('sha256').update(savedCipher).digest('hex');
      for (const exchange of ['variational', 'var']) await json('/api/hub/trading-connections/export', 'POST', { exchange, revision, password }, 400);

      // Simulate older saved rows that predate automatic alias recognition.
      for (const project of [' VAR ', ' VaRiAtIoNaL ']) {
        const before = await ledger();
        const manual = { ...rowOf(before), project, mode: 'manual' };
        database(db => db.prepare('UPDATE assets SET data=? WHERE owner=? AND id=?').run(JSON.stringify(manual), 'owner', manual.id));
        fixture({ balance: '88', quote: 0.5 });
        const reused = await connect();
        assert.equal(reused.assets.length, initialCount + 1);
        assert.equal(rowOf(reused).id, manual.id, 'Connection reuses an existing manual Var alias');
        assert.equal(rowOf(reused).value, 44);
      }
      const beforeDuplicate = await ledger();
      const manual = { ...rowOf(beforeDuplicate), project: 'var', mode: 'manual' };
      const duplicate = { ...manual, id: 'row-900', cell: 'E900', project: 'variational' };
      database(db => {
        db.prepare('UPDATE assets SET data=? WHERE owner=? AND id=?').run(JSON.stringify(manual), 'owner', manual.id);
        db.prepare('INSERT INTO assets(owner,id,data) VALUES(?,?,?)').run('owner', duplicate.id, JSON.stringify(duplicate));
      });
      const duplicateCipher = encrypted();
      await connect(replacement, 400);
      const rejectedDuplicate = await ledger();
      assert.deepEqual(rejectedDuplicate.assets.find(asset => asset.id === manual.id), manual);
      assert.deepEqual(rejectedDuplicate.assets.find(asset => asset.id === duplicate.id), duplicate);
      assert.equal(encrypted(), duplicateCipher);
      database(db => db.prepare('DELETE FROM assets WHERE owner=? AND id=?').run('owner', duplicate.id));
      const reconnected = await connect();
      const restartCipher = encrypted();
      await restart();
      assert.equal(readFileSync(join(directory, 'config.json'), 'utf8'), configuration);
      const restored = await ledger();
      assertPreserved(rowOf(restored), rowOf(reconnected));
      assert.equal(restored.connections.variational.configured, true);
      assert.equal(encrypted(), restartCipher);
      fixture({ balance: '90', quote: 0.5 });
      const syncedAfterRestart = await forceSync();
      assert.equal(rowOf(syncedAfterRestart).value, 45, 'Restarted server decrypts the saved session and resumes syncing');
      assert.equal(syncedAfterRestart.connections.variational.error, null);
      const disconnected = await json('/api/connections', 'DELETE', { exchange: 'variational' });
      assert.equal(disconnected.connections.variational.configured, false);
      assert.equal(disconnected.connections.variational.lastSync, syncedAfterRestart.connections.variational.lastSync);
      assertPreserved(rowOf(disconnected), rowOf(syncedAfterRestart));
      assert.equal(encrypted(), undefined);
      const again = await json('/api/connections', 'DELETE', { exchange: 'variational' });
      assert.equal(again.assets.length, initialCount + 1);
      await restart();
      const restoredDisconnected = await ledger();
      assert.equal(restoredDisconnected.connections.variational.configured, false);
      assertPreserved(rowOf(restoredDisconnected), rowOf(disconnected));
    } else {
      fixture({ balance: '125', quote: 0.8 });
      const connected = await connect();
      assert.equal(rowOf(connected).value, 100, 'Top-level balance is authoritative; P&L, margin and sub-accounts are not added again');
    }

    const beforeImport = await ledger();
    const beforeImportCipher = encrypted();
    const source = sourceFor(sourceAlias);
    const duplicateSource = structuredClone(source);
    const baseline = duplicateSource.periods[0];
    baseline.rows.push({ ...baseline.rows.at(-1), id: 'row-41', cell: 'E41', project: sourceAlias === 'var' ? 'variational' : 'var' });
    baseline.total = baseline.rowSum = baseline.rows.reduce((sum, asset) => sum + asset.value, 0);
    baseline.cny = baseline.total * baseline.fx;
    await json('/api/import', 'POST', { source: duplicateSource, apply: true }, 400);
    assert.deepEqual(rowOf(await ledger()), rowOf(beforeImport), 'Rejected duplicate source cannot modify the saved amount');
    const preview = await json('/api/import', 'POST', { source, apply: false });
    assert.equal(preview.summary.resultingRows, 4);
    assert.ok(preview.summary.retained.some(value => value.includes('已同步余额')));
    const imported = await json('/api/import', 'POST', { source, apply: true });
    assert.equal(imported.ledger.assets.filter(asset => asset.mode === 'variational').length, 1);
    assert.equal(rowOf(imported.ledger).id, 'row-40');
    assertPreserved({ ...rowOf(imported.ledger), id: rowOf(beforeImport).id }, rowOf(beforeImport));
    assert.equal(imported.ledger.connections.variational.lastSync, beforeImport.connections.variational.lastSync);
    assert.equal(imported.ledger.connections.variational.configured, beforeImport.connections.variational.configured);
    assert.equal(encrypted(), beforeImportCipher, 'Import retains the exact encrypted session or disconnected state');
    await restart();
    const afterImportRestart = await ledger();
    assert.equal(afterImportRestart.dataKind, 'personal');
    assertPreserved(rowOf(afterImportRestart), rowOf(imported.ledger));
    assert.deepEqual(afterImportRestart.connections.variational, imported.ledger.connections.variational);
    assert.equal(encrypted(), beforeImportCipher);
    assertNoSecrets(output);
  } finally {
    await stop();
    // Only remove this scenario's freshly created directory, never a supplied path.
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    assert.ok(basename(directory).startsWith('asset-var-smoke-'));
    rmSync(directory, { recursive: true });
  }
}

export async function runVariationalSmoke(runtime) {
  assert.ok(existsSync(join(runtime, 'scripts/variational-diagnostic.py')), 'Release runtime includes the Python helper');
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', '-c', 'import ssl; assert ssl.OPENSSL_VERSION'], { windowsHide: true, stdio: 'pipe' });
  await scenario(runtime, 'var', true);
  await scenario(runtime, 'variational', false);
  console.log('Variational production smoke passed: authentication/origin checks, transient Node/Python three-GET diagnostics and cooldown, encrypted session isolation, challenge/401/403/HTML diagnostics, failed verification, zero/negative equity, valuation and quote fallback, failure preservation, aliases/duplicate rejection, source import retention, trading export exclusion, disconnect and restart recovery.');
}
