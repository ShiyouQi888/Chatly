/**
 * 真实聊天数据层：会话 / 消息 / 已读 / 撤回 / 在线 / 正在输入
 *
 * 职责边界：
 *   - 把后端 snake/raw 形状映射成界面直接可用的形状（ChatRow / Message 消费）
 *   - 订阅 WebSocket，把实时事件折进本地状态
 *   - 乐观发送：先插入 pending 消息，REST 返回后用真实 id 顶掉
 *
 * 不负责：动态 / 通知 / 状态 —— 那些仍在 AppContext（原型数据）。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api, fallbackAvatar, formatRelative, formatTime, resolveAvatarValue } from '../api/client.js'
import { useAuth } from './AuthContext.jsx'
import { useChatSocket, sendTyping as emitTyping } from '../hooks/useChatSocket.js'

const ChatCtx = createContext(null)

const AV_COLORS = [
  ['#a99bfb', '#6d5df6'],
  ['#8fd3f4', '#3f8efc'],
  ['#a8e6cf', '#3fae7d'],
  ['#ffd08a', '#f59f3c'],
  ['#f6b9c9', '#e8657f'],
  ['#c7b3ff', '#8b6cf0'],
]

function avatarOf(user) {
  if (!user) return fallbackAvatar('?')
  // avatar 可能是 preset:<n>（内置预设）或 /uploads/...（真实上传），统一在这里解析
  if (user.avatar) return resolveAvatarValue(user.avatar)
  const seed = user.nickname || user.username || String(user.id || '?')
  return fallbackAvatar(seed, AV_COLORS[Math.abs(Number(user.id) || 0) % AV_COLORS.length])
}

/* ================= 映射 ================= */

function lastBody(lm, geoName) {
  const t = lm.text || ''
  if (t === '(消息已撤回)') return '消息已撤回'
  if (lm.kind === 'image') return '[图片]'
  /* 位置消息的「正文」是地点名 —— 服务端把它放在 geo.name 而不是 content 里，
     这里得单独取一次，否则会话列表的预览会是一条空白（看起来像消息没发出去）。 */
  if (lm.kind === 'location') return `[位置] ${geoName || ''}`.trim()
  /* 投票消息的 content 存的就是题目（服务端约定，见 routes/polls.js），
     加个前缀让列表上一眼看出这不是一句话。 */
  if (lm.kind === 'poll') return `[投票] ${t}`.trim()
  if (lm.kind === 'file') return `[文件] ${t}`
  return t.replace(/\n/g, ' ')
}

function previewFromLast(raw, meId) {
  const lm = raw.lastMessage
  if (!lm) return ''
  const mine = lm.senderId === meId
  const who =
    raw.type === 'group'
      ? mine
        ? '我: '
        : `${raw.members.find((m) => m.user.id === lm.senderId)?.user.nickname || ''}: `
      : ''
  return who + lastBody(lm, lm.geoName)
}

/** 新消息进来时，用消息内容重算会话预览 */
function previewFromMessage(m, conv) {
  const who = conv.type === 'group' ? (m.mine ? '我: ' : `${m.sender}: `) : ''
  if (m.revoked) return who + '消息已撤回'
  /* 投票消息的 text 就是题目 —— 和 lastBody 里的分流保持一致 */
  if (m.kind === 'poll') return who + `[投票] ${m.text || ''}`.trim()
  return who + lastBody({ kind: m.kind, text: m.text }, m.geo?.name)
}

function mapConversation(raw, meId, presence = {}) {
  const others = (raw.members || []).filter((m) => m.user.id !== meId)
  const other = others[0]
  const updatedAt = raw.lastMessage ? Number(raw.lastMessage.createdAt) : Number(raw.updatedAt || 0) * 1000

  /* 群头像不能借用某个成员的头像 —— 那个人一改自己的头像，群头像就跟着变了，
     而且看着像「群是某个人开的」。没有群头像时统一用群名生成的渐变底图。 */
  const src =
    raw.avatar
      ? resolveAvatarValue(raw.avatar)
      : raw.type === 'group'
        ? fallbackAvatar(raw.name || `群${raw.id}`)
        : (other ? avatarOf(other.user) : null) || fallbackAvatar(raw.name)

  return {
    id: raw.id,
    type: raw.type,
    name: raw.name,
    src,
    /* 头像的**原始值**（`preset:n` / `/uploads/xxx` / null）。
       换个头像要拿它去比对「当前选中的是哪一款」，src 是解析后的 data-URI，比不了。 */
    avatar: raw.avatar || null,
    memberCount: raw.memberCount,
    members: raw.members || [],
    peers: others.map((m) => m.user),
    /* ---- 群聊专有：角色与群设置 ---- */
    myRole: raw.myRole || null,
    ownerId: raw.ownerId ?? null,
    announcement: raw.announcement || '',
    announcementAt: raw.announcementAt || null,
    muteAll: !!raw.muteAll,
    adminOnly: !!raw.adminOnly,
    preview: previewFromLast(raw, meId),
    time: updatedAt ? formatRelative(updatedAt) : '',
    unread: raw.unread || 0,
    muted: !!raw.muted,
    pinned: !!raw.pinned,
    online: raw.type === 'private' && other ? !!presence[other.user.id] : false,
    updatedAt,
    lastMessageId: raw.lastMessage?.id ?? 0,
  }
}

