/**
 * 通话记录页（「我 → 通话记录」）
 *
 * 数据来自 `GET /api/v1/calls`：只有元数据，没有录音、没有媒体地址。
 * 每一条都能点回拨，媒体类型沿用那条记录自己的类型 —— 视频通话的回拨仍然是视频。
 *
 * 三种结果的口径要和聊天气泡、会话预览完全一致，所以文案统一走 `lib/call.js`，
 * 这里只负责把服务端的 state 翻成那个模块认识的值。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { api, formatRelative } from '../api/client.js'
import { useVoiceCall } from '../store/VoiceCallStore.jsx'
import { useApp } from '../store/AppContext.jsx'
import { Avatar, Empty } from '../components/ui.jsx'
import { avatarOf } from '../store/ChatStore.jsx'
import { IconCallIn, IconCallOut, IconPhone, IconVideo } from '../components/Icon.jsx'
import { callMediaLabel, callText } from '../lib/call.js'
import './call-history.css'

/** 服务端的声明的 state → 文案模块认识的 callState */
const STATE_MAP = { ended: 'ended', rejected: 'declined', cancelled: 'cancelled', expired: 'missed' }

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'missed', label: '未接' },
]

function isMissed(c) {
  return c.direction === 'incoming' && STATE_MAP[c.state] === 'missed'
}

export default function CallHistoryPage() {
  const { showToast } = useApp()
  const { call, startCall } = useVoiceCall()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [more, setMore] = useState(false)
  const [nextBefore, setNextBefore] = useState(null)
  const [filter, setFilter] = useState('all')
  const [busyId, setBusyId] = useState(null)

  const load = async (before = 0) => {
    if (before) setMore(true)
    else setLoading(true)
    setError('')
    try {
      const data = await api.voiceCalls({ limit: 30, before })
      const list = data.calls || []
      setItems((old) => (before ? [...old, ...list] : list))
      setNextBefore(data.hasMore ? data.nextBefore : null)
    } catch (e) {
      setError(e.message || '通话记录加载失败')
    } finally {
      setLoading(false)
      setMore(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const shown = useMemo(
    () => (filter === 'missed' ? items.filter(isMissed) : items),
    [items, filter]
  )

  const redial = async (c) => {
    if (call.status !== 'idle') {
      showToast('当前正在通话中')
      return
    }
    setBusyId(c.callId)
    try {
      await startCall({
        conversationId: c.conversationId,
        peerId: c.peer.id,
        peerName: c.peer.nickname || c.peer.username,
        avatar: c.peer.avatar,
        media: c.media,
      })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="call-history">
      <div className="ch-filters" role="tablist" aria-label="通话记录筛选">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            className={`ch-filter ${filter === f.key ? 'is-on' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && <p className="ch-state">正在加载通话记录…</p>}
      {error && (
        <div className="ch-state is-error">
          <span>{error}</span>
          <button type="button" onClick={() => load()}>重试</button>
        </div>
      )}

      {!loading && !error && shown.length === 0 && (
        <Empty
          icon={<IconPhone size={26} />}
          title={filter === 'missed' ? '没有未接来电' : '还没有通话记录'}
          desc={filter === 'missed' ? '错过的来电会出现在这里' : '在聊天页点语音或视频按钮就能开始'}
        />
      )}

      {!loading && !error && shown.length > 0 && (
        <div className="ch-list" data-testid="call-history-list">
          {shown.map((c) => {
            const mine = c.direction === 'outgoing'
            const missed = isMissed(c)
            const text = callText({ callState: STATE_MAP[c.state] || 'ended', mine, audioDurationMs: (c.durationSec || 0) * 1000 })
            return (
              <div className={`ch-row ${missed ? 'is-missed' : ''}`} key={c.callId} data-call-id={c.callId}>
                <button
                  type="button"
                  className="ch-main"
                  onClick={() => redial(c)}
                  disabled={busyId === c.callId}
                  aria-label={`回拨 ${c.peer.nickname || c.peer.username} 的${callMediaLabel(c.media)}`}
                >
                  <span className="ch-dir" aria-hidden="true">
                    {mine ? <IconCallOut size={13} /> : <IconCallIn size={13} />}
                  </span>
                  <Avatar src={avatarOf(c.peer)} name={c.peer.nickname || c.peer.username} size={44} radius={14} />
                  <span className="ch-text">
                    <b>{c.peer.nickname || c.peer.username}</b>
                    <small>
                      {callMediaLabel(c.media)} · {text}
                    </small>
                  </span>
                  <span className="ch-time">{formatRelative(c.createdAt)}</span>
                </button>
                <button
                  type="button"
                  className="ch-redial"
                  onClick={() => redial(c)}
                  disabled={busyId === c.callId}
                  aria-label={`用${callMediaLabel(c.media)}回拨`}
                  title={`用${callMediaLabel(c.media)}回拨`}
                >
                  {c.media === 'video' ? <IconVideo size={18} /> : <IconPhone size={18} />}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {nextBefore && !loading && !error && (
        <button type="button" className="ch-more" onClick={() => load(nextBefore)} disabled={more}>
          {more ? '加载中…' : '加载更多'}
        </button>
      )}

      <p className="ch-foot">只记录通话时间与结果，不保存录音或画面。</p>
    </div>
  )
}
