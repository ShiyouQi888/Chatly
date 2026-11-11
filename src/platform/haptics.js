/**
 * 触感反馈（震动）。
 *
 * Web 端：`navigator.vibrate()`。有两条硬约束：
 * - 只在**用户手势**内有效，否则浏览器直接忽略并可能打 error 日志。
 * - iOS Safari **完全不支持**（`navigator.vibrate` 不存在）。
 *
 * 原生端走 Capacitor 的 Haptics 插件，iOS/Android 都有真正的触感马达。
 *
 * 现有调用点（`useLongPress.js`、`notifyAlert.js`）都已经在判断
 * `navigator.userActivation?.isActive`，这里保留同样的语义。
 */

import { isNative, capPlugin } from './env.js'

/**
 * 是否支持触感反馈。
 *
 * @returns {boolean}
 */
export function isSupported() {
  if (isNative) return !!capPlugin('Haptics')
  if (typeof navigator === 'undefined') return false
  return typeof navigator.vibrate === 'function'
}

/**
 * 触发一次震动。
 *
 * @param {number|number[]} pattern 毫秒数或震动节奏（与 Web Vibration API 一致）
 * @returns {boolean} 是否真的震了
 */
export function vibrate(pattern = 15) {
  if (isNative) {
    const haptics = capPlugin('Haptics')
    if (haptics) {
      try {
        /* 插件的 impact 强度分档，这里把毫秒映射到最接近的一档。 */
        const ms = Array.isArray(pattern) ? pattern[0] : pattern
        const style = ms >= 40 ? 'HEAVY' : ms >= 20 ? 'MEDIUM' : 'LIGHT'
        void haptics.impact({ style })
        return true
      } catch {
        /* 落到 Web 实现 */
      }
    }
  }

  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false
    return navigator.vibrate(pattern) !== false
  } catch {
    return false
  }
}

/**
 * 是否处在「用户刚刚 interacted」的状态。
 *
 * Web 端：只有浏览器提供 `navigator.userActivation` 才能判断；
 * 没有这个 API 的老浏览器一律当作「可以震」（宁可多震，不要少震）。
 * 原生端没有这个限制，直接返回 true。
 *
 * @returns {boolean}
 */
export function hasUserActivation() {
  if (isNative) return true
  if (typeof navigator === 'undefined') return false
  /* userActivation 不存在的老浏览器 → 放行（与既有 useLongPress 行为一致） */
  if (!navigator.userActivation) return true
  return !!navigator.userActivation.isActive
}
