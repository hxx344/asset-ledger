import { apiOwner, json } from '@/lib/api';
import { db } from '@/lib/sqlite';
import { unseal } from '@/lib/vault';
import { readTradingConnections, tradingExportFailure } from '@/lib/trading-export';

export async function GET(request: Request) {
  try {
    const owner = await apiOwner(request);
    return json(await readTradingConnections(db(), owner, unseal));
  } catch (error) {
    if (error instanceof Error && error.message === 'AUTH_REQUIRED') return json({ error: '请先登录' }, 401);
    const safe = tradingExportFailure(error);
    return json({ error: safe.error }, safe.status);
  }
}
