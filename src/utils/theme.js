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
  // 承载白字的品牌底必须压暗到 ≥4.6:1，否则浅色主题的按钮/气泡文字不可读。
  // --brand-1 只用于装饰（圆点、描边），保留原亮色；--brand-2/3/grad 承载文字，走安全值。
  const safe1 = darkenForWhite(c1)
  const safe2 = darkenForWhite(c2)
  root.style.setProperty('--brand-1', c1)
  root.style.setProperty('--brand-2', safe2)
  root.style.setProperty('--brand-3', safe2)
  root.style.setProperty('--brand-action', safe2)
  root.style.setProperty('--brand-grad', `linear-gradient(135deg, ${safe1} 0%, ${safe2} 100%)`)
  root.style.setProperty('--brand-soft', hexToRgba(c2, 0.1))
  root.style.setProperty('--brand-soft-2', hexToRgba(c2, 0.18))
  root.style.setProperty('--shadow-brand', `0 6px 20px ${hexToRgba(safe2, 0.32)}`)
  // 「我」页新页面用的别名，保持同步（同样用安全值，避免白字不达标）
  root.style.setProperty('--primary', safe2)
  root.style.setProperty('--primary-end', safe1)
  root.style.setProperty('--accent', c1)
}

/* 相对亮度（WCAG 2.1） */
function linearize(v) {
  v /= 255
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
function luminance(r, g, b) {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}
function whiteContrast(r, g, b) {
  return 1.05 / (luminance(r, g, b) + 0.05)
}

/* 把任意色压暗到「白字 ≥ target:1」，保留色相。用于主题切换时保证按钮/气泡可读。
 * 步长 4%，最多 90 步；不可解析的颜色原样返回。 */
export function darkenForWhite(hex, target = 4.6) {
  const h = String(hex || '').replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  let r = parseInt(full.slice(0, 2), 16)
  let g = parseInt(full.slice(2, 4), 16)
  let b = parseInt(full.slice(4, 6), 16)
  if (![r, g, b].every(Number.isFinite)) return hex
  let guard = 0
  while (whiteContrast(r, g, b) < target && guard++ < 90) {
    r = Math.round(r * 0.96)
    g = Math.round(g * 0.96)
    b = Math.round(b * 0.96)
  }
  const to2 = (x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')
  return `#${to2(r)}${to2(g)}${to2(b)}`
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
