import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn, SpawnOptions } from 'node:child_process';
import { isAbsolute, basename } from 'node:path';
import { diagnoseVariationalPython } from '../lib/variational-python-diagnostics.ts';

const credential = { vrToken: 'synthetic.python.input' };
const privateText = 'PRIVATE_HELPER_TEXT ' + credential.vrToken;
const success = {
  endpoint: 'session', path: '/api/me', status: 200, contentType: 'json',
  challenge: false, elapsedMs: 12, structureOk: true, outcome: 'ok',
};
type Report = Awaited<ReturnType<typeof diagnoseVariationalPython>>;

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = null;
  exitCode: number | null = null;
  input = '';
  signals: Array<NodeJS.Signals | number> = [];
  autoClose = true;
  closed = false;

  constructor() {
    super();
    this.stdin.on('data', data => { this.input += data.toString(); });
  }
  kill(signal: NodeJS.Signals | number = 'SIGTERM') {
    this.signals.push(signal);
    if (this.autoClose) queueMicrotask(() => this.finish(null));
    return true;
  }
  finish(code: number | null = 0) {
    if (this.closed) return;
    this.closed = true; this.exitCode = code;
    this.stdout.end(); this.emit('close', code);
  }
}

function childFixture(action?: (child: FakeChild) => void) {
  const child = new FakeChild();
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const launch = ((command: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    child.stdin.once('finish', () => queueMicrotask(() => action?.(child)));
    return child;
  }) as unknown as typeof spawn;
  return { child, launch, calls };
}

