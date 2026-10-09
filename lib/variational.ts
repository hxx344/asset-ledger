import type { Balance } from './types';

export type VariationalCredential = { vrToken: string };
type Json = Record<string, unknown>;
const PORTFOLIO = 'https://omni.variational.io/api/portfolio?compute_margin=true';
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd&include_last_updated_at=true';
const COINBASE = 'https://api.coinbase.com/v2/exchange-rates?currency=USDC';
const INVALID = 'Var 返回的账户数据不完整或数值无效；已保留上次数据';
const FAILED = 'Var 读取失败，请检查会话及网络后重试；已保留上次数据';
const MAX_BYTES = 2 * 1024 * 1024;

function object(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decimal(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(INVALID);
    return value === 0 ? 0 : value;
  }
  if (typeof value !== 'string' || value.length > 128 || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error(INVALID);
  const result = Number(value);
  if (!Number.isFinite(result) || (result === 0 && /[1-9]/.test(value))) throw new Error(INVALID);
  return result === 0 ? 0 : result;
}

// Only these fixed GET URLs are reachable; credentials are never sent to pricing providers.
async function read(url: string, headers: Record<string, string>, fetcher: typeof fetch): Promise<Json> {
  try {
    const response = await fetcher(url, { method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (response.redirected) throw new Error(FAILED);
    if (!response.ok) {
      if (url === PORTFOLIO && [401, 403].includes(response.status)) throw new Error('Var 会话已失效或访问被拒绝，请更新 vr-token；已保留上次数据');
      if (response.status === 429) throw new Error('Var 请求过于频繁，请稍后重试；已保留上次数据');
      throw new Error(FAILED);
    }
    if (Number(response.headers.get('content-length') || 0) > MAX_BYTES || !response.body) throw new Error(INVALID);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error(INVALID); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(data)) throw new Error(INVALID);
    return data;
  } catch (error) {
    // Whitelist our own errors; never echo raw HTTP, JSON, transport or credential content.
    const allowed = [INVALID, FAILED, 'Var 会话已失效或访问被拒绝，请更新 vr-token；已保留上次数据', 'Var 请求过于频繁，请稍后重试；已保留上次数据'];
    if (error instanceof Error && allowed.includes(error.message)) throw error;
    throw new Error(FAILED);
  }
}

async function usdcQuote(fetcher: typeof fetch): Promise<{ price: number; at: number }> {
  try {
    const data = await read(COINGECKO, { Accept: 'application/json' }, fetcher);
    const coin = data['usd-coin'];
    if (!object(coin) || typeof coin.usd !== 'number' || !Number.isFinite(coin.usd) || coin.usd <= 0 || typeof coin.last_updated_at !== 'number') throw new Error(INVALID);
    const at = coin.last_updated_at * 1000;
    if (!Number.isSafeInteger(at) || at <= 0 || Date.now() - at > 900000 || at - Date.now() > 60000) throw new Error(INVALID);
    return { price: coin.usd, at };
  } catch {
    try {
      const data = await read(COINBASE, { Accept: 'application/json' }, fetcher);
      if (!object(data.data) || data.data.currency !== 'USDC' || !object(data.data.rates)) throw new Error(INVALID);
      const price = decimal(data.data.rates.USD);
      if (price <= 0) throw new Error(INVALID);
      return { price, at: Date.now() };
    } catch { throw new Error('Var USDC/USD 汇率读取失败；已保留上次数据'); }
  }
}

export async function syncVariational(c: VariationalCredential, fetcher: typeof fetch = fetch): Promise<{ total: number; details: Balance[]; updatedAt: string }> {
  if (typeof c?.vrToken !== 'string' || c.vrToken.length < 5 || c.vrToken.length > 4096 || !/^[A-Za-z0-9._~-]+$/.test(c.vrToken)) throw new Error('Var 请填写单个 vr-token 值，不要填写完整 Cookie');
  // vr-token is a full web session, not a read-only API key. The application only reads this portfolio.
  const portfolio = await read(PORTFOLIO, { Accept: 'application/json', Cookie: 'vr-token=' + c.vrToken }, fetcher);
  const fetchedAt = Date.now();
  const quantity = decimal(portfolio.balance);
  // Omni's portfolio header uses balance directly, including all sub-accounts and unrealized P&L.
  // Neither upnl, margin usage, sub-account balances nor position notional is added again.
  const quote = await usdcQuote(fetcher);
  const total = quantity * quote.price;
  if (!Number.isFinite(total) || (total === 0 && quantity !== 0)) throw new Error(INVALID);
  return {
    total: total === 0 ? 0 : total,
    details: [{ coin: 'USDC', account: 'Omni 账户净权益（含未实现盈亏）', quantity, price: quote.price, value: total === 0 ? 0 : total }],
    // The live portfolio response has no documented valuation timestamp. Keep receipt time honest,
    // and retain an older FX timestamp so a fresh account response cannot refresh an old valuation.
    updatedAt: new Date(Math.min(fetchedAt, quote.at)).toISOString(),
  };
}
