import React, { useState, useMemo, useEffect, useRef } from 'react'
import { api } from '../api/client.js'
import { useApp } from '../store/AppContext.jsx'
import { useAuth } from '../store/AuthContext.jsx'
import { avatarOf, useChat } from '../store/ChatStore.jsx'
import { shapeMoment } from '../store/MomentStore.jsx'
import { HOT_SEARCH } from '../data/mock.js'
import { Avatar, Chip, Empty } from '../components/ui.jsx'
import MomentDetail from './MomentDetail.jsx'
import { isVideoItem } from '../components/MomentMedia.jsx'
import { IconSearch, IconBack, IconClose, IconFire, IconUser, IconChat } from '../components/Icon.jsx'
import './search-panel.css'

/* 只保留真的能搜到的类别；图片 / 文件检索需要遍历各会话消息，暂未接入 */
const FILTERS = ['全部', '联系人', '聊天', '动态']

/* 搜索索引：会话和动态都来自真实后端（动态以前用的是原型数据，
   那些内容早就不存在了 —— 搜出来点开是空的就是这么来的） */
function buildIndex(chats, moments) {
  const idx = []
  chats.forEach((c) =>
    idx.push({
      kind: c.type === 'group' ? '聊天' : '联系人',
      title: c.name,
      sub: c.preview,
      src: c.src,
      raw: c,
    })
  )
  moments.forEach((m) => {
    const text = (m.content || '').replace(/\n/g, ' ').trim()
    idx.push({
      kind: '动态',
      title: m.authorName || '',
      sub:
        text.slice(0, 30) ||
        /* 视频动态说「视频」，图文说「图片」 —— 一律写「图片」的话，
           搜到一条视频动态会显示「[1 张图片]」，点开却是个播放器 */
        (m.media?.length
          ? `[${m.media.some(isVideoItem) ? '视频' : `${m.media.length} 张图片`}]`
          : ''),
      src: m.src,
      raw: m,
    })
  })
  return idx
}

const KIND_ICON = {
  联系人: <IconUser size={16} />,
  聊天: <IconChat size={16} />,
  动态: <IconFire size={16} />,
}

