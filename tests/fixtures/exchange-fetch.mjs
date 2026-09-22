// Production smoke only: injected with Node --import; never loaded by the app itself.
import assert from 'node:assert/strict';
import { verifyTypedData } from 'ethers';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const flag = name => existsSync(join(process.env.ASSET_DATA_DIR, name));
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'api.coinbase.com') return flag('fx-failure') ? new Response('', { status: 503 }) : Response.json({ data: { currency: 'USD', rates: { CNY: '7.1234', ...(flag('market-failure') ? {} : { VIRTUAL: '1', USDT: '1', USDC: '1' }) } } });
  if (url.hostname === 'api.frankfurter.dev') return flag('fx-failure') ? new Response('', { status: 503 }) : Response.json({ base: 'USD', quote: 'CNY', rate: 7.11, date: new Date(Date.now() - 86400000).toISOString().slice(0, 10) });
  if (url.hostname === 'api.coingecko.com') return flag('market-failure') ? Response.json({}) : Response.json(Object.fromEntries(
    ['virtual-protocol', 'tether', 'usd-coin'].map(id => [id, { usd: 1, last_updated_at: Math.floor(Date.now() / 1000) }]),
  ));
  if (url.hostname === 'api.bybit.com') {
    if (url.pathname === '/v5/user/query-api') {
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
