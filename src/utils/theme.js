import { storage } from '../platform/index.js'

const DEFAULT_ON_PRIMARY = '#ffffff'

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

function parseHex(hex) {
  const value = String(hex || '').replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  if (!/^[0-9a-f]{6}$/i.test(full)) return null
  return [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16))
}

function linearize(value) {
  value /= 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function luminance(hex) {
  const rgb = parseHex(hex)
  if (!rgb) return 0
  const [r, g, b] = rgb.map(linearize)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(first, second) {
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function mixHex(color, target, amount) {
  const from = parseHex(color)
  const to = parseHex(target)
  if (!from || !to) return color
  const channels = from.map((value, index) => Math.round(value + (to[index] - value) * amount))
  return `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function colorForContrast(color, against, target = 4.6) {
  if (contrastRatio(color, against) >= target) return color
  const moveToward = luminance(against) > 0.5 ? '#000000' : '#ffffff'
  for (let step = 1; step <= 100; step += 1) {
    const candidate = mixHex(color, moveToward, step / 100)
    if (contrastRatio(candidate, against) >= target) return candidate
  }
  return moveToward
}

/* Theme colors serve both flat controls and gradient controls, whose foreground
   changes by palette. Correct each endpoint before placing accessible text on it. */
export function applyThemeColors(themeOrColors) {
  const theme = Array.isArray(themeOrColors) ? { colors: themeOrColors } : themeOrColors
  if (!Array.isArray(theme?.colors) || theme.colors.length < 2) return

  const [rawStart, rawEnd] = theme.colors
  const onPrimary = theme.onPrimary || DEFAULT_ON_PRIMARY
  const actionColors = theme.actionColors || [rawStart, rawEnd]
  const safeStart = colorForContrast(actionColors[0], onPrimary)
  const safeEnd = colorForContrast(actionColors[1], onPrimary)
  const lightInk = colorForContrast(rawStart, '#ffffff')
  const darkInk = colorForContrast(rawStart, '#1a1a26')
  const root = document.documentElement

  root.style.setProperty('--on-primary', onPrimary)
  root.style.setProperty('--text-on-brand', onPrimary)
  root.style.setProperty('--brand-1', rawStart)
  root.style.setProperty('--brand-ink-light', lightInk)
  root.style.setProperty('--brand-ink-dark', darkInk)
  root.style.setProperty('--brand-3', safeEnd)
  root.style.setProperty('--brand-action', safeEnd)
  root.style.setProperty('--brand-grad', `linear-gradient(135deg, ${safeStart} 0%, ${safeEnd} 100%)`)
  root.style.setProperty('--chat-outgoing', `linear-gradient(135deg, ${safeStart} 0%, ${safeEnd} 100%)`)
  root.style.setProperty('--chat-out-bg', `linear-gradient(135deg, ${safeStart} 0%, ${safeEnd} 100%)`)
  root.style.setProperty('--chat-outgoing-text', onPrimary)
  root.style.setProperty('--chat-out-text', onPrimary)
  root.style.setProperty('--brand-soft', hexToRgba(rawStart, 0.14))
  root.style.setProperty('--brand-soft-2', hexToRgba(rawStart, 0.2))
  root.style.setProperty('--brand-pulse', hexToRgba(rawStart, 0.45))
  root.style.setProperty('--brand-pulse-clear', hexToRgba(rawStart, 0))
  root.style.setProperty('--shadow-brand', 'none')
  root.style.setProperty('--accent', rawStart)
  root.style.setProperty('--focus-ring', hexToRgba(rawStart, 0.62))
}

const FONT_SCALE = { small: '0.9', standard: '1', large: '1.1', xlarge: '1.2' }

export function applyFontSize(value) {
  document.documentElement.style.setProperty('--font-scale', FONT_SCALE[value] || '1')
}

export const MOTION_KEY = 'chatly-motion'
export const APPEARANCE_MODE_KEY = 'chatly-mode'
const validModes = new Set(['system', 'light', 'dark'])
let systemModeMedia
let systemModeHandler

export function getSavedAppearanceMode() {
  try {
    const saved = storage.get(APPEARANCE_MODE_KEY) || 'system'
    return validModes.has(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}

export function applyAppearanceMode(mode = 'system') {
  const root = document.documentElement
  const preference = validModes.has(mode) ? mode : 'system'
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  const updateEffectiveMode = () => {
    root.dataset.colorMode = preference === 'system'
      ? (media?.matches ? 'dark' : 'light')
      : preference
  }

  if (systemModeMedia && systemModeHandler) {
    systemModeMedia.removeEventListener?.('change', systemModeHandler)
    systemModeMedia.removeListener?.(systemModeHandler)
  }
  systemModeMedia = preference === 'system' ? media : null
  systemModeHandler = preference === 'system' ? updateEffectiveMode : null
  if (systemModeMedia && systemModeHandler) {
    if (systemModeMedia.addEventListener) systemModeMedia.addEventListener('change', systemModeHandler)
    else systemModeMedia.addListener?.(systemModeHandler)
  }

  updateEffectiveMode()
  return preference
}

export function applyMotion(on) {
  document.documentElement.classList.toggle('no-motion', !on)
}

export function applySavedAppearance() {
  try {
    applyFontSize(storage.get('chatly-font-size') || 'standard')
    applyMotion(storage.get(MOTION_KEY) !== 'off')
  } catch {}
  applyAppearanceMode(getSavedAppearanceMode())
}

export function applySavedTheme(themes) {
  try {
    const saved = storage.get('chatly-theme') || '极光'
    const legacyNames = { '海盐': '薄荷', '暮色': '蜜桃', '云朵': '极光', '午夜': '石墨' }
    const resolved = legacyNames[saved] || saved
    const found = (themes || []).find((theme) => theme.name === resolved)
    if (found) {
      if (resolved !== saved) storage.set('chatly-theme', resolved)
      applyThemeColors(found)
    }
  } catch {}
}
