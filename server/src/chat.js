/**
 * 聊天业务逻辑：会话 / 消息 / 已读 / 撤回
 * DB 层用 snake_case，这里统一转成 camelCase 给 API 出参。
 */
import { q, insert, tx } from './db.js'
import { decryptMessageText, encryptMessageText } from './message-crypto.js'
import { publicUser } from './auth.js'

/* ================= 用户 ================= */
export async function listUsers(exceptId) {
  const rows = await q.all(
    'SELECT id, username, nickname, avatar, bio FROM users WHERE id != ? ORDER BY id',
    exceptId ?? -1
  )
  return rows.map(publicUser)
}

/* ================= 会话 ================= */

/** 通话时长 → 列表里那一段短文本。未接通的通话没有时长。 */
function callDurationLabel(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  if (!total) return ''
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/**
 * 会话列表里的通话预览。
 *
 * 同一条记录对主叫/被叫的含义不同 —— 「未接来电」只对被叫成立，
 * 主叫看到的是「未接通」。所以这里必须带上浏览者 id 判方向，
 * 不能只按 state 写死一句。
 */
function callPreview(last, viewerId) {
  const label = last.callMedia === 'video' ? '视频通话' : '语音通话'
  const outgoing = Number(last.senderId) === Number(viewerId)
  switch (last.callState) {
    case 'missed':
      return outgoing ? `[${label}] 未接通` : `[${label}] 未接来电`
    case 'declined':
      return outgoing ? `[${label}] 对方已拒绝` : `[${label}] 已拒绝`
    case 'cancelled':
      return outgoing ? `[${label}] 已取消` : `[${label}] 未接来电`
    default: {
      const dur = callDurationLabel(last.audioDurationMs)
      return dur ? `[${label}] ${dur}` : `[${label}]`
    }
  }
}

/** 我参与的会话列表（含最后一条消息、未读数） */
export async function listConversations(userId) {
  const convs = await q.all(
    `SELECT c.id, c.type, c.title, c.avatar, c.owner_id AS ownerId, c.updated_at AS updatedAt,
            c.announcement, c.announcement_at AS announcementAt,
            c.mute_all AS muteAll, c.admin_only AS adminOnly,
            m.role, m.muted, m.pinned, m.last_read_message_id AS lastReadMessageId
     FROM conversations c
     JOIN conversation_members m ON m.conversation_id = c.id
     WHERE m.user_id = ?
     ORDER BY m.pinned DESC, c.updated_at DESC`,
    userId
  )

  /* 每个会话还要各查两次（最后一条消息 + 未读数）+ 一次成员表。
     原来是同步的 `.map()`；async 化之后必须用 Promise.all ——
     写成 `for` 里逐条 await 也能跑，但 7 个会话就是 21 次串行往返，
     在 PG 上是肉眼可见的慢（本地 SQLite 感觉不出来，所以很容易写错）。 */
  const items = await Promise.all(
    convs.map(async (c) => {
      const last = await q.get(
        `SELECT id, sender_id AS senderId, kind, content, content_encrypted AS contentEncrypted, file_name AS fileName, geo_name AS geoName,
                call_media AS callMedia, call_state AS callState, audio_duration_ms AS audioDurationMs,
                created_at AS createdAt, revoked_at AS revokedAt
         FROM messages WHERE conversation_id = ? AND (burn_at IS NULL OR burn_at > ?) ORDER BY id DESC LIMIT 1`,
        c.id, Date.now()
      )
      /* 通话记录不计未读：它是「发生过的事」，不是等你回的消息。
         算进未读的话，每通没接的电话都会在对方会话上留一个红点，
         而点进去没有任何可读内容 —— 那是通知噪音，不是提醒。 */
      const unread = (
        await q.get(
          `SELECT COUNT(*) AS n FROM messages
           WHERE conversation_id = ? AND sender_id != ? AND id > ? AND revoked_at IS NULL
             AND kind != 'call'
             AND (burn_at IS NULL OR burn_at > ?)`,
          c.id,
          userId,
          c.lastReadMessageId,
          Date.now()
        )
      ).n

      const members = await listMembers(c.id)
      const title = resolveTitle(c, members, userId)

      return {
        id: c.id,
        type: c.type,
        name: title,
        /* 头像是「会话自己的”。私聊没有独立头像，派生自对端；
           ⚠️ 群聊**不能**借成员的头像 —— 那个人一换头像，群头像就跟着变，
           而且看着像「群是某个人开的」。群没设头像就返回 null，由前端生成渐变底图。 */
        avatar:
          c.avatar ||
          (c.type === 'private' ? members.find((m) => m.user.id !== userId)?.user.avatar || null : null),
        memberCount: members.length,
        members,
        /* 我在这个群里的角色 —— 前端靠它决定「管理」类入口要不要显示。
           不返回的话前端只能靠「是不是 ownerId」猜，猜不出管理员。 */
        myRole: c.role,
        ownerId: c.ownerId,
        announcement: c.announcement || null,
        announcementAt: c.announcementAt ? c.announcementAt * 1000 : null,
        muteAll: !!c.muteAll,
        adminOnly: !!c.adminOnly,
        muted: !!c.muted,
        pinned: !!c.pinned,
        unread,
        lastMessage: last
          ? {
              id: last.id,
              senderId: last.senderId,
              kind: last.kind,
              /* 预览文案按类型分流。位置消息的 content 是空的，
                 只用 `content || fileName` 会得到一个空字符串的会话预览。
                 投票反过来：content 里存的就是题目（见 routes/polls.js 的说明），
                 这里只需加个 `[投票]` 前缀，让列表上一眼看出这不是一句话。 */
              text: last.revokedAt
                ? '(消息已撤回)'
                : last.kind === 'location'
                  ? `[位置] ${last.geoName || ''}`.trim()
                  : last.kind === 'poll'
                    ? `[投票] ${last.content || ''}`.trim()
                    : last.kind === 'call'
                      ? callPreview(last, userId)
                      : last.contentEncrypted ? '[加密消息]' : last.content || last.fileName || '',
              callMedia: last.kind === 'call' ? last.callMedia || 'audio' : null,
              callState: last.kind === 'call' ? last.callState || 'ended' : null,
              audioDurationMs: last.kind === 'call' ? Number(last.audioDurationMs) || 0 : null,
              createdAt: last.createdAt,
            }
          : null,
        updatedAt: c.updatedAt,
      }
    })
  )

  return items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
}

function resolveTitle(c, members, userId) {
  if (c.type === 'group') return c.title || `群聊(${members.length})`
  const other = members.find((m) => m.user.id !== userId)
  return other ? other.user.nickname : '我'
}

/**
 * 会话成员。
 * 必须带上每人各自的 last_read_message_id —— 前端要据此算出
 * 「这条消息谁读了、谁还没读」，只靠一个聚合布尔值做不出来。
 */
export async function listMembers(conversationId) {
  return (
    await q.all(
      `SELECT m.user_id AS userId, m.role, m.muted, m.pinned,
              m.last_read_message_id AS lastReadMessageId,
              (SELECT value FROM user_settings s WHERE s.user_id = m.user_id AND s.key = 'read_receipts') AS readReceipts,
              u.username, u.nickname, u.avatar, u.bio
       FROM conversation_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.conversation_id = ?
       ORDER BY m.joined_at, m.user_id`,
      conversationId
    )
  ).map((r) => ({
    user: publicUser({ id: r.userId, username: r.username, nickname: r.nickname, avatar: r.avatar, bio: r.bio }),
    role: r.role,
    lastReadMessageId: r.readReceipts === 'false' || r.readReceipts === '"false"' ? 0 : Number(r.lastReadMessageId) || 0,
  }))
}

export async function isMember(conversationId, userId) {
  return !!(
    await q.get('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversationId, userId)
  )
}

let privatePairSchema
let privatePairQueue = Promise.resolve()
async function ensurePrivatePairSchema() {
  if (!privatePairSchema) {
    privatePairSchema = q.run(`CREATE TABLE IF NOT EXISTS private_conversation_pairs (
      user_low INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_high INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
      PRIMARY KEY (user_low, user_high),
      CHECK (user_low < user_high)
    )`)
  }
  return privatePairSchema
}

/** 私聊：按规范化用户对复用；数据库唯一键保证并发请求也只保留一个会话。 */
export async function ensurePrivate(aId, bId) {
  await ensurePrivatePairSchema()
  const userLow = Math.min(Number(aId), Number(bId))
  const userHigh = Math.max(Number(aId), Number(bId))
  const createOrReuse = () => tx(async () => {
    const mapped = await q.get(
      'SELECT conversation_id AS conversationId FROM private_conversation_pairs WHERE user_low = ? AND user_high = ?',
      userLow, userHigh
    )
    if (mapped) return Number(mapped.conversationId)

    const legacy = await q.get(
      `SELECT c.id FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
       WHERE c.type = 'private'
       ORDER BY c.id ASC LIMIT 1`,
      userLow, userHigh
    )
    if (legacy) {
      await q.run(
        `INSERT INTO private_conversation_pairs (user_low, user_high, conversation_id) VALUES (?, ?, ?)
         ON CONFLICT(user_low, user_high) DO NOTHING`,
        userLow, userHigh, legacy.id
      )
      const winner = await q.get(
        'SELECT conversation_id AS conversationId FROM private_conversation_pairs WHERE user_low = ? AND user_high = ?',
        userLow, userHigh
      )
      return Number(winner.conversationId)
    }

    const cid = await insert('INSERT INTO conversations (type, title, owner_id) VALUES (?, ?, ?)', 'private', null, null)
    const now = Math.floor(Date.now() / 1000)
    await q.run('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)', cid, userLow, 'member')
    await q.run('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)', cid, userHigh, 'member')
    await q.run('UPDATE conversations SET updated_at = ? WHERE id = ?', now, cid)
    const inserted = await q.get(
      `INSERT INTO private_conversation_pairs (user_low, user_high, conversation_id) VALUES (?, ?, ?)
       ON CONFLICT(user_low, user_high) DO NOTHING RETURNING conversation_id AS conversationId`,
      userLow, userHigh, cid
    )
    if (inserted) return Number(inserted.conversationId)

    const winner = await q.get(
      'SELECT conversation_id AS conversationId FROM private_conversation_pairs WHERE user_low = ? AND user_high = ?',
      userLow, userHigh
    )
    await q.run('DELETE FROM conversations WHERE id = ?', cid)
    return Number(winner.conversationId)
  })
  const result = privatePairQueue.then(createOrReuse)
  privatePairQueue = result.catch(() => {})
  return result
}

export async function createGroup(title, memberIds, ownerId) {
  const ids = Array.from(new Set([ownerId, ...memberIds]))
  const found = await q.all(
    `SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
    ...ids
  )
  if (found.length !== ids.length) throw Object.assign(new Error('成员列表中包含不存在的用户'), { status: 400 })
  return tx(async () => {
    const cid = await insert('INSERT INTO conversations (type, title, owner_id) VALUES (?, ?, ?)', 'group', title, ownerId)
    for (const uid of ids) {
      await q.run(
        'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
        cid,
        uid,
        uid === ownerId ? 'owner' : 'member'
      )
    }
    return cid
  })
}

export async function touchConversation(conversationId) {
  await q.run('UPDATE conversations SET updated_at = ? WHERE id = ?', Math.floor(Date.now() / 1000), conversationId)
}

/* ================= 群聊：资料 / 成员 / 设置 ================= */

/**
 * 我在这个会话里的角色（不在群里返回 null）。
 * 角色只有三个值（owner / admin / member），DB 的 CHECK 已经挡住了其它值。
 */
export async function memberRole(conversationId, userId) {
  const r = await q.get(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    conversationId,
    userId
  )
  return r ? r.role : null
}

/** 能管群吗：群主或管理员。私聊永远返回 false —— 私聊没有「管理」这回事。 */
export async function canManage(conversationId, userId) {
  const c = await q.get('SELECT type FROM conversations WHERE id = ?', conversationId)
  if (!c || c.type !== 'group') return false
  const role = await memberRole(conversationId, userId)
  return role === 'owner' || role === 'admin'
}

/** 是群主吗（只有群主能设/撤管理员、转让群） */
export async function isOwner(conversationId, userId) {
  return (await memberRole(conversationId, userId)) === 'owner'
}

/**
 * 我在这个会话里能发言吗。
 *
 * ⚠️ 这是**唯一**的发言门控 —— 普通发送（POST /messages）与转发都走它。
 * 只在前端门控的话，客户端绕过界面直接发包就能在禁言群里说话；
 * 只在一条链路加的话，迟早会出现「投票发不出去、文字发得出去」这种走岔。
 *
 * 私聊：是成员就能说（没有禁言这回事）。
 * 群聊：mute_all 开了 → 只有 owner/admin；admin_only 开了 → 只有 owner/admin。
 */
export async function canSpeak(conversationId, userId) {
  if (!(await isMember(conversationId, userId))) return { ok: false, status: 403, error: '无权在该会话发言' }
  const c = await q.get('SELECT type, mute_all AS muteAll, admin_only AS adminOnly FROM conversations WHERE id = ?', conversationId)
  if (!c) return { ok: false, status: 404, error: '会话不存在' }
  if (c.type !== 'group') return { ok: true }
  if (c.muteAll || c.adminOnly) {
    const role = await memberRole(conversationId, userId)
    if (role !== 'owner' && role !== 'admin') {
      return { ok: false, status: 403, error: c.muteAll ? '群已开启全员禁言' : '当前仅管理员可发言' }
    }
  }
  return { ok: true }
}

/**
 * 改群资料与群设置。只改传进来的字段 ——
 * 前端局部更新（比如只改公告）时不能把别的字段冲成 null。
 */
export async function updateGroup(conversationId, patch = {}) {
  const sets = []
  const args = []

  if (patch.title != null) {
    const t = String(patch.title).trim().slice(0, 40)
    if (!t) throw Object.assign(new Error('群名称不能为空'), { status: 400 })
    sets.push('title = ?')
    args.push(t)
  }
  /* 传空串 = 清空群头像（恢复成名字生成的底图）。
     不特殊处理的话 '' 会作为一个真值写进库，前端 `avatar || 兜底` 看着没事，
     但它既不是 preset 也不是文件，语义上是个「空头像」，跟「没设头像」分不开。 */
  if (patch.avatar != null) {
    sets.push('avatar = ?')
    args.push(String(patch.avatar).trim().slice(0, 300) || null)
  }
  if (patch.announcement != null) {
    sets.push('announcement = ?')
    args.push(String(patch.announcement).trim().slice(0, 500) || null)
    sets.push('announcement_at = ?')
    args.push(Math.floor(Date.now() / 1000))
  }
  if (patch.muteAll != null) {
    sets.push('mute_all = ?')
    args.push(patch.muteAll ? 1 : 0)
  }
  if (patch.adminOnly != null) {
    sets.push('admin_only = ?')
    args.push(patch.adminOnly ? 1 : 0)
  }

  if (!sets.length) return false
  await q.run(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`, ...args, conversationId)
  return true
}

/** 邀请成员进群。已经在群里的人跳过（成员表主键挡重复）。 */
export async function addMembers(conversationId, userIds) {
  const ids = Array.from(new Set(userIds.map(Number).filter(Boolean)))
  const joined = []
  for (const uid of ids) {
    const exists = await q.get('SELECT 1 FROM users WHERE id = ?', uid)
    if (!exists) continue
    const already = await isMember(conversationId, uid)
    if (!already) {
      await q.run(
        'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
        conversationId,
        uid,
        'member'
      )
    }
    joined.push(uid)
  }
  return joined
}

/**
 * 把某人移出群聊。
 *
 * 群主移不掉 —— 不然群里会出现「没有群主」的状态，
 * 而管理员的管理权限是从群主那里来的，群主一没整套权限模型就悬空了。
 * 要换人得先转让（本次未做，界面上也不给入口）。
 */
export async function removeMember(conversationId, userId, operatorId) {
  const target = await memberRole(conversationId, userId)
  if (!target) return { ok: false, status: 404, error: '对方不在这个群里' }
  if (target === 'owner') {
    return { ok: false, status: 403, error: '不能移出群主' }
  }
  // 管理员只能移除普通成员；移除管理员是群主的权力
  if (target === 'admin' && !(await isOwner(conversationId, operatorId))) {
    return { ok: false, status: 403, error: '只有群主可以移出管理员' }
  }

  await q.run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversationId, userId)
  return { ok: true }
}

/** 设 / 撤管理员。只有群主能做，且不能对自己操作（群主降级自己是不允许的）。 */
export async function setMemberRole(conversationId, userId, role, operatorId) {
  if (!(await isOwner(conversationId, operatorId))) {
    return { ok: false, status: 403, error: '只有群主可以设置管理员' }
  }
  const target = await memberRole(conversationId, userId)
  if (!target) return { ok: false, status: 404, error: '对方不在这个群里' }
  if (target === 'owner') {
    return { ok: false, status: 403, error: '群主不需要再设为管理员' }
  }
  if (!['admin', 'member'].includes(role)) {
    return { ok: false, status: 400, error: '角色只能是 admin 或 member' }
  }

  await q.run(
    'UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?',
    role,
    conversationId,
    userId
  )
  return { ok: true, role }
}

/** 群聊的出参：带上公告与群设置，前端设置面板要用 */
export async function groupMeta(conversationId) {
  const c = await q.get(
    `SELECT id, type, title, avatar, owner_id AS ownerId, announcement,
            announcement_at AS announcementAt, mute_all AS muteAll, admin_only AS adminOnly
     FROM conversations WHERE id = ?`,
    conversationId
  )
  if (!c) return null
  return {
    id: c.id,
    type: c.type,
    title: c.title,
    avatar: c.avatar,
    ownerId: c.ownerId,
    announcement: c.announcement || null,
    announcementAt: c.announcementAt ? c.announcementAt * 1000 : null,
    muteAll: !!c.muteAll,
    adminOnly: !!c.adminOnly,
  }
}

/** 置顶 / 免打扰：属于「成员个人偏好」，写在 conversation_members 上 */
export async function setMemberFlags(conversationId, userId, { pinned, muted } = {}) {
  if (pinned != null) {
    await q.run(
      'UPDATE conversation_members SET pinned = ? WHERE conversation_id = ? AND user_id = ?',
      pinned ? 1 : 0,
      conversationId,
      userId
    )
  }
  if (muted != null) {
    await q.run(
      'UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND user_id = ?',
      muted ? 1 : 0,
      conversationId,
      userId
    )
  }
}

/** 删除会话 = 退出成员关系；群主退出后若无人则整条会话回收 */
export async function leaveConversation(conversationId, userId) {
  await q.run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversationId, userId)
  const left = (await q.get('SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ?', conversationId)).n
  if (left === 0) await q.run('DELETE FROM conversations WHERE id = ?', conversationId)
}

