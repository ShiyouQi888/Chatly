/**
 * 深链 —— 把外部世界（系统通知、分享、其它 App）送进指定会话。
 *
 * ## 统一协议
 *
 * `chatly://conversation/{id}` · `chatly://user/{id}`
 *
 * Web 端用 URL 查询参数 `?conv=123`（既有实现，`Phone.jsx` 已在用）。
 * 原生端用自定义 URL Scheme，由系统唤起 App 后通过 `appUrlOpen` 事件送达。
 *
 * ## 冷启动的时序坑（必须按这里的顺序写）
 *
 * 原生壳冷启动时，`appUrlOpen` 事件**可能晚于** React 首次渲染到达。
 * 如果只在事件里处理，就会出现「先进首页，事件才来，用户看到首页闪一下
 * 才对会话」—— 或者更糟，事件在组件挂载前就派发，直接丢失。
 *
 * 解法是**两段式**：
 * 1. `getInitialTarget()` 在启动时读一次「壳带来的初始链接」。
 * 2. `onTarget(cb)` 订阅后续事件。
 * 调用方两个都要用，缺一不可。
 */

import { isNative, capPlugin } from './env.js'

/** 解析出的目标 */
export const TARGET_KIND = {
  CONVERSATION: 'conversation',
  USER: 'user',
}

/**
 * 把一段链接解析成目标。
 *
 * @param {string} raw
 * @returns {{ kind: string, id: number }|null}
 */
export function parseTarget(raw) {
  const value = String(raw || '').trim()
  if (!value) return null

  let pathname = ''

  try {
    /* chatly://conversation/123 —— 自定义 scheme 的 host 部分是 'conversation'，
     * pathname 是 '/123'。而 https://x/chatly/conversation/123 的 pathname
     * 是 '/chatly/conversation/123'。两种都要认。 */
    const url = new URL(value)
    pathname = `${url.hostname}${url.pathname}`
  } catch {
    pathname = value
  }

  const match = /(conversation|user)\/(\d+)/i.exec(pathname)
  if (!match) return null
  return { kind: match[1].toLowerCase(), id: Number(match[2]) }
}

/**
 * 读冷启动时壳带来的初始目标。
 *
 * Web 端读 `?conv=`；原生端读 Capacitor 的 `App.getLaunchUrl()`。
 *
 * @returns {Promise<{ kind: string, id: number }|null>}
 */
export async function getInitialTarget() {
  if (isNative) {
    const app = capPlugin('App')
    if (app) {
      try {
        const res = await app.getLaunchUrl()
        const parsed = parseTarget(res?.url)
        if (parsed) return parsed
      } catch {
        /* 拿不到启动链接不是错误 */
      }
    }
    return null
  }

  try {
    const params = new URLSearchParams(window.location.search)
    const convId = Number(params.get('conv'))
    if (convId) return { kind: TARGET_KIND.CONVERSATION, id: convId }
  } catch {
    /* noop */
  }
  return null
}

/**
 * 订阅后续的深链事件。
 *
 * @param {(target: {kind: string, id: number}) => void} cb
 * @returns {() => void} 取消订阅的函数
 */
export function onTarget(cb) {
  if (isNative) {
    const app = capPlugin('App')
    if (!app?.addListener) return () => {}
    let handle = null
    try {
      handle = app.addListener('appUrlOpen', ({ url }) => {
        const parsed = parseTarget(url)
        if (parsed) cb(parsed)
      })
    } catch {
      return () => {}
    }
    return () => {
      try {
        handle?.remove?.()
      } catch {
        /* noop */
      }
    }
  }

  /* Web 端没有事件源 —— 用 hashchange 兜一层，
     至少支持「用户在同一个标签页里改地址栏」。 */
  const handler = () => {
    const parsed = parseTarget(window.location.href)
    if (parsed) cb(parsed)
  }
  window.addEventListener('hashchange', handler)
  return () => window.removeEventListener('hashchange', handler)
}

/**
 * 构造一个会话深链（用于分享）。
 *
 * @param {number} conversationId
 * @returns {string}
 */
export function conversationLink(conversationId) {
  const id = Number(conversationId)
  if (!Number.isFinite(id)) return ''
  if (isNative) return `chatly://conversation/${id}`
  const base = `${window.location.origin}${window.location.pathname}`
  return `${base}?conv=${id}`
}
