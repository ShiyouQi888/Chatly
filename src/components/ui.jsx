/**
 * 通用 UI 原语组件
 */
import React, { useEffect, useRef } from 'react'
import { mediaUrl } from '../api/client.js'
import { IconChevron } from './Icon.jsx'
import './ui.css'

/* ===== 头像 ===== */
export function Avatar({ src, name = '', size = 48, ring = 0, online = false, badge = 0, radius }) {
  const initial = name.slice(-2)
  const r = radius ?? (size > 60 ? 24 : size > 40 ? 16 : 12)
  return (
    <span className="av-wrap" style={{ width: size, height: size }}>
      <span
        className="av"
        style={{
          width: size,
          height: size,
          borderRadius: r,
          fontSize: Math.max(11, size * 0.3),
          // 仅在传 ring 时写 inline boxShadow：
          // 否则 'none' 会覆盖外部 CSS 类给头像加的阴影（inline 优先级更高）
          ...(ring ? { boxShadow: `0 0 0 ${ring}px #fff, 0 0 0 ${ring + 2.5}px var(--brand-1)` } : null),
        }}
      >
        {src ? <img src={mediaUrl(src)} alt={name} /> : <em>{initial}</em>}
      </span>
      {online && <i className="av-online" style={{ width: size * 0.26, height: size * 0.26 }} />}
      {badge > 0 && <b className="av-badge">{badge > 99 ? '99+' : badge}</b>}
    </span>
  )
}

/* ===== 未读徽标 ===== */
export function Badge({ count, dot = false, muted = false }) {
  if (dot) return <i className={`badge badge-dot ${muted ? 'is-muted' : ''}`} />
  if (!count) return null
  return <b className={`badge ${muted ? 'is-muted' : ''}`}>{count > 99 ? '99+' : count}</b>
}

/* ===== 胶囊标签 ===== */
export function Chip({ children, active, tone = 'brand', onClick, size = 'md' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`chip chip-${tone} chip-${size} ${active ? 'is-active' : ''}`}
    >
      {children}
    </button>
  )
}

/* ===== 表单行 ===== */
export function Row({ icon, label, value, right, onClick, chevron = true, sub, danger, last }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag type={onClick ? 'button' : undefined} className={`row ${danger ? 'is-danger' : ''} ${last ? 'is-last' : ''}`} onClick={onClick}>
      {icon && <span className="row-ic">{icon}</span>}
      <span className="row-body">
        <span className="row-label">{label}</span>
        {sub && <span className="row-sub">{sub}</span>}
      </span>
      {value && <span className="row-value">{value}</span>}
      {right}
      {chevron && onClick && <IconChevron size={16} className="row-chev" />}
    </Tag>
  )
}

/* ===== 分组卡片 ===== */
export function Group({ title, children, footer }) {
  return (
    <section className="group">
      {title && <h4 className="group-title">{title}</h4>}
      <div className="group-card">{children}</div>
      {footer && <p className="group-footer">{footer}</p>}
    </section>
  )
}

/* ===== 开关 ===== */
/* `disabled` 是给「开关存得进去、但没有任何代码读它」的设置项用的 ——
   那种开关能让用户以为「我开了这个保护」，而实际上什么都不会发生。
   按项目规矩：**不做假功能**，未接通的开关一律 disabled 并在行内写明原因。 */
export function Switch({ on, onChange, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      className={`switch ${on ? 'is-on' : ''} ${disabled ? 'is-off' : ''}`}
      onClick={() => onChange?.(!on)}
    >
      <i />
    </button>
  )
}

/* ===== 头像组 ===== */
export function AvatarStack({ items = [], size = 28, max = 4 }) {
  const shown = items.slice(0, max)
  const rest = items.length - shown.length
  return (
    <span className="avstack">
      {shown.map((it, i) => (
        <span key={i} className="avstack-item" style={{ marginLeft: i === 0 ? 0 : -size * 0.32 }}>
          <Avatar src={it.src} name={it.name} size={size} radius={size / 3} />
        </span>
      ))}
      {rest > 0 && (
        <span className="avstack-more" style={{ width: size, height: size, marginLeft: -size * 0.32 }}>
          +{rest}
        </span>
      )}
    </span>
  )
}

/* ===== 分组标题栏 ===== */
/* `hint` 是**纯文字**的右上角说明（例如「使用中」）。
   和 `action` 的区别很重要：`action` 是个按钮，点了必须有事发生；
   只写 `action` 不给 `onAction` 会渲染出一个点了毫无反应的按钮。
   只为展示状态就用 `hint`。 */
export function SectionTitle({ children, action, onAction, hint }) {
  return (
    <div className="sec-title">
      <h3>{children}</h3>
      {action && (
        <button type="button" className="sec-action" onClick={onAction}>
          {action}
        </button>
      )}
      {hint && <span className="sec-hint">{hint}</span>}
    </div>
  )
}

