import type { Balance } from './types';

export type VariationalCredential = { vrToken: string };
type Json = Record<string, unknown>;
const PORTFOLIO = 'https://omni.variational.io/api/portfolio?compute_margin=true';
// Match Var Grid's default session client; this does not complete browser challenges.
const GRID_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd&include_last_updated_at=true';
const COINBASE = 'https://api.coinbase.com/v2/exchange-rates?currency=USDC';
const INVALID = 'Var 返回的账户数据不完整或数值无效；已保留上次数据';
const FAILED = 'Var 读取失败，请检查会话及网络后重试；已保留上次数据';
const CHALLENGE = 'Var 的 Cloudflare 浏览器验证拦截了服务器请求，后台暂时无法读取资产；这不能说明令牌失效。已保留上次数据';
const UNAUTHORIZED = 'Var 未接受当前会话（HTTP 401），请确认 Omni 登录状态并更新 vr-token；已保留上次数据';
const FORBIDDEN = 'Var 拒绝服务器访问（HTTP 403），尚未确认是会话失效；已保留上次数据';
const HTML_RESPONSE = 'Var 返回了网页而非账户数据，无法确认登录或访问状态；已保留上次数据';
const RATE_LIMITED = 'Var 请求过于频繁，请稍后重试；已保留上次数据';
const TIMED_OUT = 'Var 读取超时，请稍后重试；已保留上次数据';
const SAFE_ERRORS = new Set([INVALID, FAILED, CHALLENGE, UNAUTHORIZED, FORBIDDEN, HTML_RESPONSE, RATE_LIMITED, TIMED_OUT]);
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
    const rejectResponse = async (message: string): Promise<never> => {
      // Discard rejected bodies without reading or exposing challenge pages and account details.
      await response.body?.cancel().catch(() => {});
      throw new Error(message);
    };
    if (response.redirected) return rejectResponse(FAILED);
    // Omni's own client uses this header to identify a browser challenge. It takes precedence
    // over HTTP authentication codes; HTML or a generic 403 alone cannot establish its cause.
    if (url === PORTFOLIO && response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge') return rejectResponse(CHALLENGE);
    if (!response.ok) {
      if (url === PORTFOLIO && response.status === 401) return rejectResponse(UNAUTHORIZED);
      if (url === PORTFOLIO && response.status === 403) return rejectResponse(FORBIDDEN);
      if (response.status === 429) return rejectResponse(RATE_LIMITED);
      return rejectResponse(FAILED);
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (url === PORTFOLIO && ['text/html', 'application/xhtml+xml'].includes(contentType ?? '')) return rejectResponse(HTML_RESPONSE);
    if (contentType && contentType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(contentType)) return rejectResponse(INVALID);
    if (Number(response.headers.get('content-length') || 0) > MAX_BYTES || !response.body) return rejectResponse(INVALID);
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
    if (error instanceof Error && SAFE_ERRORS.has(error.message)) throw error;
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error(TIMED_OUT);
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
  const portfolio = await read(PORTFOLIO, {
    Accept: 'application/json',
    'User-Agent': GRID_USER_AGENT,
    Referer: 'https://omni.variational.io/',
    'Cache-Control': 'no-cache',
    Cookie: 'vr-token=' + c.vrToken,
  }, fetcher);
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