function mapMessage(raw, meId) {
  const mine = raw.sender?.id === meId
  return {
    id: raw.id,
    convId: raw.conversationId ?? raw.convId,
    from: mine ? 'me' : 'other',
    mine,
    senderId: raw.sender?.id,
    sender: raw.sender?.nickname || '',
    av: avatarOf(raw.sender),
    kind: raw.kind || 'text',
    text: raw.text || '',
    fileUrl: raw.fileUrl || null,
    fileName: raw.fileName || null,
    fileSize: raw.fileSize || 0,
    /* 位置消息：`{ name, address, lat, lng }`，非位置消息恒为 null。
       坐标可能是 null（用户只给了地点名）—— 别在这里补 0。 */
    geo: raw.geo || null,
    /* 投票消息只带 id：详情（选项 / 票数 / 投票人）在 `polls` 缓存里，由 loadPolls 批量补。
       塞进消息体的话，拉一页历史就要连带拉一页投票明细。 */
    pollId: raw.pollId || null,
    /**
     * 我收藏了这条没。
     * ⚠️ 用 `=== true` 而不是 `!!raw.favorited`：**只有服务端明确说 true 才算收藏**。
     * WS 推来的 `message.new` 里没有这个字段（undefined），`!!undefined` 是 false
     * 看起来「没问题」，但那是**巧合** —— 万一条消息自己发的、前端本地先乐观插了一条
     * 再被服务端消息覆盖，`!!` 会把「未知」当成「没收藏」，菜单就会显示成「收藏」
     * 而不是「取消收藏」。三态（true / false / 未知）用 `=== true` 表达才准确，
     * 未知的那份交给 FavoriteStore 的 Set 去回答。
     */
    favorited: raw.favorited === true,
    quote: raw.replyTo?.text || null,
    replyToId: raw.replyTo?.id || null,
    time: formatTime(raw.createdAt),
    createdAt: Number(raw.createdAt) || Date.now(),
    read: !!raw.read,
    revoked: !!raw.revoked,
    pending: !!raw.pending,
    failed: !!raw.failed,
  }
}

function sortConversations(list) {
  return [...list].sort(
    (a, b) => Number(b.pinned || 0) - Number(a.pinned || 0) || (b.updatedAt || 0) - (a.updatedAt || 0)
  )
}

/** 私聊会话的名字 / 头像派生自对端 —— 对端改了资料就得跟着重算 */
function refreshPrivatePeer(conv, meId) {
  if (conv.type !== 'private') return conv
  const peer = (conv.members || []).find((m) => m.user.id !== meId)?.user
  if (!peer) return conv
  return { ...conv, name: peer.nickname, src: avatarOf(peer), peers: [peer] }
}

/* ================= Reducer ================= */

const initial = {
  conversations: [],
  messages: {},
  hasMore: {},
  typing: {},
  presence: {},
  /** convId -> { userId -> 该成员已读到的最大消息 id }，用来算「谁读了谁没读」 */
  readCursors: {},
  activeConvId: null,
  /**
   * pollId -> 投票详情（选项 / 票数 / 投票人 / 我投了哪些）。
   * 消息只带 pollId，详情在这里按 id 缓存 —— 一条投票会被很多人、很多次渲染，
   * 每次都现算一份票数就会出现「同一屏两个气泡的数字不一样」。
   */
  polls: {},
  /** pollId -> true：正在取详情（气泡先画骨架，不画 0 票） */
  pollsLoading: {},
}

/**
 * 合并一份投票详情。
 *
 * ⚠️ `voters` 与 `myOptionIds` 是**按 key 合并**的，不是整份覆盖：
 * 匿名投票的出参里**根本没有 voters 字段**（服务端刻意不返回，见 poll.js），
 * 而 WS 推来的 `poll.updated` 用的也是同一份出参。
 * 如果这里写成 `{...old, ...next}`，某次推送就会把非匿名时缓存下来的头像簇抹掉 ——
 * 而发起人本人在自己手机上会看到「刚才还有头像，投完票就没了」。
 */
function mergePoll(state, poll) {
  if (!poll?.id) return state
  const prev = state.polls[poll.id]
  const next = { ...poll }
  if (!('voters' in poll) && prev && 'voters' in prev) next.voters = prev.voters
  if (!('myOptionIds' in poll) && prev && 'myOptionIds' in prev) next.myOptionIds = prev.myOptionIds
  return {
    ...state,
    polls: { ...state.polls, [poll.id]: { ...prev, ...next } },
  }
}

/** 从会话成员里初始化已读游标 */
function cursorsFromMembers(members) {
  const out = {}
  for (const m of members || []) out[m.user.id] = Number(m.lastReadMessageId) || 0
  return out
}