export default function SearchPanel({ onBack, nav }) {
  const { showToast } = useApp()
  const { user } = useAuth()
  const { conversations } = useChat()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('全部')
  const [history, setHistory] = useState(['林小夏', '设计部', '摸鱼小分队', '陈宇'])
  const [moments, setMoments] = useState([])
  const [detail, setDetail] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /* 搜索覆盖「我所有看得见的动态」：scope=friends 已经包含公开的、
     互关好友「仅好友」的，以及我自己的（含仅自己可见），正好是索引该有的范围。 */
  useEffect(() => {
    let alive = true
    api
      .moments({ scope: 'friends', limit: 50 })
      .then((d) => alive && setMoments((d.moments || []).map((m) => shapeMoment(m, user?.id))))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [user])

  const index = useMemo(() => buildIndex(conversations, moments), [conversations, moments])

  const results = useMemo(() => {
    const key = q.trim().toLowerCase()
    if (!key) return []
    return index.filter(
      (it) =>
        (filter === '全部' || it.kind === filter) &&
        (it.title.toLowerCase().includes(key) || (it.sub || '').toLowerCase().includes(key))
    )
  }, [q, filter, index])

  const grouped = useMemo(() => {
    if (filter !== '全部' || !q.trim()) return null
    const map = {}
    results.forEach((r) => {
      ;(map[r.kind] = map[r.kind] || []).push(r)
    })
    return map
  }, [results, filter, q])

  return (
    <div className="search-panel">
      <header className="sp-head">
        <button type="button" className="sub-back" onClick={onBack}>
          <IconBack size={21} />
        </button>
        <div className="sp-field">
          <IconSearch size={16} />
          <input
            ref={inputRef}
            value={q}
            placeholder="搜索联系人或群聊"
            onChange={(e) => setQ(e.target.value)}
          />
          {q && (
            <button type="button" className="sp-clear" onClick={() => setQ('')}>
              <IconClose size={15} />
            </button>
          )}
        </div>
      </header>

      {q.trim() ? (
        <>
          <div className="sp-filters">
            {FILTERS.map((f) => (
              <Chip key={f} size="sm" active={filter === f} onClick={() => setFilter(f)}>
                {f}
              </Chip>
            ))}
          </div>

          <div className="sp-scroll no-scrollbar">
            {results.length === 0 ? (
              <Empty icon={<IconSearch size={26} />} title="没有找到相关内容" desc={`换个关键词试试，或清除「${filter}」筛选`} />
            ) : grouped ? (
              Object.entries(grouped).map(([kind, items]) => (
                <section key={kind} className="sp-group">
                  <h4 className="group-title">
                    {kind} · {items.length}
                  </h4>
                  <div className="group-card">
                    {items.map((it, i) => (
                      <SearchRow key={i} it={it} last={i === items.length - 1} onPick={nav.openChat} onOpenMoment={setDetail} />
                    ))}
                  </div>
                </section>
              ))
            ) : (
              <div className="sp-group">
                <div className="group-card">
                  {results.map((it, i) => (
                    <SearchRow key={i} it={it} last={i === results.length - 1} onPick={nav.openChat} onOpenMoment={setDetail} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="sp-scroll no-scrollbar">
          <section className="sp-block">
            <h4 className="group-title">搜索历史</h4>
            <div className="sp-chips">
              {history.map((h) => (
                <Chip key={h} size="sm" onClick={() => setQ(h)}>
                  {h}
                </Chip>
              ))}
              {history.length > 0 && (
                <button
                  type="button"
                  className="sp-clear-hist"
                  onClick={() => {
                    setHistory([])
                    showToast('已清除搜索历史')
                  }}
                >
                  清除
                </button>
              )}
            </div>
            {history.length === 0 && <p className="sp-empty-hist">暂无搜索历史</p>}
          </section>

          <section className="sp-block">
            <h4 className="group-title">热门搜索</h4>
            <div className="sp-hot">
              {HOT_SEARCH.map((h, i) => (
                <button key={h} type="button" className="sp-hot-row" onClick={() => setQ(h)}>
                  <span className={`hot-rank ${i < 3 ? 'is-top' : ''}`}>{i + 1}</span>
                  <span>{h}</span>
                  <IconFire size={13} />
                </button>
              ))}
            </div>
          </section>

          <p className="chat-foot">可搜索：联系人 · 群聊 · 动态</p>
        </div>
      )}

      {/* 搜索面板本来就挂在 .phone-screen 那一层（导航栏已被卸掉），
          所以详情页的 inset:0 会盖满整块屏幕，不需要 cover-tabbar。 */}
      {detail && <MomentDetail moment={detail} onBack={() => setDetail(null)} />}
    </div>
  )
}

function SearchRow({ it, last, onPick, onOpenMoment }) {
  return (
    <button
      type="button"
      className={`sp-row ${last ? 'is-last' : ''}`}
      /* 三种结果都有真实去处：会话进聊天，动态进详情。
         以前动态那支只弹一句「打开：xxx」—— 那就是个假动作。 */
      onClick={() => {
        if (it.kind === '动态') onOpenMoment?.(it.raw)
        else onPick?.(it.raw)
      }}
    >
      {it.src ? (
        <Avatar src={it.src} name={it.title} size={40} radius={13} />
      ) : (
        <span className="sp-kind-ic">{KIND_ICON[it.kind] || <IconSearch size={16} />}</span>
      )}
      <span className="sp-row-body">
        <b>{it.title}</b>
        <em>
          <i className="sp-kind">{it.kind}</i>
          {it.sub}
        </em>
      </span>
    </button>
  )
}
