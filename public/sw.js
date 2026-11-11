/**
 * Service Worker：只做两件事 —— 接住 Web Push、把点击落到正确的会话。
 *
 * 三种推送：
 *   call.incoming  来电（要响、要常驻，直到接听或超时）
 *   call.dismiss   挂断/取消后主动撤掉那条来电通知
 *   message.new    新消息（同一个会话用同一个 tag，多条未读在托盘里替换成最新一条）
 *
 * 页面**可见**时不弹系统通知，改成 postMessage 交给页面处理：
 * 前台已经有红点和提示音，再弹一条系统通知是重复打扰。
 */

const CHAT_APP_URL = '/'

function isChatClient(client) {
  try {
    const url = new URL(client.url)
    return url.origin === self.location.origin && url.pathname !== '/qishiyou' && url.pathname !== '/admin'
  } catch {
    return false
  }
}

async function visibleChatClients() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  return windows.filter((client) => client.visibilityState === 'visible' && isChatClient(client))
}

function dismissCallNotification(callId) {
  return self.registration.getNotifications({ tag: `chatly-call-${callId}` })
    .then((notifications) => notifications.forEach((notification) => notification.close()))
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'call.dismiss' && event.data.payload?.callId) {
    event.waitUntil(dismissCallNotification(event.data.payload.callId))
  }
})

self.addEventListener('push', (event) => {
  let message
  try { message = event.data?.json() } catch { return }
  /* 留一条 debug 日志：线上排查「通知没来」时，先要能分清是
     「推送没到 SW」还是「到了但被可见页面拦下」。Chrome 的
     chrome://serviceworker-internals 里能看到这行。 */
  console.debug('[sw] push', message?.type)
  const payload = message?.payload || {}

  if (message?.type === 'call.dismiss' && payload.callId) {
    event.waitUntil(dismissCallNotification(payload.callId))
    return
  }

  if (message?.type === 'call.incoming' && payload.callId) {
    event.waitUntil((async () => {
      if (Number(payload.expiresAt) && Number(payload.expiresAt) <= Date.now()) return
      const visible = await visibleChatClients()
      if (visible.length) {
        for (const client of visible) client.postMessage(message)
        return
      }
      const name = payload.caller?.nickname || payload.caller?.username || '联系人'
      const video = payload.media === 'video'
      await self.registration.showNotification(`Chatly · ${video ? '视频' : '语音'}来电`, {
        body: `${name}邀请你进行${video ? '视频' : '语音'}通话`,
        tag: `chatly-call-${payload.callId}`,
        renotify: true,
        requireInteraction: true,
        data: { url: CHAT_APP_URL, callId: payload.callId, conversationId: payload.conversationId },
      })
    })())
    return
  }

  if (message?.type === 'message.new') {
    event.waitUntil((async () => {
      const visible = await visibleChatClients()
      if (visible.length) {
        for (const client of visible) client.postMessage(message)
        return
      }
      await self.registration.showNotification(payload.title || 'Chatly', {
        body: payload.body || '新消息',
        /* 同一会话复用 tag：系统托盘里替换而不是叠加 */
        tag: payload.tag || `chatly-msg-${payload.conversationId}`,
        /* 替换时不重新响铃/震动 —— 连发十条消息不该响十次 */
        renotify: false,
        data: {
          url: payload.url || `/?conv=${payload.conversationId || ''}`,
          conversationId: payload.conversationId,
        },
      })
    })())
  }
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const conversationId = Number(data.conversationId) || 0
  event.waitUntil((async () => {
    const target = new URL(data.url || CHAT_APP_URL, self.location.origin).href
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const chatWindow = windows.find(isChatClient)
    if (chatWindow) {
      await chatWindow.focus()
      /* 已经开着的窗口不会因为 URL 变化而重新挂载，所以用消息通知它跳转 */
      if (conversationId) chatWindow.postMessage({ type: 'openConversation', payload: { conversationId } })
      return
    }
    /* 冷启动走 URL 参数：页面挂载后自己读 ?conv= 打开会话 */
    await self.clients.openWindow(target)
  })())
})
