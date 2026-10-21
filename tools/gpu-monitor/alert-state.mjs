/**
 * GPU 提醒状态机（纯函数，便于单测）
 *
 * 判据是「同时空闲的卡数」，而不是单卡：
 *   - 空闲提醒：空闲卡数 ≥ minFreeCards 且连续保持 consecutiveSamples 次采样
 *   - 占用提醒：已发过空闲提醒后，空闲卡数 < minFreeCards 且连续保持
 *              recoverConsecutiveSamples 次采样
 * 一次事件只发一条，之后要等状态反转并重新累计才会再触发。
 */

export function createGroupState() {
  return {
    freeConsecutive: 0,
    busyConsecutive: 0,
    notified: false,
    lastFreeAlertAt: null,
    lastRecoverAlertAt: null,
  };
}

export function stepGroup(state, input, ts = null) {
  const {
    freeCount,
    minFreeCards,
    consecutiveSamples,
    recoverConsecutiveSamples,
    notifyRecovered = true,
  } = input;
  const events = { freeAlert: false, recoverAlert: false };

  if (freeCount >= minFreeCards) {
    state.freeConsecutive += 1;
    state.busyConsecutive = 0;
    if (state.freeConsecutive >= consecutiveSamples && !state.notified) {
      state.notified = true;
      state.lastFreeAlertAt = ts;
      events.freeAlert = true;
    }
    return events;
  }

  state.freeConsecutive = 0;
  if (state.notified && notifyRecovered) {
    state.busyConsecutive += 1;
    if (state.busyConsecutive >= recoverConsecutiveSamples) {
      state.notified = false;
      state.busyConsecutive = 0;
      state.lastRecoverAlertAt = ts;
      events.recoverAlert = true;
    }
  } else {
    state.busyConsecutive = 0;
  }
  return events;
}
