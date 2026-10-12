/**
 * 表情面板
 *
 * 素材：Microsoft Fluent Emoji（MIT），本地文件在 public/emoji/<码点>.svg。
 * 清单与中文名由 scripts/fetch-emoji.mjs 生成到 src/data/emoji.js —— 这里不硬编码任何表情。
 *
 * 两种用法：
 *   - 普通表情：点一下往输入框的**光标处**插入一个 Unicode 字符（走系统字体渲染，
 *     和文字一起排，复制出去也是真字符）
 *   - 大表情：点一下直接发一条贴纸式大图消息（见 ChatRoom 的 sendSticker）
 *
 * 面板高度刻意做成定值：它在 .room 里是 flex 项，高度确定才能让消息区正确收缩，
 * 而不是把输入框顶出屏幕。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EMOJI_TABS, EMOJI_NAMES, EMOJI_BIG, EMOJI_ALL, emojiUrl, EMOJI_BASE } from '../data/emoji.js'
import { animUrl, EMOJI_ANIM_DIR } from '../data/emoji-anim.js'
import { IconSearch, IconClose } from './Icon.jsx'
import './emoji-panel.css'

const RECENT_KEY = 'chatly.emoji.recent'
const RECENT_MAX = 18

/**
 * 码点 → 真实 Unicode 字符。
 * 多码点序列（如 1f441-200d-1f5e8「眼睛气泡」）必须整段一起 fromCodePoint，
 * 拆开插会插出一串散字符。
 */
export function emojiChar(code) {
  try {
    return String.fromCodePoint(...code.split('-').map((p) => parseInt(p, 16)))
  } catch {
    return ''
  }
}

/**
 * 这个 fileUrl 是不是面板发出去的大表情（决定渲染成无气泡贴纸还是普通图片）。
 *
 * ⚠️ 两个前缀都得认：静态大表情在 `/emoji/`，动画的在 `/emoji-anim/`。
 *    只判 `/emoji/` 的话 `'/emoji-anim/1f602.webp'.startsWith('/emoji/')` 是 **false**
 *    —— 动画贴纸会被当成普通图片消息渲染（带气泡边框），一眼看过去就是个 bug。
 */
export function isEmojiSticker(url) {
  if (typeof url !== 'string') return false
  return url.startsWith(`${EMOJI_BASE}/`) || url.startsWith(`${EMOJI_ANIM_DIR}/`)
}

/* ---------- 最近使用（localStorage，不进后端：这是纯本地偏好） ---------- */
function readRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    if (!Array.isArray(v)) return []
    // 清单可能会重生成、删掉旧表情；过滤掉已经不存在的码点，别渲染出破图
    return v.filter((c) => typeof c === 'string' && EMOJI_NAMES[c])
  } catch {
    return []
  }
}

function writeRecent(codes) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(codes))
  } catch {
    /* 隐私模式下 localStorage 会抛错，最近用不了不影响其它功能 */
  }
}

