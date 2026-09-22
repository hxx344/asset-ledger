'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Wallet, ChartNoAxesCombined, History, Cable, RefreshCw, Pencil, ShieldCheck, ChevronRight, Eye, ArrowUpRight } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import type { Ledger, Asset, Period } from '@/lib/types';
import { ImportLedgerDialog } from './import-ledger-dialog';
import { AssetTrend } from './asset-trend';
import { WithdrawalsPanel } from './withdrawals-panel';
import { AsterAccountsPanel } from './aster-accounts-panel';
import { assetMeasures, embeddedWithdrawals, chinaDay, periodMeasures } from '@/lib/withdrawals';
import { createHubBridge } from '@/lib/hub-bridge';
import { requestJson, createRequestSlot } from '@/lib/client-request';
import { nextLedgerExpiry } from '@/lib/client-freshness';

const money=(n:number,d=2)=>n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const stamp=(s:string|null)=>s?new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'尚未同步';
const viewNames={overview:'资产总览',history:'历史记录',withdrawals:'出金记录',connections:'交易所连接'};
type View=keyof typeof viewNames;
async function api(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<Ledger>{
 const timeoutMs=path==='/api/sync'?75_000:['/api/connections','/api/aster-accounts'].includes(path)?60_000:30_000;
 return requestJson<Ledger>(path,{method,headers:method==='GET'?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal,timeoutMs});
}
function badge(a:Asset,now:number){
 if(a.mode!=='manual'&&a.status.includes('同步')&&!a.error&&now-new Date(a.updatedAt).getTime()>300000)return '数据已过期 · 保留旧值';
 if(a.mode==='market'&&!a.error&&now-new Date(a.updatedAt).getTime()>900000)return '行情已过期 · 保留旧值';
 return a.status;
}
export default function Dashboard({initial}:{initial:Ledger}){
 const [ledger,setLedger]=useState(initial),[filter,setFilter]=useState('all'),[view,setView]=useState<View>('overview');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[now,setNow]=useState(()=>Date.now());
 const [editing,setEditing]=useState<Asset|null>(null),[quantity,setQuantity]=useState(''),[price,setPrice]=useState('');
 const [fxOpen,setFxOpen]=useState(false),[fx,setFx]=useState(String(initial.fx)),[formError,setFormError]=useState('');
 const [connectTo,setConnectTo]=useState<'bybit'|null>(null),[key,setKey]=useState(''),[secret,setSecret]=useState(''),[region,setRegion]=useState('global');
 const [detail,setDetail]=useState<Asset|null>(null),[period,setPeriod]=useState<Period|null>(null),[periodRows,setPeriodRows]=useState<Asset[]>([]);
 const busyRef=useRef(false),importOpenRef=useRef(false);
 const bridgeRef=useRef<ReturnType<typeof createHubBridge>|null>(null),historyRequestRef=useRef<AbortController|null>(null);
 const requests=useRef(createRequestSlot());
 const ledgerRef=useRef(initial),activeRef=useRef(false),mountedRef=useRef(false);
 const [importOpen,setImportOpen]=useState(false);
 function toggleImport(open:boolean){importOpenRef.current=open;setImportOpen(open);}
 const refresh=useCallback(async(manual=false)=>{
  if(busyRef.current||importOpenRef.current||(!manual&&!activeRef.current))return;busyRef.current=true;setBusy(true);
  const controller=requests.current.start(!manual);if(!controller){busyRef.current=false;setBusy(false);return;}
  try{
   const data=await api('/api/sync','POST',{},controller.signal);
   if(controller.signal.aborted||!mountedRef.current)return;
   const previous=ledgerRef.current;
   const changed=manual||JSON.stringify([previous.assets,previous.fx,previous.fxStatus,previous.withdrawals,previous.connections,previous.asterAccounts])!==JSON.stringify([data.assets,data.fx,data.fxStatus,data.withdrawals,data.connections,data.asterAccounts]);
   ledgerRef.current=data;setLedger(data);setError('');if(changed)bridgeRef.current?.changed();if(manual)toast.success('已完成刷新，更新状态见资产明细');
  }
  catch(e){if(!controller.signal.aborted&&mountedRef.current)setError(e instanceof Error?e.message:'更新失败');}
  finally{if(requests.current.finish(controller)){busyRef.current=false;if(mountedRef.current){setBusy(false);setNow(Date.now());}}}
 },[]);
 useEffect(()=>{
  mountedRef.current=true;
  let timer:ReturnType<typeof setInterval>|undefined;
  const update=()=>{
   const wasActive=activeRef.current;activeRef.current=!!bridgeRef.current?.active&&document.visibilityState==='visible'&&navigator.onLine;
   if(timer!==undefined){clearInterval(timer);timer=undefined;}
   if(!activeRef.current&&requests.current.cancel(true)){busyRef.current=false;setBusy(false);}
   if(activeRef.current){if(!wasActive)void refresh();timer=setInterval(()=>void refresh(),60000);}
   setNow(Date.now());
  };
  const bridge=createHubBridge({onActivity:update,onNavigate:({projectId,query})=>{if(projectId==='asset'&&Object.keys(query).length===0){setView('overview');location.hash='overview';window.scrollTo({top:0});}}});bridgeRef.current=bridge;
  update();document.addEventListener('visibilitychange',update);window.addEventListener('online',update);window.addEventListener('offline',update);
  const slot=requests.current;
  return()=>{mountedRef.current=false;activeRef.current=false;bridge.dispose();bridgeRef.current=null;if(timer!==undefined)clearInterval(timer);document.removeEventListener('visibilitychange',update);window.removeEventListener('online',update);window.removeEventListener('offline',update);slot.cancel();historyRequestRef.current?.abort();busyRef.current=false;};
 },[refresh]);
 useEffect(()=>{
  if(document.hidden||!bridgeRef.current?.active)return;
  const time=Date.now(),next=nextLedgerExpiry(ledger,time);
  if(next===null)return;
  const timer=setTimeout(()=>setNow(Date.now()),Math.min(next-time,2_147_483_647));
  return()=>clearTimeout(timer);
 },[ledger,now]);
 useEffect(()=>{
  const read=()=>{const v=location.hash.slice(1);if(v in viewNames)setView(v as View);};read();window.addEventListener('hashchange',read);return()=>window.removeEventListener('hashchange',read);
 },[]);
 useEffect(()=>{
  const context=(document as Document & {modelContext?:{registerTool:(tool:unknown,options:unknown)=>Promise<void>|void}}).modelContext;
  if(!context?.registerTool)return;
  const lifecycle=new AbortController();
  Promise.resolve(context.registerTool({name:'read_asset_ledger',description:'读取当前资产估值、单价、来源及更新时间，不进行同步或修改。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute:(input:unknown)=>{if(!input||typeof input!=='object'||Object.keys(input).length)throw new Error('无需参数');return {assets:ledger.assets,fx:ledger.fx,baselineDate:ledger.baselineDate};}},{signal:lifecycle.signal})).catch(()=>{});
  return()=>lifecycle.abort();
 },[ledger]);
 function navigate(v:View){setView(v);if(window.location.hash!=='#'+v)window.history.pushState(null,'','#'+v);window.scrollTo({top:0});}
 async function mutate(path:string,method:string,body:unknown,onSuccess:()=>void){
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setFormError('');
  const controller=requests.current.start();if(!controller){busyRef.current=false;setBusy(false);return;}
  try{const data=await api(path,method,body,controller.signal);if(controller.signal.aborted||!mountedRef.current)return;ledgerRef.current=data;setLedger(data);setError('');bridgeRef.current?.changed();onSuccess();toast.success('已保存');}
  catch(e){if(!controller.signal.aborted&&mountedRef.current)setFormError(e instanceof Error?e.message:'保存失败，输入已保留');}
  finally{if(requests.current.finish(controller)){busyRef.current=false;if(mountedRef.current){setBusy(false);setNow(Date.now());}}}
 }
 function edit(a:Asset){setEditing(a);setQuantity(String(a.quantity??0));setPrice(a.price===null?'':String(a.price));setFormError('');}
 function connection(exchange:'bybit'|'aster'){if(exchange==='aster'){navigate('connections');return;}setConnectTo(exchange);setKey('');setSecret('');setFormError('');}
 async function openPeriod(p:Period){
  historyRequestRef.current?.abort();const controller=new AbortController();historyRequestRef.current=controller;
  setPeriod(p);setPeriodRows([]);setFormError('');
  try{const data=await requestJson<{rows:Asset[]}>('/api/history?id='+encodeURIComponent(p.id),{signal:controller.signal});if(!controller.signal.aborted&&mountedRef.current)setPeriodRows(data.rows);}
  catch(e){if(!controller.signal.aborted&&mountedRef.current)setFormError(e instanceof Error?e.message:'无法读取历史明细');}
 }
 const total=ledger.assets.reduce((s,a)=>s+(a.value??0),0);
 const exchangeTotal=ledger.assets.filter(a=>a.mode==='bybit'||a.mode==='aster').reduce((s,a)=>s+(a.value??0),0);
 const pointsTotal=ledger.assets.filter(a=>a.kind.includes('积分')).reduce((s,a)=>s+(a.value??0),0);
 const rows=ledger.assets.filter(a=>filter==='all'||(filter==='manual'?a.mode==='manual':a.mode!=='manual')).sort((a,b)=>(b.value??0)-(a.value??0));
 const today=chinaDay(new Date(now));
 const measures=assetMeasures(total,embeddedWithdrawals(ledger.assets),ledger.withdrawals,today);
 const fxStale=!!ledger.fxStatus.error||!ledger.fxStatus.fetchedAt||now-Date.parse(ledger.fxStatus.fetchedAt)>300000;
 const fxSource=ledger.fxStatus.source==='manual'?'手动备用':ledger.fxStatus.source==='saved'?'原表 / 已保存值':ledger.fxStatus.source==='Frankfurter'?'Frankfurter / ECB（日度参考）':'Coinbase';
 const pending=Object.values(ledger.connections).filter(c=>!c.configured).length;
 const failures=ledger.assets.filter(a=>a.error);
 const nav=[{id:'overview' as View,label:'资产总览',Icon:ChartNoAxesCombined},{id:'history' as View,label:'历史记录',Icon:History},{id:'withdrawals' as View,label:'出金记录',Icon:ArrowUpRight},{id:'connections' as View,label:'交易所连接',Icon:Cable}];
 const renderTable=(assets:Asset[],editable=true)=><Table><TableHeader><TableRow><TableHead>项目 / 资产</TableHead><TableHead>类型</TableHead><TableHead className="numeric">数量</TableHead><TableHead className="numeric">单价 / USD</TableHead><TableHead className="numeric">估值 / USD</TableHead>{editable&&<><TableHead>数据来源 / 更新时间</TableHead><TableHead>操作</TableHead></>}</TableRow></TableHeader><TableBody>{assets.map(a=><TableRow key={a.id}><TableCell><strong className="asset-name">{a.project}</strong>{a.project==='virtual'&&<small className="ticker">VIRTUAL</small>}</TableCell><TableCell><span className="kind">{a.kind}</span></TableCell><TableCell className="numeric">{editable&&['bybit','aster'].includes(a.mode)?'账户权益':a.quantity===null?'—':money(a.quantity,a.quantity%1?4:0)}</TableCell><TableCell className="numeric">{editable&&['bybit','aster'].includes(a.mode)?'—':a.price===null?'—':money(a.price,a.price<1?6:2)}</TableCell><TableCell className="numeric asset-value">{a.value===null?'—':money(a.value)}</TableCell>{editable&&<><TableCell><span title={a.error} className={'status '+(a.mode==='manual'?'':a.error||badge(a,now).includes('旧值')||badge(a,now).includes('待')?'amber':'live')}>{badge(a,now)}</span><small className="ticker">{stamp(a.updatedAt)}</small></TableCell><TableCell>{['bybit','aster'].includes(a.mode)?<button className="icon-button" aria-label={'查看 '+a.project+' 资产'} onClick={()=>a.details?setDetail(a):connection(a.mode as 'bybit'|'aster')}><Eye size={16}/></button>:<button className="icon-button" aria-label={'编辑 '+a.project+' '+a.kind} onClick={()=>edit(a)}><Pencil size={15}/></button>}</TableCell></>}</TableRow>)}</TableBody></Table>;
 return <div className="ledger-shell">
 <a className="skip-link" href="#ledger-content">跳到页面内容</a>
 <header className="topbar">
   <div className="brand"><Wallet aria-hidden="true"/><div>资产账本<small>ASSET LEDGER</small></div></div>
   <div className="topbar-actions">
     <span className="workspace-date">{new Date(now).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric'})}</span>
     <span className="privacy"><ShieldCheck size={16} aria-hidden="true"/>独立密码保护</span>
     <button className="button" onClick={async()=>{try{const response=await fetch('/api/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw new Error();window.location.assign('/login');}catch{toast.error('退出失败，请重试');}}}>退出</button>
   </div>
 </header>
 <nav className="workspace-nav" aria-label="账本功能"><div>{nav.map(({id,label,Icon})=><button type="button" key={id} aria-current={view===id?'page':undefined} onClick={()=>navigate(id)}><Icon size={17} aria-hidden="true"/><span>{label}</span></button>)}</div></nav>
 <main className="workspace" id="ledger-content" tabIndex={-1}><div className="page"><div className="page-heading"><div><h1>{viewNames[view]}</h1><p>{view==='overview'?'实时估值与手动资产，统一记录。':view==='history'?'保留原表记录；每天保存最近一次更新。':view==='withdrawals'?'登记出金，观察剔除提款影响后的资产变化。':'只读获取账户资产，密钥仅加密保存在服务端。'}</p></div><button className="button primary" disabled={busy} onClick={()=>void refresh(true)}><RefreshCw className={busy?'loading-spin':''} size={16}/>{busy?'正在更新':'刷新资产'}</button></div>
 {ledger.dataKind==='example'&&<div className="notice import-notice"><div><strong>当前为示例数据，尚未导入你的原表</strong><p>这里的资产和金额是演示内容。导入原表后才会显示你的真实持仓和历史。</p></div><button className="button primary" disabled={busy} onClick={()=>toggleImport(true)}>导入原表数据</button></div>}
 {error&&<div className="notice" role="alert">{error}。当前显示上次已保存的数据。</div>}
 {ledger.fxStatus.error&&<div className="notice" role="status">{ledger.fxStatus.error}，人民币折算暂用 1 USD = {money(ledger.fx,4)} CNY。</div>}
 {view==='overview'&&<><section className="summary"><div><div className="metric-label">表内总额 <span>USD · 原口径</span></div><div className="total-number">$ {money(total)}</div><p className="muted">折合人民币 ¥ {money(total*ledger.fx)} <button className="text-button" aria-label="人民币汇率详情与备用设置" onClick={()=>{setFx(String(ledger.fx));setFormError('');setFxOpen(true);}}><Pencil size={12}/></button></p><div className="fx-summary"><span className={'status '+(fxStale?'amber':'live')}>1 USD = {money(ledger.fx,4)} CNY · {ledger.fxStatus.error?'更新失败 · 保留旧值':fxStale?'待更新':ledger.fxStatus.source==='manual'?'临时手动':'自动更新'}</span><small>{fxSource}{ledger.fxStatus.rateDate?' · 报价日期 '+ledger.fxStatus.rateDate:' · 获取时间 '+stamp(ledger.fxStatus.fetchedAt)}</small></div></div>
 <div className="secondary-metric">
  <div className="metric-label">交易所资产</div>
  <strong>$ {money(exchangeTotal)}</strong>
  <span className="muted">折合人民币 ¥ {money(exchangeTotal*ledger.fx)}</span>
  <span className={'status '+(pending?'amber':'live')}>{pending?pending+' 个账户待连接':'只读账户已连接'}</span>
 </div>
 <div className="secondary-metric">
  <div className="metric-label">积分预估价值</div>
  <strong>$ {money(pointsTotal)}</strong>
  <span className="muted">折合人民币 ¥ {money(pointsTotal*ledger.fx)}</span>
  <span className="muted">沿用表格估值，可手动编辑</span>
 </div></section>
 {failures.length>0&&<div className="notice" role="status">{failures.map(a=>a.project+'：'+a.error).join('；')}</div>}
 <section className="withdrawal-summary" aria-label="出金调整口径"><div><span>实际持有资产 / USD</span><strong>$ {money(measures.held)}</strong><p>表内总额减去原表“出金”</p></div><div className="adjusted-metric"><span>剔除出金影响 / USD</span><strong>$ {money(measures.adjusted)}</strong><p>实际持有资产 + 累计出金</p></div><div><span>累计出金 / USD</span><strong>$ {money(measures.withdrawn)}</strong><button className="text-button" onClick={()=>navigate('withdrawals')}>管理出金记录 <ArrowUpRight size={14}/></button></div></section>
 <div className="chart-grid"><AssetTrend ledger={ledger} today={today} onHistory={()=>navigate('history')}/>
 <section className="panel sync-panel"><div className="panel-title"><h2>数据连接</h2><ShieldCheck size={18}/></div>{(['bybit','aster'] as const).map(name=><button className="connection-row" key={name} onClick={()=>connection(name)}><div className={'exchange-mark '+name}>{name==='bybit'?'B':'A'}</div><div><strong>{name==='bybit'?'Bybit':'Aster'}</strong><small>{ledger.connections[name].configured?'已连接 · '+stamp(ledger.connections[name].lastSync):'待连接只读接口'}</small></div><ChevronRight size={17}/></button>)}<div className="connection-row"><div className="exchange-mark virtual">V</div><div><strong>Virtual</strong><small>实时单价 · 数量手动</small></div></div><div className="sync-note">页面打开时每 60 秒刷新<br/>USD/CNY 随刷新自动更新<br/>{fxSource}</div></section></div>
 <section className="panel holdings"><div className="holdings-heading"><h2>资产明细 <span>{rows.length}</span></h2><Tabs value={filter} onValueChange={setFilter}><TabsList><TabsTrigger value="all">全部资产</TabsTrigger><TabsTrigger value="auto">自动更新</TabsTrigger><TabsTrigger value="manual">手动维护</TabsTrigger></TabsList></Tabs></div>{renderTable(rows)}</section></>}
 {view==='history'&&<><div className="notice">原表未来预填和导入前示例不计入曲线。同日多份记录在此保留；曲线优先采用日快照，其次采用最后一份原表记录。出金调整只影响派生口径，表内总额保持原值。</div><section className="panel holdings"><Table><TableHeader><TableRow><TableHead>日期（北京时间）</TableHead><TableHead>来源</TableHead><TableHead className="numeric">表内总额 / USD</TableHead><TableHead className="numeric">实际持有 / USD</TableHead><TableHead className="numeric">累计出金 / USD</TableHead><TableHead className="numeric">剔除出金影响 / USD</TableHead><TableHead className="numeric">汇率</TableHead><TableHead className="numeric">原总额 / CNY</TableHead><TableHead>核对 / 明细</TableHead></TableRow></TableHeader><TableBody>{[...ledger.history].sort((a,b)=>b.date.localeCompare(a.date)).map(p=>{const values=periodMeasures(p,ledger),included=!p.future&&!p.archived;return <TableRow key={p.id}><TableCell>{p.date}</TableCell><TableCell><span className={'status '+(p.future||p.partial?'amber':'')}>{p.archived?'导入前示例记录':p.future?'原表预填':p.id.startsWith('daily-')?(p.partial?'当日快照 · 含旧值':'当日最后更新'):'原表 '+p.id}</span></TableCell><TableCell className="numeric">{money(p.total)}</TableCell><TableCell className="numeric">{included?money(values.held):'—'}</TableCell><TableCell className="numeric">{included?money(values.withdrawn):'—'}</TableCell><TableCell className="numeric">{included?money(values.adjusted):'—'}</TableCell><TableCell className="numeric" title={p.fxStatus?(p.fxStatus.source==='Frankfurter'?'Frankfurter / ECB · 报价日 '+p.fxStatus.rateDate:p.fxStatus.source+' · '+stamp(p.fxStatus.fetchedAt)):'原记录汇率'}>{p.fx}{p.fxStatus?.error&&<small className="ticker">沿用旧汇率</small>}</TableCell><TableCell className="numeric">{money(p.cny)}</TableCell><TableCell><button className="text-button" onClick={()=>void openPeriod(p)}>{p.difference?'合计差异 $ '+money(p.difference):'查看明细'}</button></TableCell></TableRow>;})}</TableBody></Table></section><p className="help section-note">日快照在刷新或编辑时保存；页面关闭期间不补造记录。入金未剔除，资产变化不等于投资收益。</p></>}
 {view==='withdrawals'&&<WithdrawalsPanel ledger={ledger} today={today} busy={busy} error={formError} mutate={mutate} clearError={()=>setFormError('')}/>}
 {view==='connections'&&<div className="connections-grid">{(['bybit'] as const).map(name=><section className="panel connection-card" key={name}><div className="connection-card-title"><div className={'exchange-mark '+name}>{name==='bybit'?'B':'A'}</div><h2>{name==='bybit'?'Bybit':'Aster'}</h2><span className={'status '+(ledger.connections[name].configured?'live':'amber')}>{ledger.connections[name].configured?'已连接':'未连接'}</span></div><p className="help">{name==='bybit'?'统一账户净权益与资金账户余额；包含未实现盈亏，不重复累加保证金。':'使用 API Pro 钱包地址和私钥读取合约净权益，可同时读取现货余额。范围不含质押资产。'}</p><p className="help section-note">最近成功同步：{stamp(ledger.connections[name].lastSync)}</p>{ledger.connections[name].error&&<p className="error-text">{ledger.connections[name].error}</p>}<div className="form-actions"><button className="button primary" onClick={()=>connection(name)}>{ledger.connections[name].configured?'更新连接':'连接账户'}</button></div></section>)}<AsterAccountsPanel accounts={ledger.asterAccounts} busy={busy} error={formError} clearError={()=>setFormError('')} mutate={mutate}/></div>}
 <footer className="page-footer">{ledger.dataKind==='example'?'示例账本 · 尚未导入原表':'源自《资产统计.xlsx》'} · 起始持仓 {ledger.baselineDate} · 自 {ledger.startedAt} 开始更新</footer></div></main>
 <Dialog open={!!editing} onOpenChange={v=>!v&&setEditing(null)}><DialogContent><DialogHeader><DialogTitle>编辑 {editing?.project}</DialogTitle><DialogDescription>{editing?.kind} · {editing?.mode==='market'?'单价按行情更新，持仓数量手动维护。':'修改后重新计算估值，并保存当日快照。'}</DialogDescription></DialogHeader><form className="form-grid" onSubmit={e=>{e.preventDefault();if(editing)void mutate('/api/ledger','PATCH',{id:editing.id,quantity:Number(quantity),price:price===''?null:Number(price)},()=>setEditing(null));}}><label>数量<input type="number" min="0" step="any" required value={quantity} onChange={e=>setQuantity(e.target.value)}/></label><label>单价 / USD<input type="number" min="0" step="any" value={price} disabled={editing?.mode==='market'} onChange={e=>setPrice(e.target.value)}/></label><p className="help">估值：{price===''?'待填写单价':'$ '+money(Number(quantity)*Number(price))}</p>{formError&&<p className="error-text" role="alert">{formError}</p>}<div className="form-actions"><button type="button" className="button" onClick={()=>setEditing(null)}>取消</button><button className="button primary" disabled={busy}>保存修改</button></div></form></DialogContent></Dialog>
 <Dialog open={fxOpen} onOpenChange={setFxOpen}><DialogContent><DialogHeader><DialogTitle>人民币换算汇率</DialogTitle><DialogDescription>每 60 秒随资产自动更新。可临时设置备用值，下一次自动获取成功后会覆盖；历史快照保留当时汇率。</DialogDescription></DialogHeader><p className="help">当前来源：{fxSource}<br/>{ledger.fxStatus.rateDate?'报价日期：'+ledger.fxStatus.rateDate:'获取时间：'+stamp(ledger.fxStatus.fetchedAt)}<br/>来源未提供逐笔报价时间时，展示获取时间。</p><form className="form-grid" onSubmit={e=>{e.preventDefault();void mutate('/api/ledger','PATCH',{fx:Number(fx)},()=>setFxOpen(false));}}><label>1 USD 折合 CNY<input type="number" min="0.001" step="any" required value={fx} onChange={e=>setFx(e.target.value)}/></label>{formError&&<p className="error-text" role="alert">{formError}</p>}<button className="button primary" disabled={busy}>临时使用此汇率</button></form></DialogContent></Dialog>
 <Dialog open={!!connectTo} onOpenChange={v=>{if(!v){setConnectTo(null);setSecret('');setKey('');}}}><DialogContent><DialogHeader><DialogTitle>连接 Bybit</DialogTitle><DialogDescription>验证只读权限与余额，成功后加密保存。</DialogDescription></DialogHeader><form className="form-grid" onSubmit={e=>{e.preventDefault();void mutate('/api/connections','POST',{exchange:'bybit',apiKey:key.trim(),apiSecret:secret.trim(),region},()=>{setConnectTo(null);setKey('');setSecret('');});}}><label>API Key<input autoComplete="off" spellCheck={false} autoCapitalize="none" required value={key} onChange={e=>setKey(e.target.value)}/></label><label>API Secret<input type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" required value={secret} onChange={e=>setSecret(e.target.value)}/></label><label>账户地区<Select value={region} onValueChange={setRegion}><SelectTrigger aria-label="账户地区"><SelectValue/></SelectTrigger><SelectContent>{[['global','国际站'],['nl','荷兰'],['tr','土耳其'],['kz','哈萨克斯坦'],['ge','格鲁吉亚'],['ae','阿联酋'],['eu','欧洲']].map(([v,l])=><SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent></Select></label><p className="help">HMAC 类型只读 API，需要账户与资产读取权限；不读取子账户及理财产品。</p>{formError&&<p className="error-text" role="alert">{formError}</p>}<div className="form-actions">{ledger.connections.bybit.configured&&<button type="button" className="button" disabled={busy} onClick={()=>void mutate('/api/connections','DELETE',{exchange:'bybit'},()=>{setConnectTo(null);setKey('');setSecret('');})}>断开并保留估值</button>}<button className="button primary" disabled={busy}>{busy?'验证中…':'验证并连接'}</button></div></form></DialogContent></Dialog>
 <Dialog open={!!detail} onOpenChange={v=>!v&&setDetail(null)}><DialogContent className="detail-dialog"><DialogHeader><DialogTitle>{detail?.project} 账户明细</DialogTitle><DialogDescription>最近同步 {stamp(detail?.updatedAt??null)} · 美元净权益</DialogDescription></DialogHeader><div className="holdings"><Table><TableHeader><TableRow><TableHead>账户 / 币种</TableHead><TableHead className="numeric">数量</TableHead><TableHead className="numeric">美元价值</TableHead></TableRow></TableHeader><TableBody>{detail?.details?.map((b,i)=><TableRow key={i}><TableCell>{b.account}<small className="ticker">{b.coin}</small></TableCell><TableCell className="numeric">{money(b.quantity,6)}</TableCell><TableCell className="numeric">{money(b.value)}</TableCell></TableRow>)}</TableBody></Table></div><p className="help">账户合计采用交易所净权益。币种行仅供核对，不将保证金和持仓名义价值再次计入。</p></DialogContent></Dialog>
 <Dialog open={!!period} onOpenChange={v=>!v&&setPeriod(null)}><DialogContent className="detail-dialog"><DialogHeader><DialogTitle>{period?.date} 资产快照</DialogTitle><DialogDescription>{period?.archived?'导入前示例记录':period?.future?'原表预填记录':period?.id.startsWith('daily-')?'当日最近一次已保存数据':'原表 '+period?.id} · 总额 $ {money(period?.total??0)}</DialogDescription></DialogHeader>{period?.difference!==0&&<p className="notice">行估值之和与原合计相差 $ {money(period?.difference??0)}。保留原合计，未修改历史。</p>}{formError?<p className="error-text">{formError}</p>:periodRows.length?<div className="holdings">{renderTable(periodRows,false)}</div>:<p className="help">读取快照…</p>}</DialogContent></Dialog>
 <ImportLedgerDialog open={importOpen} onOpenChange={toggleImport} onImported={data=>{ledgerRef.current=data;setLedger(data);setError('');setNow(Date.now());bridgeRef.current?.changed();}}/>
 <Toaster position="bottom-right" richColors/></div>;
}
