/**
 * 收藏数据层：列表 / 收藏 / 取消 / 批量 + 「这条消息我收藏了没」
 *
 * ## 为什么单独一个 store
 *
 * 和 Chat / Moment / Discover 同样的理由：收藏是**真实落库**的东西，
 * 塞进 AppContext（原型数据）之后「这条到底存下来没有」就说不清了。
 *
 * ## 它跨两个屏
 *
 * 收藏状态有两个使用方，且它们要一致：
 *   · ChatRoom  —— 长按菜单显示「收藏」还是「取消收藏」、多选批量
 *   · MeTab     —— 我的收藏列表、统计条上的数字
 * 放在一个 store 里，两边的数字才不可能对不上（各自存一份必然会打架）。
 *
 * ## `favedIds` 是个 Set，不是从列表里推出来的
 *
 * 聊天记录里那条消息可能**根本不在收藏列表的第一页**（收藏了几百条时）。
 * 从 `list` 里反查「这条收藏了没」只对前 N 条有效 —— 长按一条两年前的旧消息，
 * 菜单会错误地显示「收藏」。所以这里独立维护一个 Set：
 *   · 拉历史消息时由服务端的 `favorited` 字段灌进来（一次 IN 查询就够）
 *   · 收藏 / 取消时就地增删
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { useAuth } from './AuthContext.jsx'

const FavCtx = createContext(null)

export function FavoriteProvider({ children }) {
  const { user } = useAuth()

  const [list, setList] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  /** messageId 的 Set —— 见文件头「为什么不用 list 反查」 */
  const [favedIds, setFavedIds] = useState(() => new Set())
  const meRef = useRef(null)
  meRef.current = user || null

  /* 退出登录时清空：上一个人的收藏不能留给下一个人看 */
  useEffect(() => {
    if (!user) {
      setList([])
      setHasMore(false)
      setTotal(0)
      setFavedIds(new Set())
    }
  }, [user])

  const refresh = useCallback(async ({ beforeId } = {}) => {
    if (!meRef.current) return
    setLoading(true)
    setError('')
    try {
      const out = await api.favorites({ beforeId })
      setList((prev) => (beforeId ? [...prev, ...out.favorites] : out.favorites))
      setHasMore(!!out.hasMore)
      setTotal(Number(out.total) || 0)
      /* 首页那批的 messageId 直接灌进 Set（不必再单独查一次） */
      setFavedIds((prev) => {
        const next = beforeId ? new Set(prev) : new Set()
        for (const f of out.favorites) if (f.messageId) next.add(f.messageId)
        return next
      })
    } catch (e) {
      setError(e.message || '加载收藏失败')
    } finally {
      setLoading(false)
    }
  }, [])

  /**
   * 把一批消息的收藏状态**记下来**（由 ChatRoom 拉完历史后调用）。
   * 只增不减：`favorited === false` 的消息不该被「抹掉」——
   * 它本来就不在 Set 里，而服务端出参已经保证了权威性。
   */
  const rememberFavorited = useCallback((messages) => {
    setFavedIds((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const m of messages || []) {
        if (m.favorited && !next.has(m.id)) {
          next.add(m.id)
          changed = true
        }
        /* 服务端明确说没收藏 → 从 Set 里拿掉（可能是别处取消了） */
        if (m.favorited === false && next.has(m.id)) {
          next.delete(m.id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const isFaved = useCallback((messageId) => favedIds.has(Number(messageId)), [favedIds])

  const markFaved = useCallback((messageId) => {
    setFavedIds((prev) => {
      if (prev.has(Number(messageId))) return prev
      const next = new Set(prev)
      next.add(Number(messageId))
      return next
    })
  }, [])

  const markUnfaved = useCallback((messageId) => {
    setFavedIds((prev) => {
      if (!prev.has(Number(messageId))) return prev
      const next = new Set(prev)
      next.delete(Number(messageId))
      return next
    })
  }, [])

  /**
   * 收藏一条。**不做乐观更新** —— 收藏没有「等一个来回会显得卡」的问题
   * （它不是点赞那种要立刻变红的东西），而且失败时要给出准确原因
   * （「这条消息已撤回，不能收藏」是服务端才知道的）。所以以服务端为准。
   */
  const addFavorite = useCallback(
    async (messageId) => {
      const out = await api.favoriteMessage(Number(messageId))
      markFaved(messageId)
      setTotal((n) => (out.created ? n + 1 : n))
      /* 收藏成功后列表是旧的 —— 下次打开「我的收藏」时 refresh 会重拉，
         这里只把计数与 Set 更新掉，避免为了一个计数立刻重拉整页。 */
      return out
    },
    [markFaved]
  )

  const removeFavorite = useCallback(
    async (messageId) => {
      const out = await api.unfavoriteMessage(Number(messageId))
      markUnfaved(messageId)
      if (out.removed) setTotal((n) => Math.max(0, n - 1))
      /* 列表里那一条也要立刻消失（用户正看着它） */
      setList((prev) => prev.filter((f) => f.messageId !== Number(messageId)))
      return out
    },
    [markUnfaved]
  )

  /** 按收藏 id 删（「我的收藏」列表里那条右边的删除） */
  const removeFavoriteById = useCallback(async (favoriteId) => {
    const out = await api.removeFavorite(Number(favoriteId))
    setList((prev) => {
      const gone = prev.find((f) => f.id === Number(favoriteId))
      if (gone?.messageId) markUnfaved(gone.messageId)
      return prev.filter((f) => f.id !== Number(favoriteId))
    })
    if (out.removed) setTotal((n) => Math.max(0, n - 1))
    return out
  }, [markUnfaved])

  /**
   * 批量收藏（多选模式）。返回 `{added, skipped}` ——
   * skipped 里是「已撤回 / 不存在」的那些，界面要如实说「N 条成功、M 条跳过」，
   * 不能只说「已收藏」让用户以为全成功了。
   */
  const addFavorites = useCallback(
    async (messageIds) => {
      const ids = (messageIds || []).map(Number).filter(Boolean)
      if (!ids.length) return { added: [], skipped: [] }
      const out = await api.favoriteMessages(ids)
      setFavedIds((prev) => {
        const next = new Set(prev)
        for (const f of out.added || []) if (f.messageId) next.add(f.messageId)
        return next
      })
      setTotal(Number(out.total) || 0)
      return out
    },
    []
  )

  const removeFavorites = useCallback(async (messageIds) => {
    const ids = (messageIds || []).map(Number).filter(Boolean)
    if (!ids.length) return { removed: 0 }
    const out = await api.unfavoriteMessages(ids)
    setFavedIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      return next
    })
    setList((prev) => prev.filter((f) => !ids.includes(f.messageId)))
    setTotal(Number(out.total) || 0)
    return out
  }, [])

  const value = useMemo(
    () => ({
      list,
      hasMore,
      total,
      loading,
      error,
      refresh,
      isFaved,
      rememberFavorited,
      addFavorite,
      removeFavorite,
      removeFavoriteById,
      addFavorites,
      removeFavorites,
    }),
    [
      list,
      hasMore,
      total,
      loading,
      error,
      refresh,
      isFaved,
      rememberFavorited,
      addFavorite,
      removeFavorite,
      removeFavoriteById,
      addFavorites,
      removeFavorites,
    ]
  )

  return <FavCtx.Provider value={value}>{children}</FavCtx.Provider>
}

export function useFavorites() {
  const ctx = useContext(FavCtx)
  if (!ctx) throw new Error('useFavorites 必须在 FavoriteProvider 内使用')
  return ctx
}
