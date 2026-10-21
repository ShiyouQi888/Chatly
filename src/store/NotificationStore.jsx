/**
 * 通知数据层：列表 / 未读数 / 已读 / 偏好 + WS 实时接收
 *
 * ## 为什么单独一个 store
 * 和 Chat / Moment / Favorite 同一个理由：通知是**真实落库**的东西，
 * 留在 AppContext（原型数据）里就说不清「这条是不是真存下来了」。
 * 通知数据保存在服务端；静态演示通知已经从应用数据中移除，避免被误接回页面。
 *
 * ## Tab 筛选在前端做，不在后端
 * 后端支持 `?group=`，但这里只按 all 拉一页再本地筛。理由是**实时**：
 * 推送来的新通知落在哪一个 Tab 是不可预知的，若每个 Tab 各拉一份，
 * 一条新通知到达时要么只更新当前 Tab（切过去发现数字对不上），
 * 要么四个请求各打一次。本地筛一份数据，两边天然一致。
 *
 * ## 未读数是服务端给的，不是从 list 里数出来的
 * list 只有最近 30 条。未读超过 30 条时数出来会**少报**，
 * 而那个数字正是红点上写的那一个。所以单独走 /notifications/unread。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { useAuth } from './AuthContext.jsx'
import { useChatSocket } from '../hooks/useChatSocket.js'
import { setNotifyPrefs, alertForNotification } from '../utils/notifyAlert.js'

const NotifyCtx = createContext(null)

export function NotificationProvider({ children }) {
  const { user, token } = useAuth()

  const [list, setList] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [prefs, setPrefs] = useState(null)
  const [prefsLoading, setPrefsLoading] = useState(false)
  const [prefsError, setPrefsError] = useState('')
  const prefsRef = useRef(null)
  const prefWriteRef = useRef({})

  const meRef = useRef(null)
  meRef.current = user || null

  /* 退出登录清空：上一个人的通知不能留给下一个人看 */
  useEffect(() => {
    if (!user) {
      setList([])
      setUnread(0)
      setHasMore(false)
      setPrefs(null)
      prefsRef.current = null
      setPrefsLoading(false)
      setPrefsError('')
      setNotifyPrefs(null)
    }
  }, [user])

  const refresh = useCallback(async () => {
    if (!meRef.current) return
    setLoading(true)
    setError('')
    try {
      const [out, u] = await Promise.all([api.notifications({ limit: 30 }), api.unreadNotifications()])
      setList(out.items || [])
      setHasMore(!!out.hasMore)
      setUnread(Number(u.unread) || 0)
    } catch (e) {
      setError(e.message || '加载通知失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMore = useCallback(async () => {
    if (!list.length) return refresh()
    const last = list[list.length - 1]
    try {
      const out = await api.notifications({ beforeId: last.id, limit: 30 })
      setList((prev) => {
        const seen = new Set(prev.map((x) => x.id))
        return [...prev, ...(out.items || []).filter((x) => !seen.has(x.id))]
      })
      setHasMore(!!out.hasMore)
    } catch {
      /* 翻页失败保持原状 —— 列表还在，按钮点第二次会重试 */
    }
  }, [list])

  /* 偏好：读回来之后**同时**灌进 notifyAlert 的模块状态。
     只 setState 不调 setNotifyPrefs 的话，界面上开关拨了、
     真来通知时该不该响还是按旧值判 —— 那正是「点了没反应」。 */
  const loadPrefs = useCallback(async () => {
    if (!meRef.current) return null
    setPrefsLoading(true)
    setPrefsError('')
    try {
      const p = await api.notificationPrefs()
      prefsRef.current = p
      setPrefs(p)
      setNotifyPrefs(p)
      return p
    } catch (e) {
      setPrefsError(e.message || '读取通知设置失败')
      return null
    } finally {
      setPrefsLoading(false)
    }
  }, [])

  const savePref = useCallback(async (key, value) => {
    const aliases = {
      notify_message: 'message', notify_mention: 'mention', notify_like: 'like',
      notify_comment: 'comment', notify_follow: 'follow', notify_group: 'group', notify_system: 'system',
    }
    const prefKey = aliases[key] || key
    const previous = prefsRef.current?.[prefKey]
    const writeId = (prefWriteRef.current[prefKey] || 0) + 1
    prefWriteRef.current[prefKey] = writeId
    const next = { ...(prefsRef.current || {}), [prefKey]: value }
    prefsRef.current = next
    setPrefs(next)
    setNotifyPrefs(next)
    try {
      await api.updateSetting(key, value)
    } catch (error) {
      /* 只回滚本次仍是最新写入的字段，避免较早请求失败覆盖用户刚才的新选择。 */
      if (prefWriteRef.current[prefKey] === writeId) {
        const restored = { ...(prefsRef.current || {}) }
        if (previous === undefined) delete restored[prefKey]
        else restored[prefKey] = previous
        prefsRef.current = restored
        setPrefs(restored)
        setNotifyPrefs(restored)
      }
      throw error
    }
  }, [prefs])

  const savePrefs = useCallback(async (patch) => {
    const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, prefsRef.current?.[key]]))
    const writeId = (prefWriteRef.current.__batch || 0) + 1
    prefWriteRef.current.__batch = writeId
    const next = { ...(prefsRef.current || {}), ...patch }
    prefsRef.current = next
    setPrefs(next)
    setNotifyPrefs(next)
    try {
      await api.updateSettings(patch)
    } catch (error) {
      if (prefWriteRef.current.__batch === writeId) {
        const restored = { ...(prefsRef.current || {}) }
        for (const [key, value] of Object.entries(previous)) {
          if (restored[key] !== patch[key]) continue
          if (value === undefined) delete restored[key]
          else restored[key] = value
        }
        prefsRef.current = restored
        setPrefs(restored)
        setNotifyPrefs(restored)
      }
      throw error
    }
  }, [prefs])

  const markRead = useCallback(async (ids) => {
    /* 先本地置已读再请求：点完红点还在 = 「点了没反应」。
       请求失败要回滚，否则界面和服务器长期不一致。 */
    const snapshot = list
    const un = unread
    setList((prev) => (ids ? prev.map((n) => (ids.includes(n.id) ? { ...n, unread: false } : n)) : prev.map((n) => ({ ...n, unread: false }))))
    setUnread((prev) => (ids ? Math.max(0, prev - snapshot.filter((n) => ids.includes(n.id) && n.unread).length) : 0))
    try {
      await api.markNotificationsRead(ids)
    } catch (e) {
      setList(snapshot)
      setUnread(un)
      throw e
    }
  }, [list, unread])

  /* ---------- 实时接收 ----------
     socket 是模块级单例（见 useChatSocket），ChatProvider 已经连上了；
     这里再注册一个订阅者，两个 store 各收各的事件类型。 */
  const onEvent = useCallback(
    (evt) => {
      if (evt.type !== 'notification.new') return
      const n = evt.payload?.notification
      if (!n) return
      setList((prev) => {
        if (prev.some((x) => x.id === n.id)) return prev
        return [n, ...prev]
      })
      setUnread((u) => u + (n.unread ? 1 : 0))
      /* 声音 / 震动 / 免打扰在这一条线上生效（见 utils/notifyAlert.js）。
         silent 的判断：用户此刻正开着通知中心就别响了 —— 他已经看见了。 */
      alertForNotification({ silent: !!window.__noticeOpen })
    },
    []
  )
  useChatSocket(token, onEvent)

  useEffect(() => {
    if (!user) return
    refresh()
    loadPrefs()
  }, [user, refresh, loadPrefs])

  const value = useMemo(
    () => ({
      list,
      hasMore,
      unread,
      loading,
      error,
      prefs,
      prefsLoading,
      prefsError,
      refresh,
      loadMore,
      markRead,
      savePref,
      savePrefs,
      loadPrefs,
    }),
    [list, hasMore, unread, loading, error, prefs, prefsLoading, prefsError, refresh, loadMore, markRead, savePref, savePrefs, loadPrefs]
  )

  return <NotifyCtx.Provider value={value}>{children}</NotifyCtx.Provider>
}

export function useNotifications() {
  const ctx = useContext(NotifyCtx)
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider')
  return ctx
}

/** 通知类型 → 归到哪个 Tab（和 NoticeCenter 的三个分类严格对应） */
export const NOTICE_GROUP = {
  message: '聊天',
  mention: '聊天',
  like: '互动',
  comment: '互动',
  follow: '互动',
  group: '系统',
  system: '系统',
}

/** 通知类型 → 界面上那句话。动词由服务端的事件决定，这里只负责说人话 */
export function noticeText(n) {
  switch (n.kind) {
    case 'message':
      return n.body || '发来一条消息'
    case 'mention':
      return n.body ? `@了你：${n.body}` : '@ 了你'
    case 'like':
      return n.body ? `赞了你的动态：${n.body}` : '赞了你的动态'
    case 'comment':
      return n.refParentId
        ? n.body
          ? `回复了你的评论：${n.body}`
          : '回复了你的评论'
        : n.body
          ? `评论了你的动态：${n.body}`
          : '评论了你的动态'
    case 'follow':
      return n.body || '关注了你'
    case 'group':
      return n.body || '群公告已更新'
    default:
      return n.body || '有一条新通知'
  }
}
