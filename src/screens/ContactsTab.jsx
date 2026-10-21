import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client.js'
import { useApp } from '../store/AppContext.jsx'
import { useChat, avatarOf } from '../store/ChatStore.jsx'
import { ActionMenu, Avatar, Empty } from '../components/ui.jsx'
import UserProfile from './UserProfile.jsx'
import FriendRequestsPage from './FriendRequestsPage.jsx'
import { IconBack, IconChat, IconChevron, IconContacts, IconMore, IconPlus, IconSearch, IconScan, IconTrash, IconUser } from '../components/Icon.jsx'
import './contacts-tab.css'

function contactInitial(user) {
  const value = String(user.nickname || user.username || '?').trim()
  const ch = value[0]?.toLocaleUpperCase('zh-CN') || '#'
  return /^[A-Z]$/.test(ch) ? ch : '#'
}

export default function ContactsTab({ nav }) {
  const { showToast } = useApp()
  const { conversations, createPrivateChat, createGroupChat } = useChat()
  const [contacts, setContacts] = useState([])
  const [incomingRequestCount, setIncomingRequestCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [manage, setManage] = useState(false)
  const [selected, setSelected] = useState([])
  const [menu, setMenu] = useState(null)
  const [profileId, setProfileId] = useState(null)
  const [friendRequestsOpen, setFriendRequestsOpen] = useState(false)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [groupSheet, setGroupSheet] = useState(false)
  const [groupsExpanded, setGroupsExpanded] = useState(false)
  const [groupTitle, setGroupTitle] = useState('')
  const [groupMembers, setGroupMembers] = useState([])
  const [busy, setBusy] = useState(false)

  const loadContacts = async () => {
    setError('')
    try {
      const result = await api.contacts()
      setContacts(result.contacts || [])
    } catch (e) {
      setError(e.message || '通讯录加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    const refreshIncomingRequests = async () => {
      try {
        const result = await api.friendRequests()
        if (active) setIncomingRequestCount((result.incoming || []).length)
      } catch {
        // Keep the last known badge state if a transient request fails.
      }
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshIncomingRequests()
    }
    loadContacts()
    refreshIncomingRequests()
    const timer = window.setInterval(refreshIncomingRequests, 30000)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [])

  const refreshContactsAndRequests = () => {
    loadContacts()
    api.friendRequests()
      .then((result) => setIncomingRequestCount((result.incoming || []).length))
      .catch(() => {})
  }

  const filtered = useMemo(() => {
    const key = query.trim().toLocaleLowerCase('zh-CN')
    return [...contacts]
      .filter((u) => !key || `${u.nickname} ${u.username}`.toLocaleLowerCase('zh-CN').includes(key))
      .sort((a, b) => (a.nickname || a.username).localeCompare(b.nickname || b.username, 'zh-CN'))
  }, [contacts, query])

  const groups = useMemo(() => {
    const result = new Map()
    for (const user of filtered) {
      const key = contactInitial(user)
      if (!result.has(key)) result.set(key, [])
      result.get(key).push(user)
    }
    return [...result.entries()].sort(([a], [b]) => a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b))
  }, [filtered])

  const groupChats = useMemo(() => {
    const key = query.trim().toLocaleLowerCase('zh-CN')
    return conversations.filter((c) => c.type === 'group' && (!key || c.name.toLocaleLowerCase('zh-CN').includes(key)))
  }, [conversations, query])

  const openContact = async (user) => {
    try {
      const conversationId = await createPrivateChat(user.id)
      nav.openChat({ id: conversationId })
    } catch (e) {
      showToast(e.message || '打开聊天失败')
    }
  }

  const removeContacts = async (ids) => {
    if (!ids.length) return
    setBusy(true)
    try {
      for (const id of ids) await api.removeContact(id)
      setContacts((list) => list.filter((u) => !ids.includes(u.id)))
      setSelected([])
      setManage(false)
      setMenu(null)
      showToast(ids.length === 1 ? '已删除联系人' : `已删除 ${ids.length} 位联系人`)
    } catch (e) {
      showToast(e.message || '删除联系人失败')
      await loadContacts()
    } finally {
      setBusy(false)
    }
  }

  const openMenu = (user) => setMenu(user)
  const menuItems = menu ? [
    { label: '发消息', icon: <IconChat size={19} />, onClick: () => openContact(menu) },
    { label: '查看资料', icon: <IconUser size={19} />, onClick: () => setProfileId(menu.id) },
    { label: '删除联系人', icon: <IconTrash size={19} />, danger: true, onClick: () => removeContacts([menu.id]) },
  ] : []

  const addItems = [
    { label: '搜索添加好友', icon: <IconSearch size={19} />, onClick: nav.openSearch },
    { label: '扫一扫添加', icon: <IconScan size={19} />, onClick: nav.openScan },
    { label: '发起群聊', icon: <IconChat size={19} />, onClick: () => setGroupSheet(true) },
    { label: manage ? '退出通讯录管理' : '通讯录管理', icon: <IconContacts size={19} />, onClick: () => { setManage(!manage); setSelected([]) } },
  ]

  const toggleSelected = (id) => setSelected((items) => items.includes(id) ? items.filter((x) => x !== id) : [...items, id])

  const createGroup = async () => {
    if (!groupTitle.trim()) return showToast('请填写群名称')
    if (!groupMembers.length) return showToast('请至少选择一位联系人')
    setBusy(true)
    try {
      const conversationId = await createGroupChat(groupTitle.trim(), groupMembers)
      setGroupSheet(false)
      setGroupTitle('')
      setGroupMembers([])
      nav.openChat({ id: conversationId })
    } catch (e) {
      showToast(e.message || '创建群聊失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tabpane contacts-tab">
      <header className="contacts-head">
        <h1>通讯录</h1>
        <div className="contacts-head-actions">
          <button type="button" className="icon-btn" aria-label="搜索联系人" onClick={() => document.querySelector('.contacts-search input')?.focus()}><IconSearch size={20} /></button>
          <button type="button" className="icon-btn icon-btn--brand" aria-label="通讯录菜单" onClick={() => setShowAddMenu(true)}><IconPlus size={20} /></button>
        </div>
      </header>

      <div className="contacts-scroll no-scrollbar">
        <label className="contacts-search">
          <IconSearch size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索姓名或账号" />
        </label>

        <section className="contacts-shortcuts">
          <button type="button" className="contacts-friend-requests" onClick={() => setFriendRequestsOpen(true)}>
            <span className="contacts-shortcut-icon is-add"><IconPlus size={19} /></span>
            <b>新的朋友</b>
            <span className="contacts-shortcut-meta">好友申请与添加</span>
            {incomingRequestCount > 0 && <span className="contacts-request-alert" role="img" aria-label={`有 ${incomingRequestCount} 个待处理好友申请`}>!</span>}
          </button>
          <button type="button" onClick={() => setGroupSheet(true)}><span className="contacts-shortcut-icon is-group"><IconChat size={19} /></span><b>群聊</b><span>{groupChats.length} 个</span></button>
        </section>

        {groupChats.length > 0 && <section className="contacts-group-list">
          <button type="button" className="contacts-group-heading" aria-expanded={groupsExpanded} onClick={() => setGroupsExpanded((open) => !open)}>
            <span>群聊 <small>{groupChats.length}</small></span>
            <IconChevron size={17} className={groupsExpanded ? 'is-expanded' : ''} />
          </button>
          {groupsExpanded && groupChats.map((chat) => <button type="button" className="contacts-group-row" key={chat.id} onClick={() => nav.openChat({ id: chat.id })}>
            <Avatar src={chat.src} name={chat.name} size={42} radius={14} />
            <span><b>{chat.name}</b><small>{chat.memberCount || 0} 位成员</small></span>
          </button>)}
        </section>}

        <div className="contacts-list-head">
          <span>联系人</span>
          <button type="button" onClick={() => { setManage(!manage); setSelected([]) }}>{manage ? '完成' : '管理'}</button>
        </div>

        {loading && <p className="contacts-state">正在加载通讯录…</p>}
        {error && <div className="contacts-state is-error"><span>{error}</span><button type="button" onClick={loadContacts}>重试</button></div>}
        {!loading && !error && contacts.length === 0 && <Empty icon={<IconContacts size={27} />} title="通讯录还是空的" desc="对方同意好友申请后，会显示在这里" />}
        {!loading && !error && contacts.length > 0 && filtered.length === 0 && <Empty icon={<IconSearch size={25} />} title="没有找到联系人" desc="试试其他姓名或账号" />}

        {groups.map(([letter, users]) => (
          <section className="contact-letter-group" key={letter}>
            <h2>{letter}</h2>
            {users.map((user) => {
              const checked = selected.includes(user.id)
              return (
                <div className={`contact-row ${manage ? 'is-managing' : ''}`} key={user.id}>
                  {manage && <button type="button" className={`contact-check ${checked ? 'is-checked' : ''}`} aria-label={checked ? '取消选择' : '选择联系人'} onClick={() => toggleSelected(user.id)}>{checked ? '✓' : ''}</button>}
                  <button type="button" className="contact-main" onClick={() => manage ? toggleSelected(user.id) : openContact(user)}>
                    <Avatar src={avatarOf(user)} name={user.nickname} size={46} radius={15} online={user.online} />
                    <span className="contact-main-text"><b>{user.nickname || user.username}</b><small>@{user.username}</small></span>
                  </button>
                  {!manage && <button type="button" className="contact-more" aria-label={`${user.nickname}的菜单`} onClick={() => openMenu(user)}><IconMore size={20} /></button>}
                </div>
              )
            })}
          </section>
        ))}
        {!loading && !error && contacts.length > 0 && <p className="contacts-foot">共 {contacts.length} 位联系人</p>}
      </div>

      {manage && selected.length > 0 && <div className="contacts-manage-bar"><span>已选择 {selected.length} 位</span><button type="button" disabled={busy} onClick={() => removeContacts(selected)}><IconTrash size={17} />删除联系人</button></div>}

      <ActionMenu open={!!menu} onClose={() => setMenu(null)} title={menu?.nickname || menu?.username} items={menuItems} />
      <ActionMenu open={showAddMenu} onClose={() => setShowAddMenu(false)} title="通讯录菜单" items={addItems} />

      {friendRequestsOpen && <FriendRequestsPage
        onBack={() => setFriendRequestsOpen(false)}
        onAddFriend={() => { setFriendRequestsOpen(false); nav.openSearch() }}
        onUpdated={refreshContactsAndRequests}
      />}

      {profileId && <UserProfile userId={profileId} onBack={() => setProfileId(null)} onMessage={async () => {
        const user = contacts.find((u) => u.id === profileId)
        setProfileId(null)
        if (user) await openContact(user)
      }} />}

      {groupSheet && <div className="contacts-sheet-root">
        <button type="button" className="contacts-sheet-mask" aria-label="关闭建群面板" onClick={() => setGroupSheet(false)} />
        <section className="contacts-group-sheet">
          <header><button type="button" onClick={() => setGroupSheet(false)}><IconBack size={21} /></button><b>发起群聊</b><button type="button" disabled={busy} onClick={createGroup}>{busy ? '创建中' : '创建'}</button></header>
          <input className="contacts-group-title" value={groupTitle} onChange={(e) => setGroupTitle(e.target.value)} placeholder="输入群聊名称" maxLength={30} />
          <p>选择联系人 · 已选 {groupMembers.length} 人</p>
          <div className="contacts-group-members">{contacts.map((user) => {
            const checked = groupMembers.includes(user.id)
            return <button type="button" key={user.id} onClick={() => setGroupMembers((ids) => checked ? ids.filter((id) => id !== user.id) : [...ids, user.id])}>
              <Avatar src={avatarOf(user)} name={user.nickname} size={39} radius={13} />
              <span>{user.nickname || user.username}</span><i className={checked ? 'is-checked' : ''}>{checked ? '✓' : ''}</i>
            </button>
          })}</div>
        </section>
      </div>}
    </div>
  )
}
