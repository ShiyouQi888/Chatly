/**
 * 群投票的两端：**发起面板**（整屏）与**消息气泡**（列表里那张卡）。
 *
 * ## 三条不能违反的规矩
 *
 * 1. **只认服务端给的 `closed` / `percent` / `votes`，前端不自己算一份。**
 *    自己算就会出现「同一屏两个气泡的百分比不一样」「过期了按钮还能点」这类
 *    说不清谁对的分歧。前端只负责渲染和发请求。
 *
 * 2. **匿名不是「前端不显示」——是服务端根本没给。**
 *    非匿名时出参有 `voters`，匿名时**连字段都没有**。所以这里渲染头像簇的判据是
 *    `Array.isArray(voters)`，而不是 `!anonymous`：后者一旦有人改了服务端出参，
 *    界面会安静地画出一片空白而不是暴露数据（宁可少画，不可多画）。
 *
 * 3. **票数没拉到之前不画「0 票」。** 详情是异步补拉的，拿到之前画 0 票 =
 *    对着用户撒谎（明明有人投过）。所以那种状态画骨架条。
 */
import { useEffect, useMemo, useState } from 'react'
import { Avatar } from './ui.jsx'
import { avatarOf } from '../store/ChatStore.jsx'
import { IconCheck, IconClose, IconPlus, IconTrash, IconClock, IconUser } from './Icon.jsx'
import './poll.css'

const MAX_QUESTION = 80
const MAX_OPTION_TEXT = 40
const MIN_OPTIONS = 2
const MAX_OPTIONS = 10

/** 码点长度 —— '😂'.length === 2，不按码点算的话一条 emoji 标题会被判超长 */
const cpLen = (s) => [...String(s || '')].length

/** 用户可读的剩余时间。**只写「还有多久」，不写具体到分的绝对时间**（时区/误差都容易吵架）。 */
export function deadlineText(deadline, now = Date.now()) {
  if (!Number.isFinite(deadline) || deadline === null) return ''
  const left = deadline - now
  if (left <= 0) return '已到截止时间'
  const min = Math.round(left / 60000)
  if (min < 60) return `还剩 ${min} 分钟`
  const hour = Math.round(min / 60)
  if (hour < 24) return `还剩 ${hour} 小时`
  return `还剩 ${Math.round(hour / 24)} 天`
}

const DEADLINES = [
  { key: 'none', label: '不限时', hours: 0 },
  { key: '1h', label: '1 小时', hours: 1 },
  { key: '24h', label: '24 小时', hours: 24 },
  { key: '3d', label: '3 天', hours: 72 },
  { key: '7d', label: '7 天', hours: 24 * 7 },
]

/* ============================================================
   发起面板
   ============================================================ */

