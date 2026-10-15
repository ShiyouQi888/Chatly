import React, { useEffect, useMemo, useState } from 'react'
import { useNotifications, NOTICE_GROUP, noticeText } from '../store/NotificationStore.jsx'
import { avatarOf } from '../store/ChatStore.jsx'
import { useApp } from '../store/AppContext.jsx'
import { api, formatAgo } from '../api/client.js'
import { Avatar, Chip, Empty } from '../components/ui.jsx'
import MomentDetail from './MomentDetail.jsx'
import UserProfile from './UserProfile.jsx'
import { IconBack, IconBell, IconChat, IconHeart, IconInfo, IconGear, IconCheck } from '../components/Icon.jsx'
import './notice-center.css'

const TABS = ['全部', '聊天', '互动', '系统']

const TAB_ICON = {
  聊天: <IconChat size={17} />,
  互动: <IconHeart size={17} />,
  系统: <IconInfo size={17} />,
}

/**
 * 点一条通知跳到哪儿。
 *
 * 原则：**能跳就真跳，跳不了就明确说不能跳**，不给一个点了只弹 toast 的假行。
 *   · message / mention —— 跳到那条聊天消息（跨 Tab 走 nav.jumpToMessage）
 *   · like / comment   —— 跳到那条动态详情
 *   · follow           —— 打开对方资料（关注这个动作没有「内容」可跳）
 *   · group / system   —— 没有对应界面，点了标已读、给一句说明
 * 原内容可能已经被删（动态撤了、会话没了）：跳之前给一个兜底，
 * 而不是白点一下没反应。
 */
export default function NoticeCenter({ onBack, nav, onOpenSettings }) {
  const { showToast } = useApp()
  const { list, unread, loading, error, refresh, loadMore, hasMore, markRead } = useNotifications()
  const [tab, setTab] = useState('全部')
  /* 就地打开的两个覆盖层（.md-root z-index 130 / .up-root 140，都盖过 .notice 的 82）。
     不在 Phone 那层做：通知中心本身就是覆盖层，往上提一层会让状态和关闭顺序更难对齐。 */
  const [detail, setDetail] = useState(null) // 动态对象
  const [profileId, setProfileId] = useState(null)

  /* 打开这一屏就拉一次：通知可能在别的设备 / 别的页面上刚产生。
     同时立一个「正在看通知」的标记 —— NotificationStore 收到 WS 推送时读它，
     正开着这一屏就别再响铃（用户已经看见了，再叮一声是打扰）。
     卸载时必须清掉，否则关掉了还在静音。 */
  useEffect(() => {
    window.__noticeOpen = true
    refresh().catch(() => {})
    return () => {
      window.__noticeOpen = false
    }
  }, [refresh])

  const shown = useMemo(
    () => (tab === '全部' ? list : list.filter((n) => NOTICE_GROUP[n.kind] === tab)),
    [list, tab]
  )

  /** 拉那条动态。拿不到（作者删了 / 可见范围收紧了）返回 null，调用方如实说 */
  const fetchMoment = async (momentId) => {
    try {
      const { moment } = await api.moment(momentId)
      return moment || null
    } catch {
      return null
    }
  }

  const onRow = async (n) => {
    /* 先标已读：不管后面跳不跳得动，「看过了」这件事是确定的 */
    markRead([n.id]).catch(() => {})
    if (n.kind === 'message' || n.kind === 'mention') {
      if (n.conversationId && n.refId) {
        nav?.jumpToMessage?.(n.conversationId, n.refId)
        onBack()
      } else showToast('这条消息已经不在了')
      return
    }
    if (n.kind === 'like' || n.kind === 'comment') {
      if (!n.refId) return showToast('这条动态已经不在了')
      const m = await fetchMoment(n.refId)
      /* 通知里的 body 是**当时的快照**，动态本身可能已经改了或删了 ——
         以服务端此刻的为准，不能拿 body 拼一条假的详情出来。 */
      if (m) setDetail(m)
      else showToast('这条动态已经被删除了')
      return
    }
    if (n.kind === 'follow') {
      if (!n.actor?.id) return showToast('这个人已经不存在了')
      setProfileId(n.actor.id)
      return
    }
    showToast('这类通知没有可跳转的页面')
  }

  return (
    <div className="notice">
      <header className="notice-head">
        <button type="button" className="sub-back" onClick={onBack}>
          <IconBack size={21} />
        </button>
        <h2>
          通知
          {unread > 0 && <i className="notice-count">{unread > 99 ? '99+' : unread}</i>}
        </h2>
        <button
          type="button"
          className="notice-clear"
          disabled={!unread}
          aria-label="全部标为已读"
          onClick={() => {
            markRead(null)
              .then(() => showToast('已全部标记为已读'))
              .catch((e) => showToast(e.message || '操作失败'))
          }}
        >
          <IconCheck size={17} />
        </button>
      </header>

      <div className="notice-tabs">
        {TABS.map((t) => (
          <Chip key={t} active={tab === t} size="sm" onClick={() => setTab(t)}>
            {t}
          </Chip>
        ))}
      </div>

      <div className="notice-scroll no-scrollbar">
        {loading && list.length === 0 ? (
          <p className="sub-note" style={{ textAlign: 'center', marginTop: 30 }}>正在加载…</p>
        ) : error ? (
          <p className="sub-note is-warn" style={{ textAlign: 'center', marginTop: 30 }}>{error}</p>
        ) : shown.length === 0 ? (
          <Empty
            icon={<IconBell size={26} />}
            title="暂无通知"
            desc={tab === '全部' ? '有人赞你、评论你、@ 你时会出现在这里' : `「${tab}」还没有内容`}
          />
        ) : (
          <div className="notice-list">
            {shown.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`notice-row ${n.unread ? 'is-unread' : ''}`}
                onClick={() => onRow(n)}
              >
                <span className="nr-av">
                  {n.actor ? (
                    <Avatar src={avatarOf(n.actor)} name={n.actor.nickname} size={44} radius={14} />
                  ) : (
                    <span className="nr-sys">{TAB_ICON[NOTICE_GROUP[n.kind]] || TAB_ICON.系统}</span>
                  )}
                  {n.unread && <i className="nr-dot" />}
                </span>
                <span className="nr-body">
                  <span className="nr-top">
                    <b>{n.actor ? n.actor.nickname : NOTICE_GROUP[n.kind] || '系统'}</b>
                    <em>{formatAgo(n.createdAt)}</em>
                  </span>
                  <span className="nr-text">{noticeText(n)}</span>
                </span>
              </button>
            ))}
            {tab === '全部' && hasMore && (
              <button type="button" className="nf-btn" onClick={loadMore}>
                加载更多
              </button>
            )}
          </div>
        )}
        <p className="chat-foot">通知按聊天 / 互动 / 系统分类</p>
      </div>

      <div className="notice-foot">
        <button type="button" className="nf-btn" onClick={onOpenSettings}>
          <IconGear size={16} /> 通知设置
        </button>
      </div>

      {/* 就地打开的两个覆盖层（见上面 detail / profileId 的注释）。
          MomentDetail 自己会拉评论，这里只把动态对象交进去。 */}
      {detail && <MomentDetail moment={detail} onBack={() => setDetail(null)} />}
      {profileId && (
        <UserProfile userId={profileId} onBack={() => setProfileId(null)} onMessage={() => setProfileId(null)} />
      )}
    </div>
  )
}
