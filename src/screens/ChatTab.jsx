import React, { useEffect, useMemo, useState } from 'react'
import { useApp } from '../store/AppContext.jsx'
import { useChat, avatarOf } from '../store/ChatStore.jsx'
import { useNotifications } from '../store/NotificationStore.jsx'
import { api } from '../api/client.js'
import { Avatar, Badge, ActionMenu, Empty } from '../components/ui.jsx'
import StatusStories from '../components/StatusStories.jsx'
import { useLongPress } from '../hooks/useLongPress.js'
import {
  IconSearch,
  IconPlus,
  IconScan,
  IconBell,
  IconBellOff,
  IconPin,
  IconMarkRead,
  IconTrash,
  IconUser,
  IconMoment,
  IconPlusCircle,
  IconChat,
  IconCheck,
} from '../components/Icon.jsx'
import './chat-tab.css'

/* ===== 会话行 =====
   左滑删除：关掉「聊天列表左滑删除」后，长按菜单里不再出现删除项。
   ⚠️ 不是「藏掉菜单」，是**整项拿掉** —— 留一个点了没反应的灰项更糟。 */
function ChatRow({ c, onOpen, onMenu }) {
  /* 长按 / 右键 → 会话操作菜单（置顶 / 免打扰 / 删除…）。
     ⚠️ 原来只绑 onContextMenu（桌面右键），**手机上根本触发不了** ——
     长按会走系统自己的文字选择 / 链接预览。改成 useLongPress 之后
     长按与右键共用同一个回调（见该 hook 的说明）。 */
  const longPress = useLongPress(() => onMenu(c))
  return (
    <button
      type="button"
      className="chat-row"
      onClick={() => onOpen(c)}
      {...longPress.handlers}
    >
      <span className="cr-av">
        <Avatar src={c.src} name={c.name} size={50} radius={16} online={c.online} />
      </span>

      <span className="cr-body">
        <span className="cr-top">
          <span className="cr-name">
            {c.pinned && <i className="cr-pin" />}
            {c.name}
            {c.type === 'group' && <em className="cr-members">{c.memberCount}人</em>}
          </span>
          <span className="cr-time">{c.time}</span>
        </span>

        <span className="cr-bottom">
          <span className="cr-msg">{c.preview}</span>
          <span className="cr-meta">
            {c.muted && <IconBellOff size={14} className="cr-mute" />}
            {c.unread > 0 && <Badge count={c.unread} muted={c.muted} />}
          </span>
        </span>
      </span>
    </button>
  )
}

/* ===== 搜索栏入口 ===== */
function SearchEntry({ onOpen }) {
  return (
    <button type="button" className="search-entry" onClick={onOpen}>
      <IconSearch size={17} />
      <span>搜索联系人、聊天记录、动态</span>
    </button>
  )
}

/* ===== 新建面板 ===== */
function ComposeSheet({ open, onClose, onPickGroup, onPickFriend, onPickStatus }) {
  if (!open) return null
  const items = [
    { label: '发起群聊', desc: '选择联系人建群', icon: <IconPlusCircle size={20} />, key: 'group', onClick: onPickGroup },
    { label: '发起私聊', desc: '找个人开始聊', icon: <IconChat size={20} />, key: 'private', onClick: onPickFriend },
    { label: '发布状态', desc: '分享此刻的心情', icon: <IconMoment size={20} />, key: 'status', onClick: onPickStatus },
  ]
  return (
    <div className="compose-root">
      <div className="compose-mask" onClick={onClose} />
      <div className="compose-panel anim-pop">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className="compose-item"
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return
              onClose()
              it.onClick?.()
            }}
          >
            <span className="compose-ic">{it.icon}</span>
            <span className="compose-text">
              <b>{it.label}</b>
              <em>{it.disabled ? '即将上线' : it.desc}</em>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ===== 选人面板：发起私聊 / 建群 ===== */
