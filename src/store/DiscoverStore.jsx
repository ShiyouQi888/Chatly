/**
 * 发现页数据层：推荐用户 / 附近的人 / 兴趣标签 / 可加入的兴趣群 / 热门动态
 *
 * 为什么单独一个 store 而不是塞进 AppContext：
 *   这一页的内容是**真实落库**的（关注关系、群成员、动态），
 *   和 AppContext 里那些纯粹的原型数据（通知、状态 Stories）混在一起，
 *   「这条是不是真的存下来了」就说不清了 —— 这正是本项目一直在避免的事。
 *
 * 三件刻意的设计：
 *   1. **关注是乐观更新 + 失败回滚**。点了立刻变，等一个来回会显得卡；
 *      但失败必须回滚，否则界面上的「已关注」和库里的关系对不上。
 *   2. **热门动态复用 MomentStore 的接口**（`scope=hot`），不自己再造一份列表 ——
 *      两处各存一份，点赞数就会打架。
 *   3. **附近的人没有距离**。库里没有定位数据，任何 "2.3 km" 都是编的；
 *      后端给的是「同城 / 同省 / 地区名」，这里原样透出，不加工成数字。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { useAuth } from './AuthContext.jsx'
import { avatarOf } from './ChatStore.jsx'

const DiscoverCtx = createContext(null)

const initial = {
  users: [],
  usersHasMore: false,
  nearby: [],
  myRegion: null,
  /* 我自己的城市位置（只有城市名，不含坐标）—— 后端给了才说明「距离」是真的算出来的 */
  myGeo: null,
  tags: [],
  groups: [],
  hot: [],
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET':
      return { ...state, ...action.patch }

    case 'APPEND_USERS': {
      const seen = new Set(state.users.map((u) => u.id))
      return {
        ...state,
        users: [...state.users, ...action.users.filter((u) => !seen.has(u.id))],
        usersHasMore: action.hasMore,
      }
    }

    /* 关注状态就地翻转 —— 乐观更新与回滚都走它 */
    case 'FOLLOW':
      return {
        ...state,
        users: state.users.map((u) => (u.id === action.id ? { ...u, following: action.on } : u)),
        nearby: state.nearby.map((u) => (u.id === action.id ? { ...u, following: action.on } : u)),
      }

    /* 加入成功后从「可加入」列表里摘掉：它已经在我的会话里了 */
    case 'JOINED_GROUP':
      return { ...state, groups: state.groups.filter((g) => g.id !== action.id) }

    default:
      return state
  }
}

/** 后端出参 → 界面直接可用的形状（头像地址统一走 avatarOf，没有头像时给色块） */
function shapeUser(u) {
  return { ...u, src: avatarOf(u) }
}

export function DiscoverProvider({ children }) {
  const { user } = useAuth()
  const [state, dispatch] = useReducer(reducer, initial)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  const meRef = useRef(null)
  meRef.current = user || null
  const tagRef = useRef('')
  const offsetRef = useRef(0)

  /* ---------- 一次拉全量 ----------
     发现页就四块内容，分开拉会在界面上出现「先出来一块、再出来一块」的跳动；
     一次并发拉完，loading 也是一个。 */
  const loadUsers = useCallback(async (tag = '') => {
    tagRef.current = tag
    offsetRef.current = 0
    const { users, hasMore } = await api.discoverUsers({ tag, limit: 20, offset: 0 })
    dispatch({ type: 'SET', patch: { users: users.map(shapeUser), usersHasMore: hasMore } })
    return users
  }, [])

  const refresh = useCallback(async () => {
    if (!meRef.current) return
    setLoading(true)
    setError('')
    try {
      const tag = tagRef.current
      const [u, n, t, g, h] = await Promise.all([
        api.discoverUsers({ tag, limit: 20, offset: 0 }),
        api.discoverNearby(20),
        api.discoverTags(),
        api.discoverGroups(),
        api.moments({ scope: 'hot', limit: 10 }),
      ])
      offsetRef.current = 0
      dispatch({
        type: 'SET',
        patch: {
          users: u.users.map(shapeUser),
          usersHasMore: u.hasMore,
          nearby: n.users.map(shapeUser),
          myRegion: n.myRegion,
          myGeo: n.myGeo || null,
          tags: t.tags,
          groups: g.groups,
          hot: h.moments || [],
        },
      })
    } catch (e) {
      setError(e.message || '加载发现页失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!user) {
      dispatch({ type: 'SET', patch: initial })
      return
    }
    refresh()
  }, [user, refresh])

  /** 按兴趣标签筛选：重新拉推荐列表（标签筛选在服务端做，前端过滤会因为分页而漏人） */
  const setTag = useCallback(
    async (tag) => {
      setLoading(true)
      setError('')
      try {
        await loadUsers(tag)
      } catch (e) {
        setError(e.message || '加载失败')
      } finally {
        setLoading(false)
      }
    },
    [loadUsers]
  )

  const loadMoreUsers = useCallback(async () => {
    if (!state.usersHasMore || loadingMore) return
    setLoadingMore(true)
    try {
      const next = offsetRef.current + state.users.length
      const { users, hasMore } = await api.discoverUsers({
        tag: tagRef.current,
        limit: 20,
        offset: next,
      })
      offsetRef.current = next
      dispatch({ type: 'APPEND_USERS', users: users.map(shapeUser), hasMore })
    } catch {
      /* 翻页失败不打断浏览 */
    } finally {
      setLoadingMore(false)
    }
  }, [state.usersHasMore, state.users.length, loadingMore])

  /* ---------- 关注 / 取关 ---------- */
  const follow = useCallback(async (id) => {
    const cur =
      state.users.find((u) => u.id === id) || state.nearby.find((u) => u.id === id)
    if (!cur || id === meRef.current?.id) return
    const next = !cur.following
    dispatch({ type: 'FOLLOW', id, on: next })
    try {
      const out = next ? await api.followUser(id) : await api.unfollowUser(id)
      /* 以服务端返回的状态为准：别人的操作可能同时发生。
         ⚠️ **只认布尔值**。这个字段曾经因为后端对象展开的顺序问题被覆盖成「关注数」，
         `!!数量` 恒为 true —— 表现就是「取关了，按钮还写着已关注」，而库里其实已经删了。
         类型不对就不采信，保留乐观值，别让一个字段类型错误把界面带偏。 */
      if (typeof out?.following === 'boolean') dispatch({ type: 'FOLLOW', id, on: out.following })
    } catch {
      dispatch({ type: 'FOLLOW', id, on: !next })
      throw new Error(next ? '关注失败，请重试' : '取关失败，请重试')
    }
  }, [state.users, state.nearby])

  /* ---------- 加入兴趣群 ---------- */
  const joinGroup = useCallback(async (groupId) => {
    const out = await api.joinGroup(groupId)
    dispatch({ type: 'JOINED_GROUP', id: groupId })
    return out
  }, [])

  const value = useMemo(
    () => ({
      ...state,
      loading,
      loadingMore,
      error,
      refresh,
      setTag,
      loadMoreUsers,
      follow,
      joinGroup,
    }),
    [state, loading, loadingMore, error, refresh, setTag, loadMoreUsers, follow, joinGroup]
  )

  return <DiscoverCtx.Provider value={value}>{children}</DiscoverCtx.Provider>
}

export function useDiscover() {
  const ctx = useContext(DiscoverCtx)
  if (!ctx) throw new Error('useDiscover 必须在 DiscoverProvider 内使用')
  return ctx
}
