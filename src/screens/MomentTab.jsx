/**
 * 动态 Tab：真实内容流（读后端，不再用原型数据）
 *
 * 三个筛选各有各的语义，别混：
 *   朋友 —— 我能看到的（公开 + 互关好友的「仅好友」+ 自己的），按时间倒序
 *   我的 —— 只看自己发的，含「仅自己可见」的那几条
 *   热门 —— 我能看到的，按热度（赞 + 评论加权）排
 *
 * 点赞走乐观更新（点了立刻变，失败回滚）；删除与编辑只有自己的动态才有入口。
 */
import React, { useEffect, useState } from 'react'
import { api, formatAgo } from '../api/client.js'
import { useMoments } from '../store/MomentStore.jsx'
import { useApp } from '../store/AppContext.jsx'
import { Avatar, Chip, ActionMenu, Empty } from '../components/ui.jsx'
import MediaViewer from '../components/MediaViewer.jsx'
import MomentMedia from '../components/MomentMedia.jsx'
import {
  IconPlus,
  IconSearch,
  IconHeart,
  IconComment,
  IconMore,
  IconMusic,
  IconPlay,
  IconEdit,
  IconLocate,
  IconLock,
  IconTrash,
} from '../components/Icon.jsx'
import MomentComposer from '../components/MomentComposer.jsx'
import MomentDetail from './MomentDetail.jsx'
import './moment-tab.css'

const VIS_LABEL = { public: '', friends: '仅好友', private: '仅自己' }

/* 动态媒体项 → 查看器需要的形状。
   查看器是给聊天消息写的（字段叫 fileUrl），动态这边叫 url —— 在这里对齐，
   不要为了省一行让查看器去猜两种字段。 */
function toViewer(it) {
  return {
    id: it?.id,
    kind: it?.kind === 'video' ? 'video' : 'image',
    fileUrl: it?.url,
    fileName: it?.fileName,
    fileSize: it?.fileSize,
  }
}

/* ===== 音乐卡片 =====
   播放是未接入的 —— 不像以前那样点一下换个图标就当播了。 */
function MusicCard({ m }) {
  return (
    <div className="music-card">
      <span className="mc-cover">
        <IconMusic size={20} />
      </span>
      <span className="mc-info">
        <b>{m.title}</b>
        <em>{m.artist}</em>
      </span>
      <button type="button" className="mc-play" disabled aria-label="播放未接入">
        <IconPlay size={15} />
      </button>
      <span className="mc-dur">{m.duration || '未接入'}</span>
    </div>
  )
}

