import React, { useState, useMemo, useEffect, useRef } from 'react'
import { api } from '../api/client.js'
import { useApp } from '../store/AppContext.jsx'
import { useAuth } from '../store/AuthContext.jsx'
import { avatarOf, useChat } from '../store/ChatStore.jsx'
import { shapeMoment } from '../store/MomentStore.jsx'
import { Avatar, Chip, Empty } from '../components/ui.jsx'
import MomentDetail from './MomentDetail.jsx'
import { isVideoItem } from '../components/MomentMedia.jsx'
import { IconSearch, IconBack, IconClose, IconFire, IconUser, IconChat } from '../components/Icon.jsx'
import './search-panel.css'

/* 「找人」是**全体用户**（走后端 /users/search），消息搜索只返回本人有权访问的文本消息，
   和会话 / 动态的本地索引是独立数据源。
   所以它在结果区单独成组，并且是唯一受对方隐私开关约束的一类。 */
const FILTERS = ['全部', '找人', '联系人', '聊天', '消息', '动态']
const friendActionLabel = (status) => ({
  outgoing: '等待验证', incoming: '收到申请', friends: '已添加',
}[status] || '加好友')

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
  消息: <IconChat size={16} />,
  动态: <IconFire size={16} />,
}

/* 手机号形态的判据 —— 和后端 profile.js 的 PHONE_RE**必须一致**，
   否则会出现「看着像手机号、却按昵称搜」这种对不上的情况。 */
const PHONE_RE = /^1[3-9]\d{9}$/

