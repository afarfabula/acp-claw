import assert from 'node:assert/strict';
import { billPeriods, previousDate, summarizeText } from './bill.mjs';

assert.equal(previousDate('2026-10-28'), '2026-10-27');
assert.equal(previousDate('2026-03-01'), '2026-02-28');
assert.equal(previousDate('2026-01-01'), '2025-12-31');

assert.deepEqual(
  billPeriods(new Date('2026-10-27T23:30:00.000Z'), 'Asia/Shanghai'),
  {
    today: '2026-10-28',
    yesterday: '2026-10-27',
    monthStart: '2026-10-01',
  },
);

const text = summarizeText(
  {
    spendCents: 11700,
    refundCents: 2000,
    provisionalCount: 3,
  },
  [
    { label: '外卖', value: 80.32 },
    { label: '便利店零食', value: 19.88 },
    { label: '未分类', value: 16.8 },
  ],
  '昨日（10-27）',
);
assert.equal(
  text,
  '昨日（10-27）消费 ¥117.00，退款 ¥20.00；' +
    '主要：外卖 ¥80.32（69%）、便利店零食 ¥19.88（17%）、未分类 ¥16.80（14%），含 3 笔待月账确认',
);

assert.match(
  summarizeText(
    { spendCents: 0, refundCents: 0, provisionalCount: 0 },
    [],
    '本月至今',
  ),
  /^本月至今消费 ¥0\.00；主要：无消费记录$/,
);

console.log('bill tests: ok');
