/**
 * 动态数据层：列表 / 发布 / 编辑 / 删除 / 点赞 / 评论
 *
 * 和 ChatStore 同样的分层理由：动态是**真实落库**的内容，
 * 不能和 AppContext 里的原型数据（发现 / 通知 / 状态）混在一个 store 里 ——
 * 混了之后「这条是不是真的存下来了」就说不清了。
 *
 * 不负责：状态与发现页推荐，它们由各自模块管理。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { api } from '../api/client.js'
import { useAuth } from './AuthContext.jsx'
import { avatarOf } from './ChatStore.jsx'

const MomentCtx = createContext(null)

const initial = {
  scope: 'friends', // friends | mine | hot
  list: [],
  hasMore: false,
  comments: {}, // momentId -> 评论数组
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_SCOPE':
      return { ...state, scope: action.scope, list: [], hasMore: false }

    case 'SET_LIST':
      return { ...state, list: action.list, hasMore: action.hasMore }

    case 'APPEND': {
      const seen = new Set(state.list.map((m) => m.id))
      return {
        ...state,
        list: [...state.list, ...action.list.filter((m) => !seen.has(m.id))],
        hasMore: action.hasMore,
      }
    }

    /** 新增或替换一条（发布后插入、编辑后就地更新、点赞后回填计数都走它） */
    case 'UPSERT': {
      const m = action.moment
      const i = state.list.findIndex((x) => x.id === m.id)
      return {
        ...state,
        list: i >= 0 ? state.list.map((x) => (x.id === m.id ? { ...x, ...m } : x)) : [m, ...state.list],
      }
    }

    case 'REMOVE':
      return { ...state, list: state.list.filter((m) => m.id !== action.id) }

    case 'SET_COMMENTS':
      return { ...state, comments: { ...state.comments, [action.id]: action.comments } }

    default:
      return state
  }
}

/** 后端出参 → 界面直接可用的形状。
 *  导出是因为搜索结果也要渲染 MomentDetail —— 从搜索进详情时那条动态
 *  可能不在列表里（比如筛选是「我的」，搜到的是好友的），得在别处也能补这几个派生字段。 */
export function shapeMoment(m, meId) {
  return {
    ...m,
    mine: m.author?.id === meId,
    src: avatarOf(m.author),
    authorName: m.author?.nickname || '',
    time: m.createdAt,
  }
}

