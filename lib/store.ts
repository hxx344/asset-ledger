import { seedLedger, readSource } from './seed';
import { db } from './sqlite';
export { db } from './sqlite';
import { seal, unseal } from './vault';
import { quotes, syncBybit, syncAster, validateAsterWallet } from './exchanges';
import { editValue, type Credentials, type WithdrawalInput } from './validation';
import { embeddedWithdrawals } from './withdrawals';
import { yuanQuote } from './fx';
import type { Asset, Ledger, Connection, Period, Withdrawal, FxStatus } from './types';

export const chinaDate=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
export async function initialize(owner:string){
  const ready=await db().prepare('SELECT value FROM settings WHERE owner = ? AND key = ?').bind(owner,'initialized').first();
  if(ready)return;
  const source=readSource(), seed=seedLedger(source);
  await db().batch([
    ...seed.assets.map(a=>db().prepare('INSERT OR IGNORE INTO assets(owner,id,data) VALUES(?,?,?)').bind(owner,a.id,JSON.stringify(a))),
    db().prepare('INSERT OR IGNORE INTO settings(owner,key,value) VALUES(?,?,?)').bind(owner,'fx',String(seed.fx)),
    db().prepare('INSERT OR IGNORE INTO settings(owner,key,value) VALUES(?,?,?)').bind(owner,'source-ledger',JSON.stringify(source)),
    db().prepare('INSERT OR IGNORE INTO settings(owner,key,value) VALUES(?,?,?)').bind(owner,'initialized','1'),
  ]);
}
export async function getLedger(owner:string):Promise<Ledger>{
  await initialize(owner);
  const [rows, settings, connectionRows, snapshotRows]=await Promise.all([
    db().prepare('SELECT data FROM assets WHERE owner = ?').bind(owner).all<{data:string}>(),
    db().prepare('SELECT key,value FROM settings WHERE owner = ?').bind(owner).all<{key:string,value:string}>(),
    db().prepare('SELECT exchange FROM connections WHERE owner = ?').bind(owner).all<{exchange:string}>(),
    db().prepare("SELECT data FROM snapshots WHERE owner = ? ORDER BY json_extract(data, '$.date') DESC LIMIT 730").bind(owner).all<{data:string}>(),
  ]);
  const source=settings.results.find(s=>s.key==='source-ledger');
  const ledger=seedLedger(source?JSON.parse(source.value):readSource());
  ledger.assets=rows.results.map(r=>JSON.parse(r.data) as Asset).sort((a,b)=>Number(a.id.slice(4))-Number(b.id.slice(4)));
  ledger.fx=Number(settings.results.find(s=>s.key==='fx')?.value??ledger.fx);
  ledger.fxStatus=JSON.parse(settings.results.find(s=>s.key==='fx-status')?.value??'null')??ledger.fxStatus;
  for(const name of ['bybit','aster'] as const){
    const meta=settings.results.find(s=>s.key===name+'-status');
    ledger.connections[name]={...ledger.connections[name],...(meta?JSON.parse(meta.value):{}),configured:connectionRows.results.some(r=>r.exchange===name)} as Connection;
  }
  ledger.history.push(...snapshotRows.results.map(r=>{const {assets,...period}=JSON.parse(r.data);return {...period,withdrawn:embeddedWithdrawals(assets??[])} as Period;}));
  ledger.withdrawals=JSON.parse(settings.results.find(s=>s.key==='withdrawals')?.value??'[]');
  return ledger;
}
async function saveAsset(owner:string,a:Asset){await db().prepare('UPDATE assets SET data = ? WHERE owner = ? AND id = ?').bind(JSON.stringify(a),owner,a.id).run();}
async function setting(owner:string,key:string,value:unknown){await db().prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?) ON CONFLICT(owner,key) DO UPDATE SET value=excluded.value').bind(owner,key,typeof value==='string'?value:JSON.stringify(value)).run();}
async function snapshot(owner:string){
  const ledger=await getLedger(owner);
  const total=ledger.assets.reduce((s,a)=>s+(a.value??0),0), date=chinaDate();
  const partial=!!ledger.fxStatus.error||ledger.assets.some(a=>a.mode!=='manual'&&(!!a.error||Date.now()-new Date(a.updatedAt).getTime()>900000));
  const data={id:'daily-'+date,date,total,fx:ledger.fx,fxStatus:ledger.fxStatus,cny:total*ledger.fx,future:false,difference:0,partial,updatedAt:new Date().toISOString(),assets:ledger.assets};
  await db().prepare('INSERT INTO snapshots(owner,date,data) VALUES(?,?,?) ON CONFLICT(owner,date) DO UPDATE SET data=excluded.data').bind(owner,date,JSON.stringify(data)).run();
}
export async function lock(owner:string){
  const now=Date.now();
  const result=await db().prepare('INSERT INTO sync_locks(owner,expires) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET expires=excluded.expires WHERE sync_locks.expires < ?').bind(owner,now+120000,now).run();
  if(!result.meta.changes)throw new Error('资产正在更新，请稍后重试');
}
export async function unlock(owner:string){await db().prepare('DELETE FROM sync_locks WHERE owner = ?').bind(owner).run();}
export async function editAsset(owner:string,input:{id:string,quantity:number,price:number|null}){
  await lock(owner);
  try{
    const ledger=await getLedger(owner), asset=ledger.assets.find(a=>a.id===input.id);
    if(!asset)throw new Error('未找到该资产');
    if(asset.mode==='bybit'||asset.mode==='aster')throw new Error('交易所资产由只读接口维护');
    const price=asset.mode==='market'?asset.price:input.price;
    const status=asset.mode==='manual'?'手动估值':asset.status;
    const next={...asset,quantity:input.quantity,price,value:editValue(input.quantity,price),status};
    if(asset.mode==='manual')next.updatedAt=new Date().toISOString();
    await saveAsset(owner,next);await snapshot(owner);
    return getLedger(owner);
  }finally{await unlock(owner);}
}
export async function editFx(owner:string,fx:number){
  await lock(owner);try{await saveFx(owner,fx,{source:'manual',fetchedAt:new Date().toISOString(),rateDate:null,error:null});await snapshot(owner);return getLedger(owner);}finally{await unlock(owner);}
}
async function saveFx(owner:string,rate:number,status:FxStatus){
  await db().batch(Object.entries({'fx':String(rate),'fx-status':JSON.stringify(status)}).map(([key,value])=>db().prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?) ON CONFLICT(owner,key) DO UPDATE SET value=excluded.value').bind(owner,key,value)));
}
export async function saveWithdrawal(owner:string,input:WithdrawalInput,editing=false){
  await lock(owner);
  try{
    const ledger=await getLedger(owner);
    if(input.date<ledger.baselineDate)throw new Error('新增出金日期不能早于原表基准日 '+ledger.baselineDate+'，原表出金已单独计入');
    if(input.date>chinaDate())throw new Error('不能登记尚未发生的出金');
    const existing=ledger.withdrawals.find(row=>row.id===input.id);
    if(editing&&!existing)throw new Error('未找到出金记录，请刷新页面');
    if(!editing&&existing){
      if(existing.date===input.date&&existing.amount===input.amount&&existing.note===input.note)return ledger;
      throw new Error('出金记录编号重复，请刷新页面');
    }
    if(!editing&&ledger.withdrawals.length>=2000)throw new Error('出金记录已达到 2000 条上限');
    const now=new Date().toISOString();
    const record:Withdrawal={...input,createdAt:existing?.createdAt??now,updatedAt:now};
    await setting(owner,'withdrawals',editing?ledger.withdrawals.map(row=>row.id===input.id?record:row):[...ledger.withdrawals,record]);
    await snapshot(owner);return getLedger(owner);
  }finally{await unlock(owner);}
}
export async function deleteWithdrawal(owner:string,id:string){
  await lock(owner);
  try{
    const ledger=await getLedger(owner);
    await setting(owner,'withdrawals',ledger.withdrawals.filter(row=>row.id!==id));
    await snapshot(owner);return getLedger(owner);
  }finally{await unlock(owner);}
}
export async function connect(owner:string,input:Credentials){
  await lock(owner);
  try{
    if(input.exchange==='aster')validateAsterWallet(input);
    const encrypted=await seal(input,owner+':'+input.exchange);
    const prices=await quotes();
    const result=input.exchange==='bybit'?await syncBybit(input,prices):await syncAster(input,prices);
    const now=new Date().toISOString();
    await db().prepare('INSERT INTO connections(owner,exchange,encrypted,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner,exchange) DO UPDATE SET encrypted=excluded.encrypted,updated_at=excluded.updated_at').bind(owner,input.exchange,encrypted,now).run();
    const ledger=await getLedger(owner),asset=ledger.assets.find(a=>a.mode===input.exchange)!;
    await saveAsset(owner,{...asset,quantity:result.total,price:1,value:result.total,status:'只读同步',updatedAt:now,error:undefined,details:result.details});
    await setting(owner,input.exchange+'-status',{configured:true,lastSync:now,error:null,scope:input.exchange==='bybit'?'统一账户 + 资金账户':input.includeSpot?'API Pro · 合约 + 现货':'API Pro · 合约净权益',label:(input.exchange==='bybit'?input.apiKey:input.walletAddress).slice(-4)});
    await snapshot(owner);return getLedger(owner);
  }finally{await unlock(owner);}
}
export async function disconnect(owner:string,exchange:'bybit'|'aster'){
  await lock(owner);try{
    const ledger=await getLedger(owner),asset=ledger.assets.find(a=>a.mode===exchange)!;
    await db().prepare('DELETE FROM connections WHERE owner = ? AND exchange = ?').bind(owner,exchange).run();
    await setting(owner,exchange+'-status',{configured:false,lastSync:ledger.connections[exchange].lastSync,error:null,scope:ledger.connections[exchange].scope});
    await saveAsset(owner,{...asset,status:'已断开 · 保留旧值',error:undefined});await snapshot(owner);return getLedger(owner);
  }finally{await unlock(owner);}
}
export async function refresh(owner:string){
  await lock(owner);
  try{
    const ledger=await getLedger(owner);
    const last=await db().prepare('SELECT value FROM settings WHERE owner = ? AND key = ?').bind(owner,'last-attempt').first<{value:string}>();
    if(last&&Date.now()-Number(last.value)<30000)return ledger;
    await setting(owner,'last-attempt',String(Date.now()));
    const stored=await db().prepare('SELECT exchange,encrypted FROM connections WHERE owner = ?').bind(owner).all<{exchange:'bybit'|'aster',encrypted:string}>();
    const [marketResult,fxResult]=await Promise.allSettled([quotes(),yuanQuote()]);
    const prices=marketResult.status==='fulfilled'?marketResult.value:undefined;
    const marketError=marketResult.status==='rejected'?(marketResult.reason instanceof Error?marketResult.reason.message:'无法获取行情'):undefined;
    if(fxResult.status==='fulfilled')await saveFx(owner,fxResult.value.rate,fxResult.value.status);
    else await setting(owner,'fx-status',{...ledger.fxStatus,error:'人民币汇率更新失败，保留上次汇率'});
    const virtual=ledger.assets.find(a=>a.mode==='market')!;
    if(prices){await saveAsset(owner,{...virtual,price:prices.VIRTUAL.price,value:(virtual.quantity??0)*prices.VIRTUAL.price,updatedAt:prices.VIRTUAL.at,status:prices.VIRTUAL.source+' · 实时单价',error:undefined});}
    else await saveAsset(owner,{...virtual,status:'行情失败 · 保留旧值',error:marketError});
    await Promise.all(stored.results.map(async row=>{
      const asset=ledger.assets.find(a=>a.mode===row.exchange)!;
      try{
        if(!prices)throw new Error(marketError);
        const c=await unseal(row.encrypted,owner+':'+row.exchange);
        const result=row.exchange==='bybit'?await syncBybit(c,prices):await syncAster(c,prices);
        const now=new Date().toISOString();
        await saveAsset(owner,{...asset,quantity:result.total,price:1,value:result.total,details:result.details,updatedAt:now,status:'只读同步',error:undefined});
        await setting(owner,row.exchange+'-status',{...ledger.connections[row.exchange],lastSync:now,error:null});
      }catch(e){
        const error=e instanceof Error?e.message:'同步暂时失败';
        await saveAsset(owner,{...asset,status:'同步失败 · 保留旧值',error});
        await setting(owner,row.exchange+'-status',{...ledger.connections[row.exchange],error});
      }
    }));
    await snapshot(owner);return getLedger(owner);
  }finally{await unlock(owner);}
}