/* ================= 消息 ================= */
export async function createMessage({
  conversationId,
  senderId,
  kind = 'text',
  content = null,
  fileUrl = null,
  fileName = null,
  fileSize = null,
  audioDurationMs = null,
  replyToId = null,
  geo = null,
  pollId = null,
}) {
  const now = Date.now()
  const encryptionSetting = kind === 'text' && content != null
    ? await q.get("SELECT value FROM user_settings WHERE user_id = ? AND key = 'message_encryption'", senderId)
    : null
  const encrypted = encryptionSetting?.value === 'true' || encryptionSetting?.value === '"true"'
  const storedContent = encrypted ? encryptMessageText(content) : content
  const id = await insert(
    `INSERT INTO messages
       (conversation_id, sender_id, kind, content, content_encrypted, file_url, file_name, file_size, audio_duration_ms, reply_to_id, created_at,
        geo_name, geo_address, geo_lat, geo_lng, poll_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    conversationId,
    senderId,
    kind,
    storedContent,
    encrypted ? 1 : 0,
    fileUrl,
    fileName,
    fileSize,
    audioDurationMs,
    replyToId,
    now,
    geo?.name ?? null,
    geo?.address ?? null,
    Number.isFinite(geo?.lat) ? geo.lat : null,
    Number.isFinite(geo?.lng) ? geo.lng : null,
    pollId ?? null
  )
  await touchConversation(conversationId)
  return getMessage(id)
}

/**
 * 写一条通话记录（kind='call'）。
 *
 * ⚠️ **只能由服务端在通话收尾时调用**。`routes/messages.js` 的发送白名单里没有 'call' ——
 * 否则任何客户端都能给自己伪造一条「通话 99 分钟」，而通话记录的价值就在于它是事实。
 *
 * 四个结果的口径（和 ws.js 的状态机一一对应）：
 *   ended      接通后正常结束（含对方断线）
 *   missed     振铃超时，被叫没接
 *   declined   被叫拒接
 *   cancelled  主叫在接通前取消
 */
export async function recordCallMessage({
  conversationId,
  callerId,
  media = 'audio',
  state = 'ended',
  durationSec = 0,
  endedAt = Date.now(),
}) {
  const mediaValue = media === 'video' ? 'video' : 'audio'
  const stateValue = ['ended', 'missed', 'declined', 'cancelled'].includes(state) ? state : 'ended'
  /* 只有接通过的通话才有「时长」；未接通一律 0，不要拿振铃时间冒充通话时间。 */
  const durationMs = stateValue === 'ended' ? Math.max(0, Math.round(Number(durationSec) || 0)) * 1000 : 0
  const id = await insert(
    `INSERT INTO messages
       (conversation_id, sender_id, kind, content, content_encrypted, audio_duration_ms, call_media, call_state, created_at)
     VALUES (?, ?, 'call', NULL, 0, ?, ?, ?, ?)`,
    conversationId,
    callerId,
    durationMs,
    mediaValue,
    stateValue,
    endedAt
  )
  await touchConversation(conversationId)
  return getMessage(id)
}

export async function getMessage(id) {
  const m = await q.get(
    `SELECT id, conversation_id AS conversationId, sender_id AS senderId, kind,
            content, content_encrypted AS contentEncrypted, burn_at AS burnAt,
            file_url AS fileUrl, file_name AS fileName, file_size AS fileSize, audio_duration_ms AS audioDurationMs,
            reply_to_id AS replyToId, created_at AS createdAt, revoked_at AS revokedAt,
            geo_name AS geoName, geo_address AS geoAddress, geo_lat AS geoLat, geo_lng AS geoLng,
            poll_id AS pollId, call_media AS callMedia, call_state AS callState
     FROM messages WHERE id = ?`,
    id
  )
  if (!m) return null
  if (m.burnAt && Number(m.burnAt) <= Date.now()) return null
  const sender = await q.get('SELECT id, username, nickname, avatar, bio FROM users WHERE id = ?', m.senderId)
  const replied = m.replyToId ? await getMessage(m.replyToId) : null
  return {
    id: m.id,
    conversationId: m.conversationId,
    sender: publicUser(sender),
    kind: m.kind,
    text: m.revokedAt ? '' : m.contentEncrypted ? decryptMessageText(m.content) : m.content || '',
    encrypted: !!m.contentEncrypted,
    burnAt: m.burnAt || null,
    fileUrl: m.fileUrl,
    fileName: m.fileName,
    fileSize: m.fileSize,
    audioDurationMs: m.audioDurationMs == null ? null : Number(m.audioDurationMs),
    /* 位置消息的正文。坐标可能为 null（历史消息 / 只给了名字），
       前端据此决定「只显示名字」还是「能点开地图」—— 别拿 0 当兜底，0,0 是几内亚湾。 */
    geo:
      m.kind === 'location'
        ? { name: m.geoName || '', address: m.geoAddress || '', lat: m.geoLat, lng: m.geoLng }
        : null,
    /* 投票消息只带一个 id，**不带题目 / 选项 / 票数**：
       票数是会变的，塞进消息出参就意味着「拉一页历史 = 拉一页投票明细」，
       而聊天记录里绝大多数消息根本不是投票。前端拿 id 集合走 `GET /polls?ids=` 批量换。 */
    pollId: m.kind === 'poll' ? m.pollId : null,
    /* 通话记录：媒体类型 + 结果。时长复用 audioDurationMs —— 对通话来说它就是「通话多长」，
       没必要再加一列。前端据此画气泡（未接 / 已拒绝 / 03:12）。 */
    callMedia: m.kind === 'call' ? m.callMedia || 'audio' : null,
    callState: m.kind === 'call' ? m.callState || 'ended' : null,
    replyTo: replied
      ? { id: replied.id, senderName: replied.sender.nickname, text: replied.text.slice(0, 40) }
      : null,
    createdAt: m.createdAt,
    revoked: !!m.revokedAt,
  }
}

/**
 * 取会话里的消息。
 *
 * ## 两个方向
 *
 * - `beforeId`：**向前翻历史**（聊到上面去）。
 * - `afterId`：**向后取增量**（多端同步用）。
 *
 * ## 为什么需要 afterId
 *
 * 多端场景下，新设备登录、或某台设备断网很久后重连，
 * 它需要知道「我错过的那些消息」—— 只向前翻是翻不出来的
 * （那是历史方向）。`messages.id` 是全局自增主键，
 * 所以「id > 我最后看到的那条」天然就是增量区间，且不漏不重。
 *
 * 两个参数**互斥**：同时给会以 afterId 为准（增量优先 ——
 * 客户端在重连时更可能想要「补齐错过的」）。
 *
 * @param {number} conversationId
 * @param {{ limit?: number, beforeId?: number|null, afterId?: number|null }} [options]
 */
export async function listMessages(conversationId, { limit = 50, beforeId = null, afterId = null } = {}) {
  let rows
  if (afterId != null) {
    /* 增量方向：取 id > afterId 的，**按 id 升序**返回（客户端按顺序追加）。 */
    rows = await q.all(
      `SELECT id FROM messages WHERE conversation_id = ? AND id > ? AND (burn_at IS NULL OR burn_at > ?) ORDER BY id ASC LIMIT ?`,
      conversationId, afterId, Date.now(), limit
    )
    /* getMessage 是逐条查的（每条还要查发送者），Promise.all 保持入参顺序。 */
    return Promise.all(rows.map((r) => getMessage(r.id)))
  }

  const sql = beforeId
    ? `SELECT id FROM messages WHERE conversation_id = ? AND id < ? AND (burn_at IS NULL OR burn_at > ?) ORDER BY id DESC LIMIT ?`
    : `SELECT id FROM messages WHERE conversation_id = ? AND (burn_at IS NULL OR burn_at > ?) ORDER BY id DESC LIMIT ?`
  rows = beforeId ? await q.all(sql, conversationId, beforeId, Date.now(), limit) : await q.all(sql, conversationId, Date.now(), limit)
  /* Promise.all 保持入参顺序 —— 这里靠它，`getMessage` 是逐条查的（每条还要查发送者）。 */
  return (await Promise.all(rows.map((r) => getMessage(r.id)))).reverse()
}

/**
 * 引用目标校验。返回「落库用的 reply_to_id」（合法时是数字，无引用时是 null），
 * 不合法直接抛 `{status, message}` —— 调用方（routes）按 status 转状态码。
 *
 * 和 canSpeak 一样的理由下沉到这里：引用校验有三个调用点（普通发送 / 发起投票 /
 * 转发），各抄一份的话迟早走岔（比如投票的链路就漏了）。
 * 判据见 routes/messages.js 那段注释：存在性 / 同会话 / 未撤回，
 * 不存在与无权看同为 404。
 */
export async function assertReplyTo(conversationId, replyToId) {
  if (replyToId == null || replyToId === '') return null
  const rid = Number(replyToId)
  if (!Number.isFinite(rid)) {
    throw Object.assign(new Error('引用消息 id 非法'), { status: 400 })
  }
  const target = await getMessage(rid)
  if (!target || target.conversationId !== conversationId) {
    throw Object.assign(new Error('被引用的消息不存在或不在本会话'), { status: 404 })
  }
  if (target.revoked) {
    throw Object.assign(new Error('被引用的消息已被撤回'), { status: 400 })
  }
  return rid
}

/** 撤回：仅本人、仅 2 分钟内 */
export async function revokeMessage(messageId, userId) {
  const m = await q.get('SELECT id, sender_id AS senderId, created_at AS createdAt, kind FROM messages WHERE id = ?', messageId)
  if (!m) return { ok: false, status: 404, error: '消息不存在' }
  if (m.senderId !== userId) return { ok: false, status: 403, error: '只能撤回自己的消息' }
  /* 通话记录是事实，不是用户发出去的内容：撤掉它等于把「打过这通电话」抹掉，
     而对方那边已经响过铃、进过通话页。 */
  if (m.kind === 'call') return { ok: false, status: 400, error: '通话记录不能撤回' }

  const MAX = 2 * 60 * 1000
  if (Date.now() - m.createdAt > MAX) return { ok: false, status: 400, error: '超过 2 分钟无法撤回' }

  await q.run('UPDATE messages SET revoked_at = ?, content = NULL, content_encrypted = 0 WHERE id = ?', Date.now(), messageId)
  return { ok: true, message: await getMessage(messageId) }
}

/* ================= 已读 ================= */
export async function markRead(conversationId, userId, uptoMessageId = null) {
  const current = await q.get(
    'SELECT last_read_message_id AS v FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    conversationId,
    userId
  )
  if (!current) return { ok: false, status: 403, error: '不是会话成员' }

  let target = uptoMessageId
  if (target == null) {
    const last = await q.get('SELECT COALESCE(MAX(id),0) AS v FROM messages WHERE conversation_id = ?', conversationId)
    target = last.v
  }
  target = Math.max(Number(target) || 0, Number(current.v) || 0)
  await q.run('UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?', target, conversationId, userId)
  const setting = await q.get("SELECT value FROM user_settings WHERE user_id = ? AND key = 'burn_after_read'", userId)
  let burnMessages = []
  if (setting?.value === 'true' || setting?.value === '"true"') {
    const burnAt = Date.now() + 30_000
    await q.run(
      `UPDATE messages SET burn_at = ? WHERE conversation_id = ? AND sender_id != ?
       AND id <= ? AND burn_at IS NULL AND revoked_at IS NULL AND kind = 'text'`,
      burnAt, conversationId, userId, target
    )
    burnMessages = await q.all(
      'SELECT id, burn_at AS burnAt FROM messages WHERE conversation_id = ? AND sender_id != ? AND id <= ? AND burn_at = ?',
      conversationId, userId, target, burnAt
    )
  }
  return { ok: true, lastReadMessageId: target, burnMessages }
}

/** 我的消息在对方侧的已读状态：取所有其他成员的最小 last_read */
export async function readCursor(conversationId, myId) {
  const row = await q.get(
    `SELECT COALESCE(MIN(m.last_read_message_id), 0) AS v
     FROM conversation_members m
     LEFT JOIN user_settings s ON s.user_id = m.user_id AND s.key = 'read_receipts'
     WHERE m.conversation_id = ? AND m.user_id != ?
       AND COALESCE(s.value, 'true') NOT IN ('false', '"false"')`,
    conversationId,
    myId
  )
  return row ? Number(row.v) : 0
}

export async function memberIds(conversationId) {
  const rows = await q.all('SELECT user_id AS id FROM conversation_members WHERE conversation_id = ?', conversationId)
  return rows.map((r) => r.id)
}

/* ================= 转发 ================= */

/* 转发允许的消息类型。poll 不在里面 —— 投票是「某次发起」的记录，
   票数、截止、匿名都绑在原会话的 polls 行上，复制一条 kind='poll' 的消息
   过去只会得到一个悬空的 poll_id（新会话没有那次投票）。
   要转投票请对方去原会话参与，这是产品语义，不是技术限制。 */
const FORWARDABLE_KINDS = ['text', 'image', 'file', 'video', 'location']

/**
 * 把一批消息逐条重发到目标会话。返回 { ok, forwarded: [...], skipped: [...] }。
 *
 * 语义上是「复制」，不是「移动」：原消息不动，新消息的发送者是转发人。
 * 逐条的失败不影响其它条（skipped 里带原因），和批量收藏同一个口径。
 *
 * 每条必过的门：
 *   - 原消息存在，否则 404（不泄漏）
 *   - 转发人是原会话成员，否则 403（消息 id 自增可猜，不能拿 id 当鉴权）
 *   - 原消息未撤回（撤回的消息 text 已被抹空，转过去是条空消息）
 *   - kind 可转（poll 不可转，见上）
 *   - 引用（reply_to）**剥离**：replyTo 指向原会话的某条消息，
 *     原样带过去会在目标会话挂一个点不开的引用。转发是「内容搬运」，
 *     不是「关系搬运」。
 *
 * 目标会话的门（canSpeak）在路由层统一判一次，不在循环里逐条判。
 */
export async function forwardMessages(sourceIds, targetConversationId, senderId) {
  const ids = Array.from(new Set((sourceIds || []).map(Number).filter(Boolean)))
  const forwarded = []
  const skipped = []

  for (const mid of ids) {
    const src = await getMessage(mid)
    if (!src) {
      skipped.push({ messageId: mid, reason: '消息不存在' })
      continue
    }
    if (src.conversationId == null || !(await isMember(src.conversationId, senderId))) {
      skipped.push({ messageId: mid, reason: '无权查看原消息' })
      continue
    }
    if (src.revoked) {
      skipped.push({ messageId: mid, reason: '该消息已被撤回' })
      continue
    }
    if (!FORWARDABLE_KINDS.includes(src.kind)) {
      skipped.push({ messageId: mid, reason: `该类型消息不支持转发（${src.kind}）` })
      continue
    }

    const msg = await createMessage({
      conversationId: targetConversationId,
      senderId,
      kind: src.kind,
      content: src.text || null,
      fileUrl: src.fileUrl,
      fileName: src.fileName,
      fileSize: src.fileSize,
      replyToId: null,
      geo:
        src.kind === 'location' && src.geo
          ? { name: src.geo.name, address: src.geo.address, lat: src.geo.lat, lng: src.geo.lng }
          : null,
      pollId: null,
    })
    forwarded.push(msg)
  }

  return { ok: true, forwarded, skipped }
}
