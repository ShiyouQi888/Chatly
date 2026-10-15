/**
 * 互动通知：生成、门控、查询
 *
 * ## 为什么判定必须集中在本文件
 * 和 privacy.js 同一个理由：`user_settings` 是「键值随便存」的表，
 * 真正的风险从来不是存不进去，而是**存了没人读**。
 * 所以「notify_like 关掉之后该不该落这一行」这类判断只在这里做一次，
 * 路由只负责调用，界面只负责展示。
 *
 * ## 门控发生在**写入时**，不是读取时
 * 关掉「点赞通知」= 这类事件不再产生通知。不做「全存下来、读的时候过滤」，
 * 因为那等于替用户攒一堆他明确说过不想要的行。
 * 代价要说清：关掉期间发生的事，重新打开也不会补回来 —— 和真实 App 的行为一致，
 * 界面上也这么写。
 *
 * ## 哪些事件会产生通知（对应界面上的每一行开关）
 *   message  私聊里对方发的消息
 *   mention  群里 @ 我（含 @全体成员）。群里没 @ 我的消息**不落行**：
 *            未读已由 conversation_members.last_read_message_id 承担，
 *            再按消息存一份只会随消息量线性膨胀，而它本来也不是「通知」。
 *   like     别人赞了我发的动态
 *   comment  别人评论我的动态，或回复了我的评论
 *   follow   有人关注了我
 *   group    群公告更新
 *   system   —— 目前没有任何服务端产生方，界面上如实标「未接入」并禁用
 *
 * ## 声音 / 震动 / 免打扰**不在这里判**
 * 那三项管的是「通知到了之后怎么吵你」，不是「有没有这条通知」。
 * 它们在客户端判（见 src/utils/notifyAlert.js）：免打扰时段用的是用户设备的本地时间，
 * 服务端判反而会对时区不对的人成立。
 */
import { q, insert } from './db.js'
import { listMembers } from './chat.js'

/** 事件类型 → 存进 user_settings 的键。和 NotificationSettings.jsx 的行一一对应。 */
export const NOTIFY_KEY = {
  message: 'notify_message',
  mention: 'notify_mention',
  like: 'notify_like',
  comment: 'notify_comment',
  follow: 'notify_follow',
  group: 'notify_group',
  system: 'notify_system',
}

export const NOTIFY_DEFAULTS = {
  message: true,
  mention: true,
  like: true,
  comment: true,
  follow: true,
  group: true,
  system: true,
  /* 下面四项是客户端要的提醒偏好。服务端不拿它们做拦截，只提供读写。 */
  sound: true,
  vibrate: true,
  dnd_enabled: false,
  dnd_start: '23:00',
  dnd_end: '08:00',
}

export const NOTIFY_KINDS = Object.keys(NOTIFY_KEY)

function coerceBool(raw, def) {
  if (raw === undefined || raw === null) return def
  if (typeof raw === 'boolean') return raw
  if (raw === 0 || raw === 1) return !!raw
  const s = String(raw).trim().toLowerCase()
  if (s === 'true' || s === '1') return true
  if (s === 'false' || s === '0') return false
  return def
}

/** 别名，给「提醒方式」那几个键用 */
const VALUE_KEYS = {
  sound: 'sound',
  vibrate: 'vibrate',
  dnd_enabled: 'dnd_enabled',
  dnd_start: 'dnd_start',
  dnd_end: 'dnd_end',
}

/**
 * 某个人的通知偏好（含提醒方式）。总是返回完整对象，调用方不用判 undefined。
 * 库里的值可能是 JSON 文本（routes/settings.js 这么写），也可能是历史遗留的裸字符串，
 * 两种都读一遍；读不出来就回落**默认值**而不是 false ——
 * 把「用户没设过」当成「用户关掉了」是最容易做的错事。
 */