function MomentAttachment({ moment, onAction }) {
  const card = moment.card
  const [selected, setSelected] = useState(card?.myOptions || [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => setSelected(card?.myOptions || []), [card?.myOptions])
  if (!card) return null

  const act = async (type, payload) => {
    setBusy(true)
    setError('')
    try { await onAction(moment.id, type, payload) }
    catch (e) { setError(e.message || '操作失败，请重试') }
    finally { setBusy(false) }
  }

  if (card.kind === 'poll') {
    const total = Number(card.totalVotes) || 0
    const hasVoted = (card.myOptions || []).length > 0
    const toggle = (index) => setSelected((current) => {
      if (!card.data.multi) return [index]
      return current.includes(index) ? current.filter((i) => i !== index) : [...current, index]
    })
    return (
      <section className="mc-card mc-card-poll" aria-label="动态投票">
        <h3>投票 · {card.data.question}</h3>
        <div className="mc-card-poll-options">
          {card.data.options.map((option, index) => {
            const count = Number(card.counts?.[index]) || 0
            const percent = total ? Math.round(count / total * 100) : 0
            return (
              <button type="button" key={`${index}-${option}`} className={`mc-card-poll-option ${selected.includes(index) ? 'is-selected' : ''}`} onClick={() => toggle(index)} disabled={busy || hasVoted} aria-pressed={selected.includes(index)}>
                <span>{option}{card.myOptions?.includes(index) ? ' ✓' : ''}</span>
                <span>{count} 票 · {percent}%</span>
              </button>
            )
          })}
        </div>
        <div className="mc-card-poll-actions">
          <span>{total} 人参与{card.data.multi ? ' · 多选' : ' · 单选'}</span>
          <button type="button" onClick={() => act('vote', { optionIndexes: selected })} disabled={busy || !selected.length || hasVoted}>
            {busy ? '提交中…' : hasVoted ? '已投票' : '投票'}
          </button>
        </div>
        {hasVoted && <p className="mc-card-poll-locked">已投票，不能再次修改</p>}
        {error && <p role="alert">{error}</p>}
      </section>
    )
  }

  if (card.kind === 'activity') {
    const date = Number(card.data.startsAt)
    return (
      <section className="mc-card mc-card-activity" aria-label="活动">
        <h3>活动 · {card.data.title}</h3>
        <p>{Number.isFinite(date) ? new Date(date).toLocaleString('zh-CN', { hour12: false }) : '时间待定'}</p>
        {card.data.location && <p>地点：{card.data.location}</p>}
        {card.data.description && <p>{card.data.description}</p>}
        <div className="mc-card-rsvp">
          <button type="button" className={card.myStatus === 'going' ? 'is-active' : ''} onClick={() => act('rsvp', { status: card.myStatus === 'going' ? null : 'going' })} disabled={busy} aria-pressed={card.myStatus === 'going'}>
            {busy ? '处理中…' : `参加 ${card.going || 0}`}
          </button>
          <button type="button" className={card.myStatus === 'interested' ? 'is-active' : ''} onClick={() => act('rsvp', { status: card.myStatus === 'interested' ? null : 'interested' })} disabled={busy} aria-pressed={card.myStatus === 'interested'}>
            感兴趣 {card.interested || 0}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </section>
    )
  }

  if (card.kind === 'link') {
    return (
      <a className="mc-card mc-card-link" href={card.data.url} target="_blank" rel="noopener noreferrer">
        <h3>{card.data.title}</h3>
        {card.data.description && <p>{card.data.description}</p>}
        <p>{new URL(card.data.url).hostname}</p>
      </a>
    )
  }
  return null
}

/* ===== 单条动态 ===== */
function MomentCard({ m, onLike, onOpen, onEdit, onRemove, onCardAction }) {
  const { showToast } = useApp()
  const [menu, setMenu] = useState(false)

  const items = [
    ...(m.mine
      ? [
          { label: '编辑', icon: <IconEdit size={19} />, onClick: () => onEdit(m) },
          {
            label: '删除',
            icon: <IconTrash size={19} />,
            danger: true,
            onClick: () => onRemove(m),
          },
        ]
      : []),
    /* 未接入的一律禁用并写明，不做「点了弹个 toast 假装成功」 */
    { label: '分享 · 未接入', icon: null, disabled: true },
    { label: '举报 · 未接入', icon: null, disabled: true },
  ]

  return (
    <article className="mcard anim-fade-up">
      <header className="mc-head">
        <Avatar src={m.src} name={m.authorName} size={42} radius={14} />
        <div className="mc-meta">
          <b>
            {m.authorName}
            {VIS_LABEL[m.visibility] && (
              <i className="mc-vis">
                {m.visibility === 'private' && <IconLock size={10} />}
                {VIS_LABEL[m.visibility]}
              </i>
            )}
          </b>
          <em>
            {formatAgo(m.time)}
            {m.location && (
              <>
                <i>·</i>
                <IconLocate size={11} /> {m.location}
              </>
            )}
          </em>
        </div>
        <button type="button" className="mc-more" onClick={() => setMenu(true)} aria-label="更多操作">
          <IconMore size={18} />
        </button>
      </header>

      {m.topic && <span className="mc-topic">{m.topic}</span>}
      {m.content && <p className="mc-text">{m.content}</p>}

      {/* 图片走网格、视频走播放器 —— 分支在 MomentMedia 里，列表和详情共用 */}
      {m.media?.length > 0 && <MomentMedia media={m.media} prefix="mgrid" onOpen={onOpen(m)} />}
      {m.music && <MusicCard m={m.music} />}
      <MomentAttachment moment={m} onAction={onCardAction} />

      <div className="mc-acts">
        <button
          type="button"
          className={`mc-act ${m.liked ? 'is-on' : ''}`}
          onClick={() => onLike(m.id)}
          aria-pressed={m.liked}
        >
          <IconHeart size={17} sw={m.liked ? 0 : 1.8} />
          <span>{m.likeCount || '赞'}</span>
        </button>
        <button type="button" className="mc-act" onClick={() => onOpen(m)('__comments__')}>
          <IconComment size={17} />
          <span>{m.commentCount || '评论'}</span>
        </button>
        <button type="button" className="mc-act mc-act--end" onClick={() => onOpen(m)('__detail__')}>
          查看详情
        </button>
      </div>

      <ActionMenu open={menu} onClose={() => setMenu(false)} items={items} />
    </article>
  )
}

export default function MomentTab({ nav }) {
  const {
    list,
    scope,
    setScope,
    hasMore,
    loading,
    refresh,
    loadMore,
    publish,
    editMoment,
    removeMoment,
    updateMomentCard,
    toggleLike,
  } = useMoments()
  const { showToast } = useApp()

  /* 每次进入动态 Tab 都重新拉一次列表。
     动态没有 WS 推送（不像聊天），只靠登录时那一次 refresh 的话：
     停在列表上不动，别人新发的动态你永远看不到 —— 除非退出重登。
     这也是朋友圈的行为：回列表才刷新。 */
  useEffect(() => {
    refresh()
  }, [refresh])

  const [composer, setComposer] = useState(null) // null | { mode:'new' } | { mode:'edit', moment }
  const [detail, setDetail] = useState(null)
  const [viewer, setViewer] = useState(null)
  const [askRemove, setAskRemove] = useState(null)
  /* 发布面板的**初始可见范围**读「我 → 隐私设置 → 动态可见范围」。
     以前这里写死 'public'，于是那个设置项存进库之后没有任何人读它 ——
     一个「能拨、存得下、不生效」的假开关。
     读不到（没登录 / 接口失败）就用 'public'，不弹错：这只是个默认值。 */
  const [defaultVisibility, setDefaultVisibility] = useState('public')

  useEffect(() => {
    let alive = true
    api
      .getSettings()
      .then((s) => {
        if (alive && s?.moment_visibility) setDefaultVisibility(s.moment_visibility)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  /** 点图 / 评论 / 详情都走这里：返回该条动态对应的打开函数 */
  const openFor = (m) => (arg) => {
    if (arg === '__comments__' || arg === '__detail__') setDetail(m)
    else setViewer(toViewer(arg))
  }

  const onLike = (id) => toggleLike(id).catch((e) => showToast(e.message))

  const onCardAction = async (id, type, payload) => {
    const out = type === 'vote'
      ? await api.voteMomentCard(id, payload.optionIndexes)
      : await api.respondMomentActivity(id, payload.status)
    updateMomentCard(id, out.card)
  }

  const onSubmit = async (payload) => {
    if (composer?.mode === 'edit') {
      await editMoment(composer.moment.id, payload)
      showToast('动态已更新')
    } else {
      await publish(payload)
      showToast('动态已发布')
    }
  }

  return (
    <div className="tabpane">
      <header className="moment-head">
        <h1 className="ph-title">动态</h1>
        <div className="chat-head-act">
          <button type="button" className="icon-btn" onClick={nav.openSearch} aria-label="搜索">
            <IconSearch size={20} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--brand"
            onClick={() => setComposer({ mode: 'new' })}
            aria-label="发布动态"
          >
            <IconPlus size={20} sw={2.2} />
          </button>
        </div>
      </header>

      <div
        className="moment-scroll no-scrollbar"
        onScroll={(e) => {
          const el = e.currentTarget
          if (hasMore && !loading && el.scrollHeight - el.scrollTop - el.clientHeight < 240) loadMore()
        }}
      >
        <div className="moment-filters">
          {[
            ['friends', '朋友'],
            ['mine', '我的'],
            ['hot', '热门'],
          ].map(([v, label]) => (
            <Chip key={v} active={scope === v} onClick={() => setScope(v)}>
              {label}
            </Chip>
          ))}
        </div>

        {list.length === 0 && !loading ? (
          <Empty
            icon={<IconEdit size={26} />}
            title={scope === 'mine' ? '你还没有发布过动态' : '这里还没有动态'}
            desc="分享一张照片、一段心情，让朋友看到你"
          />
        ) : (
          <div className="moment-list">
            {list.map((m) => (
              <MomentCard
                key={m.id}
                m={m}
                onLike={onLike}
                onOpen={openFor}
                onEdit={(x) => setComposer({ mode: 'edit', moment: x })}
                onRemove={(x) => setAskRemove(x)}
                onCardAction={onCardAction}
              />
            ))}
          </div>
        )}

        {loading && <p className="chat-foot">加载中…</p>}
        {!loading && !hasMore && list.length > 0 && <p className="chat-foot">已显示全部动态</p>}
      </div>

      <MomentComposer
        open={!!composer}
        editing={composer?.mode === 'edit' ? composer.moment : null}
        defaultVisibility={defaultVisibility}
        onClose={() => setComposer(null)}
        onSubmit={onSubmit}
      />

      {askRemove && (
        <ActionMenu
          open
          onClose={() => setAskRemove(null)}
          title="删除这条动态？"
          items={[
            {
              label: '删除',
              icon: <IconTrash size={19} />,
              danger: true,
              onClick: async () => {
                try {
                  await removeMoment(askRemove.id)
                  showToast('动态已删除')
                } catch (e) {
                  showToast(e.message || '删除失败')
                }
              },
            },
          ]}
        />
      )}

      {detail && <MomentDetail moment={detail} onBack={() => setDetail(null)} />}

      {/* kind 跟着媒体走：之前这里硬写 image，视频动态点开会当成图片显示（一个黑框） */}
      {viewer && <MediaViewer m={viewer} onClose={() => setViewer(null)} />}
    </div>
  )
}
