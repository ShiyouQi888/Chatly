/**
 * /api/v1/users —— 用户列表（发起聊天 / 建群）+ 找人 + 查看他人资料 + 好友申请
 *
 * ## 隐私闸在哪一层
 * 三个「添加好友」开关管的是**能不能被找到**，不是「能不能被加」。
 * 所以闸门开在「发现」这一层，并且只在请求**明确声明了渠道**时才生效：
 *   - `GET /users/search?q=`  —— 手机号形态的 q → `add_friend_by_phone`；
 *     其它 → `add_friend_by_search`。命中闸门的人**直接不出现在结果里**。
 *   - `GET /users/by-username/:username?from=qr` —— `from=qr` 走 `add_friend_by_qr`；
 *     `from=search`（手动输 ID）走 `add_friend_by_search`；不带 `from` 不设闸。
 *     查得到 ≠ 加得上：资料照常返回（你知道这是谁），但 `addable.allowed = false`。
 *   - `POST /users/:id/friend-request` 带 `source` 时再校验一遍 —— 前端可以绕过，
 *     服务端不能只靠界面把按钮禁掉。
 * 不带渠道的入口（群成员列表、发现页推荐）一律放行，见 privacy.js 顶部说明。
 */
import { Router } from 'express'
import { authRequired, publicUser, USER_COLS } from '../auth.js'
import { q, tx } from '../db.js'
import { listUsers } from '../chat.js'
import { profileForViewer, privateConversationWith, userIdByUsername, readProfile, PHONE_RE } from '../profile.js'
import { isOnlineAnywhere, onlineSetOf } from '../ws.js'
import { privacyOf, privacyOfMany, onlineVisible, canAddBy, CHANNEL_KEY } from '../privacy.js'
import { pushNotification } from '../notification.js'
import { unfollow, isFollowing, followCounts, followingIds } from '../moment.js'
import { cancelFriendRequest, createFriendRequest, decideFriendRequest, friendStates, listFriendRequests } from '../friends.js'

const r = Router()
r.use(authRequired)

/* ---------- 好友申请 ---------- */
r.get('/friend-requests', async (req, res) => {
  res.json(await listFriendRequests(Number(req.user.id)))
})

r.post('/friend-requests/:requestId/accept', async (req, res) => {
  const id = Number(req.params.requestId)
  const result = id ? await decideFriendRequest(id, Number(req.user.id), 'accepted') : null
  if (!result) return res.status(404).json({ error: '好友申请不存在或已处理' })
  await pushNotification({ userId: result.requesterId, actorId: result.recipientId, kind: 'follow', refId: result.requestId, body: '已同意你的好友申请' })
  res.json({ ok: true, status: 'friends' })
})

r.post('/friend-requests/:requestId/reject', async (req, res) => {
  const id = Number(req.params.requestId)
  const result = id ? await decideFriendRequest(id, Number(req.user.id), 'rejected') : null
  if (!result) return res.status(404).json({ error: '好友申请不存在或已处理' })
  res.json({ ok: true, status: 'rejected' })
})

r.delete('/friend-requests/:requestId', async (req, res) => {
  const id = Number(req.params.requestId)
  if (!id || !(await cancelFriendRequest(id, Number(req.user.id)))) {
    return res.status(404).json({ error: '好友申请不存在或已处理' })
  }
  res.json({ ok: true, status: 'cancelled' })
})