export function MomentProvider({ children }) {
  const { user } = useAuth()
  const [state, dispatch] = useReducer(reducer, initial)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const meRef = useRef(null)
  meRef.current = user || null
  const scopeRef = useRef(state.scope)
  scopeRef.current = state.scope

  const refresh = useCallback(async (scope) => {
    const me = meRef.current
    if (!me) return
    const sc = scope || scopeRef.current
    setLoading(true)
    setError('')
    try {
      const { moments, hasMore } = await api.moments({ scope: sc, limit: 20 })
      dispatch({ type: 'SET_LIST', list: moments.map((m) => shapeMoment(m, me.id)), hasMore })
    } catch (e) {
      setError(e.message || '加载动态失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const setScope = useCallback(
    (scope) => {
      dispatch({ type: 'SET_SCOPE', scope })
      return refresh(scope)
    },
    [refresh]
  )

  useEffect(() => {
    if (!user) {
      dispatch({ type: 'SET_LIST', list: [], hasMore: false })
      return
    }
    refresh()
  }, [user, refresh])

  const loadMore = useCallback(async () => {
    const me = meRef.current
    if (!me || !state.hasMore || loading) return
    const last = state.list[state.list.length - 1]
    if (!last) return
    setLoading(true)
    try {
      const { moments, hasMore } = await api.moments({
        scope: state.scope,
        beforeId: last.id,
        limit: 20,
      })
      dispatch({ type: 'APPEND', list: moments.map((m) => shapeMoment(m, me.id)), hasMore })
    } catch {
      /* 翻页失败不打断浏览：列表还在，用户看不到红字更有用 */
    } finally {
      setLoading(false)
    }
  }, [state.hasMore, state.list, state.scope, loading])

  /* ---------- 发布 / 编辑 / 删除 ---------- */
  const publish = useCallback(async (payload) => {
    const me = meRef.current
    const { moment } = await api.publishMoment(payload)
    dispatch({ type: 'UPSERT', moment: shapeMoment(moment, me.id) })
    return moment
  }, [])

  const editMoment = useCallback(async (id, fields) => {
    const me = meRef.current
    const { moment } = await api.editMoment(id, fields)
    if (moment) dispatch({ type: 'UPSERT', moment: shapeMoment(moment, me.id) })
    return moment
  }, [])

  const removeMoment = useCallback(async (id) => {
    await api.deleteMoment(id)
    dispatch({ type: 'REMOVE', id })
  }, [])

  const updateMomentCard = useCallback((id, card) => {
    dispatch({ type: 'UPSERT', moment: { id, card } })
  }, [])

  /* ---------- 点赞 ----------
     乐观更新：点赞是「点了就有反馈」的交互，等一个来回再变会显得卡。
     失败要回滚 —— 否则计数和红心状态会和服务器对不上，刷新后又跳回去。 */
  /** known：这条动态不在当前列表里时的兜底（从搜索结果进详情就是这种情形），
   *  没有它点赞会因为「找不到当前状态」被静默吞掉 —— 点了没反应最难查。 */
  const toggleLike = useCallback(async (id, known) => {
    const cur = state.list.find((m) => m.id === id) || known
    if (!cur) return
    const next = !cur.liked
    dispatch({
      type: 'UPSERT',
      moment: { id, liked: next, likeCount: Math.max(0, (cur.likeCount || 0) + (next ? 1 : -1)) },
    })
    try {
      const out = await api.toggleMomentLike(id)
      dispatch({ type: 'UPSERT', moment: { id, liked: out.liked, likeCount: out.likeCount } })
    } catch {
      dispatch({
        type: 'UPSERT',
        moment: { id, liked: !next, likeCount: cur.likeCount },
      })
      throw new Error('点赞失败，请重试')
    }
  }, [state.list])

  /* ---------- 评论 ---------- */
  const loadComments = useCallback(async (id) => {
    const { comments } = await api.momentComments(id)
    dispatch({ type: 'SET_COMMENTS', id, comments })
    return comments
  }, [])

  const addComment = useCallback(async (id, content, parentId = null) => {
    const out = await api.addMomentComment(id, content, parentId)
    // 评论数用服务端返回的值，不自己 +1 —— 别人的评论可能同时进来
    dispatch({ type: 'UPSERT', moment: { id, commentCount: out.commentCount } })
    await loadComments(id)
    return out
  }, [loadComments])

  const deleteComment = useCallback(
    async (momentId, commentId) => {
      await api.deleteMomentComment(momentId, commentId)
      await loadComments(momentId)
      const { moment } = await api.moment(momentId).catch(() => ({}))
      if (moment) dispatch({ type: 'UPSERT', moment: shapeMoment(moment, meRef.current?.id) })
    },
    [loadComments]
  )

  const value = useMemo(
    () => ({
      me: user,
      scope: state.scope,
      list: state.list,
      hasMore: state.hasMore,
      loading,
      error,
      refresh,
      setScope,
      loadMore,
      publish,
      editMoment,
      removeMoment,
      updateMomentCard,
      toggleLike,
      commentsOf: (id) => state.comments[id],
      loadComments,
      addComment,
      deleteComment,
    }),
    [
      user,
      state.scope,
      state.list,
      state.hasMore,
      state.comments,
      loading,
      error,
      refresh,
      setScope,
      loadMore,
      publish,
      editMoment,
      removeMoment,
      updateMomentCard,
      toggleLike,
      loadComments,
      addComment,
      deleteComment,
    ]
  )

  return <MomentCtx.Provider value={value}>{children}</MomentCtx.Provider>
}

export function useMoments() {
  const ctx = useContext(MomentCtx)
  if (!ctx) throw new Error('useMoments must be used within MomentProvider')
  return ctx
}
