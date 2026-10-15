/**
 * /api/v1/feedback —— 用户反馈（「我 → 帮助与反馈」的提交）
 *
 * 这一组接口原先**不存在**，而前端 `HelpPage` 已经在调
 * `api.uploadFeedbackScreenshot()` / `api.submitFeedback()` ——
 * 点「提交反馈」只会抛 `... is not a function`，被 catch 后弹一句
 * 技术错误给用户看。README 里也老实地标着「待实现」，只是没人接上。
 *
 * 两条和别处一致的规矩：
 *   ① 截图地址只收**本服务托管**的 `/uploads/...` 地址（同 messages.fileUrl）。
 *      不卡的话客户端能塞任意 URL 进来 —— `http://tracker.example/px.gif`
 *      这种追踪像素一旦落库，管理员一打开后台就上报 IP。
 *   ② 截图走 `uploadImage`（扩展名 + MIME 双校验，5MB），
 *      和头像同一套：只按 MIME 判的话，改个 Content-Type 就能塞任意文件。
 */
import { Router } from 'express'
import { insert } from '../db.js'
import { authRequired } from '../auth.js'
import { uploadImage, isStaticAssetUrl } from '../upload.js'

const r = Router()
r.use(authRequired)

const TYPES = ['bug', 'feature', 'ui', 'other']
/** 与前端 `maxLength` 一致 */
const DESC_MAX = 1000
const CONTACT_MAX = 100

/** 上传截图。返回 /uploads 地址，提交时再把这个地址带上。 */
r.post('/screenshot', (req, res, next) => {
  uploadImage.single('file')(req, res, (err) => {
    if (err) return next(err)
    if (!req.file) return res.status(400).json({ error: '没有收到文件' })
    res.status(201).json({
      url: `/uploads/${req.file.filename}`,
      fileName: req.file.originalname,
      fileSize: req.file.size,
    })
  })
})

/** 提交反馈 */
r.post('/', async (req, res) => {
  const { type, description, contact, screenshotUrl } = req.body || {}

  const desc = String(description || '').trim()
  if (!desc) return res.status(400).json({ error: '请填写问题描述' })
  /* 按**码点**数，不是 `.length`：一个 emoji 在 UTF-16 里占 2，
     用 length 卡 1000 会让「打了 1000 个字」的人被判超限。 */
  if ([...desc].length > DESC_MAX) {
    return res.status(400).json({ error: `问题描述最多 ${DESC_MAX} 字` })
  }

  const t = TYPES.includes(type) ? type : 'other'
  const c = String(contact || '').trim().slice(0, CONTACT_MAX)
  const shot = isStaticAssetUrl(screenshotUrl) ? String(screenshotUrl) : null

  const id = await insert(
    `INSERT INTO feedbacks (user_id, type, description, contact, screenshot_url)
     VALUES (?, ?, ?, ?, ?)`,
    req.user.id,
    t,
    desc,
    c || null,
    shot
  )

  res.status(201).json({ id })
})

export default r
