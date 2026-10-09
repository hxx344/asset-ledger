import test from 'node:test';
import assert from 'node:assert/strict';
import { syncVariational } from '../lib/variational.ts';
import { connectionSchema } from '../lib/validation.ts';

const credential = { vrToken: 'synthetic.var.session' };
function fixture(portfolio: unknown = { balance: '125' }, options: { price?: number; quoteAt?: number; fallback?: unknown; primaryFailure?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    assert.equal(init.body, undefined); assert.ok(init.signal instanceof AbortSignal);
    if (url.hostname === 'omni.variational.io') {
      assert.equal(url.href, 'https://omni.variational.io/api/portfolio?compute_margin=true');
      assert.equal(new Headers(init.headers).get('cookie'), 'vr-token=' + credential.vrToken);
      assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
      return Response.json(portfolio);
    }
    assert.equal(new Headers(init.headers).has('cookie'), false);
    assert.equal(JSON.stringify(init).includes(credential.vrToken), false);
    if (url.hostname === 'api.coingecko.com') {
      assert.equal(url.searchParams.get('ids'), 'usd-coin');
      return options.primaryFailure ? new Response('', { status: 503 }) : Response.json({ 'usd-coin': { usd: options.price ?? 0.99, last_updated_at: (options.quoteAt ?? Math.floor(Date.now() / 1000) * 1000) / 1000 } });
    }
    assert.equal(url.href, 'https://api.coinbase.com/v2/exchange-rates?currency=USDC');
    return Response.json(options.fallback ?? {});
  }) as typeof fetch;
}

test('Var reads the fixed portfolio GET and counts total balance once with USDC/USD conversion', async () => {
  const quoteAt = Math.floor((Date.now() - 60000) / 1000) * 1000;
  const result = await syncVariational(credential, fixture({ balance: '125', upnl: '25', margin_usage: { initial_margin: '50' }, sub_accounts: { cross: { balance: '120' }, isolated: [{ balance: '5' }] } }, { quoteAt }));
  assert.equal(result.total, 123.75);
  assert.equal(result.details.length, 1); assert.equal(result.details[0].quantity, 125); assert.equal(result.details[0].price, 0.99);
  assert.equal(result.details[0].coin, 'USDC'); assert.equal(result.updatedAt, new Date(quoteAt).toISOString());
});

test('Var accepts genuine zero and negative equity without rounding malformed values to zero', async () => {
  for (const [balance, total] of [['0', 0], ['-0.000', 0], ['-100', -99], [100, 99]] as const) {
    assert.equal((await syncVariational(credential, fixture({ balance }))).total, total);
  }
  for (const balance of [undefined, null, false, '', ' ', 'NaN', 'Infinity', '1e9', '123junk', '9'.repeat(309), '0.' + '0'.repeat(400) + '1', {}, []]) {
    await assert.rejects(syncVariational(credential, fixture({ balance })), /Var /);
  }
  for (const payload of [[], null, { data: { balance: '1' } }, { margin_usage: {}, upnl: '20' }]) await assert.rejects(syncVariational(credential, fixture(payload)), /Var /);
});

test('Var uses independent USDC pricing and a correctly directed Coinbase fallback', async () => {
  const result = await syncVariational(credential, fixture({ balance: '100' }, { primaryFailure: true, fallback: { data: { currency: 'USDC', rates: { USD: '1.02' } } } }));
  assert.equal(result.total, 102);
  assert.ok(Date.now() - Date.parse(result.updatedAt) < 2000);
  for (const quoteAt of [0, Date.now() - 901000, Date.now() + 61000, NaN]) await assert.rejects(syncVariational(credential, fixture(undefined, { quoteAt })), /USDC\/USD/);
  for (const price of [0, -1, Infinity, NaN]) await assert.rejects(syncVariational(credential, fixture(undefined, { price })), /USDC\/USD/);
  for (const fallback of [{ data: { currency: 'USD', rates: { USD: '1' } } }, { data: { currency: 'USDC', rates: { USD: '0' } } }, { data: { currency: 'USDC', rates: { USD: '' } } }]) {
    await assert.rejects(syncVariational(credential, fixture(undefined, { primaryFailure: true, fallback })), /USDC\/USD/);
  }
});