export default function SearchPanel({ onBack, nav }) {
  const { showToast } = useApp()
  const { user } = useAuth()
  const { conversations, createPrivateChat } = useChat()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('全部')
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('chatly-search-history') || '[]').filter((x) => typeof x === 'string').slice(0, 8) }
    catch { return [] }
  })
  const [moments, setMoments] = useState([])
  const [messageResults, setMessageResults] = useState([])
  const [messageLoading, setMessageLoading] = useState(false)
  const [messageHasMore, setMessageHasMore] = useState(false)
  const [messageBeforeId, setMessageBeforeId] = useState(null)
  const [messageSearchNote, setMessageSearchNote] = useState('')
  const [detail, setDetail] = useState(null)
  const inputRef = useRef(null)

  /* ---- 找人（全体用户） ---- */
  const [people, setPeople] = useState([])
  const [peopleBy, setPeopleBy] = useState(null)
  const [peopleNote, setPeopleNote] = useState('')
  const [peopleLoading, setPeopleLoading] = useState(false)
  const [followBusy, setFollowBusy] = useState(null)

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

  useEffect(() => {
    const key = q.trim()
    setMessageResults([])
    setMessageHasMore(false)
    setMessageBeforeId(null)
    setMessageSearchNote('')
    setMessageLoading(false)
    if (key.length < 2 || (filter !== '全部' && filter !== '消息')) return
    let alive = true
    setMessageLoading(true)
    const timer = setTimeout(() => {
      api.searchMessages({ q: key })
        .then((result) => {
          if (!alive) return
          setMessageResults(result.messages || [])
          setMessageHasMore(!!result.hasMore)
          setMessageBeforeId(result.nextBeforeId || null)
          if (result.encryptedExcluded) setMessageSearchNote('部分加密消息暂时无法解密检索')
        })
        .catch((error) => alive && setMessageSearchNote(error.message || '消息搜索失败'))
        .finally(() => alive && setMessageLoading(false))
    }, 300)
    return () => { alive = false; clearTimeout(timer) }
  }, [q, filter])

  const rememberSearch = (value = q) => {
    const term = value.trim()
    if (!term) return
    const next = [term, ...history.filter((item) => item !== term)].slice(0, 8)
    setHistory(next)
    localStorage.setItem('chatly-search-history', JSON.stringify(next))
  }

  const loadMoreMessages = async () => {
    if (!messageHasMore || !messageBeforeId || messageLoading) return
    setMessageLoading(true)
    try {
      const result = await api.searchMessages({ q: q.trim(), beforeId: messageBeforeId })
      setMessageResults((items) => [...items, ...(result.messages || [])])
      setMessageHasMore(!!result.hasMore)
      setMessageBeforeId(result.nextBeforeId || null)
    } catch (error) {
      showToast(error.message || '加载更多消息失败')
    } finally {
      setMessageLoading(false)
    }
  }

  /* 全局「找人」。
     两个门槛，都是为了不把「打第一个字」变成一个全表模糊查询：
       · 300ms 防抖（打字过程里只在停顿时发一次）
       · 少于 2 个字符且不像手机号时不发（`like '%林%'` 命中一大片，没有意义）
     命中对方「通过搜索 / 通过手机号添加」开关的人**不会出现在结果里** ——
     那是后端过滤的，前端拿不到、也就藏不住。 */
  useEffect(() => {
    const key = q.trim()
    if (!key) {
      setPeople([])
      setPeopleBy(null)
      setPeopleNote('')
      return
    }
    const phoneLike = PHONE_RE.test(key.replace(/[\s-]/g, ''))
    if (!phoneLike && key.length < 2) {
      setPeople([])
      setPeopleBy(null)
      setPeopleNote('')
      return
    }
    let alive = true
    setPeopleLoading(true)
    const timer = setTimeout(() => {
      api
        .searchUsers(key)
        .then((d) => {
          if (!alive) return
          setPeople(Array.isArray(d.users) ? d.users : [])
          setPeopleBy(d.by || null)
          setPeopleNote(d.hint || '')
        })
        .catch(() => {
          if (!alive) return
          setPeople([])
          setPeopleBy(null)
          setPeopleNote('')
        })
        .finally(() => {
          if (alive) setPeopleLoading(false)
        })
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [q])

  /* 好友申请把搜索渠道带给服务端，服务端再校验对方的隐私开关。 */
  const toggleFollow = async (u) => {
    if ((u.friendStatus || 'none') !== 'none') return
    setFollowBusy(u.id)
    try {
      const out = await api.requestFriend(u.id, peopleBy)
      setPeople((list) => list.map((x) => (x.id === u.id ? { ...x, friendStatus: out.friendStatus || 'outgoing' } : x)))
      showToast(out.friendStatus === 'incoming' ? '对方已向你发送申请，请在通讯录中处理' : '好友申请已发送')
    } catch (e) {
      showToast(e.message || '操作失败')
    } finally {
      setFollowBusy(null)
    }
  }

  const sayTo = async (u) => {
    try {
      const convId = await createPrivateChat(u.id)
      onBack() /* 先关掉整屏的搜索面板，再开聊天室，否则两个整屏层会叠在一起 */
      nav.openChat({ id: convId })
    } catch (e) {
      showToast(e.message || '打开私聊失败')
    }
  }

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

  /* 「找人」这一组什么时候显示：有关键词，且筛选是「全部」或「找人」 */
  const showPeople = (filter === '全部' || filter === '找人') && !!q.trim()

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
            placeholder="搜索联系人、群聊、消息、动态或用户 ID / 手机号"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') rememberSearch() }}
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
            {results.length === 0 && !showPeople && messageResults.length === 0 && !messageLoading && !messageSearchNote ? (
              <Empty icon={<IconSearch size={26} />} title="没有找到相关内容" desc={`换个关键词试试，或清除「${filter}」筛选`} />
            ) : (
              <>
                {/* 「找人」放在最前：它是「全体用户」的结果，是这次搜索里唯一可能
                    出现陌生人的一组；会话 / 动态都是我已经有的东西，排在后面更好找。 */}
                {showPeople && (
                  <section className="sp-group">
                    <h4 className="group-title">
                      找人
                      {people.length ? ` · ${people.length}` : ''}
                    </h4>
                    <div className="group-card">
                      {people.map((u, i) => (
                        <PeopleRow
                          key={u.id}
                          u={u}
                          last={i === people.length - 1}
                          busy={followBusy === u.id}
                          onFollow={toggleFollow}
                          onSay={sayTo}
                        />
                      ))}
                      {people.length === 0 && (
                        <p className="sp-people-empty" data-testid="people-empty">
                          {peopleLoading ? '正在找人…' : peopleNote || '没有找到相关用户'}
                        </p>
                      )}
                    </div>
                  </section>
                )}

                {(filter === '全部' || filter === '消息') && (messageResults.length > 0 || messageLoading || messageSearchNote) && (
                  <section className="sp-group">
                    <h4 className="group-title">消息{messageResults.length ? ` · ${messageResults.length}` : ''}</h4>
                    <div className="group-card">
                      {messageResults.map((message, i) => (
                        <button
                          key={message.id}
                          type="button"
                          className={`sp-row sp-message-row ${i === messageResults.length - 1 ? 'is-last' : ''}`}
                          onClick={() => {
                            onBack()
                            nav.jumpToMessage?.(message.conversationId, message.id)
                          }}
                        >
                          <span className="sp-kind-ic"><IconChat size={16} /></span>
                          <span className="sp-row-body">
                            <b>{message.conversationTitle || '私聊'} · {message.senderName}</b>
                            <em>{message.text}</em>
                          </span>
                        </button>
                      ))}
                      {messageResults.length === 0 && messageLoading && <p className="sp-people-empty">正在搜索消息…</p>}
                      {messageSearchNote && <p className="sp-people-empty">{messageSearchNote}</p>}
                      {messageHasMore && <button type="button" className="sp-load-more" onClick={loadMoreMessages} disabled={messageLoading}>{messageLoading ? '加载中…' : '加载更早的消息'}</button>}
                    </div>
                  </section>
                )}

                {results.length > 0 &&
                  (grouped
                    ? Object.entries(grouped).map(([kind, items]) => (
                        <section key={kind} className="sp-group">
                          <h4 className="group-title">
                            {kind} · {items.length}
                          </h4>
                          <div className="group-card">
                            {items.map((it, i) => (
                              <SearchRow
                                key={i}
                                it={it}
                                last={i === items.length - 1}
                                onPick={nav.openChat}
                                onOpenMoment={setDetail}
                              />
                            ))}
                          </div>
                        </section>
                      ))
                    : (
                        <div className="sp-group">
                          <div className="group-card">
                            {results.map((it, i) => (
                              <SearchRow
                                key={i}
                                it={it}
                                last={i === results.length - 1}
                                onPick={nav.openChat}
                                onOpenMoment={setDetail}
                              />
                            ))}
                          </div>
                        </div>
                      ))}

                {/* 两类结果都空的时候才说「没有找到」—— 只判一类会在
                    「搜到人了、但没有相关会话」时错误地显示空状态。 */}
                {results.length === 0 && people.length === 0 && !peopleLoading &&
                  messageResults.length === 0 && !messageLoading && !messageSearchNote && (
                  <Empty
                    icon={<IconSearch size={26} />}
                    title="没有找到相关内容"
                    desc={`换个关键词试试，或清除「${filter}」筛选`}
                  />
                )}
              </>
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
                    localStorage.removeItem('chatly-search-history')
                    showToast('已清除搜索历史')
                  }}
                >
                  清除
                </button>
              )}
            </div>
            {history.length === 0 && <p className="sp-empty-hist">暂无搜索历史</p>}
          </section>

          <p className="chat-foot">可搜索：用户（ID / 手机号）· 联系人 · 群聊 · 文字消息 · 动态</p>
        </div>
      )}

      {/* 搜索面板本来就挂在 .phone-screen 那一层（导航栏已被卸掉），
          所以详情页的 inset:0 会盖满整块屏幕，不需要 cover-tabbar。 */}
      {detail && <MomentDetail moment={detail} onBack={() => setDetail(null)} />}
    </div>
  )
}

