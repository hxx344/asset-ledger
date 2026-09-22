import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHubSummary, readHubSummary } from '../lib/hub-summary.ts';
import { openDatabase } from '../lib/sqlite.ts';

const now = Date.parse('2026-09-22T17:00:00Z');
const fresh = new Date(now - 1000).toISOString();
const asset = (mode = 'market', updatedAt: string | null = fresh, value: number | null = 100) => ({ project: 'asset', mode, updatedAt, value });
const input = () => ({ assets: [asset()], fx: 7, fxStatus: { fetchedAt: fresh, error: null }, example: false, history: [] });

test('summary preserves ledger totals, withdrawals, oldest dynamic time and CNY/USD units', () => {
  const result = buildHubSummary({ ...input(), assets: [asset('market', fresh), asset('aster', '2026-09-22T16:58:00Z', 200), { ...asset('manual', '2020-01-01T00:00:00Z', 25), project: ' 出金 ' }] }, now);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.data.updatedAt, '2026-09-22T16:58:00.000Z');
  assert.equal(result.data.health.state, 'online');
  assert.equal(result.data.health.staleAfterSeconds, 900);
  const metrics = Object.fromEntries(result.data.metrics.map(metric => [metric.key, metric]));
  assert.equal(metrics.ledger_total.value, 325);
  assert.equal(metrics.holdings.value, 300);
  assert.equal(metrics.manual_valuation_at.value, '2020-01-01T00:00:00.000Z');
  assert.equal(metrics.fx.unit, 'CNY/USD');
});

test('only explicit manual valuations are static; missing dynamic sources and FX errors stay visible', () => {
  const manual = buildHubSummary({ ...input(), assets: [asset('manual', '2020-01-01T00:00:00Z')] }, now).data;
  assert.equal(manual.freshness, 'static');
  assert.equal(manual.health.state, 'online');
  const unknown = buildHubSummary({ ...input(), assets: [asset('unrecognized')] }, now).data;
  assert.equal(unknown.freshness, undefined);
  assert.equal(unknown.health.state, 'partial');
  assert.match(unknown.health.message, /未识别/);
  const missingTime = buildHubSummary({ ...input(), assets: [asset(), asset('aster', null)] }, now).data;
  assert.equal(missingTime.updatedAt, null);
  assert.equal(missingTime.health.state, 'stale');
  assert.equal(buildHubSummary({ ...input(), assets: [asset('market', '2020-01-01T00:00:00Z')] }, now).data.health.state, 'stale');
  const fxError = buildHubSummary({ ...input(), assets: [asset('manual')], fxStatus: { fetchedAt: fresh, error: 'FX failed' } }, now).data;
  assert.equal(fxError.freshness, 'static');
  assert.equal(fxError.health.state, 'partial');
  assert.match(fxError.health.message, /汇率/);
  const missingValue = buildHubSummary({ ...input(), assets: [asset('manual', fresh, null)] }, now).data;
  assert.equal(missingValue.metrics[0].value, null);
  assert.equal(missingValue.health.state, 'partial');
});

test('trend chooses the last original and daily total, skips invalid/future/archived dates and retains 90 distinct dates', () => {
  const history = Array.from({ length: 100 }, (_, index) => ({ id: 'original-' + index, date: new Date(Date.parse('2026-06-16T00:00:00Z') + index * 86400000).toISOString().slice(0, 10), total: index }));
  const result = buildHubSummary({ ...input(), history: [
    ...history, { id: 'original-later', date: '2026-09-22', total: 1000 },
    { id: 'daily-2026-09-22', date: '2026-09-22', total: 2000 },
    { id: 'original-last', date: '2026-09-22', total: 3000 },
    { id: 'daily-2026-09-23', date: '2026-09-23', total: 4000 },
    { id: 'future', date: '2026-09-24', total: 9999 },
    { id: 'archived', date: '2026-09-23', total: 9999, archived: true },
    { id: 'prefill', date: '2026-09-23', total: 9999, future: true },
    { id: 'invalid', date: '2026-02-30', total: 9999 },
  ] }, now).data;
  assert.equal(result.trend.length, 90);
  assert.deepEqual(result.trend.slice(-2), [{ at: '2026-09-22T00:00:00+08:00', value: 2000 }, { at: '2026-09-23T00:00:00+08:00', value: 4000 }]);
  assert.match(result.health.message, /非收益曲线/);
});

test('summary reads owner-scoped projected totals and finds 90 valid days beyond archived and invalid newest rows', async () => {
  const database = openDatabase(':memory:');
  try {
    await database.prepare('INSERT INTO assets VALUES(?,?,?)').bind('owner', 'row-1', JSON.stringify({ ...asset(), details: [{ privateHistoryMarker: 'not-in-summary' }] })).run();
    await database.prepare('INSERT INTO assets VALUES(?,?,?)').bind('other', 'row-1', JSON.stringify(asset('manual', fresh, 999999))).run();
    for (const [key, value] of Object.entries({ fx: '7', 'fx-status': JSON.stringify({ fetchedAt: fresh }), 'source-ledger': JSON.stringify({ source: 'personal', periods: [{ id: 'E1', date: '2026-09-22', total: 1, rows: [{ privateHistoryMarker: 'not-in-summary' }] }] }) })) {
      await database.prepare('INSERT INTO settings VALUES(?,?,?)').bind('owner', key, value).run();
    }
    for (let index = 0; index < 100; index++) {
      const date = new Date(Date.parse('2026-06-16T00:00:00Z') + index * 86400000).toISOString().slice(0, 10);
      await database.prepare('INSERT INTO snapshots VALUES(?,?,?)').bind('owner', date, JSON.stringify({ id: 'daily-' + date, date, total: index, assets: [{ privateHistoryMarker: 'not-in-summary', value: 123456 }] })).run();
    }
    await database.prepare('INSERT INTO snapshots VALUES(?,?,?)').bind('owner', 'archive-recent', JSON.stringify({ id: 'archive-recent', date: '2026-09-23', total: 9999, archived: true })).run();
    const result = await readHubSummary(database, 'owner', now);
    assert.equal(result.data.metrics[0].value, 100);
    assert.equal(result.data.trend.length, 90);
    assert.deepEqual(result.data.trend.at(-1), { at: '2026-09-23T00:00:00+08:00', value: 99 });
    assert.equal(result.data.trend.find(point => point.at.startsWith('2026-09-22'))?.value, 98);
    assert.equal(JSON.stringify(result).includes('privateHistoryMarker'), false);
  } finally { database.close(); }
});
