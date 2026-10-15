/* 主题应用：把一套主题色写进全局 CSS 变量。
 * 为什么要写 --brand-* 而不是 --primary：
 * 全站 250+ 处样式用的都是 --brand-1/2/3、--brand-grad、--brand-soft，
 * --primary 只在「我」页新增的几个页面里用。之前切换主题只写 --primary，
 * 看着切成功了（toast 也弹了），其实主界面一点没变 —— 典型的点了没反应。 */
export function hexToRgba(hex, alpha) {
  const h = String(hex || '').replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  if (!Number.isFinite(n)) return `rgba(109, 93, 246, ${alpha})`
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function applyThemeColors(colors) {
  if (!Array.isArray(colors) || colors.length < 2) return
  const [c1, c2] = colors
  const root = document.documentElement
  // 全站主色（250+ 处在用）
  root.style.setProperty('--brand-1', c1)
  root.style.setProperty('--brand-2', c2)
  root.style.setProperty('--brand-3', c2)
  root.style.setProperty('--brand-grad', `linear-gradient(135deg, ${c1} 0%, ${c2} 100%)`)
  root.style.setProperty('--brand-soft', hexToRgba(c2, 0.1))
  root.style.setProperty('--brand-soft-2', hexToRgba(c2, 0.18))
  root.style.setProperty('--shadow-brand', `0 6px 20px ${hexToRgba(c2, 0.32)}`)
  // 「我」页新页面用的别名，保持同步
  root.style.setProperty('--primary', c2)
  root.style.setProperty('--primary-end', c1)
  root.style.setProperty('--accent', c1)
}

const FONT_SCALE = { small: '0.9', standard: '1', large: '1.1', xlarge: '1.2' }

export function applyFontSize(value) {
  const scale = FONT_SCALE[value] || '1'
  document.documentElement.style.setProperty('--font-scale', scale)
}

/* 动效开关。
 * 关掉时给 <html> 挂 `.no-motion`，由 global.css 用**和
 * `@media (prefers-reduced-motion: reduce)` 完全相同的规则**停掉动画 ——
 * 两边各写一份必然漂，改了一处另一处就不生效。
 * 存 localStorage：这是个跨会话的偏好，刷新后必须还在（否则又变成「点了没反应」）。 */
export const MOTION_KEY = 'chatly-motion'

export function applyMotion(on) {
  document.documentElement.classList.toggle('no-motion', !on)
}

export function applySavedAppearance() {
  try {
    const fontSize = localStorage.getItem('chatly-font-size') || 'standard'
    applyFontSize(fontSize)
    applyMotion(localStorage.getItem(MOTION_KEY) !== 'off')
  } catch {}
}

/* 启动时恢复主题。MeTab 里也有一份恢复（进「我」页时），
 * 但用户可能一次都不进「我」页 —— 主题必须在整站入口就恢复，
 * 否则「切了主题、刷新、首页还是紫的」就是点了没反应。 */
export function applySavedTheme(themes) {
  try {
    const saved = localStorage.getItem('chatly-theme') || '极光'
    const found = (themes || []).find((t) => t.name === saved)
    if (found) applyThemeColors(found.colors)
  } catch {}
}