export async function notifyPrefsOf(userId) {
  const out = { ...NOTIFY_DEFAULTS }
  const rows = await q.all(
    'SELECT key, value FROM user_settings WHERE user_id = ?',
    userId
  )
  /* 同一批键有两种写法（notify_sound / sound）：两种都认，
     因为界面上那几行以前就叫不同的名字存过。 */
  const alias = { notify_sound: 'sound', notify_vibrate: 'vibrate' }
  for (const r of rows) {
    let v = r.value
    try {
      v = JSON.parse(r.value)
    } catch {
      /* 裸文本，按原样用 */
    }
    const kindKey = Object.keys(NOTIFY_KEY).find((k) => NOTIFY_KEY[k] === r.key)
    if (kindKey) {
      out[kindKey] = coerceBool(v, NOTIFY_DEFAULTS[kindKey])
      continue
    }
    const mapped = VALUE_KEYS[r.key] || alias[r.key]
    if (!mapped) continue
    if (mapped === 'dnd_start' || mapped === 'dnd_end') {
      if (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)) out[mapped] = v
      continue
    }
    out[mapped] = coerceBool(v, NOTIFY_DEFAULTS[mapped])
  }
  return out
}

/* ================= 产生通知 ================= */

/** 这一类通知，收件人开了吗 */
async function kindAllowed(userId, kind) {
  if (!NOTIFY_KEY[kind]) return false
  const prefs = await notifyPrefsOf(userId)
  return prefs[kind] !== false
}

/**
 * 已经有一条**未读**的同源通知就别再来一条。
 *
 * 不做去重的话，一个人对着同一条动态连点五次赞（取消再赞）会攒出五条通知，
 * 通知中心会被同一件事刷屏 —— 那是噪音，不是信息。
 *
 * ⚠️ 用 `(col = ? OR (? IS NULL AND col IS NULL))` 而不是 `col IS ?`：
 *    `IS` 带参数在 PostgreSQL 里是语法错误（只接 NULL / 布尔字面量），
 *    本地 SQLite 全绿、线上 PG 直接 500 —— 双驱动最该避开的那类写法。
 */
async function alreadyPending({ userId, actorId, kind, refId, refParentId }) {
  const row = await q.get(
    `SELECT 1 AS x FROM notifications
      WHERE user_id = ?
        AND kind = ?
        AND read_at IS NULL
        AND (actor_id = ? OR (? IS NULL AND actor_id IS NULL))
        AND (ref_id = ? OR (? IS NULL AND ref_id IS NULL))
        AND (ref_parent_id = ? OR (? IS NULL AND ref_parent_id IS NULL))
      LIMIT 1`,
    userId,
    kind,
    actorId ?? null,
    actorId ?? null,
    refId ?? null,
    refId ?? null,
    refParentId ?? null,
    refParentId ?? null
  )
  return !!row
}

/** 按 id 取一条并整形（push 之后要把它原样推给客户端，省一次重拼） */
async function fetchOne(id) {
  const row = await q.get(`${SELECT} WHERE n.id = ?`, id)
  return row ? decorate(row) : null
}

/**
 * 落一行通知，并推给在线的收件人。
 *
 * 返回 `null` 表示「按收件人的开关这条不该存在」或「已有未读的同一件事」；
 * 返回对象表示真的产生了一条。调用方（点赞、评论那条线）不需要接这个返回值 ——
 *
 * ⚠️ 这个函数**从不抛错**。通知是附属体验：一条点赞通知写失败，
 * 绝不能连带让「点赞」这个主操作失败，用户只会以为点赞坏了。
 * 失败会 console.warn 出来，不静默。
 */
