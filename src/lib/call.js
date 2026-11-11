/**
 * 通话文案 —— 气泡、会话预览、通话记录页共用一份。
 *
 * 为什么抽出来：同一条通话记录在主叫和被叫眼里含义不同
 * （主叫看到「未接通」，被叫看到「未接来电」），三处各写一套必然有一处写反。
 * 这里统一按 `mine` + `callState` 出文案，调用方只负责排版。
 */

export function formatCallDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  if (!total) return ''
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export const callMediaLabel = (media) => (media === 'video' ? '视频通话' : '语音通话')

/**
 * 这条记录对「我」意味着什么。
 * @param {{ callState?: string, callMedia?: string, audioDurationMs?: number, mine?: boolean }} m
 */
export function callText(m) {
  switch (m?.callState) {
    case 'missed':
      return m.mine ? '未接通' : '未接来电'
    case 'declined':
      return m.mine ? '对方已拒绝' : '已拒绝'
    case 'cancelled':
      return m.mine ? '已取消' : '未接来电'
    default:
      return formatCallDuration(m?.audioDurationMs) || '已结束'
  }
}
