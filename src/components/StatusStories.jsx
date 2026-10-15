import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client.js'
import { useApp } from '../store/AppContext.jsx'
import { avatarOf } from '../store/ChatStore.jsx'
import { useAuth } from '../store/AuthContext.jsx'
import { Avatar } from './ui.jsx'
import { IconClose, IconPlus, IconTrash } from './Icon.jsx'
import './status-stories.css'

const MOODS = ['✨', '☀️', '☕', '🎧', '💼', '🏖️', '🌙', '😊', '🏃', '📚', '🍜']

function timeLeft(expiresAt) {
  const hours = Math.max(1, Math.ceil((Number(expiresAt) - Date.now()) / 3_600_000))
  return `${hours} 小时后过期`
}

export default function StatusStories({ composeRequest = 0 }) {
  const { user } = useAuth()
  const { showToast } = useApp()
  const [statuses, setStatuses] = useState([])
  const [loading, setLoading] = useState(true)
  const [composerOpen, setComposerOpen] = useState(false)
  const [viewing, setViewing] = useState(null)
  const [content, setContent] = useState('')
  const [mood, setMood] = useState('✨')
  const [busy, setBusy] = useState(false)

  const load = async (quiet = false) => {
    try {
      const result = await api.statuses()
      setStatuses(result.statuses || [])
    } catch (error) {
      if (!quiet) showToast(error.message || '状态加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const timer = setInterval(() => load(true), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (composeRequest) setComposerOpen(true)
  }, [composeRequest])

  const ownStatus = useMemo(() => statuses.find((s) => Number(s.userId) === Number(user?.id)), [statuses, user?.id])
  const friendStatuses = useMemo(() => statuses.filter((s) => Number(s.userId) !== Number(user?.id)), [statuses, user?.id])

  const openStatus = async (status) => {
    setViewing(status)
    if (Number(status.userId) === Number(user?.id) || status.viewed) return
    try {
      await api.viewStatus(status.id)
      setStatuses((items) => items.map((item) => item.id === status.id ? { ...item, viewed: true } : item))
      setViewing((item) => item?.id === status.id ? { ...item, viewed: true } : item)
    } catch (error) {
      showToast(error.message || '状态已过期')
      setViewing(null)
      load()
    }
  }

  const publish = async (event) => {
    event.preventDefault()
    if (!content.trim()) return showToast('写一句状态再发布吧')
    setBusy(true)
    try {
      const result = await api.createStatus({ content: content.trim(), mood })
      setStatuses(result.statuses || [])
      setContent('')
      setMood('✨')
      setComposerOpen(false)
      showToast('状态已发布，24 小时后自动消失')
    } catch (error) {
      showToast(error.message || '发布状态失败')
    } finally {
      setBusy(false)
    }
  }

  const removeOwnStatus = async () => {
    if (!ownStatus) return
    setBusy(true)
    try {
      await api.deleteStatus(ownStatus.id)
      setStatuses((items) => items.filter((item) => item.id !== ownStatus.id))
      setViewing(null)
      showToast('状态已删除')
    } catch (error) {
      showToast(error.message || '删除状态失败')
    } finally {
      setBusy(false)
    }
  }

  return <>
    <div className="status-strip no-scrollbar">
      <div className="status-card status-card--self">
        <button type="button" className="status-avatar-button" onClick={() => ownStatus ? openStatus(ownStatus) : setComposerOpen(true)} aria-label={ownStatus ? '查看我的状态' : '发布状态'}>
          <span className={`status-avatar-ring ${ownStatus ? 'has-status' : 'is-empty'}`}><Avatar src={avatarOf(user)} name={user?.nickname} size={54} radius={18} /></span>
        </button>
        <button type="button" className="status-add" onClick={() => setComposerOpen(true)} aria-label="发布状态"><IconPlus size={13} sw={2.7} /></button>
        <button type="button" className="status-label" onClick={() => ownStatus ? openStatus(ownStatus) : setComposerOpen(true)}>
          <b>{ownStatus ? ownStatus.content : '我的状态'}</b>
          {!ownStatus && <small>分享此刻</small>}
        </button>
      </div>

      {friendStatuses.map((status) => <button type="button" className="status-card" key={status.id} onClick={() => openStatus(status)}>
        <span className={`status-avatar-ring ${status.viewed ? 'is-seen' : 'has-status'}`}><Avatar src={avatarOf(status.user)} name={status.user.nickname} size={54} radius={18} /></span>
        <span className="status-label"><b>{status.content}</b><small>{status.user.nickname || status.user.username}</small></span>
      </button>)}
      {!loading && !friendStatuses.length && !ownStatus && <span className="status-empty-hint">发布状态，让朋友知道你此刻的心情</span>}
    </div>

    {composerOpen && <div className="status-overlay">
      <button type="button" className="status-overlay-mask" aria-label="关闭状态编辑器" onClick={() => setComposerOpen(false)} />
      <form className="status-composer" onSubmit={publish}>
        <header><button type="button" onClick={() => setComposerOpen(false)} aria-label="关闭"><IconClose size={20} /></button><b>发布状态</b><button type="submit" disabled={busy || !content.trim()}>{busy ? '发布中…' : '发布'}</button></header>
        <label className="status-editor">
          <textarea value={content} onChange={(e) => setContent(e.target.value.slice(0, 140))} maxLength={140} placeholder="此刻的你正在做什么？" autoFocus />
          <span>{content.length}/140</span>
        </label>
        <p className="status-mood-title">选一个心情</p>
        <div className="status-moods">{MOODS.map((item) => <button type="button" key={item} className={mood === item ? 'is-selected' : ''} onClick={() => setMood(item)}>{item}</button>)}</div>
        <p className="status-expiry-note">状态仅对互相关注的好友可见，24 小时后自动删除。</p>
      </form>
    </div>}

    {viewing && <div className="status-overlay status-viewer-overlay">
      <button type="button" className="status-overlay-mask" aria-label="关闭状态" onClick={() => setViewing(null)} />
      <article className="status-viewer">
        <header><Avatar src={avatarOf(viewing.user)} name={viewing.user.nickname} size={38} radius={13} /><span><b>{Number(viewing.userId) === Number(user?.id) ? '我的状态' : viewing.user.nickname}</b><small>{timeLeft(viewing.expiresAt)}</small></span><button type="button" aria-label="关闭" onClick={() => setViewing(null)}><IconClose size={21} /></button></header>
        <div className="status-viewer-content"><span>{viewing.mood}</span><p>{viewing.content}</p></div>
        {Number(viewing.userId) === Number(user?.id) ? <section className="status-viewers">
          <div className="status-viewers-title">浏览了此状态 · {viewing.viewCount || 0}</div>
          {viewing.viewers?.length ? viewing.viewers.map((entry) => <div className="status-viewer-person" key={entry.user.id}><Avatar src={avatarOf(entry.user)} name={entry.user.nickname} size={30} radius={10} /><span>{entry.user.nickname || entry.user.username}</span></div>) : <p>还没有人看过</p>}
          <button type="button" className="status-delete" disabled={busy} onClick={removeOwnStatus}><IconTrash size={16} />删除状态</button>
        </section> : <p className="status-viewer-foot">仅互相关注的好友可见</p>}
      </article>
    </div>}
  </>
}
