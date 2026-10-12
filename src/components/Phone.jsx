import React, { useMemo, useState } from 'react'
import { useApp } from '../store/AppContext.jsx'
import { useAuth } from '../store/AuthContext.jsx'
import { useChat } from '../store/ChatStore.jsx'
import ChatTab from '../screens/ChatTab.jsx'
import MomentTab from '../screens/MomentTab.jsx'
import DiscoverTab from '../screens/DiscoverTab.jsx'
import MeTab from '../screens/MeTab.jsx'
import ChatRoom from '../screens/ChatRoom.jsx'
import NoticeCenter from '../screens/NoticeCenter.jsx'
import SearchPanel from '../screens/SearchPanel.jsx'
import ScanPage from '../screens/ScanPage.jsx'
import LoginScreen from '../screens/LoginScreen.jsx'
import { IconChat, IconMoment, IconCompass, IconUser } from './Icon.jsx'
import { Badge, Toast } from './ui.jsx'
import './phone.css'

const TABS = [
  { key: 'chat', label: '聊天', icon: IconChat },
  { key: 'moment', label: '动态', icon: IconMoment },
  { key: 'discover', label: '发现', icon: IconCompass },
  { key: 'me', label: '我', icon: IconUser },
]

/* 启动时用已存 token 换取用户信息，短暂的空档给一个品牌 loading，避免闪一下登录页 */
function Boot({ text }) {
  return (
    <div className="boot">
      <span className="boot-logo">
        <IconChat size={26} />
      </span>
      <p>{text}</p>
    </div>
  )
}

export default function Phone() {
  const { tab, dispatch, toast, noticeUnread } = useApp()
  const { user, ready, login } = useAuth()
  const { conversations } = useChat()

  const [openChatId, setOpenChatId] = useState(null)
  const [openNotice, setOpenNotice] = useState(false)
  const [openSearch, setOpenSearch] = useState(false)
  const [openScan, setOpenScan] = useState(false)
  /**
   * 「跳到聊天里某条消息」的请求：`{ conversationId, messageId, nonce }`。
   *
   * 为什么要有它：收藏在**我页**，而它要跳到**聊天页**的某个房间 —— 跨 Tab。
   * MeTab 自己切不了 Tab 又开不了房间（`openChat` 在 Phone 这一层）。
   * `nonce` 是必须的：用户可能连点两次同一条收藏，
   * 只比较 `messageId` 的话第二次值没变 → effect 不重跑 → 看着像「点了没反应」
   * （扫一扫的「重试」踩过同一个坑，见 LESSONS）。
   */
  const [jumpTo, setJumpTo] = useState(null)

  /* 未读汇总：会话行里的数字由后端算好，这里只做展示层汇总 */
  const unreadTotal = useMemo(
    () => conversations.reduce((n, c) => n + (c.muted ? 0 : c.unread || 0), 0),
    [conversations]
  )

  /* 会话对象从 store 里按 id 取，保证打开时拿到的是最新状态（预览/未读/在线） */
  const openChat = useMemo(
    () => conversations.find((c) => c.id === openChatId) || null,
    [conversations, openChatId]
  )

  if (!ready) {
    return (
      <div className="stage">
        <div className="phone">
          <div className="phone-screen">
            <Boot text="正在恢复会话…" />
          </div>
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="stage">
        <div className="phone">
          <div className="phone-screen">
            <LoginScreen onLogin={login} />
            <Toast text={toast} />
          </div>
        </div>
      </div>
    )
  }

  const nav = {
    openChat: (chat) => setOpenChatId(chat.id),
    openNotice: () => setOpenNotice(true),
    openSearch: () => setOpenSearch(true),
    openScan: () => setOpenScan(true),
    /**
     * 跨 Tab 跳转：切到聊天页 → 打开那个会话 → 滚到某条消息并高亮。
     * 收藏（在我页）的「在聊天中查看」用它。
     * 房间是由 `openChatId` 决定的，所以这里把它一并设上；
     * ChatRoom 收到 `jumpTo` 后自己负责翻页与滚动（它才知道消息加载到哪儿了）。
     */
    jumpToMessage: (conversationId, messageId) => {
      dispatch({ type: 'SET_TAB', tab: 'chat' })
      setOpenChatId(Number(conversationId))
      setJumpTo({ conversationId: Number(conversationId), messageId: Number(messageId), nonce: Date.now() })
    },
  }

  const showTabBar = !openChat && !openNotice && !openSearch && !openScan

  return (
    <div className="stage">
      <div className="phone">
        <div className="phone-screen">
          <div className="screen-body">
            {tab === 'chat' && <ChatTab nav={nav} />}
            {tab === 'moment' && <MomentTab nav={nav} />}
            {tab === 'discover' && <DiscoverTab nav={nav} />}
            {tab === 'me' && <MeTab nav={nav} />}
          </div>

          {/* 覆盖层：会话 / 通知中心 / 搜索 / 扫一扫 */}
          {openChat && (
            <ChatRoom
              chat={openChat}
              onBack={() => {
                setOpenChatId(null)
                /* 退出房间时把跳转请求也清掉：留着的话下次进同一个房间
                   会**又跳一次**（用户只是正常打开会话，却莫名滚到某条旧消息）。 */
                setJumpTo(null)
              }}
              nav={nav}
              jumpTo={jumpTo?.conversationId === openChat.id ? jumpTo : null}
              onJumped={() => setJumpTo(null)}
            />
          )}
          {openNotice && <NoticeCenter onBack={() => setOpenNotice(false)} nav={nav} />}
          {openSearch && <SearchPanel onBack={() => setOpenSearch(false)} nav={nav} />}
          {openScan && <ScanPage onBack={() => setOpenScan(false)} nav={nav} />}

          {showTabBar && (
            <nav className="tabbar">
              {TABS.map((t) => {
                const Ico = t.icon
                const active = tab === t.key
                return (
                  <button
                    key={t.key}
                    type="button"
                    className={`tab ${active ? 'is-active' : ''}`}
                    onClick={() => dispatch({ type: 'SET_TAB', tab: t.key })}
                  >
                    <span className="tab-ic">
                      <Ico size={23} sw={active ? 2.1 : 1.75} />
                      {t.key === 'chat' && unreadTotal > 0 && <Badge count={unreadTotal} />}
                    </span>
                    <span className="tab-label">{t.label}</span>
                  </button>
                )
              })}
            </nav>
          )}

          <Toast text={toast} />
        </div>
      </div>
    </div>
  )
}
