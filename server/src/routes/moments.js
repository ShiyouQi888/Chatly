/**
 * /api/v1/moments —— 动态：发布 / 展示 / 管理 / 点赞 / 评论
 *
 * 权限只有一条主线：**自己的动态才能改、才能删**；别人的动态只能点赞和评论。
 * 能不能**看**则由 `visibleTo()` 统一判（列表与详情共用，避免「列表看不见点进去却能看」）。
 *
 * 点赞 / 评论会**给作者发通知**（见 notification.js）——
 * 「消息通知」那一页的「点赞」「评论」两个开关，生效的就是这一条线。
 */
import { Router } from 'express'
import { authRequired } from '../auth.js'
import { uploadMomentImage, uploadMomentVideo, looksLikeVideo, removeUpload } from '../upload.js'
import { pushNotification, momentOwner, commentOwner, momentExcerpt } from '../notification.js'
import {
  listMoments,
  getMoment,
  createMoment,
  updateMoment,
  deleteMoment,
  toggleLike,
  likedBy,
  listComments,
  addComment,
  deleteComment,
  visibleTo,
  voteMomentCard,
  respondToMomentActivity,
} from '../moment.js'

const r = Router()
r.use(authRequired)

/**
 * 上传动态媒体（配图 / 视频）。
 *
 * ⚠️ 用 **query** 而不是 body 传 kind：multer 的 `limits` 只能给一个值，
 * 图片与视频上限不同（12MB / 80MB），所以得在**解析之前**就知道要挂哪个中间件 ——
 * 而 multipart 的 body 字段只有 multer 自己解析完才有，放在 body 里就永远慢一步。
 * query 在 multer 之前就能读到，这是唯一可行的位置。
 */
r.post('/upload', (req, res, next) => {
  const mw = req.query.kind === 'video' ? uploadMomentVideo : uploadMomentImage
  mw.single('file')(req, res, next)
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到文件' })
  const kind = req.query.kind === 'video' ? 'video' : 'image'

  /* 视频再验一次文件内容。不合法就把刚落盘的文件删掉 ——
     留着的话它不会被任何动态引用，只能等清理脚本回收（那就是个定时炸弹般的孤儿）。 */
  if (kind === 'video' && !looksLikeVideo(req.file.path)) {
    removeUpload(`/uploads/${req.file.filename}`)
    return res.status(400).json({ error: '这个文件不是有效的视频' })
  }

  res.status(201).json({
    url: `/uploads/${req.file.filename}`,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    mimeType: req.file.mimetype,
    kind,
  })
})

/** 动态列表：scope = friends（默认）| mine | hot */
r.get('/', async (req, res) => {
  const scope = ['friends', 'mine', 'hot'].includes(req.query.scope) ? req.query.scope : 'friends'
  const out = await listMoments({
    viewerId: req.user.id,
    scope,
    beforeId: req.query.beforeId ? Number(req.query.beforeId) : null,
    limit: Number(req.query.limit) || 20,
  })
  res.json(out)
})

