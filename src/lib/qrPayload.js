/* ===== 二维码负载格式 =====
 *
 * 只用一个自定义 scheme，不引任何库：
 *   chatly://user/<username>          个人码（我页 → 我的二维码）   ← 本轮已实现
 *   chatly://group/<conversationId>   群码                        ← **预留**，识别到会明确说「暂未支持」
 *   chatly://moment/<momentId>        动态码                       ← **预留**
 *   其它（http(s) / 纯文本）           原样展示 + 复制
 *
 * 为什么不用 JSON：这串东西是要给人看的。JSON 是一坨花括号，肉眼啥也看不出来；
 * URL 形态既能被通用扫码器识别，出问题时一眼就知道是谁的码、该找谁。
 *
 * ⚠️ 生成与解析**必须共用这一份**（`userPayload()` / `parseQrPayload()`）：
 * 生成侧改一处、解析侧漏改，症状是「自己的码自己扫不出来」，而且两边单看都「像对的」。
 *
 * 群码这一档刻意只做到「识别出类型」，不假装能进群 —— 后端还没有群邀请 / 入群码校验，
 * 做了就是个点了没反应的假按钮（见 README「不做假功能」）。
 */

export const QR_SCHEME = 'chatly'

const RE = new RegExp(`^${QR_SCHEME}://([a-z]+)/(.+)$`, 'i')

/** 个人码负载。username 就是界面上的「ID: xxxx」 */
export function userPayload(username) {
  const clean = String(username == null ? '' : username)
    .trim()
    .replace(/^@+/, '')
  return `${QR_SCHEME}://user/${encodeURIComponent(clean)}`
}

/** 群码负载（预留，生成入口尚未接入） */
export function groupPayload(conversationId) {
  return `${QR_SCHEME}://group/${Number(conversationId)}`
}

/**
 * 解析扫到的字符串。
 * @returns {{type:'user'|'group'|'moment'|'url'|'text'|'unknown'|'empty', raw:string,
 *            username?:string, groupId?:number, momentId?:number, url?:string, text?:string, kind?:string}}
 */
export function parseQrPayload(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return { type: 'empty', raw: text }

  const m = RE.exec(text)
  if (m) {
    const kind = m[1].toLowerCase()
    let value = m[2].trim()
    try {
      value = decodeURIComponent(value)
    } catch {
      /* 非法的 % 转义就按原样用，不要因为一个坏字符把整条识别挂掉 */
    }

    if (kind === 'user') {
      const username = value.replace(/^@+/, '').trim()
      return username ? { type: 'user', raw: text, username } : { type: 'unknown', raw: text, kind }
    }
    if (kind === 'group' || kind === 'moment') {
      const id = Number(value)
      if (Number.isInteger(id) && id > 0) {
        return kind === 'group'
          ? { type: 'group', raw: text, groupId: id }
          : { type: 'moment', raw: text, momentId: id }
      }
      return { type: 'unknown', raw: text, kind }
    }
    return { type: 'unknown', raw: text, kind }
  }

  if (/^https?:\/\//i.test(text)) return { type: 'url', raw: text, url: text }
  return { type: 'text', raw: text, text }
}

/**
 * 纯文本形态下「像不像一个用户 ID」。
 * 用第三方工具生成的码经常只放一个 ID，直接当普通文本丢掉太可惜 ——
 * 但也不能自作主张跳转，所以只用来**多给一个按钮**，点了才去查。
 */
export function looksLikeUserId(text) {
  return /^@?[A-Za-z0-9][A-Za-z0-9_.-]{1,23}$/.test(String(text == null ? '' : text).trim())
}

/** 手动输入框的清洗：去空格、去 @ 前缀 */
export function normalizeUsernameInput(text) {
  return String(text == null ? '' : text)
    .trim()
    .replace(/^@+/, '')
}
