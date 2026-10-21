import React, { useCallback, useEffect, useState } from 'react'
import { api, formatAgo } from '../api/client.js'
import { avatarOf } from '../store/ChatStore.jsx'
import { Avatar, Empty } from '../components/ui.jsx'
import { IconBack, IconCheck, IconPlus, IconTrash } from '../components/Icon.jsx'
import './friend-requests.css'

export default function FriendRequestsPage({ onBack, onAddFriend, onUpdated }) {
  const [data, setData] = useState({ incoming: [], outgoing: [] })
  const [tab, setTab] = useState('incoming')
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setError('')
    try {
      setData(await api.friendRequests())
    } catch (e) {
      setError(e.message || '好友申请加载失败')
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const decide = async (requestId, decision) => {
    setBusyId(requestId)
    try {
      if (decision === 'accept') await api.acceptFriendRequest(requestId)
      else if (decision === 'reject') await api.rejectFriendRequest(requestId)
      else await api.cancelFriendRequest(requestId)
      await refresh()
      onUpdated?.()
    } catch (e) {
      setError(e.message || '操作失败，请重试')
    } finally {
      setBusyId(null)
    }
  }

  const rows = data[tab] || []
  return (
    <div className="friend-requests-root" role="dialog" aria-modal="true" aria-label="新的朋友">
      <header className="friend-requests-head">
        <button type="button" onClick={onBack} aria-label="返回"><IconBack size={21} /></button>
        <h2>新的朋友</h2>
        {onAddFriend && <button type="button" className="fr-add" onClick={onAddFriend}><IconPlus size={17} />添加</button>}
      </header>
      <div className="fr-tabs" role="tablist">
        <button type="button" className={tab === 'incoming' ? 'is-active' : ''} onClick={() => setTab('incoming')}>
          收到的申请{data.incoming.length > 0 && <i>{data.incoming.length}</i>}
        </button>
        <button type="button" className={tab === 'outgoing' ? 'is-active' : ''} onClick={() => setTab('outgoing')}>已发送</button>
      </div>
      <div className="fr-list">
        {error && <div className="fr-error"><span>{error}</span><button type="button" onClick={refresh}>重试</button></div>}
        {!error && rows.length === 0 && (
          <Empty icon={<IconCheck size={25} />} title={tab === 'incoming' ? '暂时没有好友申请' : '还没有发送申请'} desc={tab === 'incoming' ? '有人申请添加你时会显示在这里' : '搜索或扫码找到朋友后可以发送申请'} />
        )}
        {rows.map(({ requestId, createdAt, user }) => (
          <article className="fr-row" key={requestId}>
            <Avatar src={avatarOf(user)} name={user.nickname} size={48} radius={15} />
            <div className="fr-user">
              <b>{user.nickname || user.username}</b>
              <span>@{user.username}</span>
              <small>{formatAgo(createdAt)}</small>
            </div>
            {tab === 'incoming' ? (
              <div className="fr-actions">
                <button type="button" className="fr-accept" disabled={busyId === requestId} onClick={() => decide(requestId, 'accept')}>
                  <IconCheck size={15} />同意
                </button>
                <button type="button" className="fr-reject" disabled={busyId === requestId} onClick={() => decide(requestId, 'reject')}>拒绝</button>
              </div>
            ) : (
              <button type="button" className="fr-cancel" disabled={busyId === requestId} onClick={() => decide(requestId, 'cancel')}>
                <IconTrash size={15} />撤回
              </button>
            )}
          </article>
        ))}
      </div>
    </div>
  )
}
