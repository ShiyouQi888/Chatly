/**
 * /api/v1/conversations —— 会话列表、创建、消息、已读
 *
 * ⚠️ 所有 handler 都是 **async**：数据层现在是异步的（PG 驱动下 q.* 真的是 Promise）。
 *    少写一个 await 不会报错，只会把 Promise 当成数据发出去 ——
 *    症状是接口 200、字段全是 `{}`，从报错里完全看不出问题。
 *    Express 5 会把 async handler 的 reject 转给错误中间件，所以不用包 try/catch。
 */
import { Router } from 'express'
import { authRequired } from '../auth.js'
import { q } from '../db.js'
import {
  listConversations,
  listMessages,
  ensurePrivate,
  createGroup,
  isMember,
  listMembers,
  markRead,
  readCursor,
  memberIds,
  setMemberFlags,
  leaveConversation,
  canManage,
  memberRole,
  updateGroup,
  createMessage,
  addMembers,
  removeMember,
  setMemberRole,
  groupMeta,
} from '../chat.js'
import { broadcastToUsers } from '../ws.js'
import { isValidAvatarValue } from '../profile.js'
import { uploadExists } from '../upload.js'
import { favoritedMessageIds } from '../favorite.js'
import { notifyAnnouncement } from '../notification.js'
import { privatePairGate } from '../friends.js'

const r = Router()
r.use(authRequired)

/** 公告发布也进入群消息流，方便成员从聊天记录里看到公告正文。 */
async function publishAnnouncementMessage(conversationId, senderId, text) {
  const message = await createMessage({
    conversationId,
    senderId,
    kind: 'text',
    content: `📢 群公告\n${text}`,
  })
  broadcastToUsers(await memberIds(conversationId), 'message.new', { message })
}

/** 我的会话列表 */
r.get('/', async (req, res) => {
  res.json({ conversations: await listConversations(req.user.id) })
})

/** 发起私聊 / 建群 */
r.post('/', async (req, res) => {
  const { type = 'private', userId, title, memberIds = [] } = req.body || {}

  if (type === 'group') {
    if (!title) return res.status(400).json({ error: '群聊需要名称' })
    const ids = Array.isArray(memberIds) ? memberIds.map(Number).filter(Boolean) : []
    if (ids.length === 0) return res.status(400).json({ error: '请至少选择一位成员' })
    const cid = await createGroup(title, ids, req.user.id)
    return res.status(201).json({ conversationId: cid })
  }

  const other = Number(userId)
  if (!other || other === req.user.id) return res.status(400).json({ error: '无效的会话对象' })
  if (!(await q.get('SELECT id FROM users WHERE id = ?', other))) return res.status(404).json({ error: '用户不存在' })
  const denial = await privatePairGate(Number(req.user.id), other)
  if (denial) return res.status(403).json(denial)
  const cid = await ensurePrivate(req.user.id, other)
  res.status(201).json({ conversationId: cid })
})

/**
 * 会话更新，两类字段走同一个接口：
 *   - **个人偏好**：pinned / muted（写在我自己的成员行上，谁都能改自己的）
 *   - **群资料 / 群设置**：title / avatar / announcement / muteAll / adminOnly（只有群主和管理员能改）
 *
 * 分开两个接口会让前端「改个群名」和「开个免打扰」走两条完全不同的路，没必要。
 */
