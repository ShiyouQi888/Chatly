/**
 * /api/v1/moments —— 动态：发布 / 展示 / 管理 / 点赞 / 评论
 *
 * 权限只有一条主线：**自己的动态才能改、才能删**；别人的动态只能点赞和评论。
 * 能不能**看**则由 `visibleTo()` 统一判（列表与详情共用，避免「列表看不见点进去却能看」）。
 */
import { Router } from 'express'
import { authRequired } from '../auth.js'
import { uploadMomentImage, uploadMomentVideo, looksLikeVideo, removeUpload } from '../upload.js'
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
r.get('/', (req, res) => {
  const scope = ['friends', 'mine', 'hot'].includes(req.query.scope) ? req.query.scope : 'friends'
  const out = listMoments({
    viewerId: req.user.id,
    scope,
    beforeId: req.query.beforeId ? Number(req.query.beforeId) : null,
    limit: Number(req.query.limit) || 20,
  })
  res.json(out)
})

/** 发布 */
r.post('/', (req, res) => {
  const { content, topic, location, locationLat, locationLng, visibility, media, music } = req.body || {}
  try {
    const id = createMoment({
      userId: req.user.id,
      content,
      topic,
      location,
      locationLat,
      locationLng,
      visibility,
      media,
      music,
    })
    res.status(201).json({ id, moment: getMoment(id, req.user.id) })
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

/** 详情 */
r.get('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!visibleTo(id, req.user.id)) {
    return res.status(404).json({ error: '动态不存在或你没有权限查看' })
  }
  const m = getMoment(id, req.user.id)
  if (!m) return res.status(404).json({ error: '动态不存在' })
  res.json({ moment: m })
})

/** 编辑（只有作者） */
r.patch('/:id', (req, res) => {
  const id = Number(req.params.id)
  try {
    updateMoment(id, req.user.id, req.body || {})
    res.json({ ok: true, moment: getMoment(id, req.user.id) })
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

/** 删除（只有作者） */
r.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  try {
    deleteMoment(id, req.user.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

/* ---------- 点赞 ---------- */

/** 点赞 / 取消点赞（同一个接口，服务端按当前状态翻转 —— 前端不用维护两份计数） */
r.post('/:id/like', (req, res) => {
  const id = Number(req.params.id)
  if (!visibleTo(id, req.user.id)) {
    return res.status(404).json({ error: '动态不存在或你没有权限查看' })
  }
  try {
    res.json(toggleLike(id, req.user.id))
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

r.get('/:id/likes', (req, res) => {
  const id = Number(req.params.id)
  if (!visibleTo(id, req.user.id)) {
    return res.status(404).json({ error: '动态不存在或你没有权限查看' })
  }
  res.json({ likes: likedBy(id) })
})

/* ---------- 评论 ---------- */

r.get('/:id/comments', (req, res) => {
  const id = Number(req.params.id)
  if (!visibleTo(id, req.user.id)) {
    return res.status(404).json({ error: '动态不存在或你没有权限查看' })
  }
  res.json({ comments: listComments(id) })
})

/** 发评论。parentId 有值就是「回复某条评论」 */
r.post('/:id/comments', (req, res) => {
  const id = Number(req.params.id)
  if (!visibleTo(id, req.user.id)) {
    return res.status(404).json({ error: '动态不存在或你没有权限查看' })
  }
  try {
    const out = addComment({
      momentId: id,
      userId: req.user.id,
      content: req.body?.content,
      parentId: req.body?.parentId,
    })
    res.status(201).json(out)
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

/** 删评论：评论本人 或 动态作者 */
r.delete('/:id/comments/:commentId', (req, res) => {
  const id = Number(req.params.id)
  const cid = Number(req.params.commentId)
  if (!visibleTo(id, req.user.id)) {
    return res.status(404).json({ error: '动态不存在或你没有权限查看' })
  }
  try {
    deleteComment(cid, req.user.id, id)
    res.json({ ok: true })
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

export default r