function NewChatSheet({ mode, onClose, onCreated }) {
  const { createPrivateChat, createGroupChat } = useChat()
  const [users, setUsers] = useState([])
  const [picked, setPicked] = useState([])
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!mode) return undefined
    let alive = true
    setErr('')
    setPicked([])
    setTitle('')
    api
      .users()
      .then(({ users: list }) => alive && setUsers(list))
      .catch((e) => alive && setErr(e.message || '加载联系人失败'))
    return () => {
      alive = false
    }
  }, [mode])

  if (!mode) return null

  const isGroup = mode === 'group'

  const toggle = (id) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  const start = async (userId) => {
    setBusy(true)
    setErr('')
    try {
      const convId = await createPrivateChat(userId)
      onCreated(convId)
      onClose()
    } catch (e) {
      setErr(e.message || '创建失败')
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    if (!title.trim()) return setErr('请填写群名称')
    if (picked.length === 0) return setErr('请至少选择一位成员')
    setBusy(true)
    setErr('')
    try {
      const convId = await createGroupChat(title.trim(), picked)
      onCreated(convId)
      onClose()
    } catch (e) {
      setErr(e.message || '创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="nc-root">
      <div className="nc-mask" onClick={onClose} />
      <div className="nc-panel anim-sheet">
        <span className="sheet-grab" />
        <header className="nc-head">
          <b>{isGroup ? '发起群聊' : '发起私聊'}</b>
          <button type="button" onClick={onClose} aria-label="关闭">
            <IconPlus size={18} sw={2.4} />
          </button>
        </header>

        {isGroup && (
          <label className="nc-title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="群名称"
              maxLength={20}
            />
          </label>
        )}

        {err && <p className="nc-err">{err}</p>}

        <div className="nc-list">
          {users.length === 0 && !err && <p className="nc-hint">暂无其他用户</p>}
          {users.map((u) => {
            const on = picked.includes(u.id)
            return (
              <button
                key={u.id}
                type="button"
                className={`nc-user ${on ? 'is-on' : ''}`}
                onClick={() => (isGroup ? toggle(u.id) : start(u.id))}
                disabled={busy}
              >
                <Avatar src={avatarOf(u)} name={u.nickname} size={40} radius={13} online={u.online} />
                <span className="nc-user-t">
                  <b>{u.nickname}</b>
                  <em>@{u.username}</em>
                </span>
                {isGroup && (
                  <span className={`nc-check ${on ? 'is-on' : ''}`}>
                    {on && <IconCheck size={13} sw={3} />}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {isGroup && (
          <button type="button" className="nc-submit" onClick={create} disabled={busy}>
            {busy ? '创建中…' : `创建群聊${picked.length ? ` · 已选 ${picked.length} 人` : ''}`}
          </button>
        )}
      </div>
    </div>
  )
}

export default function ChatTab({ nav, statusComposeSignal = 0 }) {
  const { showToast } = useApp()
  const {
    conversations,
    loading,
    error,
    togglePin,
    toggleMute,
    toggleUnread,
    deleteConversation,
  } = useChat()
  /* 互动通知的未读数（铃铛上的角标）。和会话未读是**两件事**：
     后者是「有消息没看」，前者是「有人赞你 / 评论你 / @ 你」。 */
  const { unread: notifyUnread } = useNotifications()

  const [menuChat, setMenuChat] = useState(null)
  const [compose, setCompose] = useState(false)
  const [newMode, setNewMode] = useState(null)
  const [statusComposeRequest, setStatusComposeRequest] = useState(0)

  /* 后端已按「置顶优先 + 时间倒序」返回，这里只做兜底排序 */
  const ordered = useMemo(
    () =>
      [...conversations].sort(
        (a, b) => Number(b.pinned || 0) - Number(a.pinned || 0) || (b.updatedAt || 0) - (a.updatedAt || 0)
      ),
    [conversations]
  )

  /* 「聊天列表左滑删除」关掉后，长按菜单里也不再给删除项。
     读 localStorage 而不用 state：ChatTab 和设置页是两个独立页面，
     关掉开关切回来时要**立刻**生效，不等人为刷新。 */
  const swipeDeleteEnabled = (() => {
    try {
      return localStorage.getItem('chatly-swipe-delete') !== 'false'
    } catch {
      return true
    }
  })()

  const menuItems = menuChat
    ? [
        {
          label: menuChat.pinned ? '取消置顶' : '置顶会话',
          icon: <IconPin size={20} />,
          onClick: async () => {
            await togglePin(menuChat.id)
            showToast(menuChat.pinned ? '已取消置顶' : '已置顶')
          },
        },
        {
          label: menuChat.unread > 0 ? '标记已读' : '标记未读',
          icon: <IconMarkRead size={20} />,
          onClick: () => {
            toggleUnread(menuChat.id)
            showToast(menuChat.unread > 0 ? '已标记为已读' : '已标记为未读')
          },
        },
        {
          label: menuChat.muted ? '取消免打扰' : '设置免打扰',
          icon: <IconBellOff size={20} />,
          onClick: async () => {
            await toggleMute(menuChat.id)
            showToast(menuChat.muted ? '已关闭免打扰' : '已开启免打扰')
          },
        },
        // 开关关掉时整项拿掉，不留灰按钮
        ...(swipeDeleteEnabled
          ? [
              {
                label: '删除会话',
                icon: <IconTrash size={20} />,
                danger: true,
                onClick: async () => {
                  await deleteConversation(menuChat.id)
                  showToast('会话已删除')
                },
              },
            ]
          : []),
      ]
    : []

  return (
    <div className="tabpane">
      <header className="chat-head">
        <div className="chat-head-left">
          <h1 className="brand">
            Chatly
            <i className="brand-dot" />
          </h1>
          <p className="brand-sub">连接更有趣的人</p>
        </div>
        <div className="chat-head-act">
          {/* 通知中心入口。以前它根本没有入口（nav.openNotice 定义了却没人调用），
              所以这一整块功能等于不存在。铃铛上挂互动未读数。 */}
          <button
            type="button"
            className="icon-btn"
            onClick={() => nav.openNotice?.()}
            aria-label="通知中心"
            data-testid="open-notice"
          >
            <IconBell size={20} />
            {notifyUnread > 0 && <Badge count={notifyUnread} />}
          </button>
          <button type="button" className="icon-btn" onClick={nav.openSearch} aria-label="搜索">
            <IconSearch size={20} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => nav.openScan?.()}
            aria-label="扫一扫"
            data-testid="open-scan"
          >
            <IconScan size={20} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--brand"
            onClick={() => setCompose(true)}
            aria-label="新建"
          >
            <IconPlus size={20} sw={2.2} />
          </button>
        </div>
      </header>

      <div className="chat-scroll no-scrollbar">
        <SearchEntry onOpen={nav.openSearch} />
        <StatusStories composeRequest={statusComposeRequest + statusComposeSignal} />

        <div className="chat-list">
          {ordered.map((c) => (
            <ChatRow key={c.id} c={c} onOpen={nav.openChat} onMenu={setMenuChat} />
          ))}
        </div>

        {loading && ordered.length === 0 && <p className="chat-foot">正在加载会话…</p>}
        {error && <p className="chat-foot chat-foot--err">{error}</p>}
        {!loading && !error && ordered.length === 0 && (
          <Empty title="还没有会话" desc="点右上角 + 找个人聊聊" />
        )}
        {ordered.length > 0 && <p className="chat-foot">已显示全部会话</p>}
      </div>

      {/* 会话列表的菜单是**长按**弹出来的，所以要开那道「补发 click」防御 */}
      <ActionMenu
        open={!!menuChat}
        onClose={() => setMenuChat(null)}
        title={menuChat?.name}
        items={menuItems}
        longPress
      />

      <ComposeSheet
        open={compose}
        onClose={() => setCompose(false)}
        onPickGroup={() => setNewMode('group')}
        onPickFriend={() => setNewMode('private')}
        onPickStatus={() => setStatusComposeRequest((value) => value + 1)}
      />

      <NewChatSheet
        mode={newMode}
        onClose={() => setNewMode(null)}
        onCreated={(convId) => nav.openChat({ id: convId })}
      />
    </div>
  )
}
