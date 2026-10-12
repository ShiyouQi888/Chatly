/**
 * /api/v1/polls —— 群投票（PRD §14）
 *
 * 与路由层的一贯分工一致：这里只做「取 req.user.id / 校验参数 / 转形状 / 广播」，
 * 判定逻辑全在 ../poll.js。
 */
import { Router } from 'express'
import { authRequired } from '../auth.js'
import { createMessage, isMember, memberIds, canSpeak, assertReplyTo } from '../chat.js'
import { broadcastToUsers } from '../ws.js'
import { createPoll, viewPoll, viewPollsByIds, pollConversations, listPolls, votePoll, closePoll } from '../poll.js'

const r = Router()
r.use(authRequired)

/** 业务层抛的是 `{status, message}`，没有 status 的是真 bug（让错误中间件报 500） */
function fail(res, e) {
  if (e && e.status) return res.status(e.status).json({ error: e.message })
  throw e
}

/* ---------- 批量取投票（聊天记录里的 kind='poll' 消息按 pollId 换详情） ----------
   ⚠️ 授权口径：**逐条确认调用方是那条投票所属会话的成员**，有一个不通过就整批拒。
   只按 pollId 查会引起「猜 id 读别人群的投票」—— 投票 id 是自增的，很好猜。
   越权与不存在**同为 404**（和动态详情一个取舍）：不泄漏「这条投票其实存在，只是你看不到」。 */
r.get('/', (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean)
  if (!ids.length) return res.json({ polls: [] })
  if (ids.length > 100) return res.status(400).json({ error: '一次最多查 100 条投票' })

  const convOf = pollConversations(ids)
  for (const id of ids) {
    const cid = convOf.get(id)
    if (!cid || !isMember(cid, req.user.id)) {
      return res.status(404).json({ error: '投票不存在或你无权查看' })
    }
  }
  res.json({ polls: viewPollsByIds(ids, req.user.id) })
})

/** 某个会话里的投票列表（群设置 → 群投票） */
r.get('/of/:conversationId', (req, res) => {
  const cid = Number(req.params.conversationId)
  if (!cid) return res.status(400).json({ error: '会话 id 非法' })
  if (!isMember(cid, req.user.id)) return res.status(403).json({ error: '无权查看该会话的投票' })
  res.json({ polls: listPolls(cid, req.user.id) })
})

/* ---------- 发起投票 ----------
   投票同时是**一条聊天消息**（kind='poll'）—— 它要出现在聊天记录里、
   要有已读回执、要能被撤回、要能被引用回复，所以走消息表而不是另起一套。
   消息的 kind='poll' 与 polls 行在同一次请求里建，不会出现「有投票没消息」。 */
r.post('/', (req, res) => {
  const { conversationId, question, options, multi, anonymous, deadline, replyToId } = req.body || {}
  const cid = Number(conversationId)
  if (!cid) return res.status(403).json({ error: '无权在该会话发起投票' })
  /* 发起投票同时会发一条 kind='poll' 的消息，所以发言门控（禁言）同样适用 ——
     只查 isMember 的话，禁言群里发起投票就成了一条绕过禁言的发言通道。 */
  const speak = canSpeak(cid, req.user.id)
  if (!speak.ok) return res.status(speak.status || 403).json({ error: speak.error || '无权在该会话发起投票' })

  let created
  try {
    created = createPoll({
      conversationId: cid,
      creatorId: req.user.id,
      question,
      options,
      multi: !!multi,
      anonymous: !!anonymous,
      deadline: deadline ?? null,
    })
  } catch (e) {
    return fail(res, e)
  }

  const message = createMessage({
    conversationId: cid,
    senderId: req.user.id,
    kind: 'poll',
    /* 题目同时写进消息的 `content` —— 会话列表的预览（`[投票] 周六去哪？`）要用它。
       这是**唯一一处刻意的冗余**：`polls.question` 才是真源，`content` 只是给预览的副本。
       它不会漂移，因为投票发布后**题目不可编辑**（没有 PATCH 接口）。
       不这么写的话，会话列表每行都要 LEFT JOIN polls 才能拿到预览文案，
       而那是整个 App 最热的查询（每次登录 / 每次刷新会话列表）。
       和位置消息把地点名放 `geo_name` 而不是 `content` 是相反的取舍 ——
       位置消息的正文本来就要显示成地点名，投票的正文不显示，所以放哪都不影响渲染。 */
    content: created.poll.question,
    pollId: created.poll.id,
    /* 引用走统一校验（这条以前是裸 Number() 落库，和普通发送一样漏）。
       ⚠️ 这里和普通发送的口径**故意不同**：投票行已经建出来了，
       引用不合法不能让整个 201 变 400（重发会建出第二条投票），
       只能落空 —— 前端按 message.replyTo 是否存在决定显不显示引用块。 */
    replyToId: (() => {
      try {
        return assertReplyTo(cid, replyToId)
      } catch {
        return null
      }
    })(),
  })

  broadcastToUsers(memberIds(cid), 'message.new', { message })
  res.status(201).json({ message, poll: created.poll })
})

/* ---------- 投票 / 改票 / 取消投票 ----------
   `optionIds` 是**投票后的完整状态**（见 poll.js）。空数组 = 取消投票。 */
r.post('/:id/vote', (req, res) => {
  const id = Number(req.params.id)
  const poll = viewPoll(id, null)
  if (!poll) return res.status(404).json({ error: '投票不存在' })
  if (!isMember(poll.conversationId, req.user.id)) return res.status(403).json({ error: '无权参与该投票' })

  let out
  try {
    out = votePoll(id, req.user.id, req.body?.optionIds)
  } catch (e) {
    return fail(res, e)
  }

  /* 票数变了要推给群里所有人（包括自己 —— 自己的客户端也靠这条把票数刷新到权威值）。
     没变化（重复提交同一份选择）就不推，省掉一圈没人会看到差别的广播。 */
  if (out.changed) {
    broadcastToUsers(memberIds(poll.conversationId), 'poll.updated', { poll: out.poll, by: req.user.id })
  }
  res.json({ poll: out.poll, changed: out.changed })
})

/** 发起人提前结束 */
r.post('/:id/close', (req, res) => {
  const id = Number(req.params.id)
  const poll = viewPoll(id, null)
  if (!poll) return res.status(404).json({ error: '投票不存在' })
  if (!isMember(poll.conversationId, req.user.id)) return res.status(403).json({ error: '无权操作该投票' })

  let out
  try {
    out = closePoll(id, req.user.id)
  } catch (e) {
    return fail(res, e)
  }
  broadcastToUsers(memberIds(poll.conversationId), 'poll.updated', { poll: out.poll, by: req.user.id })
  res.json({ poll: out.poll })
})

export default r
