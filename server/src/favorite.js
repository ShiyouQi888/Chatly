/**
 * 消息收藏业务逻辑（PRD §9「长按消息 → 收藏」、「消息多选批量 → 收藏」）
 *
 * 只管数据，不做 HTTP —— 与 chat.js / moment.js / poll.js 同一套分层。
 *
 * ## 一条硬规矩：收藏是**快照**
 *
 * 收藏下来的内容不跟着原消息走。原消息被撤回、被清理、会话被删，
 * 收藏里的这一条**必须还在**，文字和文件地址都在。
 * 做成引用的话，对方一撤回消息，你的收藏就变成一条空记录 —— 那不叫收藏。
 *
 * 所以：
 *   · 文字 / 文件地址 / 位置 / 投票 id 全部抄一份进 favorites 行；
 *   · **发送者的昵称和头像不抄** —— 那个会变（用户改了昵称，收藏里不该还是旧名字），
 *     只存 sender_id，渲染时现查；发送者注销了（SET NULL）就退化成「已注销用户」。
 *   · `message_id` 留着只为「在聊天中查看」跳转，`ON DELETE SET NULL`，
 *     消息没了收藏照样活。
 *
 * 由此带来一个**必须一起处理的副作用**：快照的 file_url 是那个文件最后的引用者，
 * 所以 `scripts/lib/debris.mjs` 的 `purgeOrphanUploads()` 必须把它算作引用方，
 * 否则第一次跑清理就把收藏里的图全挪走（界面上集体变破图）。
 */
import { q, insert } from './db.js'
import { decryptMessageText } from './message-crypto.js'

/** 收藏列表一次最多返回多少条（再把 hasMore 告诉前端） */
export const PAGE_SIZE = 30

function bad(status, error) {
  return Object.assign(new Error(error), { status })
}

/* ================= 快照 ================= */

/**
 * 从一条消息行里抄出快照字段。
 *
 * 用 `SELECT *` 形状的原始行（chat.js 的 getMessage 出参也行）——
 * 这里刻意**不依赖 getMessage 的 camelCase 出参**：那个出参对已撤回的消息
 * 会把 text 抹成空串、把 fileUrl 留着，两处语义不同容易搞混。
 * 直接从 messages 表读，字段名就是库里的名字，一眼能对上。
 */
async function snapshotOf(messageId) {
  const m = await q.get(
    `SELECT id, conversation_id AS conversationId, sender_id AS senderId, kind,
            content, content_encrypted AS contentEncrypted, file_url AS fileUrl, file_name AS fileName, file_size AS fileSize,
            geo_name AS geoName, geo_address AS geoAddress, geo_lat AS geoLat, geo_lng AS geoLng,
            poll_id AS pollId, revoked_at AS revokedAt
     FROM messages WHERE id = ? AND (burn_at IS NULL OR burn_at > ?)`,
    messageId,
    Date.now()
  )
  return m || null
}

/**
 * 收藏一条消息。
 *
 * 幂等：已经收藏过就返回既有那一行（附带 `created:false`），不报错也不重复插入。
 * 前端「收藏 / 取消收藏」是一个开关，重复点不该炸。
 *
 * @returns {{ok:true, favorite:object, created:boolean}}
 */
