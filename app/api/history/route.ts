import {apiOwner,json,failure} from '@/lib/api';
import {db} from '@/lib/store';
import raw from '@/lib/imported-ledger.json';
export async function GET(request:Request){try{
  const owner=await apiOwner(request),id=new URL(request.url).searchParams.get('id');
  const original=raw.periods.find(p=>p.id===id);
  if(original)return json({rows:original.rows});
  if(!id||!/^daily-\d{4}-\d{2}-\d{2}$/.test(id))return json({error:'未找到记录'},404);
  const row=await db().prepare('SELECT data FROM snapshots WHERE owner = ? AND date = ?').bind(owner,id.slice(6)).first<{data:string}>();
  return row?json({rows:JSON.parse(row.data).assets}):json({error:'未找到记录'},404);
}catch(e){return failure(e);}}