/* ===== 空状态 ===== */
export function Empty({ icon, title, desc }) {
  return (
    <div className="empty">
      {icon && <span className="empty-ic">{icon}</span>}
      <p className="empty-title">{title}</p>
      {desc && <p className="empty-desc">{desc}</p>}
    </div>
  )
}

/* ===== 底部弹出面板 ===== */
export function Sheet({ open, onClose, title, children, footer }) {
  if (!open) return null
  return (
    <div className="sheet-root">
      <div className="sheet-mask" onClick={onClose} />
      <div className="sheet-panel anim-sheet">
        <span className="sheet-grab" />
        {title && <h3 className="sheet-title">{title}</h3>}
        <div className="sheet-body no-scrollbar">{children}</div>
        {footer && <div className="sheet-footer">{footer}</div>}
      </div>
    </div>
  )
}

/* ===== 长按 / 点击菜单 ===== */
/**
 * 长按类菜单必须防「松手补发的 click」—— 这是本项目实测踩到的坑，写清楚：
 *
 * 触摸长按的完整时序是
 *   `touchStart` → 计时器到点（480ms）→ **弹菜单** → 用户松手
 *   → 浏览器为这次手势补发一个 `click`。
 *
 * 那个 click 会落在**手指抬起的位置**对应到的新 DOM 上。菜单是刚渲染出来的，
 * 于是它可能：
 *   ① 落在 `.sheet-mask` 上 → 菜单被自己关掉（「长按没反应」）；
 *   ② **落在某个 `.menu-item` 上** → 菜单被关掉**并且执行了那一项**
 *      （实测：松手瞬间 click 的 target 就是 `menu-item`）。
 * ② 更危险 —— 用户只是长按了一下，却可能「被撤回」或「被取消收藏」。
 *
 * 所以防御必须**同时盖住遮罩和菜单项**，而且两者用同一个时间窗。
 * 450ms 是实测出来的：`touchEnd` 到补发 click 之间几乎没有延迟，
 * 但不同浏览器/设备有一些差异，留够余量。
 *
 * ## ⚠️ 这道防御**只对长按弹出的菜单**开（`longPress` 属性）
 *
 * 补发的 click 是「长按」这个手势独有的。点「⋯」、点某个成员弹出的菜单
 * 根本没有前置手势，也就不存在尾巴 —— 对它照样上 450ms 死区，
 * 只会造成一个真实的缺陷：**点开菜单后马上点第一项，那一下被吞掉，什么都不发生**
 * （菜单不关、操作不执行，用户只会以为「这个功能坏了」）。
 *
 * 这个坑已经真实咬过一次：动态页「编辑」的端到端自检就报过
 * 「点编辑后面板打不开」，查到最后既没有报错也不是回归，
 * 而是脚本点得太快、正好落进死区 —— 断言指向了完全错误的方向。
 * 所以：**能用 `longPress` 区分就不要靠时间窗兜底**，
 * 调用方只要说明「这个菜单是长按弹出来的」即可。
 */
const LONG_PRESS_CLICK_GUARD_MS = 450

export function ActionMenu({ open, onClose, title, items = [], longPress = false }) {
  const openedAt = useRef(0)
  useEffect(() => {
    if (open) openedAt.current = Date.now()
  }, [open])

  if (!open) return null

  /** 菜单刚弹出的这段时间里，任何 click 都是「上一次长按的尾巴」，一律忽略。
      只对长按菜单生效 —— 点击弹出的菜单没有尾巴要防。 */
  const guarded = () => longPress && Date.now() - openedAt.current < LONG_PRESS_CLICK_GUARD_MS
  const guardClose = () => {
    if (guarded()) return
    onClose?.()
  }
  /** 菜单项也要防：否则补发的 click 会**直接执行那一项**（比关掉菜单更糟） */
  const guardItem = (fn) => () => {
    if (guarded()) return
    fn?.()
    onClose?.()
  }

  return (
    <div className="sheet-root">
      <div className="sheet-mask" onClick={guardClose} />
      <div className="sheet-panel anim-sheet">
        <span className="sheet-grab" />
        {title && <h3 className="sheet-title">{title}</h3>}
        <div className="menu-list">
          {items.map((it, i) => (
            <button
              key={i}
              type="button"
              /* 未接入的项必须真的 disabled —— 只写个「未接入」字样却还能点，
                 点下去弹层关了什么也没发生，看着就像功能坏了 */
              className={`menu-item ${it.danger ? 'is-danger' : ''} ${it.disabled ? 'is-off' : ''}`}
              disabled={it.disabled === true}
              onClick={guardItem(it.onClick)}
            >
              {it.icon && <span className="menu-ic">{it.icon}</span>}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="menu-cancel" onClick={guardClose}>
          取消
        </button>
      </div>
    </div>
  )
}

/* ===== 轻提示 ===== */
export function Toast({ text }) {
  if (!text) return null
  return <div className="toast anim-fade-in">{text}</div>
}