r.patch('/:id', async (req, res) => {
  const cid = Number(req.params.id)
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: '无权访问该会话' })

  const { pinned, muted, title, avatar, announcement, muteAll, adminOnly } = req.body || {}

  const groupPatch = { title, avatar, announcement, muteAll, adminOnly }
  const wantsGroupChange = Object.values(groupPatch).some((v) => v != null)
  if (wantsGroupChange && !(await canManage(cid, req.user.id))) {
    return res.status(403).json({ error: '只有群主和管理员可以修改群资料' })
  }

  /* 群头像和用户头像同一套规则：只能是预设或自家 /uploads 下的文件。
     不校验的话客户端能把任意 URL 写成群头像，别人一进群就去请求那个地址（外链 + 追踪）。
     还要查文件真的存在 —— 语法合法但文件没了会留下一张永远的破图。 */
  if (avatar != null && avatar !== '') {
    if (!isValidAvatarValue(avatar)) {
      return res.status(400).json({ error: '群头像取值非法（只支持内置预设或本地上传）' })
    }
    if (avatar.startsWith('/uploads/') && !uploadExists(avatar)) {
      return res.status(400).json({ error: '这张头像文件已经不在了，请重新上传' })
    }
  }

  const hasPref = pinned != null || muted != null
  if (!hasPref && !wantsGroupChange) return res.status(400).json({ error: '没有需要更新的字段' })

  if (hasPref) await setMemberFlags(cid, req.user.id, { pinned, muted })

  let meta = null
  if (wantsGroupChange) {
    try {
      await updateGroup(cid, groupPatch)
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message })
    }
    meta = await groupMeta(cid)
    /* 群资料变了要推给**所有成员**：别人开着群聊页，群名一改他的标题栏还是旧的，
       只有刷新才变 —— 那不叫实时。 */
    broadcastToUsers(await memberIds(cid), 'conversation.updated', { conversationId: cid, meta })

    /* 只有公告**真的写了内容**才发通知。清空公告（announcement=''）不该
       给全群发一条「群公告已更新」—— 那是打扰，不是信息。
       这一条对应「消息通知」页里的「群通知」开关。 */
    const text = String(announcement ?? '').trim()
    if (text) {
      await publishAnnouncementMessage(cid, req.user.id, text)
      /* 每次发布都是一次新的提醒。用公告更新时间作为版本标识，避免成员尚未
         读上一条通知时，通知去重逻辑把本次修改误判为重复事件。 */
      await notifyAnnouncement({
        conversationId: cid,
        ownerId: req.user.id,
        excerpt: text,
        revision: Date.now(),
      })
    }
  }

  res.json({
    ok: true,
    pinned: pinned != null ? !!pinned : undefined,
    muted: muted != null ? !!muted : undefined,
    meta: meta || undefined,
  })
})

/** 重新置顶并通知群成员。公告在聊天页固定显示，此操作会刷新置顶时间并重新推送。 */
r.post('/:id/announcement/push', async (req, res) => {
  const cid = Number(req.params.id)
  if (!(await isMember(cid, req.user.id))) return res.status(404).json({ error: '群聊不存在或你已不在群里' })
  if (!(await canManage(cid, req.user.id))) return res.status(403).json({ error: '只有群主和管理员可以推送群公告' })

  const conversation = await q.get('SELECT type, announcement FROM conversations WHERE id = ?', cid)
  if (!conversation || conversation.type !== 'group') return res.status(404).json({ error: '群聊不存在' })
  const announcement = String(conversation.announcement || '').trim()
  if (!announcement) return res.status(400).json({ error: '请先发布群公告' })

  await updateGroup(cid, { announcement })
  await publishAnnouncementMessage(cid, req.user.id, announcement)
  const meta = await groupMeta(cid)
  const users = await memberIds(cid)
  broadcastToUsers(users, 'conversation.updated', { conversationId: cid, meta })
  await notifyAnnouncement({
    conversationId: cid,
    ownerId: req.user.id,
    excerpt: announcement,
    revision: Date.now(),
  })
  res.json({ ok: true, meta })
})

/* ================= 群成员管理 ================= */

/** 邀请成员进群（群主和管理员可邀请，普通成员也可以拉人 —— 群里拉人是常态） */
r.post('/:id/members', async (req, res) => {
  const cid = Number(req.params.id)
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: '无权访问该会话' })

  const c = await q.get('SELECT type FROM conversations WHERE id = ?', cid)
  if (!c || c.type !== 'group') return res.status(400).json({ error: '只有群聊可以添加成员' })

  const ids = Array.isArray(req.body?.userIds) ? req.body.userIds : []
  if (!ids.length) return res.status(400).json({ error: '请选择要邀请的成员' })

  const joined = await addMembers(cid, ids)
  if (!joined.length) return res.status(400).json({ error: '没有可邀请的成员' })

  const meta = await groupMeta(cid)
  broadcastToUsers(await memberIds(cid), 'conversation.updated', { conversationId: cid, meta })
  res.status(201).json({ ok: true, joined, memberCount: (await listMembers(cid)).length })
})

/** 移出成员 / 自己退出群聊（删的是自己就是退出） */
r.delete('/:id/members/:userId', async (req, res) => {
  const cid = Number(req.params.id)
  const target = Number(req.params.userId)
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: '无权访问该会话' })

  const leaving = target === req.user.id
  /* 退出不需要管理权限；移出别人必须能管群 */
  if (!leaving && !(await canManage(cid, req.user.id))) {
    return res.status(403).json({ error: '只有群主和管理员可以移出成员' })
  }

  const out = await removeMember(cid, target, req.user.id)
  if (!out.ok) return res.status(out.status).json({ error: out.error })

  const meta = await groupMeta(cid)
  /* 被移出的人也要收到通知，否则他的列表里还挂着这个群，
     点进去才会发现「已经不在群里了」—— 体验很差。
     ⚠️ 名单要在移除之后取（他现在已经不在里面了），所以必须**单独把他加回去**。 */
  broadcastToUsers([...(await memberIds(cid)), target], 'conversation.updated', {
    conversationId: cid,
    meta,
    removedUserId: target,
  })
  res.json({ ok: true, removedUserId: target })
})

