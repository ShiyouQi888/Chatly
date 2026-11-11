/**
 * 社群 Tab —— 群聊的聚合视图
 *
 * 这一页取代了原来的「发现」页。发现页做的是推荐用户 / 附近的人 / 活动报名 /
 * 热门话题 / 兴趣标签 —— 那是把聊天软件往内容社区推。
 * 社群只做一件事：**找群、加群、进群**，全部落在真实的 `conversations` 表上。
 *
 * 两块内容各有唯一数据源，不重复查：
 *   - 我加入的群 → 会话列表（`useChat().conversations`），本来就带未读数和头像
 *   - 可加入的群 → `GET /communities`，只返回 `discoverable = 1` 且我不在里面的群
 *
 * ⚠️ 不在这里编「1.2 万人已加入」这类数字：成员数是 `conversation_members` 的真实计数，
 *    群不存在就显示「暂无公开群」，绝不拿假卡片撑版面。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client.js'
import { useApp } from '../store/AppContext.jsx'
import { useChat, avatarOf } from '../store/ChatStore.jsx'
import { Avatar, Badge, Empty } from '../components/ui.jsx'
import { IconCommunity, IconPlus, IconSearch } from '../components/Icon.jsx'
import './community-tab.css'

const norm = (v) => String(v || '').toLocaleLowerCase('zh-CN')

function GroupRow({ chat, onOpen }) {
  const unread = chat.muted ? 0 : chat.unread || 0
  return (
    <button type="button" className="cm-row" data-id={chat.id} onClick={onOpen}>
      <span className="cm-avatar">
        <Avatar src={chat.src} name={chat.name} size={48} radius={16} />
        {unread > 0 && <Badge count={unread} />}
      </span>
      <span className="cm-row-text">
        <b>{chat.name}</b>
        <small>{chat.memberCount ? `${chat.memberCount} 位成员` : '群聊'}</small>
      </span>
      {chat.pinned && <span className="cm-pin">已置顶</span>}
    </button>
  )
}

function PublicGroupCard({ group, busy, onJoin }) {
  const src = avatarOf({ avatar: group.avatar, nickname: group.title, id: group.id })
  return (
    <div className="cm-card" data-id={group.id}>
      <Avatar src={src} name={group.title} size={46} radius={15} />
      <div className="cm-card-text">
        <b>{group.title}</b>
        <small>
          {group.memberCount} 位成员
          {group.ownerNickname ? ` · 群主 ${group.ownerNickname}` : ''}
        </small>
      </div>
      <button type="button" className="cm-join" disabled={busy} onClick={onJoin} aria-label={`加入 ${group.title}`}>
        <IconPlus size={15} />
        {busy ? '加入中' : '加入'}
      </button>
    </div>
  )
}

export default function CommunityTab({ nav }) {
  const { showToast } = useApp()
  const { conversations, refresh } = useChat()
  const [publicGroups, setPublicGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [joining, setJoining] = useState(null)

  const loadPublicGroups = async () => {
    setError('')
    setLoading(true)
    try {
      const result = await api.communities({ limit: 50 })
      setPublicGroups(result.groups || [])
    } catch (e) {
      setError(e.message || '社群列表加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadPublicGroups()
  }, [])

  const key = norm(query.trim())

  const myGroups = useMemo(
    () =>
      conversations
        .filter((c) => c.type === 'group' && (!key || norm(c.name).includes(key)))
        /* 置顶 > 未读 > 最近活跃。这是「群的主页」，排序要和聊天列表一致，
           否则同一个群在两页的位置不同，用户会觉得列表在乱跳。 */
        .sort(
          (a, b) =>
            (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
            (b.unread || 0) - (a.unread || 0) ||
            (b.updatedAt || 0) - (a.updatedAt || 0)
        ),
    [conversations, key]
  )

  const joinable = useMemo(
    () => publicGroups.filter((g) => !key || norm(g.title).includes(key)),
    [publicGroups, key]
  )

  const join = async (group) => {
    setJoining(group.id)
    try {
      const result = await api.joinCommunity(group.id)
      setPublicGroups((list) => list.filter((g) => g.id !== group.id))
      await refresh()
      showToast(`已加入「${group.title}」`)
      nav.openChat({ id: result.conversationId || group.id })
    } catch (e) {
      showToast(e.message || '加入失败')
      /* 失败时重新拉一次：可能群刚被设为不公开，留着卡片会让人反复点，一直失败 */
      void loadPublicGroups()
    } finally {
      setJoining(null)
    }
  }

  return (
    <div className="tabpane community-tab">
      <header className="cm-head">
        <h1>社群</h1>
        <span className="cm-count">{myGroups.length} 个群</span>
      </header>

      <div className="cm-scroll no-scrollbar">
        <label className="cm-search">
          <IconSearch size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索群聊" />
        </label>

        {myGroups.length > 0 && (
          <section className="cm-section">
            <div className="cm-section-head">
              <span>我的群聊</span>
              <small>{myGroups.length}</small>
            </div>
            <div className="cm-list">
              {myGroups.map((chat) => (
                <GroupRow key={chat.id} chat={chat} onOpen={() => nav.openChat({ id: chat.id })} />
              ))}
            </div>
          </section>
        )}

        {/* 一个群都没有时不要整块消失 —— 那会让页面看起来只有「加群」半屏，
            用户不知道「我的群」这块本来就该在这儿。 */}
        {myGroups.length === 0 && !loading && !key && (
          <section className="cm-section">
            <div className="cm-section-head"><span>我的群聊</span></div>
            <Empty
              icon={<IconCommunity size={26} />}
              title="还没有加入任何群"
              desc="在通讯录里「发起群聊」，或从下面加入一个公开群"
            />
          </section>
        )}

        <section className="cm-section">
          <div className="cm-section-head">
            <span>可加入的群</span>
            {!loading && !error && <small>{joinable.length}</small>}
          </div>

          {loading && <p className="cm-state">正在加载社群…</p>}
          {error && (
            <div className="cm-state is-error">
              <span>{error}</span>
              <button type="button" onClick={loadPublicGroups}>重试</button>
            </div>
          )}

          {!loading && !error && joinable.length > 0 && (
            <div className="cm-cards">
              {joinable.map((group) => (
                <PublicGroupCard
                  key={group.id}
                  group={group}
                  busy={joining === group.id}
                  onJoin={() => join(group)}
                />
              ))}
            </div>
          )}

          {!loading && !error && joinable.length === 0 && (
            <Empty
              icon={<IconCommunity size={27} />}
              title={key ? '没有找到群聊' : '暂无公开群'}
              desc={key ? '试试其他关键词' : '群主在群设置里开启「公开群」后，会出现在这里'}
            />
          )}
        </section>

        <p className="cm-foot">社群是群的主页：在这里找群、加群、进群；消息在「聊天」里看。</p>
      </div>
    </div>
  )
}
