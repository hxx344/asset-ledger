import raw from './imported-ledger.json';
import type { Ledger, Asset } from './types';
export function seedLedger(): Ledger {
  const base = raw.periods.find(p => p.id === raw.baselineId)!;
  return {
    assets: base.rows.map(row => ({...row, mode: row.project === 'virtual' ? 'market' : row.project === 'bybit' ? 'bybit' : row.project === 'aster' ? 'aster' : 'manual', updatedAt: base.date + 'T00:00:00+08:00', status: row.project === 'virtual' ? '待更新行情' : ['bybit','aster'].includes(row.project) ? '待连接 · 表格值' : '手动估值' } as Asset)),
    history: raw.periods.map(({rows: _rows,...period}) => period), fx: raw.fx, baselineDate: raw.baselineDate, startedAt: raw.startedAt, baselineTotal: base.total,
    connections: { bybit: {configured:false,lastSync:null,error:null,scope:'统一账户 + 资金账户'}, aster: {configured:false,lastSync:null,error:null,scope:'合约账户'} }
  };
}
