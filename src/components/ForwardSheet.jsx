/**
 * 转发目标选择器 —— 整屏层：搜会话 + 点一个目标 → 确认转发。
 *
 * ## 为什么单独一个组件，而不是复用别的列表
 * 转发要的是「我能往里发消息的会话」—— 最近会话列表正好就是这个，
 * 但它多两件事：① 搜名字过滤；② 点中即选（而不是打开聊天）。
 * 和 ChatTab 的会话行**长得像但行为不一样**，硬复用会把两边的 onClick 语义搅在一起。
 *
 * ## 三条不能违反的规矩
 * 1. **进来就聚焦搜索框吗？不。** 移动端自动聚焦会弹键盘，
 *    把列表顶上去 —— 用户先要看的是「最近跟谁聊过」。要搜了他自己会点。
 * 2. **当前会话排第一个并标出来。** 转发给自己当前所在的会话（备忘/再发一遍）
 *    是合理需求，但要点之前让他看见「这就是当前这个」。
 * 3. **禁言群要标出来但不禁用。** 禁不禁言是**服务端**说了算（canSpeak），
 *    前端在这里禁用等于替服务端做决定 —— 万一两边口径不一致，
 *    会出现「界面不让选、接口其实能发」或反过来的怪事。
 *    所以只标「禁言中」，点了之后服务端 403 再如实报错。
 */
import { useMemo, useState } from 'react'
import { Avatar } from './ui.jsx'
import { IconClose, IconSearch, IconCheck } from './Icon.jsx'
import './forward-sheet.css'

export default function ForwardSheet({ open, conversations = [], currentId, count, onClose, onPick }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  if (!open) return null

  const keyword = q.trim().toLowerCase()
  const list = useMemo(() => {
    const arr = [...(conversations || [])]
    /* 当前会话置顶并标记 —— 见文件头第 2 条 */
    arr.sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId))
    if (!keyword) return arr
    return arr.filter((c) => String(c.name || '').toLowerCase().includes(keyword))
  }, [conversations, currentId, keyword])

  const confirm = async () => {
    if (!sel || busy) return
    setBusy(true)
    setErr('')
    try {
      await onPick?.(sel)
      onClose?.()
    } catch (e) {
      /* 服务端拒了（比如禁言）—— 如实报错，面板**不关**，
         让用户换个目标，而不是关了重进再选一遍。 */
      setErr(e?.message || '转发失败')
      setBusy(false)
    }
  }

  return (
    <div className="fw-root cover-tabbar" data-testid="forward-sheet">
      <header className="fw-bar">
        <button type="button" className="fw-cancel" onClick={onClose} aria-label="取消">
          <IconClose size={20} />
        </button>
        <h2>转发{count ? `（${count} 条）` : ''}</h2>
        <button
          type="button"
          className="fw-send"
          disabled={!sel || busy}
          onClick={confirm}
          data-testid="fw-send"
        >
          {busy ? '发送中' : '发送'}
        </button>
      </header>

      <div className="fw-body no-scrollbar">
        <div className="fw-search">
          <IconSearch size={16} />
          <input
            value={q}
            maxLength={40}
            placeholder="搜索会话"
            onChange={(e) => setQ(e.target.value)}
            data-testid="fw-search"
          />
        </div>

        {err && (
          <p className="fw-err" data-testid="fw-err">
            {err}
          </p>
        )}

        {list.length === 0 ? (
          <p className="fw-empty" data-testid="fw-empty">
            {keyword ? '没有匹配的会话' : '暂无会话'}
          </p>
        ) : (
          <ul className="fw-list">
            {list.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`fw-row ${sel?.id === c.id ? 'is-sel' : ''}`}
                  onClick={() => setSel(c)}
                  data-testid={`fw-row-${c.id}`}
                  data-current={c.id === currentId ? '1' : '0'}
                >
                  <Avatar src={c.src} name={c.name} size={44} radius={14} />
                  <span className="fw-main">
                    <b>
                      {c.name}
                      {c.id === currentId && <em className="fw-cur">当前会话</em>}
                    </b>
                    {c.type === 'group' && c.muteAll ? (
                      <em className="fw-sub is-warn">禁言中</em>
                    ) : (
                      c.preview && <em className="fw-sub">{c.preview}</em>
                    )}
                  </span>
                  {sel?.id === c.id && (
                    <span className="fw-tick">
                      <IconCheck size={13} sw={3} />
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