/* ---------- 通讯录联系人（互相关注） ---------- */
r.get('/contacts', async (req, res) => {
  const rows = await q.all(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.bio
     FROM follows mine
     JOIN follows theirs ON theirs.follower_id = mine.followee_id AND theirs.followee_id = mine.follower_id
     JOIN users u ON u.id = mine.followee_id
     WHERE mine.follower_id = ?
     ORDER BY u.nickname, u.username, u.id`,
    req.user.id
  )
  const ids = rows.map((u) => Number(u.id))
  const [privacy, present] = await Promise.all([privacyOfMany(ids), onlineSetOf(ids)])
  res.json({
    contacts: rows.map((u) => ({
      ...publicUser(u),
      online: onlineVisible(privacy.get(Number(u.id))) && present.has(Number(u.id)),
      following: true,
      followedBy: true,
    })),
  })
})

/* 移除联系人会解除双方关注，确保互关关系和通讯录同时消失。 */
r.delete('/contacts/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!id || id === Number(req.user.id)) return res.status(400).json({ error: '联系人 id 无效' })
  if (!(await q.get('SELECT id FROM users WHERE id = ?', id))) return res.status(404).json({ error: '联系人不存在' })
  const viewerId = Number(req.user.id)
  const now = Date.now()
  await tx(async () => {
    await q.run('DELETE FROM removed_contacts WHERE (user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)', viewerId, id, id, viewerId)
    await q.run('INSERT INTO removed_contacts (user_id, contact_id, removed_at) VALUES (?, ?, ?)', viewerId, id, now)
    await q.run('INSERT INTO removed_contacts (user_id, contact_id, removed_at) VALUES (?, ?, ?)', id, viewerId, now)
    await unfollow(viewerId, id)
    await unfollow(id, viewerId)
  })
  res.json({ ok: true })
})

/* ---------- 用户列表（发起聊天 / 建群） ----------
   在线状态要按**对方**的 `online_status_visible` 门控，所以不能简单地
   `isOnline(u.id)` —— 那等于把「他关掉了在线状态」这件事也一并泄露了。 */
r.get('/', async (req, res) => {
  const rows = await listUsers(req.user.id)
  const ids = rows.map((u) => u.id)
  const [privacy, present] = await Promise.all([privacyOfMany(ids), onlineSetOf(ids)])
  const users = rows.map((u) => ({
    ...u,
    online: onlineVisible(privacy.get(Number(u.id))) && present.has(Number(u.id)),
  }))
  res.json({ users })
})

/**
 * 他人资料的响应体 —— `/:id`、`/by-username/:username`、`/search` 共用一份。
 * 两个入口各拼一遍迟早会长歪（加了个字段只补一边），所以只留一处。
 */
async function viewerPayload(viewerId, targetId, { channel = null } = {}) {
  const profile = await profileForViewer(viewerId, targetId)
  if (!profile) return null

  const isSelf = Number(viewerId) === Number(targetId)
  const privacy = await privacyOf(targetId)
  const online = isSelf
    ? await isOnlineAnywhere(targetId)
    : onlineVisible(privacy) && (await isOnlineAnywhere(targetId))

  return {
    user: profile,
    userId: targetId,
    isSelf,
    online,
    /* 已经聊过就把会话 id 带上，资料页「发消息」可以直接跳进去，不用再建一条 */
    conversationId: await privateConversationWith(viewerId, targetId),
    ...(await followCounts(targetId)),
    /* ⚠️ 这两个布尔必须在展开**之后**：`followCounts` 返回的是数量，
       先写布尔再展开的话，`following` 会被覆盖成一个数字。 */
    following: await isFollowing(viewerId, targetId),
    followedBy: await isFollowing(targetId, viewerId),
    friendStatus: (await friendStates(viewerId, [targetId])).get(Number(targetId)) || 'none',
    /* 只能看、不能加：命中了对方某个渠道的隐私开关时给出原因，界面据此把按钮换掉 */
    addable: isSelf ? { allowed: true, reason: null } : canAddBy(privacy, channel),
  }
}

/* ---------- 关注 ----------
   关注关系不只是「个人主页的数字」：动态的「仅好友可见」就是按**互相关注**判的。
   没有这张表的话，可见范围就是一个点了没反应的假开关。 */
const sendFriendRequest = async (req, res) => {
  const id = Number(req.params.id)
  if (!id || id === Number(req.user.id)) return res.status(400).json({ error: '不能申请添加自己' })

  /* 服务端再校验一遍渠道闸：前端把按钮禁掉是提示，这里才是拦截。
     代码 `privacy_blocked` 让前端能区分「对方不让加」和「别的原因失败」。 */
  const source = typeof req.body?.source === 'string' ? req.body.source : null
  if (source && CHANNEL_KEY[source]) {
    const gate = canAddBy(await privacyOf(id), source)
    if (!gate.allowed) {
      return res.status(403).json({ error: gate.reason, code: 'privacy_blocked' })
    }
  }

  if (!(await q.get('SELECT id FROM users WHERE id = ?', id))) return res.status(404).json({ error: '用户不存在' })
  const request = await createFriendRequest(Number(req.user.id), id)
  if (request.created) {
    await pushNotification({ userId: id, actorId: req.user.id, kind: 'follow', refId: request.requestId, body: '申请添加你为好友' })
  }
  res.json({ ok: true, requestId: request.requestId, friendStatus: request.status, requested: request.status === 'outgoing' })
}

r.post('/:id/friend-request', sendFriendRequest)
/* 旧客户端兼容：原 follow 写操作现在也只会创建待同意申请，不再直接建立关系。 */
r.post('/:id/follow', sendFriendRequest)

r.delete('/:id/follow', async (req, res) => {
  const id = Number(req.params.id)
  await unfollow(req.user.id, id)
  res.json({ ok: true, ...(await followCounts(id)), following: false })
})

/* ---------- 找人（全局搜索） ----------
   和「搜索面板」里那个只搜自己会话 / 动态的本地索引是两回事：
   这里是**在全体用户里找**，所以必须受对方隐私设置约束，命中闸门的人直接不返回。

   ⚠️ 必须注册在 `/:id` **之前**：Express 按顺序匹配，`/search` 会被 `/:id` 抢先吃掉
   （那样 Number('search') 是 NaN，接口回 400「用户 id 非法」，看着像参数写错了）。
   路由名字故意用 `/search` 而不是 `/find` —— 和隐私设置里的「通过搜索添加」对齐。 */
r.get('/search', async (req, res) => {
  const raw = String(req.query.q || '').trim()
  if (!raw) return res.json({ users: [], by: null })

  /* 手机号形态 → 按精确手机号找；否则按 ID / 昵称模糊找。
     两种形态用的**必须是同一个正则**（PHONE_RE），否则会出现
     「资料里填得进手机号、却怎么都搜不到自己」。 */
  const compact = raw.replace(/[\s-]/g, '')
  const byPhone = PHONE_RE.test(compact)

  // 太短的模糊词会命中一大片，且没有实际意义；手机号形态不受这条限制
  if (!byPhone && raw.length < 2) return res.json({ users: [], by: null, hint: '至少输入 2 个字符' })

  const rows = byPhone
    ? await q.all(`SELECT ${USER_COLS} FROM users WHERE phone = ? LIMIT 20`, compact)
    : await q.all(
        `SELECT ${USER_COLS} FROM users WHERE username LIKE ? OR nickname LIKE ? ORDER BY id LIMIT 20`,
        `%${raw}%`,
        `%${raw}%`
      )

  const channel = byPhone ? 'phone' : 'search'
  const ids = rows.map((row) => Number(row.id))
  const [privacy, present, following] = await Promise.all([
    privacyOfMany(ids),
    onlineSetOf(ids),
    followingIds(req.user.id),
  ])
  const relationships = await friendStates(Number(req.user.id), ids)

  const users = rows
    /* 自己永远搜得到自己；别人要过闸 */
    .filter((row) => {
      const id = Number(row.id)
      if (id === Number(req.user.id)) return true
      return canAddBy(privacy.get(id), channel).allowed
    })
    .map((row) => {
      const id = Number(row.id)
      return {
        ...publicUser(row),
        online: onlineVisible(privacy.get(id)) && present.has(id),
        following: following.has(id),
        friendStatus: relationships.get(id) || 'none',
        isSelf: id === Number(req.user.id),
      }
    })

  res.json({ users, by: channel })
})

/* ---------- 按 username 查（扫一扫 / 手输 ID 用） ----------
   ⚠️ 必须注册在 `/:id` **之前**：Express 按顺序匹配，虽然 `/:id` 只吃单段路径、
   这里有两段不会真的撞上，但顺序写错以后加了 `/:id/xxx` 之类就会互相截胡。 */
r.get('/by-username/:username', async (req, res) => {
  // 二维码里可能带 `@` 前缀，也允许前后空格 —— 手输时很容易多打
  const username = String(req.params.username || '').trim().replace(/^@+/, '')
  if (!username) return res.status(400).json({ error: '请填写用户 ID' })

  const id = await userIdByUsername(username)
  if (!id) return res.status(404).json({ error: `没有找到 ID 为「${username}」的用户` })

  /* `from` 决定走哪个隐私开关：扫码是 `qr`，手动输 ID 是 `search`。
     认不出来的（以及不传的）不设闸 —— 见文件头。 */
  const from = String(req.query.from || '').trim()
  const channel = CHANNEL_KEY[from] ? from : null

  const payload = await viewerPayload(req.user.id, id, { channel })
  if (!payload) return res.status(404).json({ error: '用户不存在' })
  res.json(payload)
})

/* ---------- 他人资料 ---------- */
r.get('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ error: '用户 id 非法' })

  const payload = await viewerPayload(req.user.id, id)
  if (!payload) return res.status(404).json({ error: '用户不存在' })

  /* 只有**自己**看自己时才带上手机号。`publicUser()` 里没有这个字段，
     所以这里必须显式补一次 —— 反过来（把它放进 publicUser）会让所有
     「他人资料 / 搜索 / 群成员」出口一起泄露。 */
  if (payload.isSelf) {
    payload.user = { ...payload.user, phone: (await readProfile(id))?.phone || null }
  }

  res.json(payload)
})

export default r
