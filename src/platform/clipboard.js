/**
 * 剪贴板 —— 复制文字。
 *
 * ## 跨端差异
 *
 * Web 端：`navigator.clipboard.writeText()`。
 * **它要求安全上下文**（https / localhost），且在非用户手势的回调里会被拒。
 * 原生壳走 Capacitor 的 Clipboard 插件，无这些限制。
 *
 * 注意：现有代码在 `MyQrPage.jsx` 里用的是 `await navigator.clipboard.writeText(id)`
 * —— 没有 `?.`，在非安全上下文会直接抛 TypeError（整个点击处理器炸掉）。
 * 适配层这里统一兜住，失败时返回 false 而不是抛异常。
 */

import { isNative, capPlugin } from './env.js'

/**
 * 写入剪贴板。
 *
 * @param {string} text
 * @returns {Promise<boolean>} 是否成功
 */
export async function writeText(text) {
  const value = String(text ?? '')

  if (isNative) {
    const clipboard = capPlugin('Clipboard')
    if (clipboard) {
      try {
        await clipboard.write({ string: value })
        return true
      } catch {
        /* 落到 Web 实现再试一次 */
      }
    }
  }

  try {
    if (!navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

/**
 * 读取剪贴板。
 *
 * @returns {Promise<string>} 读不到时返回空串
 */
export async function readText() {
  if (isNative) {
    const clipboard = capPlugin('Clipboard')
    if (clipboard) {
      try {
        const res = await clipboard.read()
        return String(res?.value ?? '')
      } catch {
        /* 落到 Web 实现 */
      }
    }
  }
  try {
    if (!navigator.clipboard?.readText) return ''
    return String((await navigator.clipboard.readText()) ?? '')
  } catch {
    return ''
  }
}
