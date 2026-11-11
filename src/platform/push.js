/**
 * 推送 —— 通知通道适配层。
 *
 * ## 现状与目标
 *
 * 现有实现是纯 Web Push（VAPID + Service Worker），散在四个文件：
 * `main.jsx`（注册 SW）、`NotificationSettings.jsx`（订阅/退订）、
 * `VoiceCallStore.jsx`（给 SW 发消息关掉来电）、`Phone.jsx`（收 SW 消息跳会话）。
 *
 * 原生端**不能沿用这套**：Capacitor 的 WebView 里 Service Worker 的
 * PushManager 不可用（也不该用 —— 那是浏览器的通道）。原生通知必须走
 * 系统的 APNs（iOS）/ FCM（Android）。
 *
 * ## 当前阶段的取舍
 *
 * 按规划决策，**安卓端先不做原生推送**：国行 Android 无 GMS，FCM 不可用；
 * 厂商推送聚合需要商务对接。本阶段原生端返回「不支持」，
 * 界面据此把开关标为不可用并写明原因 —— 而不是留一个点了没反应的假开关
 * （项目铁律：不做假功能）。
 *
 * ## 接口设计
 *
 * 把「订阅」「退订」「取当前订阅」「给后台发消息」四件事收成同一组 API，
 * Web 实现是现有逻辑的原样搬运，原生实现后续补。
 */

import { isNative, capPlugin } from './env.js'

/** 推送通道 */
export const PUSH_PROVIDER = {
  WEB: 'web',
  APNS: 'apns',
  FCM: 'fcm',
}

/**
 * 当前环境是否支持推送。
 *
 * Web 端：需要 Service Worker + PushManager + Notification 三样齐全。
 * 原生端：需要 PushNotifications 插件。
 *
 * @returns {boolean}
 */
export function isSupported() {
  if (isNative) return !!capPlugin('PushNotifications')
  if (typeof window === 'undefined') return false
  return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window
}

/**
 * 当前推送通道标识。
 *
 * @returns {string} 'web' | 'apns' | 'fcm' | ''
 */
export function provider() {
  if (!isSupported()) return ''
  if (!isNative) return PUSH_PROVIDER.WEB
  const platform = String(window.Capacitor?.getPlatform?.() || '').toLowerCase()
  if (platform === 'ios') return PUSH_PROVIDER.APNS
  if (platform === 'android') return PUSH_PROVIDER.FCM
  return PUSH_PROVIDER.WEB
}

/**
 * 注册后台脚本（仅 Web 端需要）。
 *
 * @returns {Promise<ServiceWorkerRegistration|null>}
 */
export async function registerWorker() {
  if (isNative) return null
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    return registration
  } catch (error) {
    console.warn('[push] 注册后台脚本失败（推送不可用）：', error?.message || error)
    return null
  }
}

/**
 * 取当前推送订阅。
 *
 * @returns {Promise<object|null>} 订阅对象；没有或不支持时为 null
 */
export async function getSubscription() {
  if (isNative) {
    const plugin = capPlugin('PushNotifications')
    if (!plugin) return null
    try {
      const res = await plugin.getDeliveredNotifications?.()
      void res
    } catch {
      /* 插件方法在部分版本不存在 */
    }
    return null
  }

  try {
    const registration = await navigator.serviceWorker?.getRegistration('/')
    return (await registration?.pushManager?.getSubscription()) || null
  } catch {
    return null
  }
}

/**
 * 申请权限并建立订阅。
 *
 * @param {{ publicKey: string }} config 服务端下发的 VAPID 公钥
 * @returns {Promise<object|null>} 订阅对象；失败时为 null
 */
export async function subscribe(config) {
  if (isNative) {
    const plugin = capPlugin('PushNotifications')
    if (!plugin) return null
    try {
      let perm = await plugin.checkPermissions()
      if (perm?.receive !== 'granted') perm = await plugin.requestPermissions()
      if (perm?.receive !== 'granted') return null
      await plugin.register()
      return await plugin.getRegistration() || null
    } catch {
      return null
    }
  }

  if (!isSupported()) return null
  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return null

    const registration = await registerWorker()
    if (!registration) return null

    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyBytes(config?.publicKey),
      })
    }
    return subscription
  } catch {
    return null
  }
}

/**
 * 取消订阅。
 *
 * @returns {Promise<boolean>}
 */
export async function unsubscribe() {
  if (isNative) {
    const plugin = capPlugin('PushNotifications')
    if (!plugin) return false
    try {
      await plugin.unregister()
      return true
    } catch {
      return false
    }
  }

  try {
    const subscription = await getSubscription()
    if (!subscription) return false
    await subscription.unsubscribe()
    return true
  } catch {
    return false
  }
}

/**
 * 给后台脚本发消息（仅 Web 端）。
 *
 * 用途：来电被拒/挂断时，通知栏上那条横幅还在，要通知 SW 把它撤掉。
 *
 * @param {object} payload
 * @returns {Promise<boolean>}
 */
export async function postToWorker(payload) {
  if (isNative) return false
  try {
    const sw = navigator.serviceWorker
    if (!sw) return false
    const message = { type: 'call.dismiss', payload }
    if (sw.controller) {
      sw.controller.postMessage(message)
      return true
    }
    const ready = await sw.ready
    ready.active?.postMessage(message)
    return true
  } catch {
    return false
  }
}

/**
 * 订阅后台脚本推送过来的消息（仅 Web 端）。
 *
 * @param {(data: any) => void} handler
 * @returns {() => void} 取消订阅
 */
export function onWorkerMessage(handler) {
  if (isNative) return () => {}
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {}
    const listener = (event) => handler(event?.data)
    navigator.serviceWorker.addEventListener('message', listener)
    return () => navigator.serviceWorker.removeEventListener('message', listener)
  } catch {
    return () => {}
  }
}

/**
 * 把 VAPID 公钥解成 `applicationServerKey` 需要的字节数组。
 *
 * @param {string} value base64url 字符串
 * @returns {Uint8Array}
 */
export function vapidKeyBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}
