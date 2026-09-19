// Production smoke only: injected with Node --import; never loaded by the app itself.
import assert from 'node:assert/strict';
import { verifyTypedData } from 'ethers';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'api.coingecko.com') return Response.json(Object.fromEntries(
    ['virtual-protocol', 'tether', 'usd-coin'].map(id => [id, { usd: 1, last_updated_at: Math.floor(Date.now() / 1000) }]),
  ));
  if (['fapi.asterdex.com', 'sapi.asterdex.com'].includes(url.hostname)) {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    const signature = url.searchParams.get('signature');
    url.searchParams.delete('signature');
    assert.deepEqual([...url.searchParams.keys()], ['nonce', 'signer']);
    assert.equal(verifyTypedData(
      { name: 'AsterSignTransaction', version: '1', chainId: 1666, verifyingContract: '0x0000000000000000000000000000000000000000' },
      { Message: [{ name: 'msg', type: 'string' }] }, { msg: url.search.slice(1) }, signature,
    ), url.searchParams.get('signer'));
    if (url.hostname === 'fapi.asterdex.com' && url.pathname === '/fapi/v3/accountWithJoinMargin') return Response.json({ assets: [{ asset: 'USDT', marginBalance: '125' }] });
    if (url.hostname === 'sapi.asterdex.com' && url.pathname === '/api/v3/account') return Response.json({ balances: [{ asset: 'USDC', free: '20', locked: '5' }] });
    throw new Error('Unexpected Aster route in test');
  }
  return realFetch(input, init);
};