test('Var rejects cookie/header injection before any network call', async () => {
  const never = (async () => assert.fail('must not send invalid credentials')) as typeof fetch;
  for (const vrToken of ['', 'abc', 'x; other=token', 'a\r\nb', 'vr-token=abcdef', 'Bearer abcdef', '令牌token', 'a'.repeat(4097)]) {
    assert.equal(connectionSchema.safeParse({ exchange: 'variational', vrToken }).success, false);
    await assert.rejects(syncVariational({ vrToken }, never), /Var /);
  }
  assert.deepEqual(connectionSchema.parse({ exchange: 'variational', vrToken: '  ' + credential.vrToken + '  ' }), { exchange: 'variational', ...credential });
  for (const extra of [{ url: 'https://example.test' }, { apiKey: 'unexpected' }, { apiSecret: 'unexpected' }]) assert.equal(connectionSchema.safeParse({ exchange: 'variational', ...credential, ...extra }).success, false);
});

test('Var HTTP, redirect, transport and JSON failures never expose upstream text or session data', async () => {
  const sensitive = credential.vrToken + ' PRIVATE_RESPONSE';
  const safe = (error: unknown) => { assert.ok(error instanceof Error); assert.match(error.message, /^Var /); assert.equal(error.message.includes(sensitive), false); assert.equal(error.message.includes(credential.vrToken), false); return true; };
  for (const status of [302, 401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(syncVariational(credential, (async () => { calls++; return new Response(sensitive, { status, headers: { location: 'https://example.test' } }); }) as typeof fetch), safe);
    assert.equal(calls, 1);
  }
  for (const fetcher of [
    async () => { throw new Error(sensitive); },
    async () => new Response(sensitive),
    async () => { const r = Response.json({ balance: '1' }); Object.defineProperty(r, 'redirected', { value: true }); return r; },
    async () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
  ]) await assert.rejects(syncVariational(credential, fetcher as typeof fetch), safe);
});

test('Var identifies an explicit browser challenge before HTTP authentication status and never reads its body', async () => {
  for (const status of [200, 401, 403, 429, 503]) {
    let calls = 0, cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    await assert.rejects(syncVariational(credential, (async () => {
      calls++;
      return new Response(body, { status, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html', 'x-omni-auth': 'r' } });
    }) as typeof fetch), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Cloudflare 浏览器验证/);
      assert.doesNotMatch(error.message, /更新 vr-token|会话已失效/);
      return true;
    });
    assert.equal(calls, 1, 'No pricing request or retry after a portfolio challenge');
    assert.equal(cancelled, true, 'Discard an unread challenge body');
  }
});

test('Var distinguishes a rejected login, generic forbidden access and an unclassified HTML response', async () => {
  const cases = [
    { status: 401, contentType: 'application/json', expected: /HTTP 401/, refresh: true },
    { status: 403, contentType: 'application/json', expected: /HTTP 403/, refresh: false },
    { status: 403, contentType: 'text/html', expected: /HTTP 403/, refresh: false },
    { status: 200, contentType: 'text/html; charset=UTF-8', expected: /网页而非账户数据/, refresh: false },
    { status: 200, contentType: 'application/xhtml+xml', expected: /网页而非账户数据/, refresh: false },
    { status: 200, contentType: 'text/plain', expected: /账户数据不完整/, refresh: false },
  ];
  for (const { status, contentType, expected, refresh } of cases) {
    let calls = 0;
    await assert.rejects(syncVariational(credential, (async () => {
      calls++;
      return new Response('PRIVATE_RESPONSE ' + credential.vrToken, { status, headers: { 'content-type': contentType, 'server': 'cloudflare' } });
    }) as typeof fetch), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, expected);
      assert.equal(error.message.includes('更新 vr-token'), refresh);
      assert.doesNotMatch(error.message, /Cloudflare|PRIVATE_RESPONSE/);
      assert.equal(error.message.includes(credential.vrToken), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('Var exposes a safe timeout diagnosis without leaking network exceptions', async () => {
  for (const name of ['TimeoutError', 'AbortError']) {
    await assert.rejects(syncVariational(credential, (async () => { throw new DOMException(credential.vrToken, name); }) as typeof fetch), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /读取超时/);
      assert.equal(error.message.includes(credential.vrToken), false);
      return true;
    });
  }
});
