#!/usr/bin/env node
/** alert-state.mjs 的行为测试：node test-alert-state.mjs */
import assert from 'node:assert/strict';
import { createGroupState, stepGroup } from './alert-state.mjs';

const rules = {
  minFreeCards: 4,
  consecutiveSamples: 40,
  recoverConsecutiveSamples: 40,
  notifyRecovered: true,
};

function feed(state, counts, opts = {}) {
  const events = [];
  counts.forEach((freeCount, i) => {
    const e = stepGroup(state, { ...rules, ...opts, freeCount }, 1_000_000 + i);
    if (e.freeAlert || e.recoverAlert) events.push({ i, freeCount, ...e });
  });
  return events;
}

// 1) 4 张空闲：39 次不报，第 40 次报一次，继续空闲不重复报
let s = createGroupState();
let ev = feed(s, [...Array(39).fill(4)]);
assert.equal(ev.length, 0, '未达阈值不应提醒');
ev = feed(s, [4]);
assert.deepEqual(ev.map((e) => e.freeAlert), [true], '第 40 次应发空闲提醒');
ev = feed(s, [...Array(20).fill(6)]);
assert.equal(ev.length, 0, '空闲提醒不应重复发送');

// 2) 掉到 3 张：39 次不报，第 40 次报占用提醒，之后不重复
ev = feed(s, [...Array(39).fill(3)]);
assert.equal(ev.length, 0, '未满 20 分钟不应发占用提醒');
ev = feed(s, [3]);
assert.deepEqual(ev.map((e) => e.recoverAlert), [true], '满 20 分钟应发占用提醒');
ev = feed(s, [...Array(30).fill(1)]);
assert.equal(ev.length, 0, '占用提醒不应重复发送');

// 3) 恢复 ≥4 张：重新累计 20 分钟后再次空闲提醒
ev = feed(s, [...Array(39).fill(4)]);
assert.equal(ev.length, 0, '恢复后需重新累计');
ev = feed(s, [4]);
assert.deepEqual(ev.map((e) => e.freeAlert), [true], '恢复后应能再次发空闲提醒');

// 4) 抖动（3↔4）：连续计数被重置，不触发任何提醒
s = createGroupState();
ev = feed(s, [...Array(80).fill(4).flatMap((v) => [v, 3])]);
assert.equal(ev.length, 0, '抖动时不应触发提醒');

// 5) 从未发过空闲提醒时，卡被占满也不会发占用提醒
s = createGroupState();
ev = feed(s, [...Array(60).fill(0)]);
assert.equal(ev.length, 0, '没有空闲提醒就不该有占用提醒');

// 6) notifyRecovered=false 时只发空闲提醒
s = createGroupState();
ev = feed(s, [...Array(40).fill(4)]);
assert.deepEqual(ev.map((e) => e.freeAlert), [true]);
ev = feed(s, [...Array(80).fill(1)], { notifyRecovered: false });
assert.equal(ev.length, 0, '关闭占用提醒后不应发送');

// 7) minFreeCards=1 退化为「任意一张卡空闲 20 分钟」
s = createGroupState();
ev = feed(s, [...Array(40).fill(1)], { minFreeCards: 1 });
assert.deepEqual(ev.map((e) => e.freeAlert), [true], 'minFreeCards=1 时单卡空闲即可提醒');

// 8) 掉到 3 张后马上回到 4 张：占用计数重置，不补发
s = createGroupState();
feed(s, [...Array(40).fill(4)]);
ev = feed(s, [...Array(30).fill(3)]);
assert.equal(ev.length, 0);
ev = feed(s, [4, 4, 4, 3, 3, 3, 3]);
assert.equal(ev.length, 0, '回落后占用计数应重置，不补发');

console.log('✅ alert-state 全部用例通过');