/** 设 / 撤管理员（仅群主） */
r.patch('/:id/members/:userId', async (req, res) => {
  const cid = Number(req.params.id)
  const target = Number(req.params.userId)
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: '无权访问该会话' })

  const { role } = req.body || {}
  if (!role) return res.status(400).json({ error: '缺少角色' })

  const out = await setMemberRole(cid, target, String(role), req.user.id)
  if (!out.ok) return res.status(out.status).json({ error: out.error })

  const meta = await groupMeta(cid)
  broadcastToUsers(await memberIds(cid), 'conversation.updated', { conversationId: cid, meta })
  res.json({ ok: true, userId: target, role: out.role })
})

/** 群成员（带角色） */
r.get('/:id/members', async (req, res) => {
  const cid = Number(req.params.id)
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: '无权访问该会话' })
  res.json({
    members: await listMembers(cid),
    meta: await groupMeta(cid),
    myRole: await memberRole(cid, req.user.id),
  })
})

/** 删除会话（退出成员关系） */
r.delete('/:id', async (req, res) => {
  const cid = Number(req.params.id)
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: '无权访问该会话' })

  await leaveConversation(cid, req.user.id)
  res.json({ ok: true })
})

/** 历史消息（分页：beforeId 向前翻页） */
r.get('/:id/messages', async (req, res) => {
  const cid = Number(req.params.id)
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: '无权访问该会话' })

  const rawLimit = req.query.limit
  const parsedLimit = rawLimit == null || rawLimit === '' ? 50 : Number(rawLimit)
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1) {
    return res.status(400).json({ error: 'limit 必须是 1 到 100 之间的正整数' })
  }
  const limit = Math.min(parsedLimit, 100)
  const rawBeforeId = req.query.beforeId
  const beforeId = rawBeforeId == null || rawBeforeId === '' ? null : Number(rawBeforeId)
  if (beforeId !== null && (!Number.isSafeInteger(beforeId) || beforeId < 1)) {
    return res.status(400).json({ error: 'beforeId 必须是正整数' })
  }
  const messages = await listMessages(cid, { limit, beforeId })
  const cursor = await readCursor(cid, req.user.id)
  /* 这一页里我收藏了哪些 —— 一次 IN 查询算完，别在出参里逐条查。
     长按菜单要靠它把「收藏」显示成「取消收藏」，没有这个字段前端只能
     等菜单点开再问一次接口（那会闪一下）。 */
  const faved = await favoritedMessageIds(
    req.user.id,
    messages.map((m) => m.id)
  )

  res.json({
    messages: messages.map((m) => ({
      ...m,
      read: m.sender.id === req.user.id ? m.id <= cursor : undefined,
      favorited: faved.has(m.id),
    })),
    hasMore: messages.length === limit,
  })
})

/** 标记已读 */
r.post('/:id/read', async (req, res) => {
  const cid = Number(req.params.id)
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: '无权访问该会话' })

  const upto = req.body?.messageId ? Number(req.body.messageId) : null
  const out = await markRead(cid, req.user.id, upto)
  if (!out.ok) return res.status(out.status).json({ error: out.error })

  // 关键：把已读推进推给同会话其他人，否则对端的「已读」标记永远不会实时变。
  // 发送者也包含在内（多端同步），前端按 userId 过滤掉自己即可。
  const recipients = await memberIds(cid)
  const receiptSetting = await q.get("SELECT value FROM user_settings WHERE user_id = ? AND key = 'read_receipts'", req.user.id)
  if (receiptSetting?.value !== 'false' && receiptSetting?.value !== '"false"') {
    broadcastToUsers(recipients, 'conversation.read', {
      conversationId: cid,
      userId: req.user.id,
      lastReadMessageId: out.lastReadMessageId,
    })
  }
  for (const item of out.burnMessages) {
    broadcastToUsers(recipients, 'message.burn', { conversationId: cid, messageId: item.id, burnAt: item.burnAt })
  }

  res.json({ lastReadMessageId: out.lastReadMessageId, burnMessages: out.burnMessages })
})

export default r