/**
 * 「找人」结果行。
 * 和 `SearchRow` 不同：这一行**不是**一个整块 `<button>` ——
 * 它里面还要放「关注」「发消息」两个按钮，而 button 套 button 在浏览器里
 * 会被解析器拆开（DOM 结构和 React 的预期不一致），点击区会错乱。
 * 所以外面用 `<div>`，交互由内部真正的按钮承担。
 */
function PeopleRow({ u, last, busy, onFollow, onSay }) {
  return (
    <div className={`sp-row sp-person ${last ? 'is-last' : ''}`} data-uid={u.id}>
      <Avatar src={avatarOf(u)} name={u.nickname} size={40} radius={13} online={u.online} />
      <span className="sp-row-body">
        <b>{u.nickname}</b>
        <em>
          <i className="sp-kind">@{u.username}</i>
          {u.region || u.bio || ''}
        </em>
      </span>
      {u.isSelf ? (
        <span className="sp-p-self">这是你</span>
      ) : (
        <span className="sp-p-acts">
          <button
            type="button"
            className={`sp-p-btn ${(u.friendStatus || 'none') !== 'none' ? 'is-on' : ''}`}
            disabled={busy || (u.friendStatus || 'none') !== 'none'}
            onClick={() => onFollow(u)}
            data-testid={`people-follow-${u.id}`}
          >
            {friendActionLabel(u.friendStatus)}
          </button>
          <button
            type="button"
            className="sp-p-btn sp-p-btn--ghost"
            onClick={() => onSay(u)}
            data-testid={`people-say-${u.id}`}
          >
            发消息
          </button>
        </span>
      )}
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
