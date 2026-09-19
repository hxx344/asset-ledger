import type { Balance } from './types';
import { Wallet } from 'ethers/wallet';

type Json = Record<string, any>;
type Fetcher = typeof fetch;
export function finite(value: unknown, field: string): number {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') throw new Error(`${field} 缺少有效数值`);
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} 不是有效数值`);
  return n;
}
export async function readJson(url: string, init: RequestInit = {}, fetcher: Fetcher = fetch): Promise<Json> {
  let response:Response;
  try{response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(12000) });}
  catch{throw new Error('行情或交易所连接超时，请稍后重试；已保留上次数据');}
  if (!response.ok) throw new Error(`服务暂时不可用（HTTP ${response.status}），保留上次数据`);
  return response.json();
}
export async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))).map(n=>n.toString(16).padStart(2,'0')).join('');
}
export type Quote = { price: number; at: string; source: string };
export async function coingeckoQuotes(fetcher: Fetcher = fetch): Promise<Record<string, Quote>> {
  const data = await readJson('https://api.coingecko.com/api/v3/simple/price?ids=virtual-protocol,tether,usd-coin&vs_currencies=usd&include_last_updated_at=true', {}, fetcher);
  const result: Record<string, Quote> = {};
  for (const [symbol, id] of [['VIRTUAL','virtual-protocol'], ['USDT','tether'], ['USDC','usd-coin']]) {
    const item = data[id];
    const price = finite(item?.usd, symbol + ' 价格');
    const at = finite(item?.last_updated_at, symbol + ' 行情时间') * 1000;
    if (price <= 0 || Date.now()-at > 900000 || at-Date.now() > 60000) throw new Error('行情数据已过期，保留上次单价');
    result[symbol] = {price,at:new Date(at).toISOString(),source:'CoinGecko / USD'};
  }
  return result;
}
export async function quotes(fetcher:Fetcher=fetch):Promise<Record<string,Quote>>{
  try{return await coingeckoQuotes(fetcher);}catch(primaryError){
    try{
      const data=await readJson('https://api.coinbase.com/v2/exchange-rates?currency=USD',{},fetcher);
      if(data.data?.currency!=='USD')throw new Error('报价基础币种不是 USD');
      const result:Record<string,Quote>={};
      for(const coin of ['VIRTUAL','USDT','USDC']){
        const rate=finite(data.data.rates?.[coin],coin+' 兑换率');
        if(rate<=0)throw new Error('兑换率必须大于零');
        result[coin]={price:1/rate,at:new Date().toISOString(),source:'Coinbase / USD（获取时间）'};
      }
      return result;
    }catch{throw primaryError;}
  }
}
export async function usdPrice(coin: string, prices: Record<string, Quote>, fetcher: Fetcher = fetch): Promise<number> {
  if (coin === 'USD') return 1;
  if (prices[coin]) return prices[coin].price;
  if (!/^[A-Z0-9]{1,20}$/.test(coin) || !prices.USDT) throw new Error('暂不支持此币种的美元估值');
  const data = await readJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${coin}USDT`, {}, fetcher);
  if (data.retCode !== 0 || !data.result?.list?.[0]) throw new Error(`${coin} 缺少行情，本次账户同步未覆盖旧值`);
  const price = finite(data.result.list[0].lastPrice, coin + ' 价格');
  if (price <= 0) throw new Error('行情价格无效');
  return price * prices.USDT.price;
}
export type BybitCredential = { apiKey: string; apiSecret: string; region: 'global' | 'nl' | 'tr' | 'kz' | 'ge' | 'ae' | 'eu' };
const BYBIT_HOSTS = { global:'https://api.bybit.com', nl:'https://api.bybit.nl', tr:'https://api.bybit-tr.com', kz:'https://api.bybit.kz', ge:'https://api.bybitgeorgia.ge', ae:'https://api.bybit.ae', eu:'https://api.bybit.eu' };
const BYBIT_READ_PATHS = new Set(['/v5/user/query-api','/v5/account/wallet-balance','/v5/asset/transfer/query-account-coins-balance']);
export async function bybitGet(c: BybitCredential, path: string, query: string, fetcher: Fetcher = fetch): Promise<Json> {
  if (!BYBIT_READ_PATHS.has(path) || !BYBIT_HOSTS[c.region]) throw new Error('仅支持只读账户接口');
  const timestamp = String(Date.now());
  const signature = await hmac(c.apiSecret, timestamp+c.apiKey+'10000'+query);
  const data = await readJson(BYBIT_HOSTS[c.region]+path+(query?'?'+query:''), { method:'GET', headers:{'X-BAPI-API-KEY':c.apiKey,'X-BAPI-TIMESTAMP':timestamp,'X-BAPI-RECV-WINDOW':'10000','X-BAPI-SIGN':signature} }, fetcher);
  if (data.retCode !== 0) throw new Error(`Bybit 读取失败（${Number(data.retCode) || '未知代码'}），请检查权限、IP 白名单及地区`);
  return data.result;
}
export async function syncBybit(c: BybitCredential, prices: Record<string,Quote>, fetcher: Fetcher = fetch): Promise<{total:number;details:Balance[]}> {
  const info = await bybitGet(c, '/v5/user/query-api', '', fetcher);
  if (Number(info.readOnly) !== 1) throw new Error('此 Bybit API 不是只读密钥，请重新创建只读 API');
  const [wallet, funding] = await Promise.all([
    bybitGet(c,'/v5/account/wallet-balance','accountType=UNIFIED',fetcher),
    bybitGet(c,'/v5/asset/transfer/query-account-coins-balance','accountType=FUND',fetcher),
  ]);
  const unified = wallet.list?.find((x: Json)=>x.accountType==='UNIFIED');
  if (!unified || !Array.isArray(unified.coin) || !Array.isArray(funding.balance)) throw new Error('Bybit 返回的账户数据不完整');
  const totalUnified = finite(unified.totalEquity, 'Bybit 统一账户权益');
  const details: Balance[] = unified.coin.map((c: Json)=>{
    const quantity=finite(c.equity,'币种权益'), value=finite(c.usdValue,'美元权益');
    return {coin:String(c.coin),account:'统一账户（净权益）',quantity,value,price:quantity===0?0:value/quantity};
  });
  const funds = await Promise.all(funding.balance.map(async (coin:Json)=>{
    const quantity = finite(coin.walletBalance,'资金账户余额');
    const price = quantity===0 ? 0 : await usdPrice(String(coin.coin),prices,fetcher);
    return {coin:String(coin.coin),account:'资金账户',quantity,price,value:quantity*price};
  }));
  return {total:totalUnified+funds.reduce((s:number,a:Balance)=>s+a.value,0),details:[...details,...funds].filter(a=>a.quantity!==0||a.value!==0)};
}
export type AsterCredential={walletAddress:string;privateKey:string;includeSpot:boolean};
const ASTER_READ_HOSTS={
  '/fapi/v3/accountWithJoinMargin':'https://fapi.asterdex.com',
  '/api/v3/account':'https://sapi.asterdex.com',
} as const;
type AsterReadPath=keyof typeof ASTER_READ_HOSTS;
const ASTER_DOMAIN={name:'AsterSignTransaction',version:'1',chainId:1666,verifyingContract:'0x0000000000000000000000000000000000000000'};
const ASTER_TYPES={Message:[{name:'msg',type:'string'}]};
let lastAsterNonce=0;
export function validateAsterWallet(c:AsterCredential):Wallet{
  if(!c.walletAddress||!c.privateKey)throw new Error('Aster 连接需要更新：请填写 API Pro 钱包地址和对应私钥；已保留旧估值');
  let wallet:Wallet;
  try{wallet=new Wallet(c.privateKey.startsWith('0x')?c.privateKey:'0x'+c.privateKey);}
  catch{throw new Error('API 钱包私钥无效，请检查是否为 64 位十六进制私钥');}
  if(wallet.address.toLowerCase()!==c.walletAddress.toLowerCase())throw new Error('API 钱包地址与私钥不匹配，请使用同一个 API 钱包的地址和私钥');
  return wallet;
}
export async function asterGet(c:AsterCredential,path:AsterReadPath,fetcher:Fetcher=fetch):Promise<Json>{
  if(!Object.hasOwn(ASTER_READ_HOSTS,path))throw new Error('仅支持 Aster 只读余额接口');
  const wallet=validateAsterWallet(c);
  // Sign precisely the encoded query sent to Aster. Private keys never leave this server.
  lastAsterNonce=Math.max(Date.now()*1000,lastAsterNonce+1);
  const query=new URLSearchParams({nonce:String(lastAsterNonce),signer:wallet.address}).toString();
  let signature:string;
  try{signature=await wallet.signTypedData(ASTER_DOMAIN,ASTER_TYPES,{msg:query});}
  catch{throw new Error('API 钱包签名失败，请检查钱包配置');}
  const data=await readJson(ASTER_READ_HOSTS[path]+path+'?'+query+'&signature='+signature,{method:'GET'},fetcher);
  if(typeof data.code==='number'&&data.code<0)throw new Error(`Aster 读取失败（${data.code}），请检查 API Pro 钱包授权和服务器时间`);
  return data;
}
export async function syncAster(c:AsterCredential,prices:Record<string,Quote>,fetcher:Fetcher=fetch):Promise<{total:number;details:Balance[]}>{
  const [account,spot]=await Promise.all([asterGet(c,'/fapi/v3/accountWithJoinMargin',fetcher),c.includeSpot?asterGet(c,'/api/v3/account',fetcher):null]);
  if(!Array.isArray(account.assets)||(spot&&!Array.isArray(spot.balances)))throw new Error('Aster 账户数据不完整，本次不覆盖旧值');
  const details:Balance[]=await Promise.all(account.assets.map(async(a:Json)=>{
    // marginBalance already includes unrealized P&L, including isolated positions.
    const quantity=finite(a.marginBalance,'Aster 币种净权益');
    const price=quantity===0?0:await usdPrice(String(a.asset),prices,fetcher);
    return {coin:String(a.asset),account:'合约净权益（含未实现盈亏）',quantity,price,value:quantity*price};
  }));
  if(spot){details.push(...await Promise.all(spot.balances.map(async(a:Json)=>{
    const quantity=finite(a.free,'现货可用余额')+finite(a.locked,'现货冻结余额');
    const price=quantity===0?0:await usdPrice(String(a.asset),prices,fetcher);
    return {coin:String(a.asset),account:'现货钱包',quantity,price,value:quantity*price};
  })));}
  return {total:details.reduce((s,a)=>s+a.value,0),details:details.filter(a=>a.quantity!==0)};
}
