import React, { useEffect } from 'react'
import { useWatchLater } from '../store/WatchLaterStore.jsx'
import { useChat } from '../store/ChatStore.jsx'
import { formatAgo } from '../api/client.js'
import { IconClock, IconFolder, IconImage, IconLocate, IconCheck, IconStar } from '../components/Icon.jsx'

/* ===== 稍后看页面 =====
   稍后看是**引用**（不是快照），原消息撤回后条目会消失。
   和收藏的区别：收藏适合「重要内容存档」，稍后看适合「待办事项」。 */
export default function WatchLaterPage({ onBack, showToast }) {
  const { list, loading, loadWatchLater, removeByMessage } = useWatchLater()
  const { conversations } = useChat()

  useEffect(() => {
    loadWatchLater()
  }, [loadWatchLater])

  const handleRemove = async (messageId) => {
    try {
      await removeByMessage(messageId)
      showToast('已从稍后看移除')
    } catch (e) {
      showToast(e.message || '移除失败')
    }
  }

  const handleJump = (conversationId, messageId) => {
    // 跳转到聊天中的消息（需要 nav 支持，暂时只做 toast）
    showToast(`跳转到会话 ${conversationId} 的消息 ${messageId}`)
  }

  const getConversationName = (conversationId) => {
    const conv = conversations.find((c) => c.id === conversationId)
    return conv?.name || `会话 ${conversationId}`
  }

  return (
    <div className="subpage cover-tabbar">
      <header className="sub-head">
        <button type="button" className="sub-back" onClick={onBack}>
          <IconClock size={21} />
        </button>
        <h2>稍后看</h2>
        <span className="sub-spacer" />
      </header>
      <div className="sub-scroll no-scrollbar">
        {loading && list.length === 0 ? (
          <p className="sub-note">加载中…</p>
        ) : list.length === 0 ? (
          <div className="empty-state">
            <IconClock size={48} />
            <p>稍后看列表为空</p>
            <p className="sub-note">长按消息 → 稍后看</p>
          </div>
        ) : (
          <div className="sub-list">
            {list.map((item) => (
              <div key={item.id} className="watch-later-row" data-testid="wl-row">
                <div className="wl-main">
                  <span className={`wl-ic is-${item.kind}`}>
                    {item.kind === 'location' ? (
                      <IconLocate size={20} />
                    ) : item.kind === 'poll' ? (
                      <IconCheck size={20} />
                    ) : item.kind === 'file' || item.kind === 'video' ? (
                      <IconFolder size={20} />
                    ) : item.kind === 'image' ? (
                      <IconImage size={20} />
                    ) : (
                      <IconStar size={20} />
                    )}
                  </span>
                  <span className="wl-body">
                    <b>{item.content || `[${item.kind}]`}</b>
                    <em>
                      {getConversationName(item.conversationId)} · {formatAgo(item.createdAt)}
                    </em>
                  </span>
                </div>
                <div className="wl-acts">
                  <button
                    type="button"
                    className="wl-act"
                    onClick={() => handleJump(item.conversationId, item.messageId)}
                    data-testid="wl-jump"
                  >
                    查看
                  </button>
                  <button
                    type="button"
                    className="wl-act is-danger"
                    onClick={() => handleRemove(item.messageId)}
                    data-testid="wl-remove"
                  >
                    移除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