export async function addFavorite(userId, messageId) {
  const mid = Number(messageId)
  if (!mid) throw bad(400, '消息 id 非法')

  const msg = await snapshotOf(mid)
  if (!msg) throw bad(404, '消息不存在')

  /* ⚠️ 「已经收藏过」必须排在「已撤回」**前面**。
     一条消息先被收藏、之后被撤回时：用户点「收藏」期望的是「它已经在收藏里了」，
     而不是一句「已撤回，不能收藏」—— 那会让人以为收藏丢了。
     幂等返回既有那一条，语义才对。 */
  const existed = await q.get(
    'SELECT id FROM favorites WHERE user_id = ? AND message_id = ?',
    userId,
    mid
  )
  if (existed) return { ok: true, favorite: await viewFavorite(existed.id, userId), created: false }

  /* 已撤回的消息**不给收藏**：快照下来就是一条「消息已撤回」，
     收藏它没有任何意义，而且用户会以为收藏失败了（列表里一条空记录）。
     明确拒绝，让界面给一句「这条消息已撤回，不能收藏」。 */
  if (msg.revokedAt) throw bad(400, '这条消息已撤回，不能收藏')

  const id = await insert(
    `INSERT INTO favorites
       (user_id, message_id, conversation_id, sender_id, kind, content, content_encrypted,
        file_url, file_name, file_size, geo_name, geo_address, geo_lat, geo_lng, poll_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    userId,
    mid,
    msg.conversationId,
    msg.senderId,
    msg.kind,
    msg.content,
    msg.contentEncrypted ? 1 : 0,
    msg.fileUrl,
    msg.fileName,
    msg.fileSize,
    msg.geoName,
    msg.geoAddress,
    msg.geoLat,
    msg.geoLng,
    msg.pollId,
    Date.now()
  )

  return { ok: true, favorite: await viewFavorite(id, userId), created: true }
}

/** 已撤回的消息不允许收藏 —— 路由用它给出提前拦截（不必等 addFavorite 抛错） */
export async function isRevoked(messageId) {
  const m = await q.get('SELECT revoked_at AS r FROM messages WHERE id = ?', Number(messageId))
  return !!m?.r
}

/**
 * 这条消息属于哪个会话（路由做「你是不是这个会话的成员」的鉴权要用）。
 *
 * ⚠️ 必须单独查一次：`addFavorite` 内部虽然知道 conversationId，
 * 但它是在**快照之后**才知道的 —— 那时候已经晚了。
 * 消息 id 是自增的、很好猜，不先鉴权就等于「知道 id 就能收藏别人私聊里的消息」。
 */
export async function conversationOfMessage(messageId) {
  const m = await q.get('SELECT conversation_id AS cid FROM messages WHERE id = ?', Number(messageId))
  return m ? m.cid : null
}

/** 批量收藏。返回逐条结果，**部分失败不影响其它条**（多选里混着一条已撤回的）。 */
export async function addFavorites(userId, messageIds) {
  const ids = Array.from(new Set((messageIds || []).map(Number).filter(Boolean)))
  if (!ids.length) throw bad(400, '请至少选择一条消息')
  if (ids.length > 50) throw bad(400, '一次最多收藏 50 条')

  const added = []
  const skipped = []
  /* 这里刻意用 for...of 逐条 await 而不是 Promise.all：批量收藏要**逐条 try/catch**，
     而且数量上限只有 50 条。并行化会把「单条失败不中断整批」这条语义搞复杂。 */
  for (const mid of ids) {
    try {
      const out = await addFavorite(userId, mid)
      if (out.created) added.push(out.favorite)
    } catch (e) {
      /* 单条失败（已撤回 / 不存在）只记下来，不中断整批 ——
         否则用户选了 10 条，其中一条是撤回的，结果一条都没收藏上。 */
      skipped.push({ messageId: mid, reason: e.message })
    }
  }
  return { ok: true, added, skipped }
}

/* ================= 查询 ================= */

/** 收藏行的出参。发送者**现查**（昵称/头像会变），拿不到就退化成「已注销用户」。 */
export async function viewFavorite(favoriteId, viewerId) {
  const f = await q.get(
    `SELECT id, user_id AS userId, message_id AS messageId, conversation_id AS conversationId,
            sender_id AS senderId, kind, content, content_encrypted AS contentEncrypted, file_url AS fileUrl, file_name AS fileName,
            file_size AS fileSize, geo_name AS geoName, geo_address AS geoAddress,
            geo_lat AS geoLat, geo_lng AS geoLng, poll_id AS pollId, created_at AS createdAt
     FROM favorites WHERE id = ? AND user_id = ?`,
    favoriteId,
    viewerId
  )
  if (!f) return null

  const sender = f.senderId
    ? await q.get('SELECT id, username, nickname, avatar FROM users WHERE id = ?', f.senderId)
    : null
  /* 这里原本还查了一次 conversations（存进 `conv`），但**从头到尾没被使用** ——
     `canJump` 只看 messageId / conversationId 两个字段，会话在不在它并不关心。
     同步时那只是一次白查；异步化之后 `listFavorites` 每渲染一行就是一次真实往返，
     所以把这段死查询删了。（要恢复「会话不在了就禁用跳转」的话，
     判据应当改成查 conversations 然后把结果并进 canJump，而不是查完丢掉。） */

  return {
    id: f.id,
    messageId: f.messageId,
    conversationId: f.conversationId,
    kind: f.kind,
    text: f.contentEncrypted ? decryptMessageText(f.content) : f.content || '',
    fileUrl: f.fileUrl,
    fileName: f.fileName,
    fileSize: f.fileSize,
    geo:
      f.kind === 'location'
        ? { name: f.geoName || '', address: f.geoAddress || '', lat: f.geoLat, lng: f.geoLng }
        : null,
    pollId: f.kind === 'poll' ? f.pollId : null,
    sender: sender
      ? { id: sender.id, username: sender.username, nickname: sender.nickname, avatar: sender.avatar }
      : null,
    /* 「在聊天中查看」的可用性：**既要原消息还在，也要会话还在**。
       只有 messageId 而没有会话时跳过去会落到一个不存在的房间（点了没反应）。 */
    canJump: !!(f.messageId && f.conversationId),
    createdAt: f.createdAt,
  }
}

/**
 * 我的收藏列表（新到旧，游标分页）。
 *
 * 游标用 `beforeId` 而不是 offset：收藏会在使用过程中增减，
 * offset 分页会出现「翻页时漏掉几条 / 重复几条」——和动态那边同一个取舍。
 */
export async function listFavorites(userId, { beforeId = null, limit = PAGE_SIZE } = {}) {
  const n = Math.min(Math.max(Number(limit) || PAGE_SIZE, 1), 60)
  /* 多取一条判 hasMore —— 比再发一次 COUNT 便宜，也不会有两次查询之间的竞态 */
  const rows = beforeId
    ? await q.all(
        'SELECT id FROM favorites WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        userId,
        Number(beforeId),
        n + 1
      )
    : await q.all('SELECT id FROM favorites WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, n + 1)

  const hasMore = rows.length > n
  const items = (
    await Promise.all(rows.slice(0, n).map((r) => viewFavorite(r.id, userId)))
  ).filter(Boolean)
  return { items, hasMore }
}

/** 收藏总数（我页统计条要用**真数**，不能再是 mock 数组的长度） */
export async function countFavorites(userId) {
  return (await q.get('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?', userId)).n
}

/**
 * 这批消息里，我收藏了哪些 —— 消息出参的 `favorited` 靠它。
 *
 * 一次查完（不是每条消息查一次）：一页 40 条消息就是 40 次查询，
 * 而这里一条 `IN (...)` 就够。返回 Set 给调用方。
 */
export async function favoritedMessageIds(userId, messageIds) {
  const ids = (messageIds || []).map(Number).filter(Boolean)
  if (!ids.length || !userId) return new Set()
  const holes = ids.map(() => '?').join(',')
  const rows = await q.all(
    `SELECT message_id AS id FROM favorites
     WHERE user_id = ? AND message_id IN (${holes})`,
    userId,
    ...ids
  )
  return new Set(rows.map((r) => r.id))
}

/* ================= 取消 ================= */

/** 取消收藏。返回是否真的删掉了一行（没收藏过 → false，不报错，因为开关要幂等）。 */
export async function removeFavorite(userId, favoriteId) {
  const r = await q.run('DELETE FROM favorites WHERE id = ? AND user_id = ?', Number(favoriteId), userId)
  return r.changes > 0
}

/** 按消息取消收藏 —— 消息气泡上的开关走这条（前端手里只有 messageId） */
export async function removeFavoriteByMessage(userId, messageId) {
  const r = await q.run('DELETE FROM favorites WHERE user_id = ? AND message_id = ?', userId, Number(messageId))
  return r.changes > 0
}

/** 批量取消（多选模式里的「取消收藏」） */
export async function removeFavoritesByMessages(userId, messageIds) {
  const ids = Array.from(new Set((messageIds || []).map(Number).filter(Boolean)))
  if (!ids.length) return 0
  const holes = ids.map(() => '?').join(',')
  return (
    await q.run(
      `DELETE FROM favorites WHERE user_id = ? AND message_id IN (${holes})`,
      userId,
      ...ids
    )
  ).changes
}

/**
 * 会话被真删时把收藏里的 conversation_id 摘掉（让「在聊天中查看」自动失效）。
 *
 * 为什么需要它：SQLite 的外键 SET NULL 只在 **conversations 行真的被删**时触发，
 * 而产品里的「删除会话」是**退出成员关系**（会话行还在，别人还在用）。
 * 那种情况下收藏里的会话仍然有效 —— 所以这里只在自检清理（真删）之后兜一下。
 */
export async function detachFavoritesOfConversation(conversationId) {
  return (
    await q.run(
      'UPDATE favorites SET conversation_id = NULL WHERE conversation_id = ?',
      Number(conversationId)
    )
  ).changes
}
