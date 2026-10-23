/**
 * 隐私门控：谁能通过什么方式找到我、加我、看到我在线
 *
 * ## 为什么单独一个文件
 * `user_settings` 是「键值随便存」的表，所以**真正的风险不是存不进去，而是存了没人读** ——
 * 一个显示「已关闭」的开关后面什么都没有，比不做这个开关更糟（用户会以为自己在保护隐私）。
 * 所以这几个键的**唯一**读取方就是本文件，接了哪几条渠道、在哪一层拦，都在这里写清楚。
 *
 * ## 语义：闸门开在「发现」这一层，不是「关注」这一层
 * 三个开关管的是「别人能不能通过这个渠道**找到我**」，不是「已经认识我的人能不能加我」。
 * 所以：
 *   - 只有**明确声明了渠道**的请求才会被拦（`POST /users/:id/follow` 带 `source`，
 *     `GET /users/by-username/:username?from=` 带 `from`）。
 *   - 群成员列表点「关注」、发现页推荐里点「关注」都**不带** source —— 那些人本来就在
 *     你眼前（同一个群 / 公开推荐），不存在「被找到」的问题，拦下来只会让人困惑。
 *   - 查得到 ≠ 加得上：命中闸门时资料照常返回（你知道这是谁），
 *     但 `addable.allowed = false` 并附上原因，关注接口也会 403。
 *
 * ## 与「在线状态」的关系
 * `online_status_visible = false` 时，**所有**对外出口都不再回答「他在不在线」：
 *   - `GET /users`、`GET /users/:id`、发现页里的人 → `online` 恒为 `false`
 *   - WS 的 `presence` 上下线广播 → 直接不发（不是发 `online:false`，
 *     因为「一直显示离线」和「对方关了在线状态」在界面上是一回事，没必要泄露前者）
 */
import { q } from './db.js'

/** 本模块认的键。不在这张表里的键一律不读 —— 多读一个就多一处要维护的语义。 */
export const PRIVACY_KEYS = [
  'add_friend_by_phone',
  'add_friend_by_qr',
  'add_friend_by_search',
  'online_status_visible',
  'moment_visibility',
]

export const PRIVACY_DEFAULTS = {
  add_friend_by_phone: true,
  add_friend_by_qr: true,
  add_friend_by_search: true,
  online_status_visible: true,
  moment_visibility: 'public',
}

/** 渠道 → 设置键。渠道名要和接口里的 `source` / `from` 完全一致。 */
export const CHANNEL_KEY = {
  qr: 'add_friend_by_qr',
  phone: 'add_friend_by_phone',
  search: 'add_friend_by_search',
}

/** 报错文案里的中文名 —— 和「隐私设置」页上的标签一字不差 */
export const CHANNEL_LABEL = {
  qr: '通过二维码添加',
  phone: '通过手机号添加',
  search: '通过搜索添加',
}

/**
 * 库里存的是 JSON 文本（见 routes/settings.js），但历史数据里可能有 `'true'` 这种手写字符串，
 * 所以这里按「布尔 → 数字 0/1 → 字符串 true/false」都认一遍。
 * 认不出来的**回落到默认值**（而不是 false）—— 宁可放过，也不要把用户没设过的项当关闭。
 */
function coerce(key, raw) {
  const def = PRIVACY_DEFAULTS[key]
  if (raw === undefined || raw === null) return def
  if (typeof def === 'boolean') {
    if (typeof raw === 'boolean') return raw
    if (raw === 0 || raw === 1) return !!raw
    const s = String(raw).trim().toLowerCase()
    if (s === 'true' || s === '1') return true
    if (s === 'false' || s === '0') return false
    return def
  }
  return typeof raw === 'string' && raw ? raw : def
}

function base() {
  return { ...PRIVACY_DEFAULTS }
}

/**
 * 把一个刚提交上来的值按某个键的语义归一化。
 * 对外暴露是因为：`PUT /settings/:key` 拿到的是**原始请求体**，
 * 而路由要在写库之后立刻据此决定「要不要广播在线状态」——
 * 那时不能等下一次读库，但也不能自己写 `!!value`（`!!'false'` 是 `true`）。
 */
export function normalizePrivacyValue(key, raw) {
  return coerce(key, raw)
}

/** 单人的隐私设置（已合并默认值）。**总是**返回一份完整对象，调用方不用判 undefined。 */
export async function privacyOf(userId) {
  const rows = await q.all('SELECT key, value FROM user_settings WHERE user_id = ?', userId)
  const out = base()
  for (const r of rows) {
    if (PRIVACY_KEYS.includes(r.key)) out[r.key] = coerce(r.key, r.value)
  }
  return out
}

/**
 * 批量取 —— 列表页（`/users`、发现页）逐人查会变成 N 次数据库往返，
 * PG 模式下每次都是一个网络往返，几十个人就是几十跳。
 * 没有记录的人直接拿默认值（Map 预填了），所以返回的 Map 对**每个**传入 id 都有值。
 */
export async function privacyOfMany(userIds) {
  const ids = [...new Set((userIds || []).map(Number))].filter(Boolean)
  const map = new Map(ids.map((id) => [id, base()]))
  if (!ids.length) return map

  const rows = await q.all(
    `SELECT user_id, key, value FROM user_settings WHERE user_id IN (${ids.map(() => '?').join(', ')})`,
    ...ids
  )
  for (const r of rows) {
    const cur = map.get(Number(r.user_id))
    if (cur && PRIVACY_KEYS.includes(r.key)) cur[r.key] = coerce(r.key, r.value)
  }
  return map
}

/**
 * 某个渠道能不能加我。
 * 未知渠道不由此函数作放行决策；好友申请路由必须先验证 source 属于 CHANNEL_KEY。
 */
export function canAddBy(privacy, channel) {
  const key = CHANNEL_KEY[channel]
  if (!key) return { allowed: false, reason: '添加来源无效' }
  if (privacy?.[key] === false) {
    return { allowed: false, reason: `对方关闭了「${CHANNEL_LABEL[channel]}」` }
  }
  return { allowed: true, reason: null }
}

/** 对方允不允许被别人看到「在线」 */
export function onlineVisible(privacy) {
  return privacy?.online_status_visible !== false
}
