import { requireChatGPTUser } from './chatgpt-auth';
import { getLedger } from '@/lib/store';
import Dashboard from './dashboard';
export const dynamic = 'force-dynamic';
export default async function Page(){ const user=await requireChatGPTUser('/'); try{return <Dashboard initial={await getLedger(user.userId)}/>;}catch{return <main className="page"><h1>资产统计</h1><p>数据存储暂不可用，请稍后刷新。原始表格保持不变。</p></main>;} }