function safe(report: Report, outcome: string) {
  assert.deepEqual(Object.keys(report).sort(), ['checkedAt', 'client', 'results']);
  assert.equal(report.client, 'grid-python');
  assert.ok(Number.isFinite(Date.parse(report.checkedAt)));
  assert.equal(report.results.length, 1);
  const result = report.results[0];
  assert.deepEqual(Object.keys(result).sort(), ['challenge', 'contentType', 'elapsedMs', 'endpoint', 'outcome', 'path', 'status', 'structureOk']);
  assert.equal(result.endpoint, 'session'); assert.equal(result.path, '/api/me');
  assert.equal(result.outcome, outcome);
  assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
  for (const secret of [credential.vrToken, privateText, 'PRIVATE_ENV_VALUE', 'PRIVATE_RESPONSE_VALUE']) {
    assert.equal(JSON.stringify(report).includes(secret), false, 'Only safe metadata may leave the subprocess boundary');
  }
  return result;
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('Python diagnostics use the fixed isolated helper and stdin, never argv or inherited app secrets', async t => {
  const saved = process.env.ASSET_PYTHON_TEST_SECRET;
  process.env.ASSET_PYTHON_TEST_SECRET = 'PRIVATE_ENV_VALUE';
  t.after(() => { if (saved === undefined) delete process.env.ASSET_PYTHON_TEST_SECRET; else process.env.ASSET_PYTHON_TEST_SECRET = saved; });
  const fixture = childFixture(child => {
    const output = JSON.stringify(success) + '\n';
    child.stdout.write(output.slice(0, 20)); child.stdout.write(output.slice(20)); child.finish();
  });
  const report = await diagnoseVariationalPython(credential, undefined, fixture.launch);
  assert.deepEqual(safe(report, 'ok'), success);
  assert.equal(fixture.calls.length, 1);
  const { command, args, options } = fixture.calls[0];
  assert.equal(command, process.platform === 'win32' ? 'python' : 'python3');
  assert.deepEqual(args.slice(0, 2), ['-I', '-B']); assert.equal(args.length, 3);
  assert.ok(isAbsolute(args[2])); assert.equal(basename(args[2]), 'variational-diagnostic.py');
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
  assert.ok(Object.keys(options.env ?? {}).every(key => ['NODE_ENV', 'PATH', 'SystemRoot', 'WINDIR'].includes(key)));
  assert.equal(JSON.stringify(fixture.calls).includes(credential.vrToken), false);
  assert.equal(JSON.stringify(fixture.calls).includes('PRIVATE_ENV_VALUE'), false);
  assert.deepEqual(JSON.parse(fixture.child.input), credential);
  assert.deepEqual(fixture.child.signals, []);
});

test('Python safe response classifications survive the strict subprocess projection', async () => {
  for (const [outcome, status, contentType, challenge, structureOk] of [
    ['challenge', 403, 'html', true, null], ['unauthorized', 401, 'json', false, null],
    ['forbidden', 403, 'json', false, null], ['redirect', 302, 'html', false, null],
    ['timeout', null, null, false, null], ['network_error', null, null, false, null],
    ['invalid_data', 200, 'json', false, false],
  ] as const) {
    const value = { ...success, outcome, status, contentType, challenge, structureOk };
    const fixture = childFixture(child => { child.stdout.write(JSON.stringify(value)); child.finish(); });
    assert.deepEqual(safe(await diagnoseVariationalPython(credential, undefined, fixture.launch), outcome), value);
  }
});

test('malformed, extra, secret-bearing or wrong-shape helper output is rejected', async () => {
  const bad = [
    '', privateText, JSON.stringify(success) + '\n' + JSON.stringify(success), 'null', '[]',
    JSON.stringify({ ...success, token: credential.vrToken }),
    JSON.stringify({ ...success, balance: 'PRIVATE_RESPONSE_VALUE' }),
    JSON.stringify({ ...success, endpoint: 'portfolio' }),
    JSON.stringify({ ...success, path: 'https://untrusted.example/' }),
    JSON.stringify({ ...success, outcome: privateText }),
    JSON.stringify({ ...success, status: 700 }), JSON.stringify({ ...success, status: 200.5 }),
    JSON.stringify({ ...success, contentType: privateText }), JSON.stringify({ ...success, challenge: 'true' }),
    JSON.stringify({ ...success, structureOk: 'true' }), JSON.stringify({ ...success, elapsedMs: -1 }),
    JSON.stringify({ ...success, elapsedMs: 24_001 }), JSON.stringify({ ...success, elapsedMs: null }),
  ];
  for (const output of bad) {
    const fixture = childFixture(child => { child.stdout.write(output); child.finish(); });
    safe(await diagnoseVariationalPython(credential, undefined, fixture.launch), 'client_error');
  }
});

test('nonzero helper exit cannot turn otherwise valid stdout into success', async () => {
  for (const code of [1, 2, null]) {
    const fixture = childFixture(child => { child.stdout.write(JSON.stringify(success)); child.finish(code); });
    safe(await diagnoseVariationalPython(credential, undefined, fixture.launch), 'client_error');
  }
});

test('helper stdout is bounded to 8192 bytes and overflow terminates the child', async () => {
  const exact = JSON.stringify(success).padEnd(8192, ' ');
  const good = childFixture(child => { child.stdout.write(exact); child.finish(); });
  safe(await diagnoseVariationalPython(credential, undefined, good.launch), 'ok');
  const oversized = childFixture(child => { child.stdout.write(exact); child.stdout.write('x'); });
  safe(await diagnoseVariationalPython(credential, undefined, oversized.launch), 'client_error');
  assert.deepEqual(oversized.child.signals, ['SIGTERM']);
});

test('spawn errors are classified without returning executable paths or raw error messages', async () => {
  for (const code of ['ENOENT', 'EACCES']) {
    const fixture = childFixture();
    const pending = diagnoseVariationalPython(credential, undefined, fixture.launch);
    fixture.child.emit('error', Object.assign(new Error(privateText), { code }));
    fixture.child.finish(-1);
    safe(await pending, code === 'ENOENT' ? 'client_unavailable' : 'client_error');
    const launch = (() => { throw Object.assign(new Error(privateText), { code }); }) as typeof spawn;
    safe(await diagnoseVariationalPython(credential, undefined, launch), code === 'ENOENT' ? 'client_unavailable' : 'client_error');
  }
});

test('stdin failure kills the helper and returns a safe client error', async () => {
  const fixture = childFixture();
  const pending = diagnoseVariationalPython(credential, undefined, fixture.launch);
  fixture.child.stdin.emit('error', new Error(privateText));
  safe(await pending, 'client_error');
  assert.deepEqual(fixture.child.signals, ['SIGTERM']);
});

test('the hard deadline escalates to SIGKILL and settles only after child close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = childFixture(); fixture.child.autoClose = false;
  let settled = false;
  const pending = diagnoseVariationalPython(credential, undefined, fixture.launch).then(report => { settled = true; return report; });
  t.mock.timers.tick(22_999); await flush();
  assert.deepEqual(fixture.child.signals, []);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(fixture.child.signals, ['SIGTERM']); assert.equal(settled, false);
  t.mock.timers.tick(249); assert.deepEqual(fixture.child.signals, ['SIGTERM']);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(fixture.child.signals, ['SIGTERM', 'SIGKILL']); assert.equal(settled, false);
  fixture.child.finish(null);
  safe(await pending, 'timeout');
});

test('caller cancellation waits for close and cannot be replaced by late stdout', async () => {
  const controller = new AbortController();
  const fixture = childFixture(); fixture.child.autoClose = false;
  let settled = false;
  const pending = diagnoseVariationalPython(credential, controller.signal, fixture.launch).then(report => { settled = true; return report; });
  controller.abort(new Error(privateText)); await flush();
  assert.deepEqual(fixture.child.signals, ['SIGTERM']); assert.equal(settled, false);
  fixture.child.stdout.write(JSON.stringify(success)); fixture.child.finish();
  safe(await pending, 'cancelled');
});

test('already cancelled or invalid input cannot start a Python process', async () => {
  let calls = 0;
  const launch = (() => { calls++; assert.fail('No subprocess should be started'); }) as typeof spawn;
  const controller = new AbortController(); controller.abort(new Error(privateText));
  safe(await diagnoseVariationalPython(credential, controller.signal, launch), 'cancelled');
  for (const vrToken of ['', 'abc', 'a; other=secret', 'a\r\nb', 'vr-token=abcdef', 'Bearer abcdef', '令牌token', 'a'.repeat(4097)]) {
    await assert.rejects(diagnoseVariationalPython({ vrToken }, undefined, launch), /Var /);
  }
  assert.equal(calls, 0);
});
