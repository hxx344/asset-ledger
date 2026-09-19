import test from 'node:test';
import assert from 'node:assert/strict';
import { assetMeasures, assetTrend, embeddedWithdrawals, chinaDay, periodMeasures } from '../lib/withdrawals.ts';
import { withdrawalSchema } from '../lib/validation.ts';
import type { Period, Withdrawal } from '../lib/types.ts';

const withdrawal = (date: string, amount: number): Withdrawal => ({ id: crypto.randomUUID(), date, amount, note: '', createdAt: date, updatedAt: date });
const period = (id: string, date: string, total: number, withdrawn = 0): Period => ({ id, date, total, withdrawn, fx: 7, cny: total * 7, difference: 0, future: false });

test('workbook cumulative withdrawals are removed from holdings and added back exactly once', () => {
  const embedded = embeddedWithdrawals([{ project: '出金', value: 2000 }, { project: '出借', value: 500 }, { project: '其他', value: 1000 }]);
  assert.equal(embedded, 2000);
  assert.deepEqual(assetMeasures(3500, embedded, [], '2026-09-19'), { held: 1500, withdrawn: 2000, adjusted: 3500, recorded: 0 });
  assert.equal(embeddedWithdrawals([{ project: '出金', value: null }]), 0);
});

test('a withdrawal reduces actual holdings but leaves the adjusted value unchanged', () => {
  const before = assetMeasures(12000, 2000, [], '2026-09-17');
  const rows = [withdrawal('2026-09-18', 1000), withdrawal('2026-09-20', 500)];
  const after = assetMeasures(11000, 2000, rows, '2026-09-19');
  assert.equal(before.held - after.held, 1000);
  assert.equal(before.adjusted, after.adjusted);
  assert.equal(after.withdrawn, 3000);
  assert.equal(assetMeasures(11000, 2000, rows, '2026-09-17').recorded, 0);
});

test('backdated corrections recalculate later points without mutating stored totals', () => {
  const history = [period('E1', '2026-09-14', 12000, 2000), period('daily-2026-09-18', '2026-09-18', 11000, 2000), period('daily-2026-09-19', '2026-09-19', 11100, 2000)];
  const copy = structuredClone(history);
  const ledger = { history, baselineDate: '2026-09-14', withdrawals: [withdrawal('2026-09-18', 1000)] };
  assert.deepEqual(assetTrend(ledger, '2026-09-19').map(p => p.adjusted), [12000, 12000, 12100]);
  ledger.withdrawals[0].amount = 900;
  assert.deepEqual(assetTrend(ledger, '2026-09-19').map(p => p.adjusted), [12000, 11900, 12000]);
  ledger.withdrawals = [];
  assert.deepEqual(assetTrend(ledger, '2026-09-19').map(p => p.adjusted), [12000, 11000, 11100]);
  assert.deepEqual(history, copy);
});

test('trend prefers daily snapshots, keeps last same-day source, and excludes future/archive points', () => {
  const ledger = { baselineDate: '2026-09-14', withdrawals: [], history: [
    period('B1', '2026-09-01', 1000), period('C1', '2026-09-01', 2000),
    period('daily-2026-09-14', '2026-09-14', 4000), period('E1', '2026-09-14', 3000),
    { ...period('F1', '2026-09-15', 9000), future: true },
    { ...period('archive-a', '2026-09-16', 8000), archived: true },
    period('daily-2026-09-20', '2026-09-20', 7000),
  ] };
  assert.deepEqual(assetTrend(ledger, '2026-09-19').map(p => p.total), [2000, 4000]);
  assert.deepEqual(assetTrend({ ...ledger, history: [] }, '2026-09-19'), []);
});

test('same-day new withdrawals apply to live daily values but not the original baseline', () => {
  const ledger = { baselineDate: '2026-09-19', withdrawals: [withdrawal('2026-09-19', 100)] };
  assert.equal(periodMeasures(period('E1', '2026-09-19', 1000), ledger).adjusted, 1000);
  assert.equal(periodMeasures(period('daily-2026-09-19', '2026-09-19', 900), ledger).adjusted, 1000);
});

test('withdrawal validation rejects invalid dates, precision and amounts; dates use Beijing midnight', () => {
  const input = { id: crypto.randomUUID(), date: '2026-09-19', amount: 12.34, note: ' test ' };
  assert.equal(withdrawalSchema.parse(input).note, 'test');
  for (const changes of [{ date: '2026-02-30' }, { amount: 0 }, { amount: -1 }, { amount: Infinity }, { amount: 0.001 }, { amount: 0.00001 }, { amount: 1e13 }, { id: 'row-1' }, { note: 'x'.repeat(201) }, { owner: 'someone-else' }]) {
    assert.equal(withdrawalSchema.safeParse({ ...input, ...changes }).success, false);
  }
  assert.equal(chinaDay(new Date('2026-09-18T15:59:59Z')), '2026-09-18');
  assert.equal(chinaDay(new Date('2026-09-18T16:00:00Z')), '2026-09-19');
});
