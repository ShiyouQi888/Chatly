/**
 * 系统分享与外部打开。
 *
 * ## 跨端差异
 *
 * Web 端：
 * - `navigator.share()` 只在移动端浏览器 + 安全上下文可用，桌面 Chrome 有，
 *   Firefox 没有。不支持时必须退回「复制链接」。
 * - `window.open(url, '_blank')` 打开外部网页 —— 桌面端会被弹窗拦截
 *   （必须由用户手势直接触发），且会开新标签页。
 *
 * 原生端：
 * - 分享走 Capacitor 的 Share 插件，能分享到微信/QQ等原生应用。
 * - 打开外部网页走 Browser 插件，用**系统浏览器**打开，
 *   而不是 WebView 内部 —— 这一点很重要：账号授权页、隐私政策
 *   这类页面必须离开 App 环境。
 */

import { isNative, capPlugin } from './env.js'

/**
 * 系统分享是否可用。
 *
 * @returns {boolean}
 */
export function canShare() {
  if (isNative) return !!capPlugin('Share')
  if (typeof navigator === 'undefined') return false
  return typeof navigator.share === 'function'
}

/**
 * 调起系统分享。
 *
 * @param {{ title?: string, text?: string, url?: string }} payload
 * @returns {Promise<boolean>} 是否成功调起（用户取消也算「调起了」）
 */
export async function share(payload = {}) {
  const { title = '', text = '', url = '' } = payload

  if (isNative) {
    const plugin = capPlugin('Share')
    if (plugin) {
      try {
        await plugin.share({ title, text, url, dialogTitle: title })
        return true
      } catch {
        return false
      }
    }
  }

  try {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false
    await navigator.share({ title, text, url })
    return true
  } catch {
    /* 用户取消分享也会走到这里 —— 不算失败，但也不能算成功。 */
    return false
  }
}

/**
 * 在外部打开一个 URL。
 *
 * 原生端用系统浏览器（Browser 插件）；Web 端用 `window.open`。
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function openExternal(url) {
  const value = String(url || '').trim()
  if (!value) return false

  if (isNative) {
    const browser = capPlugin('Browser')
    if (browser) {
      try {
        await browser.open({ url: value, presentationStyle: 'popover' })
        return true
      } catch {
        /* 落到 Web 实现 */
      }
    }
  }

  try {
    /* 'noopener' 防 tabnabbing：目标页拿不到 opener 引用。 */
    const win = window.open(value, '_blank', 'noopener,noreferrer')
    return !!win
  } catch {
    return false
  }
}
