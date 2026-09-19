import example from './example-ledger.json';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Ledger, Asset } from './types';
import { parseSource, EXAMPLE_SOURCE, type SourceLedger } from './source-ledger';
import { embeddedWithdrawals } from './withdrawals';
export type { SourceLedger } from './source-ledger';
export function readSource(): SourceLedger {
  const filenames = process.env.ASSET_DATA_DIR
    ? [resolve(process.env.ASSET_DATA_DIR, 'imported-ledger.json')]
    : [resolve('.data/imported-ledger.json'), resolve('lib/imported-ledger.json')];
  for (const filename of filenames) {
    try { return parseSource(JSON.parse(readFileSync(filename, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return example;
}
export function seedLedger(raw: SourceLedger = readSource()): Ledger {
  const base = raw.periods.find(p => p.id === raw.baselineId)!;
  return {
    dataKind: raw.source === EXAMPLE_SOURCE ? 'example' : 'personal',
    assets: base.rows.map(row => ({...row, mode: row.project === 'virtual' ? 'market' : row.project === 'bybit' ? 'bybit' : row.project === 'aster' ? 'aster' : 'manual', updatedAt: base.date + 'T00:00:00+08:00', status: row.project === 'virtual' ? '待更新行情' : ['bybit','aster'].includes(row.project) ? '待连接 · 表格值' : '手动估值' } as Asset)),
    history: raw.periods.map(({rows,...period}) => ({...period, withdrawn: embeddedWithdrawals(rows)})), withdrawals: [], fx: raw.fx, baselineDate: raw.baselineDate, startedAt: raw.startedAt, baselineTotal: base.total,
    connections: { bybit: {configured:false,lastSync:null,error:null,scope:'统一账户 + 资金账户'}, aster: {configured:false,lastSync:null,error:null,scope:'合约账户'} }
  };
}
