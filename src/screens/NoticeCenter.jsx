import React, { useMemo, useState } from 'react'
import { useApp } from '../store/AppContext.jsx'
import { Avatar, Chip, Empty } from '../components/ui.jsx'
import { IconBack, IconBell, IconChat, IconHeart, IconInfo, IconGear, IconCheck } from '../components/Icon.jsx'
import './notice-center.css'

const TABS = ['全部', '聊天', '互动', '系统']

const TAB_ICON = {
  聊天: <IconChat size={17} />,
  互动: <IconHeart size={17} />,
  系统: <IconInfo size={17} />,
}

export default function NoticeCenter({ onBack, nav }) {
  const { notices, dispatch, showToast } = useApp()
  const [tab, setTab] = useState('全部')

  const list = useMemo(() => (tab === '全部' ? notices : notices.filter((n) => n.tab === tab)), [notices, tab])
  const unread = notices.filter((n) => n.unread).length

  return (
    <div className="notice">
      <header className="notice-head">
        <button type="button" className="sub-back" onClick={onBack}>
          <IconBack size={21} />
        </button>
        <h2>
          通知
          {unread > 0 && <i className="notice-count">{unread}</i>}
        </h2>
        <button
          type="button"
          className="notice-clear"
          onClick={() => {
            dispatch({ type: 'READ_NOTICES', tab: null })
            showToast('已全部标记为已读')
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
        {list.length === 0 ? (
          <Empty icon={<IconBell size={26} />} title="暂无通知" desc="有新的互动会显示在这里" />
        ) : (
          <div className="notice-list">
            {list.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`notice-row ${n.unread ? 'is-unread' : ''}`}
                onClick={() => {
                  dispatch({ type: 'READ_NOTICES', tab: n.tab })
                  if (n.tab === '聊天') showToast('打开 ' + n.title + ' 的会话')
                  else showToast(n.title + ' · ' + n.text)
                }}
              >
                <span className="nr-av">
                  {n.src ? (
                    <Avatar src={n.src} name={n.title} size={44} radius={14} />
                  ) : (
                    <span className="nr-sys">{TAB_ICON[n.tab]}</span>
                  )}
                  {n.unread && <i className="nr-dot" />}
                </span>
                <span className="nr-body">
                  <span className="nr-top">
                    <b>{n.title}</b>
                    <em>{n.time}</em>
                  </span>
                  <span className="nr-text">{n.text}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <p className="chat-foot">通知按聊天 / 互动 / 系统分类</p>
      </div>

      <div className="notice-foot">
        <button type="button" className="nf-btn" onClick={() => showToast('通知设置 · 原型演示')}>
          <IconGear size={16} /> 通知设置
        </button>
      </div>
    </div>
  )
}
