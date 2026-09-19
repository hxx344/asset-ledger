import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
  assert.equal((await request('/api/login', 'POST', { password }, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('/api/login', 'POST', { password: 'wrong-password-123' })).status, 401);
  const login = await request('/api/login', 'POST', { password });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /SameSite=strict/i);
  cookie = setCookie.split(';')[0];
  const ledger = await (await request('/api/ledger')).json();
  assert.equal(ledger.assets.length, 5);
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
  assert.equal((await request('/api/logout', 'POST', {})).status, 200);
  cookie = '';
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await request('/api/login', 'POST', { password: 'incorrect-test-password' })).status, 401);
  assert.equal((await request('/api/login', 'POST', { password })).status, 429);
  console.log('Production smoke passed: login, spoof rejection, origin checks, edit, restart persistence, logout and login throttling.');
} finally { await stop(); rmSync(directory, { recursive: true }); }
