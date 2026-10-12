/**
 * /api/v1/users —— 用户列表（发起聊天 / 建群）+ 查看他人资料
 */
import { Router } from 'express'
import { authRequired } from '../auth.js'
import { listUsers } from '../chat.js'
import { profileForViewer, privateConversationWith, userIdByUsername } from '../profile.js'
import { isOnline } from '../ws.js'
import { follow, unfollow, isFollowing, followCounts } from '../moment.js'

const r = Router()
r.use(authRequired)

r.get('/', (req, res) => {
  const users = listUsers(req.user.id).map((u) => ({ ...u, online: isOnline(u.id) }))
  res.json({ users })
})

/**
 * 他人资料的响应体 —— `/:id` 和 `/by-username/:username` 共用一份。
 * 两个入口各拼一遍迟早会长歪（加了个字段只补一边），所以只留一处。
 */
function viewerPayload(viewerId, targetId) {
  const profile = profileForViewer(viewerId, targetId)
  if (!profile) return null
  return {
    user: profile,
    userId: targetId,
    isSelf: Number(viewerId) === Number(targetId),
    online: isOnline(targetId),
    // 已经聊过就把会话 id 带上，资料页「发消息」可以直接跳进去，不用再建一条
    conversationId: privateConversationWith(viewerId, targetId),
    ...followCounts(targetId),
    /* ⚠️ 这两个布尔必须在展开**之后**：`followCounts` 返回的是数量，
       先写布尔再展开的话，`following` 会被覆盖成一个数字。 */
    following: isFollowing(viewerId, targetId),
    followedBy: isFollowing(targetId, viewerId),
  }
}

/* ---------- 关注 ----------
   关注关系不只是「个人主页的数字」：动态的「仅好友可见」就是按**互相关注**判的。
   没有这张表的话，可见范围就是一个点了没反应的假开关。 */
r.post('/:id/follow', (req, res) => {
  const id = Number(req.params.id)
  if (!id || id === req.user.id) return res.status(400).json({ error: '不能关注自己' })
  follow(req.user.id, id)
  // 展开在前、布尔在后 —— 反过来的话计数会把 `following` 覆盖掉（见 moment.js 的注释）
  res.json({ ok: true, ...followCounts(id), following: true })
})

r.delete('/:id/follow', (req, res) => {
  const id = Number(req.params.id)
  unfollow(req.user.id, id)
  res.json({ ok: true, ...followCounts(id), following: false })
})

/* ---------- 按 username 查（扫一扫 / 手输 ID 用） ----------
   ⚠️ 必须注册在 `/:id` **之前**：Express 按顺序匹配，虽然 `/:id` 只吃单段路径、
   这里有两段不会真的撞上，但顺序写错以后加了 `/:id/xxx` 之类就会互相截胡。 */
r.get('/by-username/:username', (req, res) => {
  // 二维码里可能带 `@` 前缀，也允许前后空格 —— 手输时很容易多打
  const username = String(req.params.username || '').trim().replace(/^@+/, '')
  if (!username) return res.status(400).json({ error: '请填写用户 ID' })

  const id = userIdByUsername(username)
  if (!id) return res.status(404).json({ error: `没有找到 ID 为「${username}」的用户` })

  const payload = viewerPayload(req.user.id, id)
  if (!payload) return res.status(404).json({ error: '用户不存在' })
  res.json(payload)
})

/* ---------- 他人资料 ---------- */
r.get('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ error: '用户 id 非法' })

  const payload = viewerPayload(req.user.id, id)
  if (!payload) return res.status(404).json({ error: '用户不存在' })
  res.json(payload)
})

export default r