export async function pushNotification({
  userId,
  actorId = null,
  kind,
  refId = null,
  refParentId = null,
  conversationId = null,
  body = null,
}) {
  try {
    if (!userId || !NOTIFY_KEY[kind]) return null
    /* 不给自己发：自己赞自己的动态、自己在群里 @ 自己，都不该产生通知 */
    if (actorId && Number(actorId) === Number(userId)) return null
    if (!(await kindAllowed(userId, kind))) return null
    if (await alreadyPending({ userId, actorId, kind, refId, refParentId })) return null

    const text = body == null ? null : String(body).slice(0, 200)
    const id = await insert(
      `INSERT INTO notifications
         (user_id, actor_id, kind, ref_id, ref_parent_id, conversation_id, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      actorId ?? null,
      kind,
      refId ?? null,
      refParentId ?? null,
      conversationId ?? null,
      text,
      Date.now()
    )
    const item = await fetchOne(id)
    if (item) {
      /* 动态 import：ws.js 那一头会 import chat.js / profile.js / privacy.js，
         而它们迟早也可能用到通知。惰性取一次把这条环掐掉 ——
         环在 ESM 里不会报错，只会让某个符号在初始化完成前是 undefined，
         那种 bug 要等第一次「通知推送」跑到才炸，而且指向完全错误的文件。 */
      const { broadcastToUser } = await import('./ws.js')
      broadcastToUser(userId, 'notification.new', { notification: item })
    }
    return item
  } catch (e) {
    console.warn('[notify] 生成通知失败（已忽略，不影响主操作）：', e.message)
    return null
  }
}

/* ================= 出参 ================= */

const SELECT = `
  SELECT n.id, n.kind, n.ref_id AS refId, n.ref_parent_id AS refParentId,
         n.conversation_id AS conversationId, n.body, n.read_at AS readAt,
         n.created_at AS createdAt, n.actor_id AS actorId,
         a.username AS actorUsername, a.nickname AS actorNickname, a.avatar AS actorAvatar
    FROM notifications n
    LEFT JOIN users a ON a.id = n.actor_id
`

function decorate(r) {
  return {
    id: Number(r.id),
    kind: r.kind,
    actor: r.actorId
      ? { id: Number(r.actorId), username: r.actorUsername, nickname: r.actorNickname, avatar: r.actorAvatar }
      : null,
    refId: r.refId ?? null,
    refParentId: r.refParentId ?? null,
    conversationId: r.conversationId ?? null,
    body: r.body || null,
    /* 前端只认 unread：read_at 是不是 NULL 是存储细节，别漏出去 */
    unread: r.readAt === null || r.readAt === undefined,
    createdAt: Number(r.createdAt),
  }
}

/**
 * 通知列表（分页 + 按分类筛）。
 * group 对应界面上的 Tab：all / chat（消息+@我）/ interact（赞+评论+关注）/ system（群+系统）
 */
export async function listNotifications(userId, { beforeId = null, limit = 30, group = 'all' } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 30, 1), 100)
  const where = ['n.user_id = ?']
  const args = [userId]
  if (beforeId) {
    where.push('n.id < ?')
    args.push(Number(beforeId))
  }
  if (group === 'chat') where.push("n.kind IN ('message','mention')")
  else if (group === 'interact') where.push("n.kind IN ('like','comment','follow')")
  else if (group === 'system') where.push("n.kind IN ('group','system')")

  const rows = await q.all(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY n.id DESC LIMIT ?`,
    ...args,
    cap
  )
  return { items: rows.map(decorate), hasMore: rows.length === cap }
}

/** 未读数（入口上的红点用它） */
export async function unreadCount(userId) {
  const row = await q.get(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
    userId
  )
  return Number(row?.n) || 0
}

/**
 * 标记已读。ids 为空 = 全部。
 * ⚠️ WHERE 里必须带 user_id，否则传别人的通知 id 就能替别人「已读」——
 * 这个接口看起来无害，越权却正好藏在「反正只是个已读标记」里。
 */
export async function markNotificationsRead(userId, ids = null) {
  const now = Date.now()
  if (Array.isArray(ids) && ids.length) {
    const nums = [...new Set(ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
    if (!nums.length) return 0
    const result = await q.run(
      `UPDATE notifications SET read_at = ?
        WHERE user_id = ? AND read_at IS NULL AND id IN (${nums.map(() => '?').join(',')})`,
      now,
      userId,
      ...nums
    )
    return Number(result?.changes ?? 0)
  }
  const r = await q.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now, userId)
  return Number(r?.changes ?? 0)
}

/* ================= 事件源要用的几个小查询 ================= */

/** 某人发的动态是谁的 —— 点赞 / 评论要给作者发通知 */
export async function momentOwner(momentId) {
  const row = await q.get('SELECT user_id AS userId FROM moments WHERE id = ?', momentId)
  return row ? Number(row.userId) : null
}

/** 某条评论是谁发的 —— 回复评论要通知到被回复的人 */
export async function commentOwner(commentId) {
  const row = await q.get('SELECT user_id AS userId FROM moment_comments WHERE id = ?', commentId)
  return row ? Number(row.userId) : null
}

/** 一条动态的正文摘要（通知 body 用），太长就截 */
export async function momentExcerpt(momentId) {
  const row = await q.get('SELECT content FROM moments WHERE id = ?', momentId)
  const s = String(row?.content || '').trim()
  if (!s) return null
  return s.length > 40 ? s.slice(0, 40) + '…' : s
}

/**
 * 「@全体成员 / @所有人」两种写法都认 —— 种子里用的是前者，
 * 而很多人会打后者。漏认一个就等于那个人的 @ 通知永远不会来。
 */
export const ALL_MENTION_TOKENS = ['@全体成员', '@所有人']
/**
 * 从一条文本里找出被 @ 到的成员。
 *
 * **只有会话成员才算被 @**：文本里出现一个陌生人的昵称（比如提到「秦始皇」）
 * 不该给他发通知 —— 而他根本不在成员表里。所以这里必须拿成员表比对，
 * 不能只写个正则。
 * @param {string} text
 * @param {Array<{user:{id:number,nickname:string}}>} members
 * @returns {number[]} 被 @ 到的用户 id
 */
export function detectMentions(text, members) {
  const s = String(text || '')
  if (!s) return []
  const ids = new Set()
  if (ALL_MENTION_TOKENS.some((t) => s.includes(t))) {
    for (const m of members || []) ids.add(Number(m.user.id))
    return [...ids]
  }
  for (const m of members || []) {
    const nick = m?.user?.nickname
    if (nick && s.includes('@' + nick)) ids.add(Number(m.user.id))
  }
  return [...ids]
}

export { fetchOne as getNotification, decorate as shapeNotification }

/* ================= 聊天消息这一条线 ================= */

/**
 * 收到新消息时产生通知。**这是「新消息」「@我」两个开关真正生效的地方。**
 *
 * 分工（和界面上的两行开关严格对应）：
 *   · 私聊 → 对方收到一条 kind='message'
 *   · 群聊 → **只有被 @ 到的人**收到 kind='mention'
 *
 * 为什么群里没 @ 就不落行：未读数已经由 last_read_message_id 承担，
 * 每条群消息都给全群存一行「通知」，等于把一个群变成通知表的放大器，
 * 而且那也不是用户理解的「通知」（他打开 App 看列表就能看到）。
 *
 * @param {{conversationId:number, senderId:number, message:object}} p message 是 getMessage() 的出参
 */
export async function notifyIncomingMessage({ conversationId, senderId, message }) {
  try {
    if (!conversationId || !message) return
    const conv = await q.get('SELECT type, title FROM conversations WHERE id = ?', conversationId)
    if (!conv) return
    const members = await listMembers(conversationId)
    const body = messageSnippet(message)

    if (conv.type === 'private') {
      const other = members.find((m) => Number(m.user.id) !== Number(senderId))
      await pushNotification({
        userId: other?.user?.id,
        actorId: senderId,
        kind: 'message',
        refId: message.id,
        conversationId,
        body,
      })
      return
    }

    /* 群聊：只有 @ 到的人。detectMentions 保证「被 @ 的必须是本群成员」，
       文本里顺手打个「@秦始皇」不该惊动任何一个不在群里的人。 */
    for (const userId of detectMentions(message.text || '', members)) {
      await pushNotification({
        userId,
        actorId: senderId,
        kind: 'mention',
        refId: message.id,
        conversationId,
        body,
      })
    }
  } catch (e) {
    console.warn('[notify] 消息通知失败（已忽略，不影响发送）：', e.message)
  }
}

/**
 * 通知行上那句摘要。
 * 非文字消息**不能显示成空**（用户会以为发了条空消息），所以按 kind 给可读的名字。
 */
function messageSnippet(message) {
  if (message.encrypted) return '[加密消息]'
  switch (message.kind) {
    case 'image':
      return '[图片]'
    case 'video':
      return '[视频]'
    case 'file':
      return `[文件] ${message.fileName || ''}`.trim()
    case 'location':
      return `[位置] ${message.geo?.name || ''}`.trim()
    case 'poll':
      return '[投票]'
    default: {
      const s = String(message.text || '').replace(/\s+/g, ' ').trim()
      if (!s) return '[消息]'
      return s.length > 60 ? s.slice(0, 60) + '…' : s
    }
  }
}

/**
 * 群公告更新了 —— 给全群（除发布者）发一条「群通知」。
 * 对应界面上「群通知」那一行；它管的是公告，不是普通群消息（见上面的说明）。
 */
export async function notifyAnnouncement({ conversationId, ownerId, excerpt, revision = null }) {
  const members = await listMembers(conversationId)
  const text = String(excerpt || '').slice(0, 60)
  for (const m of members) {
    await pushNotification({
      userId: m.user.id,
      actorId: ownerId,
      kind: 'group',
      conversationId,
      refId: conversationId,
      refParentId: revision,
      body: text ? `群公告：${text}` : '群公告已更新',
    })
  }
}
