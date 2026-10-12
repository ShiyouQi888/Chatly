/**
 * 全局状态：Tab 切换、会话、消息、动态、导航
 */
import React, { createContext, useContext, useMemo, useReducer, useCallback, useState } from 'react'
import { CHATS, MESSAGES, MY_STATUS, NOTICES } from '../data/mock.js'

const AppCtx = createContext(null)

const initial = {
  tab: 'chat',
  chats: CHATS,
  messages: MESSAGES,
  /* 动态不在这里 —— 它是真实落库的内容，由 MomentStore 单独管。
     原型动态（MOMENTS）已经删掉：动态接了后端之后，
     那份数据只会让「搜索 / 我的动态」搜出一堆不存在的东西。 */
  status: MY_STATUS,
  notices: NOTICES,
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_TAB':
      return { ...state, tab: action.tab }

    case 'SEND_MESSAGE': {
      const { chatId, message } = action
      const list = state.messages[chatId] || []
      const chats = state.chats.map((c) =>
        c.id === chatId
          ? { ...c, preview: message.kind === 'text' ? message.text.replace(/\n/g, ' ') : '[文件]', time: nowHM(), draft: false }
          : c
      )
      return { ...state, messages: { ...state.messages, [chatId]: [...list, message] }, chats }
    }

    case 'MARK_READ': {
      const chats = state.chats.map((c) => (c.id === action.chatId ? { ...c, unread: 0 } : c))
      return { ...state, chats }
    }

    case 'MARK_MSG_READ': {
      const list = state.messages[action.chatId] || []
      return {
        ...state,
        messages: {
          ...state.messages,
          [action.chatId]: list.map((m) => (m.from === 'me' ? { ...m, read: true } : m)),
        },
      }
    }

    case 'MARK_ALL_READ':
      return { ...state, chats: state.chats.map((c) => ({ ...c, unread: 0 })) }

    case 'TOGGLE_PIN': {
      const chats = state.chats.map((c) => (c.id === action.chatId ? { ...c, pinned: !c.pinned } : c))
      return { ...state, chats: sortChats(chats) }
    }

    case 'TOGGLE_MUTE': {
      const chats = state.chats.map((c) => (c.id === action.chatId ? { ...c, muted: !c.muted } : c))
      return { ...state, chats }
    }

    case 'TOGGLE_UNREAD': {
      const chats = state.chats.map((c) =>
        c.id === action.chatId ? { ...c, unread: c.unread > 0 ? 0 : 1 } : c
      )
      return { ...state, chats }
    }

    case 'DELETE_CHAT':
      return { ...state, chats: state.chats.filter((c) => c.id !== action.chatId) }

    case 'SET_STATUS':
      return { ...state, status: action.status }

    case 'READ_NOTICES': {
      const notices = state.notices.map((n) => (n.tab === action.tab || !action.tab ? { ...n, unread: false } : n))
      return { ...state, notices }
    }

    case 'INSERT_MESSAGE_AT': {
      const list = state.messages[action.chatId] || []
      const next = [...list]
      next.splice(action.index, 0, action.message)
      return { ...state, messages: { ...state.messages, [action.chatId]: next } }
    }

    case 'REMOVE_MESSAGE': {
      const list = state.messages[action.chatId] || []
      return {
        ...state,
        messages: { ...state.messages, [action.chatId]: list.filter((m) => m.id !== action.messageId) },
      }
    }

    default:
      return state
  }
}

function nowHM() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 置顶会话排最前，其余保持原始相对顺序 */
function sortChats(list) {
  const pinned = list.filter((c) => c.pinned)
  const rest = list.filter((c) => !c.pinned)
  return [...pinned, ...rest]
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initial)
  const [toast, setToast] = useState('')

  const showToast = useCallback((text) => {
    setToast(text)
    window.clearTimeout(showToast._t)
    showToast._t = window.setTimeout(() => setToast(''), 1600)
  }, [])

  const unreadTotal = useMemo(
    () => state.chats.reduce((n, c) => n + (c.muted ? 0 : c.unread || 0), 0),
    [state.chats]
  )

  const noticeUnread = useMemo(() => state.notices.filter((n) => n.unread).length, [state.notices])

  const value = useMemo(
    () => ({ ...state, dispatch, toast, showToast, unreadTotal, noticeUnread }),
    [state, toast, showToast, unreadTotal, noticeUnread]
  )

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>
}

export function useApp() {
  const ctx = useContext(AppCtx)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
