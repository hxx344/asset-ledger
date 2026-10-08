// Production smoke only: injected with Node --import; never loaded by the app itself.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyTypedData } from 'ethers';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const flag = name => existsSync(join(process.env.ASSET_DATA_DIR, name));
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'api.coinbase.com') {
    if (flag('fx-ordering')) {
      const deadline = Date.now() + 3000;
      while (!flag('account-before-fx') && Date.now() < deadline) await delay(10);
      assert.ok(flag('account-before-fx'), 'Account reads must start before the delayed FX result');
    }
    return flag('fx-failure') ? new Response('', { status: 503 }) : Response.json({ data: { currency: 'USD', rates: { CNY: '7.1234', ...(flag('market-failure') ? {} : { VIRTUAL: '1', USDT: '1', USDC: '1' }) } } });
  }
  if (url.hostname === 'api.frankfurter.dev') return flag('fx-failure') ? new Response('', { status: 503 }) : Response.json({ base: 'USD', quote: 'CNY', rate: 7.11, date: new Date(Date.now() - 86400000).toISOString().slice(0, 10) });
  if (url.hostname === 'api.coingecko.com') return flag('market-failure') ? Response.json({}) : Response.json(Object.fromEntries(
    ['virtual-protocol', 'tether', 'usd-coin'].map(id => [id, { usd: 1, last_updated_at: Math.floor(Date.now() / 1000) }]),
  ));
  if (url.hostname === 'api.binance.com') {
    assert.equal(init.method,'GET');
    assert.equal(init.redirect,'manual');
    assert.equal(new Headers(init.headers).get('X-MBX-APIKEY'),'synthetic-binance-key');
    const signature=url.searchParams.get('signature');
    url.searchParams.delete('signature');
    assert.equal(signature,createHmac('sha256','synthetic-binance-secret').update(url.search.slice(1)).digest('hex'));
    assert.equal(url.href.includes('synthetic-binance-secret'),false);
    const fixture=flag('binance-fixture.json')?JSON.parse(readFileSync(join(process.env.ASSET_DATA_DIR,'binance-fixture.json'),'utf8')):{};
    if (url.pathname === '/sapi/v1/account/apiRestrictions') return Response.json({enableReading:true,enableWithdrawals:false,enableInternalTransfer:false,enableMargin:false,enableFutures:false,permitsUniversalTransfer:false,enableVanillaOptions:false,enableSpotAndMarginTrading:false,enableFixApiTrade:false,enablePortfolioMarginTrading:false,...fixture.permissions});
    if (url.pathname === '/sapi/v1/asset/wallet/balance') {
      assert.equal(url.searchParams.get('quoteAsset'),'USDT');
      if(fixture.failure)return new Response('',{status:503});
      return Response.json(fixture.wallets??[{activate:true,walletName:'Spot',balance:'100'},{activate:true,walletName:'Funding',balance:'25'}]);
    }
    throw new Error('Unexpected Binance route in test');
  }
  if (url.hostname === 'openapi.okx.com') {
    assert.equal(url.origin, 'https://openapi.okx.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers);
    const apiKey = headers.get('OK-ACCESS-KEY');
    const replacement = apiKey === 'synthetic-okx-key-replacement';
    assert.equal(apiKey, replacement ? 'synthetic-okx-key-replacement' : 'synthetic-okx-key');
    const apiSecret = replacement ? 'synthetic-okx-secret-replacement' : 'synthetic-okx-secret';
    const passphrase = replacement ? 'synthetic-okx-passphrase-replacement' : 'synthetic-okx-passphrase';
    assert.equal(headers.get('OK-ACCESS-PASSPHRASE'), passphrase);
    const timestamp = headers.get('OK-ACCESS-TIMESTAMP');
    assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Math.abs(Date.now() - Date.parse(timestamp)) < 30000);
    assert.equal(headers.get('OK-ACCESS-SIGN'), createHmac('sha256', apiSecret).update(timestamp + 'GET' + url.pathname + url.search).digest('base64'));
    for (const secret of [apiKey, apiSecret, passphrase]) assert.equal(url.href.includes(secret), false);
    const fixture = flag('okx-fixture.json') ? JSON.parse(readFileSync(join(process.env.ASSET_DATA_DIR, 'okx-fixture.json'), 'utf8')) : {};
    if (url.pathname === '/api/v5/account/config') {
      assert.equal(url.search, '');
      return Response.json({ code: '0', data: [{ perm: fixture.permissions ?? 'read_only' }] });
    }
    if (url.pathname === '/api/v5/asset/asset-valuation') {
      assert.equal(url.search, '?ccy=USD');
      if (fixture.failure) return new Response('', { status: 503 });
      return Response.json({ code: '0', data: [{ totalBal: fixture.total ?? '321.5', ts: String(fixture.ts ?? Date.now()), details: fixture.details ?? { funding: '20', trading: '100', earn: '200' } }] });
    }
    throw new Error('Unexpected OKX route in test');
  }
  if (url.hostname === 'api.bybit.com') {
    if (url.pathname === '/v5/user/query-api') {
      if (flag('fx-ordering')) writeFileSync(join(process.env.ASSET_DATA_DIR, 'account-before-fx'), 'fixture');
      // A serial Bybit -> Aster refresh cannot release this gate. This checks
      // actual provider overlap without relying on wall-clock speed assertions.
      if (flag('exchange-concurrency')) {
        const deadline = Date.now() + 3000;
        while (!flag('aster-started') && Date.now() < deadline) await delay(10);
        assert.ok(flag('aster-started'), 'Aster must start before Bybit finishes');
      }
      return Response.json({ retCode: 0, result: { readOnly: 1 } });
    }
    if (url.pathname === '/v5/account/wallet-balance') return Response.json({ retCode: 0, result: { list: [{ accountType: 'UNIFIED', totalEquity: '75', coin: [] }] } });
    if (url.pathname === '/v5/asset/transfer/query-account-coins-balance') return Response.json({ retCode: 0, result: { balance: [] } });
    throw new Error('Unexpected Bybit route in test');
  }
  if (['fapi.asterdex.com', 'sapi.asterdex.com'].includes(url.hostname)) {
    if (flag('exchange-concurrency')) writeFileSync(join(process.env.ASSET_DATA_DIR, 'aster-started'), 'fixture');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    const signature = url.searchParams.get('signature');
    url.searchParams.delete('signature');
    assert.deepEqual([...url.searchParams.keys()], ['nonce', 'signer']);
    assert.equal(verifyTypedData(
      { name: 'AsterSignTransaction', version: '1', chainId: 1666, verifyingContract: '0x0000000000000000000000000000000000000000' },
      { Message: [{ name: 'msg', type: 'string' }] }, { msg: url.search.slice(1) }, signature,
    ), url.searchParams.get('signer'));
    const accounts=flag('aster-fixtures.json')?JSON.parse(readFileSync(join(process.env.ASSET_DATA_DIR,'aster-fixtures.json'),'utf8')):{};
    const account=accounts[url.searchParams.get('signer').toLowerCase()];
    if(account?.failure)return new Response('',{status:503});
    if (url.hostname === 'fapi.asterdex.com' && url.pathname === '/fapi/v3/accountWithJoinMargin') return Response.json({ assets: [{ asset: 'USDT', marginBalance: String(account?.total??125) }] });
    if (url.hostname === 'sapi.asterdex.com' && url.pathname === '/api/v3/account') return Response.json({ balances: [{ asset: 'USDC', free: '20', locked: '5' }] });
    throw new Error('Unexpected Aster route in test');
  }
  return realFetch(input, init);
};
