/**
 * 运行环境探测 —— 多端一体化的第一块基石。
 *
 * ## 为什么要它
 *
 * 同一份业务代码要跑在四个地方：Web/PWA、iOS 壳、Android 壳、桌面壳。
 * 它们的能力边界不同（有没有 Service Worker？能不能装 App？），业务代码
 * 不能直接问 `navigator.serviceWorker` 或 `window.Capacitor` —— 那等于把
 * 「我在哪个平台上」的知识散回 30+ 个文件。
 *
 * 所以所有平台判断集中在这里，业务代码只问 `isNative()` / `isIOS()` 这类
 * 语义化的问题，不问具体平台 API。
 *
 * ## 探测方式
 *
 * - **Capacitor**：官方插件在运行时挂在 `window.Capacitor.Plugins` 上，
 *   不需要 import npm 包就能拿到。所以 P0 阶段（还没装 @capacitor/core）
 *   也能把这套探测写好，等 P3 装上壳即刻生效。
 * - **Tauri 2**：`window.__TAURI_INTERNALS__` 存在即为 Tauri 环境。
 *   桌面壳同样提供 WebView，`matchMedia` / `localStorage` 都可用。
 * - **Web**：以上都没有，且有 `document` / `window`，就是普通浏览器。
 */

/** 运行环境取值 */
export const RUNTIME = {
  WEB: 'web',
  IOS: 'ios',
  ANDROID: 'android',
  TAURI: 'tauri',
  UNKNOWN: 'unknown',
}

function detectRuntime() {
  if (typeof window === 'undefined') return RUNTIME.UNKNOWN

  const cap = window.Capacitor
  if (cap) {
    /* Capacitor 的 platform 字符串是 'ios' / 'android' / 'web'。
     * 它在壳启动时注入，早于本模块被 import 的时刻 —— 但为稳妥起见
     * 同时看 UserAgent，避免壳还没注入完就被问到。 */
    const declared = String(cap.getPlatform?.() || cap.platform || '').toLowerCase()
    if (declared === 'ios') return RUNTIME.IOS
    if (declared === 'android') return RUNTIME.ANDROID
    const ua = String(navigator.userAgent || '').toLowerCase()
    if (ua.includes('iphone') || ua.includes('ipad')) return RUNTIME.IOS
    if (ua.includes('android')) return RUNTIME.ANDROID
    /* 声明成 web 的 Capacitor（比如 PWA 模式）仍按 Web 处理。 */
    return RUNTIME.WEB
  }

  if (window.__TAURI_INTERNALS__) return RUNTIME.TAURI

  return RUNTIME.WEB
}

export const runtime = detectRuntime()

/** 是否运行在原生壳里（iOS / Android / 桌面壳） */
export const isNative = runtime === RUNTIME.IOS || runtime === RUNTIME.ANDROID || runtime === RUNTIME.TAURI

/** 是否 iOS 壳 */
export const isIOS = runtime === RUNTIME.IOS

/** 是否 Android 壳 */
export const isAndroid = runtime === RUNTIME.ANDROID

/** 是否桌面壳（Tauri） */
export const isDesktop = runtime === RUNTIME.TAURI

/** 是否普通 Web（含 PWA） */
export const isWeb = runtime === RUNTIME.WEB

/**
 * 取 Capacitor 插件实例。
 *
 * @param {string} name 插件名，如 'PushNotifications' / 'Camera'
 * @returns {object|null} 插件对象；不在 Capacitor 环境或插件未安装时为 null
 *
 * ⚠️ **不要把插件对象缓存起来**。Capacitor 在桥接就绪后可能会替换插件实例，
 * 缓存住旧引用会拿到一个永远调不通的壳。每次现取。
 */
export function capPlugin(name) {
  if (typeof window === 'undefined') return null
  const cap = window.Capacitor
  if (!cap || !cap.Plugins) return null
  return cap.Plugins[name] || null
}

/**
 * Tauri 的 invoke。
 * Tauri 2 在 `window.__TAURI_INTERNALS__.invoke` 上暴露了 invoke，
 * 不需要 import npm 包（npm 包主要是给 TS 类型用的）。
 */
export function tauriInvoke(cmd, args) {
  const internals = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : null
  if (!internals || typeof internals.invoke !== 'function') {
    return Promise.reject(new Error('当前不是桌面壳环境'))
  }
  return internals.invoke(cmd, args)
}
