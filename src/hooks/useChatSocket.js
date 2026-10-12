/**
 * 全局唯一的 WebSocket 连接（模块级单例）
 *
 * 为什么不做成「每个组件各连一条」：ChatTab 与 ChatRoom 会同时挂载，
 * 多连接会让同一条消息被处理多次、并放大服务端在线表。这里集中成一条，
 * 组件通过订阅表消费事件。
 *
 * 事件协议（下行，见 server/src/ws.js）：
 *   hello | message.new | message.revoked | conversation.read | typing | presence | error
 * 另有前端内部事件 '@status' 表示连接状态变化。
 */
import { useEffect, useRef, useState } from 'react'
import { wsUrl } from '../api/client.js'

let sock = null
let sockToken = null
let retry = 0
let retryTimer = null
let closedByUs = false

const listeners = new Set()

function emit(evt) {
  for (const fn of [...listeners]) {
    try {
      fn(evt)
    } catch (err) {
      // 单个订阅者抛错不应影响其他人
      console.error('[ws] listener error', err)
    }
  }
}

function open(token) {
  // 已有连接且 token 未变 → 复用（React StrictMode 会重复执行 effect）
  if (sock && sockToken === token && (sock.readyState === 0 || sock.readyState === 1)) return

  if (sock) {
    try {
      sock.close()
    } catch {
      /* noop */
    }
  }

  closedByUs = false
  sockToken = token

  let ws
  try {
    ws = new WebSocket(wsUrl(token))
  } catch (err) {
    console.error('[ws] 创建失败', err)
    return
  }
  sock = ws

  ws.onopen = () => {
    retry = 0
    emit({ type: '@status', payload: { connected: true } })
  }

  ws.onmessage = (e) => {
    let msg
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }
    if (msg && msg.type) emit(msg)
  }

  ws.onclose = () => {
    emit({ type: '@status', payload: { connected: false } })
    if (closedByUs) return
    if (sock === ws) sock = null
    retry = Math.min(retry + 1, 5)
    const delay = Math.min(700 * 2 ** retry, 8000)
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => open(token), delay)
  }

  ws.onerror = () => {
    try {
      ws.close()
    } catch {
      /* noop */
    }
  }
}

export function closeSocket() {
  closedByUs = true
  clearTimeout(retryTimer)
  retry = 0
  if (sock) {
    try {
      sock.close()
    } catch {
      /* noop */
    }
  }
  sock = null
  sockToken = null
}

/** 手动断开（登出时调用，避免继续重连） */
export function disconnectSocket() {
  closeSocket()
}

/** 发送「正在输入」（服务端会转发给同会话其他人） */
export function sendTyping(conversationId) {
  if (sock && sock.readyState === 1) {
    sock.send(JSON.stringify({ type: 'typing', conversationId: Number(conversationId) }))
  }
}

/**
 * 订阅全部下行事件。
 * @param {string|null} token  JWT，为 null 时不连接
 * @param {(evt:{type:string,payload:any})=>void} onEvent
 * @returns {boolean} 当前是否已连接
 */
export function useChatSocket(token, onEvent) {
  const ref = useRef(onEvent)
  ref.current = onEvent

  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!token) {
      setConnected(false)
      return undefined
    }

    const fn = (evt) => {
      if (evt.type === '@status') {
        setConnected(!!evt.payload?.connected)
        return
      }
      ref.current?.(evt)
    }

    listeners.add(fn)
    open(token)

    return () => {
      listeners.delete(fn)
    }
  }, [token])

  return connected
}