/* ==================== 面板 ==================== */
export default function EmojiPanel({ onPick, onSendBig }) {
  const [mode, setMode] = useState('emoji') // 'emoji' | 'big'
  const [tab, setTab] = useState(EMOJI_TABS[0].key)
  const [q, setQ] = useState('')
  const [recent, setRecent] = useState(readRecent)

  const searchRef = useRef(null)
  const bodyRef = useRef(null)

  /* 切到大表情时清掉搜索词，否则回来的第一眼是空的 */
  useEffect(() => {
    if (mode === 'big') setQ('')
  }, [mode])

  /* 搜索命中：名字里含关键词，或码点本身含关键词（比如直接粘 1f602）。
     搜索范围随模式走 —— 在「大表情」档里搜索，就该在大表情里找，
     否则搜出来的结果点下去会发成普通表情。 */
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return null
    const pool = mode === 'big' ? EMOJI_BIG : EMOJI_ALL
    return pool.filter((c) => {
      if (c.includes(s)) return true
      const n = EMOJI_NAMES[c] || ''
      return n.toLowerCase().includes(s) || n.includes(s)
    }).slice(0, 120)
  }, [q, mode])

  const remember = useCallback((code) => {
    setRecent((cur) => {
      const next = [code, ...cur.filter((c) => c !== code)].slice(0, RECENT_MAX)
      writeRecent(next)
      return next
    })
  }, [])

  const pick = useCallback(
    (code) => {
      const ch = emojiChar(code)
      if (ch) onPick?.(ch)
      remember(code)
    },
    [onPick, remember]
  )

  /* 大表情优先发动画版；上游没做动画的那批（多是手势类）回退静态 SVG。
     判空交给 animUrl()，不要假设一定有动画 —— EMOJI_ANIM 里只有 30/47 条。 */
  const bigUrl = useCallback((code) => animUrl(code) || emojiUrl(code), [])

  const sendBig = useCallback(
    (code) => {
      onSendBig?.({ fileUrl: bigUrl(code), fileName: EMOJI_NAMES[code] || '表情' })
      remember(code)
    },
    [onSendBig, remember, bigUrl]
  )

  /* 分类 tab：最近使用排在最前，且只在真的有记录时出现 */
  const tabs = useMemo(() => {
    const list = EMOJI_TABS.map((t) => ({ key: t.key, title: t.title, items: t.items }))
    if (recent.length) list.unshift({ key: 'recent', title: '最近', items: recent })
    return list
  }, [recent])

  // 切换分组时把网格滚回顶部 —— 否则从上一个分组的底部接着看，像是没切换
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [tab, mode])

  const active = tabs.find((t) => t.key === tab) || tabs[0]
  // 大表情档的候选是 EMOJI_BIG，跟当前选中的分类无关 ——
  // 早先写成 active.items，结果大表情档显示的其实是「当前分类的大图」。
  const items = hits || (mode === 'big' ? EMOJI_BIG : active.items)

  return (
    <section className="ep" aria-label="表情面板">
      {/* head：模式切换 + 搜索。两档模式是互斥的，用分段控件比两个 tab 清楚 */}
      <div className="ep-head">
        <div className="ep-seg" role="tablist" aria-label="表情类型">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'emoji'}
            className={`ep-seg-btn ${mode === 'emoji' ? 'is-on' : ''}`}
            onClick={() => setMode('emoji')}
          >
            表情
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'big'}
            className={`ep-seg-btn ${mode === 'big' ? 'is-on' : ''}`}
            onClick={() => setMode('big')}
          >
            大表情
          </button>
        </div>

        <div className="ep-search">
          <IconSearch size={14} />
          <input
            ref={searchRef}
            type="search"
            value={q}
            placeholder="搜索表情"
            aria-label="搜索表情"
            onChange={(e) => setQ(e.target.value)}
          />
          {q && (
            <button type="button" className="ep-clear" onClick={() => setQ('')} aria-label="清空搜索">
              <IconClose size={11} />
            </button>
          )}
        </div>
      </div>

      {/* 分类只在「表情」模式下有意义：大表情本来就一屏翻完 */}
      {mode === 'emoji' && !hits && (
        <div className="ep-tabs no-scrollbar" role="tablist" aria-label="表情分类">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={t.key === active.key}
              className={`ep-tab ${t.key === active.key ? 'is-on' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.title}
            </button>
          ))}
        </div>
      )}

      <div className="ep-body no-scrollbar" ref={bodyRef}>
        {items.length === 0 && <p className="ep-empty">没有匹配的表情</p>}

        {mode === 'big' ? (
          <div className="ep-grid is-big">
            {items.map((code) => (
              <button
                key={code}
                type="button"
                className="ep-cell is-big"
                onClick={() => sendBig(code)}
                title={EMOJI_NAMES[code] || code}
                aria-label={`发送大表情 ${EMOJI_NAMES[code] || code}`}
              >
                {/* 动画版是 GIF（约 100KB/个），静态版是 SVG。
                    两者混在一屏里：有动画的会动，上游没做动画的静止 —— 这是上游素材的实际情况。
                    格式必须是 GIF：WebP 动画帧的 blend/dispose 组合会在透明背景上叠出残影。 */}
                <img
                  src={bigUrl(code)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                />
              </button>
            ))}
          </div>
        ) : (
          <div className="ep-grid">
            {items.map((code) => (
              <button
                key={code}
                type="button"
                className="ep-cell"
                onClick={() => pick(code)}
                title={EMOJI_NAMES[code] || code}
                aria-label={EMOJI_NAMES[code] || code}
              >
                <img src={emojiUrl(code)} alt="" loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