/** 发布 */
r.post('/', async (req, res) => {
  const { content, topic, location, locationLat, locationLng, visibility, media, music, card } = req.body || {}
  try {
    const id = await createMoment({
      userId: req.user.id,
      content,
      topic,
      location,
      locationLat,
      locationLng,
      visibility,
      media,
      music,
      card,
    })
    res.status(201).json({ id, moment: await getMoment(id, req.user.id) })
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

/** 对动态投票。卡片权限沿用动态可见性。 */
r.post('/:id/card-vote', async (req, res) => {
  const id = Number(req.params.id)
  if (!(await visibleTo(id, req.user.id))) return res.status(404).json({ error: '动态不存在或你没有权限查看' })
  try {
    res.json({ card: await voteMomentCard(id, req.user.id, req.body?.optionIndexes) })
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

/** 更新活动报名状态。 */
r.post('/:id/activity-rsvp', async (req, res) => {
  const id = Number(req.params.id)
  if (!(await visibleTo(id, req.user.id))) return res.status(404).json({ error: '动态不存在或你没有权限查看' })
  try {
    res.json({ card: await respondToMomentActivity(id, req.user.id, req.body?.status) })
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

/** 详情 */
r.get('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!(await visibleTo(id, req.user.id))) {
    return res.status(404).json({ error: '动态不存在或你没有权限查看' })
  }
  const m = await getMoment(id, req.user.id)
  if (!m) return res.status(404).json({ error: '动态不存在' })
  res.json({ moment: m })
})

/** 编辑（只有作者） */
r.patch('/:id', async (req, res) => {
  const id = Number(req.params.id)
  try {
    await updateMoment(id, req.user.id, req.body || {})
    res.json({ ok: true, moment: await getMoment(id, req.user.id) })
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

/** 删除（只有作者） */
r.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  try {
    await deleteMoment(id, req.user.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

/* ---------- 点赞 ---------- */

/** 点赞 / 取消点赞（同一个接口，服务端按当前状态翻转 —— 前端不用维护两份计数） */
r.post('/:id/like', async (req, res) => {
  const id = Number(req.params.id)
  if (!(await visibleTo(id, req.user.id))) {
    return res.status(404).json({ error: '动态不存在或你没有权限查看' })
  }
  try {
    const out = await toggleLike(id, req.user.id)
    /* 只有「点成赞」才通知，取消赞不发（否则取消一次就多一条「谁赞了你」，是假信息）。
       不 await 也行，但这里**故意等它**：通知失败不影响点赞响应（pushNotification 从不抛）。 */
    if (out.liked) {
      const owner = await momentOwner(id)
      await pushNotification({
        userId: owner,
        actorId: req.user.id,
        kind: 'like',
        refId: id,
        body: await momentExcerpt(id),
      })
    }
    res.json(out)
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

r.get('/:id/likes', async (req, res) => {
  const id = Number(req.params.id)
  if (!(await visibleTo(id, req.user.id))) {
    return res.status(404).json({ error: '动态不存在或你没有权限查看' })
  }
  res.json({ likes: await likedBy(id) })
})

/* ---------- 评论 ---------- */

r.get('/:id/comments', async (req, res) => {
  const id = Number(req.params.id)
  if (!(await visibleTo(id, req.user.id))) {
    return res.status(404).json({ error: '动态不存在或你没有权限查看' })
  }
  res.json({ comments: await listComments(id) })
})

/** 发评论。parentId 有值就是「回复某条评论」 */
r.post('/:id/comments', async (req, res) => {
  const id = Number(req.params.id)
  if (!(await visibleTo(id, req.user.id))) {
    return res.status(404).json({ error: '动态不存在或你没有权限查看' })
  }
  try {
    const out = await addComment({
      momentId: id,
      userId: req.user.id,
      content: req.body?.content,
      parentId: req.body?.parentId,
    })
    /* 两类收件人，可能是同一个人（自己评论自己的动态 → pushNotification 内部会挡掉）：
       ① 动态作者收到「有人评论我的动态」；
       ② 被回复那条评论的作者收到「有人回复了我的评论」。
       通知关掉的人不会收到行（门控在写入时，见 notification.js）。 */
    const excerpt = await momentExcerpt(id)
    await pushNotification({
      userId: await momentOwner(id),
      actorId: req.user.id,
      kind: 'comment',
      refId: id,
      refParentId: req.body?.parentId ? Number(req.body.parentId) : null,
      body: excerpt,
    })
    if (req.body?.parentId) {
      await pushNotification({
        userId: await commentOwner(Number(req.body.parentId)),
        actorId: req.user.id,
        kind: 'comment',
        refId: id,
        refParentId: Number(req.body.parentId),
        body: excerpt,
      })
    }
    res.status(201).json(out)
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

/** 删评论：评论本人 或 动态作者 */
r.delete('/:id/comments/:commentId', async (req, res) => {
  const id = Number(req.params.id)
  const cid = Number(req.params.commentId)
  if (!(await visibleTo(id, req.user.id))) {
    return res.status(404).json({ error: '动态不存在或你没有权限查看' })
  }
  try {
    await deleteComment(cid, req.user.id, id)
    res.json({ ok: true })
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

export default r
