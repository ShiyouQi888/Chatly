/**
 * /api/v1/messages —— 发送消息、撤回、上传
 */
import { Router } from 'express'
import { authRequired } from '../auth.js'
import { createMessage, getMessage, revokeMessage, memberIds, canSpeak, assertReplyTo, forwardMessages } from '../chat.js'
import { broadcastToUsers } from '../ws.js'
import { uploadAny as upload, isStaticAssetUrl } from '../upload.js'
import { parseGeoPair } from '../../../shared/geo-math.mjs'

const r = Router()
r.use(authRequired)

/* ---------- 上传（图片 / 文件） ---------- */
r.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到文件' })
  res.status(201).json({
    url: `/uploads/${req.file.filename}`,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    mimeType: req.file.mimetype,
  })
})

/* 允许的消息类型。和 db.js 里 messages.kind 的 CHECK 约束**必须一致** ——
   两边各写一份的话，DB 拒收而路由放行（或反过来）时报错信息会指向完全错误的地方。
   kind 是纯前端传来的，不在白名单里的一律按非法类型挡掉（否则会撞 CHECK 报 500）。 */
const KINDS = ['text', 'image', 'file', 'video', 'location']
/** 需要带文件的类型（text / location 不需要） */
const FILE_KINDS = ['image', 'file', 'video']

/* ---------- 发送消息 ---------- */
r.post('/', (req, res) => {
  const { conversationId, kind = 'text', text, fileUrl, fileName, fileSize, replyToId } = req.body || {}
  const cid = Number(conversationId)
  /* 发言门控走 canSpeak（isMember + 禁言），不只查 isMember ——
     否则禁言只是前端的摆设，客户端直接发包就能在禁言群里说话。
     转发走同一个门（它本质也是在这个会话里发消息），见下 POST /forward。 */
  const speak = canSpeak(cid, req.user.id)
  if (!speak.ok || !cid) return res.status(speak.status || 403).json({ error: speak.error || '无权在该会话发言' })

  if (!KINDS.includes(kind)) {
    return res.status(400).json({ error: `不支持的消息类型：${kind}` })
  }
  if (kind === 'text' && (!text || !String(text).trim())) {
    return res.status(400).json({ error: '消息内容不能为空' })
  }
  if (FILE_KINDS.includes(kind) && !fileUrl) {
    return res.status(400).json({ error: '缺少文件地址' })
  }
  // 地址只能指向本服务托管的静态资源（/uploads/… 或 /emoji/…）。
  // 放开的话客户端能塞进 http://tracker/x.gif 这类外链，对方一打开就上报 IP；
  // javascript: 之类的伪协议在前端 <img src> / window.open 处也都是现成的执行面。
  if (FILE_KINDS.includes(kind) && !isStaticAssetUrl(fileUrl)) {
    return res.status(400).json({ error: '文件地址不合法' })
  }

  let geo = null
  if (kind === 'location') {
    const g = req.body?.geo || {}
    const name = String(g.name ?? '').trim().slice(0, 60)
    if (!name) return res.status(400).json({ error: '位置消息需要地点名称' })

    const pair = parseGeoPair(g.lat, g.lng)
    geo = {
      name,
      address: String(g.address ?? '').trim().slice(0, 120),
      lat: pair?.lat ?? null,
      lng: pair?.lng ?? null,
    }
  }

  /* 引用目标校验：存在性 / 同会话 / 未撤回。
     逻辑在 chat.js 的 assertReplyTo()（普通发送 / 发起投票 / 转发三处共用）。
     以前是直接落库零校验 —— 引用别的会话的消息会把那个会话的内容带进当前会话。 */
  let replyTo = null
  try {
    replyTo = assertReplyTo(cid, replyToId)
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message })
  }

  const message = createMessage({
    conversationId: cid,
    senderId: req.user.id,
    kind,
    content: kind === 'text' ? String(text).slice(0, 2000) : null,
    fileUrl: FILE_KINDS.includes(kind) ? fileUrl : null,
    fileName: FILE_KINDS.includes(kind) ? fileName || null : null,
    fileSize: FILE_KINDS.includes(kind) ? Number(fileSize) || null : null,
    replyToId: replyTo,
    geo,
  })

  // 发送者自身视为已读
  broadcastToUsers(memberIds(cid), 'message.new', { message })

  res.status(201).json({ message })
})

/* ---------- 撤回 ---------- */
r.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  const out = revokeMessage(id, req.user.id)
  if (!out.ok) return res.status(out.status).json({ error: out.error })

  const m = getMessage(id)
  broadcastToUsers(memberIds(m.conversationId), 'message.revoked', {
    conversationId: m.conversationId,
    messageId: id,
  })

  res.json({ message: out.message })
})

/* ---------- 转发 ----------
   POST /messages/forward  { targetConversationId, messageIds: [...] }
   语义是「按目标会话逐条重发」，不是「移动」：
   原消息不动，新消息的发送者是转发人，时间是现在。
   逐条失败互不影响（forwarded / skipped 和批量收藏同一个口径）。

   三个必须判的（判据的理由见 chat.js 的 forwardMessages）：
     目标会话发言权走 canSpeak —— 禁言群里转发同样是发言，不能绕过去；
     转发限制在 20 条 —— 转发是逐条 INSERT，无上限就是一条请求写爆库；
     转发目标不能是自己所在的「同一条」吗？可以 —— 转发给自己（备忘）是合理需求，不拦。 */
r.post('/forward', (req, res) => {
  const targetConversationId = Number(req.body?.targetConversationId)
  const messageIds = req.body?.messageIds
  if (!targetConversationId) return res.status(400).json({ error: '缺少目标会话' })
  if (!Array.isArray(messageIds) || !messageIds.length) {
    return res.status(400).json({ error: '请至少选择一条消息' })
  }
  if (messageIds.length > 20) return res.status(400).json({ error: '一次最多转发 20 条' })

  const speak = canSpeak(targetConversationId, req.user.id)
  if (!speak.ok) return res.status(speak.status || 403).json({ error: speak.error || '无权在目标会话发言' })

  const out = forwardMessages(messageIds, targetConversationId, req.user.id)
  for (const m of out.forwarded) {
    broadcastToUsers(memberIds(targetConversationId), 'message.new', { message: m })
  }
  res.status(201).json(out)
})

export default r