function reducer(state, action) {
  switch (action.type) {
    case 'LOAD_CONVERSATIONS':
      return {
        ...state,
        conversations: sortConversations(action.conversations),
        // 服务端返回的成员已读游标是最新权威值，直接覆盖
        readCursors: Object.fromEntries(
          action.conversations.map((c) => [c.id, cursorsFromMembers(c.members)])
        ),
      }

    case 'SET_MESSAGES':
      return {
        ...state,
        messages: { ...state.messages, [action.convId]: action.messages },
        hasMore: { ...state.hasMore, [action.convId]: !!action.hasMore },
      }

    /* 投票：一次可以合并多份（批量拉取 / 单条推送共用） */
    case 'MERGE_POLLS': {
      let next = state
      for (const poll of action.polls || []) next = mergePoll(next, poll)
      return next
    }

    case 'POLLS_LOADING': {
      const pollsLoading = { ...state.pollsLoading }
      for (const id of action.ids || []) pollsLoading[id] = !!action.on
      return { ...state, pollsLoading }
    }

    case 'PREPEND_MESSAGES': {
      const prev = state.messages[action.convId] || []
      const seen = new Set(prev.map((m) => m.id))
      const add = action.messages.filter((m) => !seen.has(m.id))
      return {
        ...state,
        messages: { ...state.messages, [action.convId]: [...add, ...prev] },
        hasMore: { ...state.hasMore, [action.convId]: !!action.hasMore },
      }
    }

    case 'UPSERT_MESSAGE': {
      const m = action.message
      const convId = m.convId

      // 1) 会话行：预览 / 时间 / 未读 / 排序
      let conversations = state.conversations
      const ci = conversations.findIndex((c) => c.id === convId)
      if (ci >= 0) {
        const c = conversations[ci]
        conversations = conversations.slice()
        conversations[ci] = {
          ...c,
          preview: previewFromMessage(m, c),
          updatedAt: m.createdAt,
          lastMessageId: m.pending ? c.lastMessageId : m.id,
          unread:
            !m.mine && !m.pending && convId !== state.activeConvId ? (c.unread || 0) + 1 : c.unread || 0,
        }
        conversations = sortConversations(conversations)
      }

      // 2) 消息列表（未加载过则不动，等打开会话时统一拉取）
      const prev = state.messages[convId]
      if (!prev) return { ...state, conversations }

      const list = prev.slice()
      const byId = list.findIndex((x) => x.id === m.id)
      if (byId >= 0) {
        list[byId] = { ...list[byId], ...m }
      } else if (m.mine) {
        // 自己发的：可能是刚发出的乐观占位，就地顶掉以保持位置
        const ti = list.findIndex((x) => x.pending && x.kind === m.kind && x.text === m.text)
        if (ti >= 0) list[ti] = m
        else list.push(m)
      } else {
        list.push(m)
      }
      return { ...state, conversations, messages: { ...state.messages, [convId]: list } }
    }

    /** REST 返回后顶掉乐观消息（若 WS 已抢先落位，则只删占位） */
    case 'REPLACE_TEMP': {
      const list = state.messages[action.convId]
      if (!list) return state
      const has = list.some((x) => x.id === action.message.id)
      const next = list.filter((x) => x.id !== action.tempId)
      if (!has) next.push(action.message)
      return { ...state, messages: { ...state.messages, [action.convId]: next } }
    }

    case 'MARK_FAILED':
      return {
        ...state,
        messages: {
          ...state.messages,
          [action.convId]: (state.messages[action.convId] || []).map((m) =>
            m.id === action.tempId ? { ...m, pending: false, failed: true } : m
          ),
        },
      }

    case 'REVOKE': {
      const list = state.messages[action.convId]
      return {
        ...state,
        messages: list
          ? {
              ...state.messages,
              [action.convId]: list.map((m) =>
                m.id === action.messageId ? { ...m, revoked: true, text: '' } : m
              ),
            }
          : state.messages,
        conversations: state.conversations.map((c) =>
          c.id === action.convId && c.lastMessageId === action.messageId
            ? { ...c, preview: '消息已撤回' }
            : c
        ),
      }
    }

    /** 某个成员的已读位置推进（来自 WS conversation.read） */
    case 'SET_MEMBER_CURSOR': {
      const cur = state.readCursors[action.convId] || {}
      const prev = cur[action.userId] || 0
      if (action.cursor <= prev) return state
      return {
        ...state,
        readCursors: { ...state.readCursors, [action.convId]: { ...cur, [action.userId]: action.cursor } },
      }
    }

    case 'CLEAR_UNREAD':
      return {
        ...state,
        conversations: state.conversations.map((c) => (c.id === action.convId ? { ...c, unread: 0 } : c)),
      }

    case 'SET_ACTIVE':
      return { ...state, activeConvId: action.convId }

    case 'TOGGLE_PIN':
      return {
        ...state,
        conversations: sortConversations(
          state.conversations.map((c) => (c.id === action.convId ? { ...c, pinned: !c.pinned } : c))
        ),
      }

    case 'TOGGLE_MUTE':
      return {
        ...state,
        conversations: state.conversations.map((c) => (c.id === action.convId ? { ...c, muted: !c.muted } : c)),
      }

    case 'TOGGLE_UNREAD':
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === action.convId ? { ...c, unread: c.unread > 0 ? 0 : 1 } : c
        ),
      }

    case 'DELETE_CONVERSATION':
      return { ...state, conversations: state.conversations.filter((c) => c.id !== action.convId) }

    /**
     * 群资料变了（群名 / 群头像 / 公告 / 群开关）。
     * 只覆盖 meta 里带了的字段 —— 服务端 updateGroup 也是这个语义，
     * 前端「只改公告」时不能顺手把群开关冲掉。
     */
    case 'GROUP_META': {
      const m = action.meta || {}
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id !== action.convId
            ? c
            : {
                ...c,
                name: m.title != null ? m.title : c.name,
                src: m.avatar != null ? resolveAvatarValue(m.avatar) : c.src,
                announcement: m.announcement != null ? m.announcement || '' : c.announcement,
                announcementAt: m.announcementAt != null ? m.announcementAt : c.announcementAt,
                muteAll: m.muteAll != null ? !!m.muteAll : c.muteAll,
                adminOnly: m.adminOnly != null ? !!m.adminOnly : c.adminOnly,
                ownerId: m.ownerId != null ? m.ownerId : c.ownerId,
              }
        ),
      }
    }

    /** 成员列表刷新（邀请 / 移人 / 打开成员面板后拉一次拿权威值） */
    case 'GROUP_MEMBERS': {
      const members = action.members || []
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id !== action.convId
            ? c
            : {
                ...c,
                members,
                memberCount: members.length,
                myRole: action.myRole || c.myRole,
                peers: members.filter((x) => x.user.id !== action.meId).map((x) => x.user),
              }
        ),
        readCursors: { ...state.readCursors, [action.convId]: cursorsFromMembers(members) },
      }
    }

    /** 设 / 撤管理员 */
    case 'GROUP_ROLE':
      return {
        ...state,
        conversations: state.conversations.map((c) => {
          if (c.id !== action.convId) return c
          const members = (c.members || []).map((m) =>
            m.user.id === action.userId ? { ...m, role: action.role } : m
          )
          return { ...c, members, myRole: action.userId === action.meId ? action.role : c.myRole }
        }),
      }

    case 'SET_TYPING': {
      const cur = state.typing[action.convId]
      const nextOn = action.on ? action.userId : cur === action.userId ? null : cur
      if (cur === nextOn) return state
      return { ...state, typing: { ...state.typing, [action.convId]: nextOn } }
    }

    case 'SET_PRESENCE':
      return { ...state, presence: { ...state.presence, [action.userId]: action.online } }

    case 'SET_PRESENCE_MAP':
      return { ...state, presence: { ...state.presence, ...action.map } }

    /**
     * 某人改了昵称 / 头像。三处都要刷，否则界面会撕裂 ——
     * 典型症状是「会话列表里还是旧昵称，点进去消息里却已经换了头像」。
     *   1) 各会话的 members（群成员面板、已读小头像都读它）
     *   2) 私聊会话的 name / src（派生自对端）
     *   3) 已加载消息里的 sender / av
     */
    case 'USER_UPDATED': {
      const u = action.user
      if (!u?.id) return state

      const conversations = sortConversations(
        state.conversations.map((c) => {
          if (!(c.members || []).some((m) => m.user.id === u.id)) return c
          const members = c.members.map((m) => (m.user.id === u.id ? { ...m, user: { ...m.user, ...u } } : m))
          return refreshPrivatePeer({ ...c, members }, action.meId)
        })
      )

      let messages = state.messages
      let changed = false
      for (const [cid, list] of Object.entries(state.messages)) {
        if (!list?.some((m) => m.senderId === u.id)) continue
        if (!changed) {
          messages = { ...state.messages }
          changed = true
        }
        messages[cid] = list.map((m) =>
          m.senderId === u.id ? { ...m, sender: u.nickname, av: avatarOf(u) } : m
        )
      }

      return { ...state, conversations, messages }
    }

    default:
      return state
  }
}