export function PollSheet({ open, onClose, onSubmit }) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [multi, setMulti] = useState(false)
  const [anonymous, setAnonymous] = useState(false)
  const [deadlineKey, setDeadlineKey] = useState('none')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  /* 关掉再打开要是一张干净的表 —— 否则上次输到一半的选项会留着，
     用户以为「上次那个没发出去的东西还在」，其实早就重新开始了。 */
  useEffect(() => {
    if (!open) return
    setQuestion('')
    setOptions(['', ''])
    setMulti(false)
    setAnonymous(false)
    setDeadlineKey('none')
    setBusy(false)
    setErr('')
  }, [open])

  /* 校验放在**提交之前**而不是提交之后：能提前拦的都在前端拦一遍，
     服务端那一份仍然是防线（前端只是让用户少撞一次 400）。 */
  const filled = useMemo(() => options.map((o) => o.trim()).filter(Boolean), [options])
  const dup = useMemo(() => {
    const norm = filled.map((o) => o.replace(/\s+/g, ' ').toLowerCase())
    return new Set(norm).size !== norm.length
  }, [filled])

  if (!open) return null

  const reason = (() => {
    if (!question.trim()) return '先写个标题'
    if (filled.length < MIN_OPTIONS) return `至少填 ${MIN_OPTIONS} 个选项`
    if (dup) return '选项不能重复'
    return ''
  })()

  const setOption = (i, v) => setOptions((list) => list.map((o, j) => (j === i ? v : o)))
  const addOption = () => setOptions((list) => (list.length >= MAX_OPTIONS ? list : [...list, '']))
  const removeOption = (i) =>
    setOptions((list) => (list.length <= MIN_OPTIONS ? list : list.filter((_, j) => j !== i)))

  const submit = async () => {
    if (reason || busy) return
    setBusy(true)
    setErr('')
    const preset = DEADLINES.find((d) => d.key === deadlineKey)
    const deadline = preset && preset.hours ? Date.now() + preset.hours * 3600 * 1000 : null
    try {
      await onSubmit?.({ question: question.trim(), options: filled, multi, anonymous, deadline })
      onClose?.()
    } catch (e) {
      setErr(e?.message || '发起失败')
      setBusy(false)
    }
  }

  return (
    <div className="poll-root cover-tabbar" data-testid="poll-sheet">
      <header className="poll-bar">
        <button type="button" className="poll-cancel" onClick={onClose} aria-label="取消">
          <IconClose size={20} />
        </button>
        <h2>发起投票</h2>
        <button
          type="button"
          className="poll-submit"
          disabled={!!reason || busy}
          onClick={submit}
          data-testid="poll-submit"
          title={reason}
        >
          {busy ? '发出中' : '发起'}
        </button>
      </header>

      <div className="poll-body no-scrollbar">
        <section className="poll-card">
          <textarea
            className="poll-q"
            value={question}
            rows={2}
            placeholder="想问什么？（例：周六去哪？）"
            onChange={(e) => setQuestion(e.target.value)}
            data-testid="poll-question"
          />
          <div className="poll-count">
            <span className={cpLen(question) > MAX_QUESTION ? 'is-over' : ''}>
              {cpLen(question)}/{MAX_QUESTION}
            </span>
          </div>
        </section>

        <section className="poll-card">
          <div className="poll-card-title">选项（{filled.length}/{MAX_OPTIONS}）</div>
          {options.map((o, i) => (
            <div className="poll-opt" key={i}>
              <span className="poll-opt-idx">{i + 1}</span>
              <input
                value={o}
                maxLength={MAX_OPTION_TEXT * 2}
                placeholder={`选项 ${i + 1}`}
                onChange={(e) => setOption(i, e.target.value)}
                data-testid={`poll-option-${i}`}
              />
              <button
                type="button"
                className="poll-opt-del"
                disabled={options.length <= MIN_OPTIONS}
                onClick={() => removeOption(i)}
                aria-label={`删除选项 ${i + 1}`}
              >
                <IconTrash size={15} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="poll-add"
            disabled={options.length >= MAX_OPTIONS}
            onClick={addOption}
            data-testid="poll-add-option"
          >
            <IconPlus size={15} />
            {options.length >= MAX_OPTIONS ? `最多 ${MAX_OPTIONS} 个选项` : '添加选项'}
          </button>
        </section>

        <section className="poll-card">
          <button
            type="button"
            className="poll-toggle"
            aria-pressed={multi}
            onClick={() => setMulti((v) => !v)}
            data-testid="poll-multi"
          >
            <span className="poll-toggle-main">
              <b>多选</b>
              <em>{multi ? '每人可以选多个选项' : '每人只能选一个（可改票）'}</em>
            </span>
            <SwitchDot on={multi} />
          </button>

          <button
            type="button"
            className="poll-toggle"
            aria-pressed={anonymous}
            onClick={() => setAnonymous((v) => !v)}
            data-testid="poll-anonymous"
          >
            <span className="poll-toggle-main">
              <b>匿名投票</b>
              {/* 说清「匿名」到底匿到什么程度 —— 只说「匿名」会让人以为票数也看不见 */}
              <em>{anonymous ? '只显示票数，不显示谁投的' : '会显示投票的人（不显示每人选了什么）'}</em>
            </span>
            <SwitchDot on={anonymous} />
          </button>
        </section>

        <section className="poll-card">
          <div className="poll-card-title">
            <IconClock size={14} /> 截止时间
          </div>
          <div className="poll-dls">
            {DEADLINES.map((d) => (
              <button
                type="button"
                key={d.key}
                className={`poll-dl ${deadlineKey === d.key ? 'is-sel' : ''}`}
                onClick={() => setDeadlineKey(d.key)}
                data-testid={`poll-deadline-${d.key}`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </section>

        {(err || reason) && (
          <p className="poll-err" data-testid="poll-err">
            {err || reason}
          </p>
        )}
      </div>
    </div>
  )
}

/** 小开关。用 aria-pressed + 自绘滑块，和项目里其它开关保持同一套视觉。 */
function SwitchDot({ on }) {
  return (
    <span className={`poll-sw ${on ? 'is-on' : ''}`} aria-hidden="true">
      <i />
    </span>
  )
}

/* ============================================================
   消息气泡
   ============================================================ */

export function PollBubble({ poll, loading, me, onVote, onClose, onOpenDetail }) {
  /* 多选的选中状态是**本地**的：用户点了两下才说「我选这两个」。
     单选不需要本地态（点一下就是一次完整的投票）。
     ⚠️ 多选这里保证「提交过至少一次」才发请求 —— 否则点第一下就把
     「只选了 A」提交上去，别人立刻看到一票，而用户还没选完。 */
  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  /* ⚠️ 所有 hook 必须在**任何 return 之前**，且数量不能随 props 变化。
     第一版把骨架态的 `if (!poll) return ...` 放在下面那个 useMemo **之前**，
     于是「详情没拉到 → 拉到」这一次渲染就多了一个 hook，
     React 直接抛 "Rendered more hooks than during the previous render"
     并卸载整棵树 —— 表现同样是「聊天室自己关了」。
     规矩：hook 全部集中在顶部，骨架态只体现在 return 的 JSX 里。 */
  const mine = useMemo(() => new Set(poll?.myOptionIds || []), [poll])
  /* ⚠️ 必须统一成 Set。第一版写的是 `pending !== null ? pending : mine` ——
     `mine` 是 Set 而 `pending` 是数组，渲染时一句 `selected.has(...)` 就抛
     `TypeError: selected.has is not a function`，同样会卸载整棵树。
     统一成 Set 之后 `.has()` 和 `[...selected]` 两个用法都成立。 */
  const selected = useMemo(() => new Set(pending !== null ? pending : mine), [pending, mine])
  const closed = !!poll?.closed

  /* 换了一条投票（气泡被复用）就把本地态清掉 */
  useEffect(() => {
    setPending(null)
    setNote('')
  }, [poll?.id])

  if (!poll) {
    return (
      <div className="poll-bubble is-skeleton" data-testid="poll-bubble" data-state="loading">
        <div className="pb-q">
          <span className="pb-skel" />
        </div>
        <span className="pb-skel-line" />
        <span className="pb-skel-line" />
        {loading === false && <p className="pb-hint">投票内容没能加载出来</p>}
      </div>
    )
  }

  const isMine = Number(poll.creator?.id) === Number(me?.id)

  const tap = async (optId) => {
    if (busy) return
    setNote('')
    if (closed) {
      setNote('投票已结束，不能再投了')
      return
    }
    /* 单选：点一下就发（点已选项 = 取消投票，这是唯一的「反悔」入口）。 */
    if (!poll.multi) {
      const next = mine.has(optId) ? [] : [optId]
      setBusy(true)
      try {
        await onVote?.(next)
      } catch (e) {
        setNote(e?.message || '投票失败')
      } finally {
        setBusy(false)
      }
      return
    }
    /* 多选：只改本地选中，最后用底部按钮一次提交 */
    setPending((prev) => {
      const set = new Set(prev !== null ? prev : mine)
      if (set.has(optId)) set.delete(optId)
      else set.add(optId)
      return [...set]
    })
  }

  const submitMulti = async () => {
    if (busy || !poll.multi) return
    setBusy(true)
    setNote('')
    try {
      await onVote?.([...(pending || [])])
      setPending(null)
    } catch (e) {
      setNote(e?.message || '投票失败')
    } finally {
      setBusy(false)
    }
  }

  const pendingDirty =
    poll.multi &&
    pending !== null &&
    (pending.length !== mine.size || pending.some((id) => !mine.has(id)))

  const showVoters = Array.isArray(poll.voters)

  return (
    <div
      className={`poll-bubble ${closed ? 'is-closed' : ''}`}
      data-testid="poll-bubble"
      data-state={closed ? 'closed' : 'open'}
      data-poll-id={poll.id}
      data-anonymous={poll.anonymous ? '1' : '0'}
      data-multi={poll.multi ? '1' : '0'}
    >
      <div className="pb-q">
        <span className="pb-badge">投票</span>
        <b data-testid="pb-question">{poll.question}</b>
      </div>

      <div className="pb-meta">
        <span>{poll.multi ? '多选' : '单选'}</span>
        {poll.anonymous && <span>匿名</span>}
        {poll.deadline ? <span>{closed ? '已结束' : deadlineText(poll.deadline)}</span> : null}
      </div>

      <div className="pb-opts">
        {poll.options.map((o) => {
          const on = selected.has(o.id)
          return (
            <button
              type="button"
              key={o.id}
              className={`pb-opt ${on ? 'is-on' : ''}`}
              disabled={busy}
              onClick={() => tap(o.id)}
              data-testid={`pb-opt-${o.id}`}
              data-selected={on ? '1' : '0'}
              data-votes={o.votes}
              aria-pressed={on}
            >
              {/* 票数比例条：宽度就用服务端给的 percent，不在前端另算一份 */}
              <span className="pb-fill" style={{ width: `${o.percent}%` }} aria-hidden="true" />
              <span className="pb-opt-body">
                <span className="pb-tick" aria-hidden="true">
                  {on ? <IconCheck size={12} sw={3.2} /> : <i />}
                </span>
                <span className="pb-text">{o.text}</span>
                <span className="pb-num">
                  {o.votes}
                  {o.votes > 0 && <em>{o.percent}%</em>}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="pb-foot">
        <span className="pb-count" data-testid="pb-voter-count">
          <IconUser size={13} /> {poll.voterCount} 人已投
          {poll.multi && poll.totalVotes !== poll.voterCount ? ` · 共 ${poll.totalVotes} 票` : ''}
        </span>

        {showVoters && poll.voters.length > 0 && (
          <span className="pb-voters" data-testid="poll-voters">
            {poll.voters.slice(0, 5).map((v) => (
              <Avatar key={v.id} src={avatarOf(v)} name={v.nickname || v.username} size={20} />
            ))}
            {poll.voters.length > 5 && <em>+{poll.voters.length - 5}</em>}
          </span>
        )}

        <button
          type="button"
          className="pb-detail"
          onClick={() => onOpenDetail?.(poll)}
          data-testid="poll-detail"
        >
          详情
        </button>
      </div>

      {poll.multi && !closed && (
        <div className="pb-actions">
          <span className="pb-tip">
            {pending === null ? '可以选多项' : `已选 ${pending.length} 项`}
          </span>
          <button
            type="button"
            className="pb-confirm"
            disabled={!pendingDirty || busy}
            onClick={submitMulti}
            data-testid="pb-confirm"
          >
            {busy ? '提交中' : mine.size ? '更新选择' : '确认投票'}
          </button>
        </div>
      )}

      {(note || (closed && !mine.size)) && (
        <p className="pb-note" data-testid="poll-note">
          {note || '投票已结束'}
        </p>
      )}

      {isMine && !closed && (
        <button
          type="button"
          className="pb-end"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setNote('')
            try {
              await onClose?.()
            } catch (e) {
              setNote(e?.message || '结束失败')
            } finally {
              setBusy(false)
            }
          }}
          data-testid="poll-end"
        >
          结束投票
        </button>
      )}
    </div>
  )
}

/* ============================================================
   详情（整屏层）：谁投了、什么时候结束
   ============================================================ */

export function PollDetailSheet({ poll, me, onClose, onVote, onClosePoll }) {
  useEffect(() => {
    if (!poll) return undefined
    const onKey = (e) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [poll, onClose])

  if (!poll) return null
  const closed = !!poll.closed

  return (
    <div className="poll-detail cover-tabbar" data-testid="poll-detail-sheet">
      <header className="poll-bar">
        <button type="button" className="poll-cancel" onClick={onClose} aria-label="关闭">
          <IconClose size={20} />
        </button>
        <h2>投票详情</h2>
        <span className="poll-spacer" aria-hidden="true" />
      </header>

      <div className="poll-body no-scrollbar">
        <section className="poll-card">
          <h3 className="pd-q" data-testid="pd-question">
            {poll.question}
          </h3>
          <p className="pd-sub">
            {poll.multi ? '多选' : '单选'} · {poll.anonymous ? '匿名投票' : '公开投票'} ·{' '}
            {poll.creator?.nickname || poll.creator?.username || '未知'} 发起
          </p>
          <p className="pd-sub">
            {closed
              ? '已结束'
              : poll.deadline
                ? `${deadlineText(poll.deadline)}（${new Date(poll.deadline).toLocaleString('zh-CN', { hour12: false })} 截止）`
                : '不设截止时间'}
          </p>
        </section>

        <section className="poll-card">
          <div className="poll-card-title">各选项票数</div>
          {poll.options.map((o) => {
            const mineOpt = (poll.myOptionIds || []).includes(o.id)
            return (
              <button
                type="button"
                key={o.id}
                className={`pd-opt ${mineOpt ? 'is-on' : ''}`}
                disabled={closed}
                onClick={() => onVote?.([o.id])}
              >
                <span className="pd-opt-top">
                  <span className="pd-opt-text">
                    {mineOpt && (
                      <span className="pd-tick">
                        <IconCheck size={11} sw={3.2} />
                      </span>
                    )}
                    {o.text}
                  </span>
                  <span className="pd-opt-num">
                    {o.votes} 票 · {o.percent}%
                  </span>
                </span>
                <span className="pd-bar" aria-hidden="true">
                  <i style={{ width: `${o.percent}%` }} />
                </span>
              </button>
            )
          })}
        </section>

        <section className="poll-card">
          <div className="poll-card-title">
            <IconUser size={14} /> 已投票的人（{poll.voterCount}）
          </div>
          {Array.isArray(poll.voters) ? (
            poll.voters.length ? (
              <ul className="pd-voters" data-testid="pd-voters">
                {poll.voters.map((v) => (
                  <li key={v.id}>
                    <Avatar src={avatarOf(v)} name={v.nickname || v.username} size={30} />
                    <b>
                      {v.nickname || v.username}
                      {Number(v.id) === Number(me?.id) && <em>（我）</em>}
                    </b>
                  </li>
                ))}
                {poll.voterCount > poll.voters.length && (
                  <li className="pd-more">…等 {poll.voterCount} 人</li>
                )}
              </ul>
            ) : (
              <p className="pd-empty">还没有人投票</p>
            )
          ) : (
            /* 匿名：服务端**没有**返回 voters，所以这里只能这么写。
               写「匿名投票，不显示投票人」是对的；写「还没有人投票」是撒谎。 */
            <p className="pd-empty" data-testid="pd-anonymous">
              匿名投票，不显示谁投了票（票数照常统计）
            </p>
          )}
        </section>

        {!closed && Number(poll.creator?.id) === Number(me?.id) && (
          <button
            type="button"
            className="pd-end"
            onClick={async () => {
              await onClosePoll?.()
              onClose?.()
            }}
            data-testid="pd-end"
          >
            提前结束投票
          </button>
        )}
      </div>
    </div>
  )
}