/* ================= Provider ================= */

export function ChatProvider({ children }) {
  const { user, token, applyUser } = useAuth()
  const [state, dispatch] = useReducer(reducer, initial)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const meRef = useRef(null)
  meRef.current = user || null

  const activeRef = useRef(null)
  activeRef.current = state.activeConvId

  /* 投票详情缓存。和 state.polls 是一份数据的两面，区别是：
     state 用来渲染（React 只认它），ref 用来在回调里**同步**读写 ——
     乐观更新 / 回滚 / 去重都要立刻看到最新值，等 setState 落地再读会读到上一帧。 */
  const stateRef = useRef(state)
  stateRef.current = state
  const pollCacheRef = useRef({})
  const pollInflightRef = useRef(new Set())

  const typingTimer = useRef({})
  const lastTypingSent = useRef(0)

  /* ---------- 拉取会话列表 ---------- */
  const refresh = useCallback(async () => {
    const me = meRef.current
    if (!me) return
    setLoading(true)
    setError('')
    try {
      const [{ conversations }, { users }] = await Promise.all([api.conversations(), api.users()])
      const presence = Object.fromEntries(users.map((u) => [u.id, !!u.online]))
      dispatch({
        type: 'LOAD_CONVERSATIONS',
        conversations: conversations.map((c) => mapConversation(c, me.id, presence)),
      })
      dispatch({ type: 'SET_PRESENCE_MAP', map: presence })
    } catch (e) {
      setError(e.message || '加载会话失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!user) {
      dispatch({ type: 'LOAD_CONVERSATIONS', conversations: [] })
      return
    }
    refresh()
  }, [user, refresh])

  /* ---------- 实时事件 ---------- */
  const onEvent = useCallback((evt) => {
    const me = meRef.current
    if (!me) return
    const p = evt.payload || {}

    switch (evt.type) {
      case 'hello':
        // （重）连成功：补齐断线期间错过的消息
        refresh()
        break

      case 'message.new': {
        const raw = p.message
        if (!raw) break
        dispatch({ type: 'UPSERT_MESSAGE', message: mapMessage(raw, me.id) })
        // 正开着这个会话且不是我发的 → 立即回执已读
        if (raw.conversationId === activeRef.current && raw.sender?.id !== me.id) {
          api.markRead(raw.conversationId, raw.id).catch(() => {})
        }
        break
      }

      case 'message.revoked':
        dispatch({ type: 'REVOKE', convId: p.conversationId, messageId: p.messageId })
        break

      /**
       * 群里有人投票 / 改票 / 结束投票。
       * payload 是**整份投票**（选项 + 票数 + 投票人），直接覆盖缓存 ——
       * 不这么做的话，票数只有自己点的那一刻会变，
       * 别人投的票要等下次重开聊天才看得到，那就不叫实时了。
       */
      case 'poll.updated':
        if (p.poll) {
          pollCacheRef.current[p.poll.id] = p.poll
          dispatch({ type: 'MERGE_POLLS', polls: [p.poll] })
        }
        break

      case 'conversation.read':
        // 记下「谁读到了哪」，前端据此渲染已读小头像与详情弹层
        dispatch({
          type: 'SET_MEMBER_CURSOR',
          convId: p.conversationId,
          userId: p.userId,
          cursor: Number(p.lastReadMessageId) || 0,
        })
        break

      case 'typing': {
        const cid = p.conversationId
        dispatch({ type: 'SET_TYPING', convId: cid, userId: p.userId, on: true })
        // 服务端不发送「停止输入」，本地超时兜底
        clearTimeout(typingTimer.current[cid])
        typingTimer.current[cid] = setTimeout(
          () => dispatch({ type: 'SET_TYPING', convId: cid, userId: p.userId, on: false }),
          2600
        )
        break
      }

      case 'presence':
        dispatch({ type: 'SET_PRESENCE', userId: p.userId, online: !!p.online })
        break

      /**
       * 群资料 / 成员 / 角色被谁改了。
       * 必须实时 —— 别人开着这个群，群名一改他的标题栏还是旧的，那不叫实时。
       */
      case 'conversation.updated': {
        const cid = p.conversationId
        if (!cid) break
        // 我被人移出群了：列表里立刻消失，别等他点进去才发现「已经不在群里」
        if (p.removedUserId && Number(p.removedUserId) === Number(me.id)) {
          dispatch({ type: 'DELETE_CONVERSATION', convId: cid })
          if (activeRef.current === cid) dispatch({ type: 'SET_ACTIVE', convId: null })
          break
        }
        if (p.meta) dispatch({ type: 'GROUP_META', convId: cid, meta: p.meta })
        // 成员增减 / 角色变更在 meta 里带不出来，重新拉一次拿权威值
        refresh()
        break
      }

      case 'user.updated':
        // 同会话的人改了昵称 / 头像：昵称与头像要立刻跟上，不能等下次 refresh
        dispatch({ type: 'USER_UPDATED', user: p.user, meId: me.id })
        // 同账号在别的标签页改了资料 → 本标签页的 user 也要跟上
        if (p.user?.id === me.id) applyUser(p.user)
        break

      default:
        break
    }
  }, [refresh, applyUser])

  const connected = useChatSocket(token, onEvent)

  /* ---------- 消息 ---------- */
  const loadMessages = useCallback(
    async (convId, { beforeId, limit = 40 } = {}) => {
      const me = meRef.current
      if (!me) return
      const { messages, hasMore } = await api.messages(convId, { limit, beforeId })
      const mapped = messages.map((m) => mapMessage(m, me.id))
      dispatch(
        beforeId
          ? { type: 'PREPEND_MESSAGES', convId, messages: mapped, hasMore }
          : { type: 'SET_MESSAGES', convId, messages: mapped, hasMore }
      )
    },
    []
  )

  const openConversation = useCallback((convId) => {
    dispatch({ type: 'SET_ACTIVE', convId })
    dispatch({ type: 'CLEAR_UNREAD', convId })
    api.markRead(convId).catch(() => {})
  }, [])

  const closeConversation = useCallback(() => dispatch({ type: 'SET_ACTIVE', convId: null }), [])

  /* ---------- 投票 ---------- */

  /**
   * 按 id 取投票详情并缓存。**别人正在取的不重复发**：
   * 一个群里同时挂 3 条投票、每条的渲染都会触发一次补拉，
   * 不去重的话同一条会被并发请求三次（而且返回顺序还不保证）。
   */
  const loadPolls = useCallback(async (pollIds) => {
    const ids = Array.from(new Set((pollIds || []).map(Number).filter(Boolean)))
    const missing = ids.filter((id) => !pollCacheRef.current[id] && !pollInflightRef.current.has(id))
    if (!missing.length) return
    for (const id of missing) pollInflightRef.current.add(id)
    dispatch({ type: 'POLLS_LOADING', ids: missing, on: true })
    try {
      const { polls } = await api.polls(missing)
      for (const p of polls || []) pollCacheRef.current[p.id] = p
      dispatch({ type: 'MERGE_POLLS', polls: polls || [] })
    } catch {
      /* 拉不到就让它保持骨架 —— 不要写一条「0 票」的假数据进去 */
    } finally {
      for (const id of missing) pollInflightRef.current.delete(id)
      dispatch({ type: 'POLLS_LOADING', ids: missing, on: false })
    }
  }, [])

  /**
   * 发起投票。投票同时是一条消息，所以这里既要把消息插进聊天记录，
   * 也要把投票详情塞进缓存 —— 否则气泡会先闪一下骨架再出内容。
   *
   * 不做乐观更新：投票的「发出去」必然要拿到服务端分配的 id 才有意义
   * （选项 id 也是服务端给的），而且这是一次用户主动点击，
   * 快慢以请求为准比画一条假的pending气泡更诚实。
   */
  const sendPollMessage = useCallback(async (payload) => {
    const me = meRef.current
    if (!me) throw new Error('未登录')
    const { message, poll } = await api.createPoll(payload)
    pollCacheRef.current[poll.id] = poll
    dispatch({ type: 'MERGE_POLLS', polls: [poll] })
    dispatch({ type: 'UPSERT_MESSAGE', message: mapMessage(message, me.id) })
    return { message, poll }
  }, [])

  /**
   * 消息里出现 `pollId` 就补拉投票详情。
   *
   * 放在这里而不是在气泡组件里各拉各的：一条投票可能同时出现在
   * 聊天记录 / 群设置列表 / 引用块里，组件各拉一次就是同一份数据请求三遍。
   * 依赖是 `state.messages`（每次分页 / 新消息都会换新引用）——
   * 合并投票时 `messages` 不变，所以不会自激循环。
   *
   * ⚠️ 这个 effect **必须待在这个文件里 `loadPolls` 定义之后**。
   * 第一版把它写在了 `useChatSocket` 后面（也就是 `const loadPolls = useCallback(...)` 之前），
   * 结果**整个 App 白屏**：依赖数组 `[state.messages, loadPolls]` 是在渲染期间求值的，
   * 那一刻 `loadPolls` 还在 TDZ 里 → `ReferenceError: Cannot access 'loadPolls' before initialization`。
   * 更要命的是它**一声不响**：Vite 不报错（这不是语法/导入问题）、
   * `vite build` 也照样通过，页面上只有一片空白 + 控制台里一条被 React 包装过的异常。
   */
  useEffect(() => {
    const ids = []
    for (const list of Object.values(state.messages)) {
      for (const m of list || []) {
        if (m.pollId) ids.push(m.pollId)
      }
    }
    if (ids.length) loadPolls(ids)
  }, [state.messages, loadPolls])

  /**
   * 拉某个群的**全部**投票（群设置 → 群投票列表）。
   *
   * 和 `loadPolls` 的区别：那个是按聊天记录里出现的 id 补详情，
   * 这个是「这个群一共发起过哪些投票」—— 列表可能包含很久以前、
   * 已经不在当前这页历史里的投票，所以必须走`/polls/of/:cid`。
   */
  const loadConversationPolls = useCallback(async (convId) => {
    const { polls: list } = await api.pollsOf(convId)
    if (list?.length) {
      for (const p of list) pollCacheRef.current[p.id] = p
      dispatch({ type: 'MERGE_POLLS', polls: list })
    }
    return list || []
  }, [])

  /**
   * 投票 / 改票 / 取消。**乐观更新**：点了要立刻看到勾和票数变化，
   * 等一个来回会有明显延迟感（项目里点赞、关注都是这个做法）。
   *
   * 本地先按「完整状态」重算一遍：单选换选项就是旧的减一、新的加一，
   * 多选整体覆盖 —— 和服务端 poll.js 的语义保持一致，不一致的话
   * 乐观态和权威值之间会闪一下。
   */
  const votePoll = useCallback(async (pollId, optionIds) => {
    const id = Number(pollId)
    const prev = pollCacheRef.current[id] || stateRef.current.polls[id]
    if (!prev) return null
    const wanted = new Set((optionIds || []).map(Number))
    const beforeMine = new Set(prev.myOptionIds || [])
    const afterMine = prev.multi ? wanted : new Set([...wanted].slice(0, 1))

    const optimistic = {
      ...prev,
      myOptionIds: [...afterMine],
      options: prev.options.map((o) => {
        const had = beforeMine.has(o.id)
        const has = afterMine.has(o.id)
        const votes = o.votes + (has ? 1 : 0) - (had ? 1 : 0)
        return { ...o, votes, mine: has }
      }),
    }
    /* 人数：我自己从「没投」变成「投了」才 +1；从「投了」变成「没投」才 −1。
       改选项不算人数变化。 */
    const wasIn = beforeMine.size > 0
    const nowIn = afterMine.size > 0
    optimistic.voterCount = prev.voterCount + (nowIn && !wasIn ? 1 : !nowIn && wasIn ? -1 : 0)
    optimistic.totalVotes = optimistic.options.reduce((n, o) => n + o.votes, 0)
    const total = optimistic.totalVotes
    optimistic.options = optimistic.options.map((o) => ({
      ...o,
      percent: total ? Math.round((o.votes / total) * 100) : 0,
    }))
    /* 非匿名时把「我」补进 / 移出投票人头像簇 */
    if ('voters' in prev) {
      const me = meRef.current
      const others = (prev.voters || []).filter((v) => v.id !== me?.id)
      optimistic.voters = nowIn ? [...others, { id: me.id, nickname: me.nickname, avatar: me.avatar, username: me.username }] : others
    }

    const apply = (poll) => {
      pollCacheRef.current[poll.id] = poll
      dispatch({ type: 'MERGE_POLLS', polls: [poll] })
    }
    apply(optimistic)
    try {
      const { poll } = await api.votePoll(id, [...wanted])
      apply(poll) // 以服务端返回为准（别人可能同时投票）
      return poll
    } catch (e) {
      apply(prev) // 失败回滚
      throw e
    }
  }, [])

  /** 发起人提前结束投票 */
  const closePoll = useCallback(async (pollId) => {
    const id = Number(pollId)
    const prev = pollCacheRef.current[id] || stateRef.current.polls[id]
    if (prev) {
      const optimistic = { ...prev, closed: true, closedAt: Date.now() }
      pollCacheRef.current[id] = optimistic
      dispatch({ type: 'MERGE_POLLS', polls: [optimistic] })
    }
    try {
      const { poll } = await api.closePoll(id)
      pollCacheRef.current[poll.id] = poll
      dispatch({ type: 'MERGE_POLLS', polls: [poll] })
      return poll
    } catch (e) {
      if (prev) {
        pollCacheRef.current[id] = prev
        dispatch({ type: 'MERGE_POLLS', polls: [prev] })
      }
      throw e
    }
  }, [])

  const sendMessage = useCallback(async (payload) => {
    const me = meRef.current
    if (!me) throw new Error('未登录')
    const convId = payload.conversationId
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

    dispatch({
      type: 'UPSERT_MESSAGE',
      message: {
        id: tempId,
        convId,
        from: 'me',
        mine: true,
        senderId: me.id,
        sender: me.nickname,
        av: avatarOf(me),
        kind: payload.kind || 'text',
        text: payload.text || '',
        fileUrl: payload.fileUrl || null,
        fileName: payload.fileName || null,
        fileSize: payload.fileSize || 0,
        geo: payload.geo || null,
        quote: payload.quoteText || null,
        replyToId: payload.replyToId || null,
        time: formatTime(Date.now()),
        createdAt: Date.now(),
        read: false,
        revoked: false,
        pending: true,
        failed: false,
      },
    })

    try {
      const { message } = await api.sendMessage({
        conversationId: convId,
        kind: payload.kind || 'text',
        text: payload.kind === 'text' ? payload.text : undefined,
        fileUrl: payload.fileUrl,
        fileName: payload.fileName,
        fileSize: payload.fileSize,
        geo: payload.geo,
        replyToId: payload.replyToId,
      })
      dispatch({ type: 'REPLACE_TEMP', convId, tempId, message: mapMessage(message, me.id) })
      return message
    } catch (e) {
      dispatch({ type: 'MARK_FAILED', convId, tempId })
      throw e
    }
  }, [])

  const revokeMessage = useCallback(async (messageId, convId) => {
    await api.revokeMessage(messageId)
    dispatch({ type: 'REVOKE', convId, messageId })
  }, [])

  const notifyTyping = useCallback((convId) => {
    const now = Date.now()
    if (now - lastTypingSent.current < 1500) return
    lastTypingSent.current = now
    emitTyping(convId)
  }, [])

  /* ---------- 会话操作（真实落库） ---------- */
  const createPrivateChat = useCallback(
    async (userId) => {
      const { conversationId } = await api.createPrivate(userId)
      await refresh()
      return conversationId
    },
    [refresh]
  )

  const createGroupChat = useCallback(
    async (title, memberIds) => {
      const { conversationId } = await api.createGroup(title, memberIds)
      await refresh()
      return conversationId
    },
    [refresh]
  )

  const togglePin = useCallback(
    async (convId) => {
      const c = state.conversations.find((x) => x.id === convId)
      if (!c) return
      dispatch({ type: 'TOGGLE_PIN', convId })
      try {
        await api.patchConversation(convId, { pinned: !c.pinned })
      } catch {
        dispatch({ type: 'TOGGLE_PIN', convId }) // 失败回滚
      }
    },
    [state.conversations]
  )

  const toggleMute = useCallback(
    async (convId) => {
      const c = state.conversations.find((x) => x.id === convId)
      if (!c) return
      dispatch({ type: 'TOGGLE_MUTE', convId })
      try {
        await api.patchConversation(convId, { muted: !c.muted })
      } catch {
        dispatch({ type: 'TOGGLE_MUTE', convId })
      }
    },
    [state.conversations]
  )

  const deleteConversation = useCallback(async (convId) => {
    dispatch({ type: 'DELETE_CONVERSATION', convId })
    try {
      await api.deleteConversation(convId)
    } catch {
      /* 已本地移除；下次 refresh 会还原为真实状态 */
    }
  }, [])

  /* ---------- 群聊：资料 / 成员 / 设置 ---------- */
  /** 拉一次群成员 + 群资料 + 我的角色（成员面板与设置面板都用它拿权威值） */
  const loadGroupMembers = useCallback(async (convId) => {
    const data = await api.groupMembers(convId)
    dispatch({
      type: 'GROUP_MEMBERS',
      convId,
      members: data.members || [],
      myRole: data.myRole,
      meId: meRef.current?.id,
    })
    if (data.meta) dispatch({ type: 'GROUP_META', convId, meta: data.meta })
    return data
  }, [])

  /** 改群名 / 群头像 / 公告 / 开关。服务端会广播，别人那边也是实时变 */
  const updateGroup = useCallback(async (convId, fields) => {
    const { meta } = await api.updateGroup(convId, fields)
    if (meta) dispatch({ type: 'GROUP_META', convId, meta })
    return meta
  }, [])

  const addGroupMembers = useCallback(
    async (convId, userIds) => {
      const out = await api.addGroupMembers(convId, userIds)
      await refresh()
      return out
    },
    [refresh]
  )

  /** 移出成员；userId 是自己就等价于退出群聊 */
  const removeGroupMember = useCallback(
    async (convId, userId) => {
      await api.removeGroupMember(convId, userId)
      if (Number(userId) === Number(meRef.current?.id)) {
        dispatch({ type: 'DELETE_CONVERSATION', convId })
        if (activeRef.current === convId) dispatch({ type: 'SET_ACTIVE', convId: null })
      } else {
        await refresh()
      }
    },
    [refresh]
  )

  const setGroupRole = useCallback(async (convId, userId, role) => {
    const out = await api.setGroupRole(convId, userId, role)
    dispatch({ type: 'GROUP_ROLE', convId, userId, role: out.role || role, meId: meRef.current?.id })
    return out
  }, [])

  const leaveGroup = useCallback(
    (convId) => removeGroupMember(convId, meRef.current?.id),
    [removeGroupMember]
  )

  /** 我能不能管这个群（群主 / 管理员）。私聊永远 false —— 私聊没有「管理」这回事 */
  const canManageGroup = useCallback(
    (convId) => {
      const c = state.conversations.find((x) => x.id === convId)
      if (!c || c.type !== 'group') return false
      return c.myRole === 'owner' || c.myRole === 'admin'
    },
    [state.conversations]
  )

  /**
   * 投票详情以 `state.polls` 为准回写 ref。
   *
   * ref 只是为了让回调**同步**读到最新值；真源始终是 state。
   * 不回写的话，凡是「别人推来的更新」（poll.updated 走 dispatch 的同时我也写了 ref，
   * 但将来任何只 dispatch 的路径）就会让乐观更新基于一份旧数据算 ——
   * 表现是票数偶尔差 1。回写便宜，能把这个类别的 bug 一次关掉。
   */
  useEffect(() => {
    pollCacheRef.current = state.polls
  }, [state.polls])

  const value = useMemo(
    () => ({
      me: user,
      connected,
      loading,
      error,
      conversations: state.conversations,
      typing: state.typing,
      presence: state.presence,
      readCursors: state.readCursors,
      activeConvId: state.activeConvId,
      messagesOf: (convId) => state.messages[convId],
      hasMoreOf: (convId) => state.hasMore[convId],
      /** pollId -> 投票详情（可能还没拉到，调用方要容忍 undefined） */
      polls: state.polls,
      pollsOf: (pollId) => state.polls[Number(pollId)],
      pollsLoadingOf: (pollId) => !!state.pollsLoading[Number(pollId)],
      loadPolls,
      loadConversationPolls,
      sendPollMessage,
      votePoll,
      closePoll,
      refresh,
      loadMessages,
      openConversation,
      closeConversation,
      sendMessage,
      revokeMessage,
      notifyTyping,
      createPrivateChat,
      createGroupChat,
      togglePin,
      toggleMute,
      toggleUnread: (convId) => dispatch({ type: 'TOGGLE_UNREAD', convId }),
      deleteConversation,
      loadGroupMembers,
      updateGroup,
      addGroupMembers,
      removeGroupMember,
      setGroupRole,
      leaveGroup,
      canManageGroup,
    }),
    [
      user,
      connected,
      loading,
      error,
      state.conversations,
      state.typing,
      state.presence,
      state.readCursors,
      state.activeConvId,
      state.messages,
      state.hasMore,
      state.polls,
      state.pollsLoading,
      refresh,
      loadMessages,
      openConversation,
      closeConversation,
      sendMessage,
      revokeMessage,
      notifyTyping,
      loadPolls,
      loadConversationPolls,
      sendPollMessage,
      votePoll,
      closePoll,
      createPrivateChat,
      createGroupChat,
      togglePin,
      toggleMute,
      deleteConversation,
      loadGroupMembers,
      updateGroup,
      addGroupMembers,
      removeGroupMember,
      setGroupRole,
      leaveGroup,
      canManageGroup,
    ]
  )

  return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>
}

export function useChat() {
  const ctx = useContext(ChatCtx)
  if (!ctx) throw new Error('useChat must be used within ChatProvider')
  return ctx
}

export { avatarOf }
