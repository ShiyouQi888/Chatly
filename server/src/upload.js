/**
 * 上传中间件工厂
 *
 * 附件与头像共用同一套磁盘命名规则（时间戳 + 随机串 + 原扩展名），
 * 但体积上限与类型白名单不同：
 *   - 附件 20MB，只拦可执行脚本
 *   - 头像  5MB，必须是图片
 *
 * 头像的类型判断**同时看扩展名和 MIME** —— 只看 MIME 的话，
 * 客户端随手改个 Content-Type 就能把任意文件塞进 uploads/ 并当成头像对外托管。
 */
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const UPLOAD_DIR = path.join(__dirname, '..', 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })
export const PRIVATE_UPLOAD_DIR = path.join(__dirname, '..', 'private-uploads')
fs.mkdirSync(PRIVATE_UPLOAD_DIR, { recursive: true })

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 12)
    cb(null, `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`)
  },
})
const privateStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PRIVATE_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 12)
    cb(null, `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${ext}`)
  },
})

/** 体积 / 类型不合法属于客户端问题，标 400，别让全局错误处理报成 500 */
function badRequest(message) {
  const e = new Error(message)
  e.status = 400
  return e
}

export const ATTACHMENT_MAX = 20 * 1024 * 1024
export const AVATAR_MAX = 5 * 1024 * 1024
/** 个人主页封面：横幅比头像大得多，给 8MB */
export const COVER_MAX = 8 * 1024 * 1024
/** 动态配图：手机直出一张照片动辄 5MB+，给 12MB 留余量 */
export const MOMENT_IMAGE_MAX = 12 * 1024 * 1024
/** 动态视频：一条短视频几十 MB，20MB 的附件上限根本不够用 */
export const MOMENT_VIDEO_MAX = 80 * 1024 * 1024

/** 通用附件（聊天里的图片 / 文件） */
export const uploadAny = multer({
  storage: privateStorage,
  limits: { fileSize: ATTACHMENT_MAX },
  fileFilter: (_req, file, cb) => {
    const bad = /\.(exe|sh|bat|cmd|html?|svg|xml|js|mjs|css)$/i.test(file.originalname || '')
    cb(bad ? badRequest('不支持的文件类型') : null, !bad)
  },
})

/** 头像：只收图片 */
export const uploadImage = multer({
  storage,
  limits: { fileSize: AVATAR_MAX },
  fileFilter: (_req, file, cb) => {
    const extOk = /\.(png|jpe?g|gif|webp)$/i.test(file.originalname || '')
    const mimeOk = /^image\/(png|jpe?g|gif|webp)$/i.test(file.mimetype || '')
    const ok = extOk && mimeOk
    cb(ok ? null : badRequest('头像只支持 PNG / JPG / GIF / WebP'), ok)
  },
})

/**
 * 个人主页封面（「我」页顶部那张大图）。
 * 和头像同一套双校验（扩展名 + MIME），只是体积上限更高：
 * 横幅照片手机直出就 5MB 上下，卡 5MB 会让人换了半天换不上。
 */
export const uploadCover = multer({
  storage,
  limits: { fileSize: COVER_MAX },
  fileFilter: (_req, file, cb) => {
    const extOk = /\.(png|jpe?g|gif|webp)$/i.test(file.originalname || '')
    const mimeOk = /^image\/(png|jpe?g|gif|webp)$/i.test(file.mimetype || '')
    const ok = extOk && mimeOk
    cb(ok ? null : badRequest('背景图只支持 PNG / JPG / GIF / WebP'), ok)
  },
})

/**
 * 动态媒体（配图 / 视频）—— 和头像同一条铁律：**扩展名 + MIME 双校验**。
 *
 * 为什么要单独一套而不是复用 `uploadAny`：
 *   - 体积上限不一样（图片 12MB / 视频 80MB），统一按 20MB 卡的话视频根本传不上来；
 *   - `uploadAny` 只拦可执行脚本扩展名，本质是个「聊天附件」口子。
 *     动态媒体是要**对外托管并自动播放**的，不能把任意文件放进来 ——
 *     一个被改名成 `.mp4` 的文本文件如果混进 uploads，用户点开动态就是一片黑，
 *     而排查时会去查播放器，不会去查上传。
 * 图片与视频分成两个实例，是因为 multer 的 `limits` 只能给一个值。
 */
const MOMENT_IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i
const MOMENT_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i

/** 动态配图 */
export const uploadMomentImage = multer({
  storage,
  limits: { fileSize: MOMENT_IMAGE_MAX },
  fileFilter: (_req, file, cb) => {
    const ok =
      MOMENT_IMAGE_EXT.test(file.originalname || '') && MOMENT_IMAGE_MIME.test(file.mimetype || '')
    cb(ok ? null : badRequest('配图只支持 PNG / JPG / GIF / WebP'), ok)
  },
})

/** 动态视频：扩展名必须在 VIDEO_EXT 里，MIME 必须是 video/* ——
 *  前端判断「这是不是视频」用的是同一份清单，两边必须同步。 */
export const uploadMomentVideo = multer({
  storage,
  limits: { fileSize: MOMENT_VIDEO_MAX },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || '')
    const extOk = new RegExp(`\\.(${VIDEO_EXT.join('|')})$`, 'i').test(name)
    const mimeOk = /^video\//i.test(file.mimetype || '')
    const ok = extOk && mimeOk
    cb(ok ? null : badRequest(`视频只支持 ${VIDEO_EXT.join(' / ')}`), ok)
  },
})

/**
 * 这个文件的内容真的是视频吗 —— 读前 12 个字节看容器魔数。
 *
 * 为什么需要第三道校验：**扩展名和 MIME 都是客户端给的**。
 * 一个文本文件改名成 `a.mp4`、再把 Content-Type 写成 `video/mp4`，
 * 前两道校验全都放行，然后我们就把它当视频托管了 —— 用户点开动态是一片黑，
 * 排查时会去查播放器，永远查不到上传这一层。
 * （这和头像那条「扩展名 + MIME 双校验」是同一个道理，只是视频还差内容这一道。）
 *
 * 只认容器魔数，不解码 —— 服务端没有 ffmpeg，也不该为了校验把几十 MB 读进内存。
 */
const VIDEO_MAGIC = {
  mp4: (b) => b.toString('latin1', 4, 8) === 'ftyp', // 同时覆盖 m4v / mov（都是 ISOBMFF）
  m4v: (b) => b.toString('latin1', 4, 8) === 'ftyp',
  mov: (b) => b.toString('latin1', 4, 8) === 'ftyp',
  webm: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3, // EBML
  mkv: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  avi: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'AVI ',
  ogv: (b) => b.toString('latin1', 0, 4) === 'OggS',
}

export function looksLikeVideo(filePath) {
  const ext = String(path.extname(filePath || '')).slice(1).toLowerCase()
  const check = VIDEO_MAGIC[ext]
  // 清单里没有的扩展名不该走到这里（fileFilter 已经拦过），放行比误杀好
  if (!check) return true
  let fh
  try {
    fh = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(12)
    const n = fs.readSync(fh, buf, 0, 12, 0)
    return n >= 12 && check(buf)
  } catch {
    return false
  } finally {
    try {
      fs.closeSync(fh)
    } catch {}
  }
}

/**
 * 删除 uploads 目录下的旧文件（换头像时清掉上一张，否则磁盘只涨不跌）。
 * 只认 basename，杜绝 ../ 穿越；文件本就不在就直接跳过。
 */
export function removeUpload(urlPath) {
  if (!urlPath) return false
  const m = /^\/uploads\/(.+)$/.exec(String(urlPath))
  if (!m) return false
  const name = path.basename(m[1])
  if (!name || name.startsWith('.')) return false
  const full = path.join(UPLOAD_DIR, name)
  if (!full.startsWith(UPLOAD_DIR)) return false
  try {
    fs.unlinkSync(full)
    return true
  } catch {
    return false
  }
}

/**
 * 这个 /uploads/... 地址在磁盘上是否真的存在。
 *
 * 为什么需要它：换头像会顺手删掉上一张本地文件。如果客户端拿着一个**旧的**地址
 * 去 PATCH（比如「还原到改之前」），地址语法完全合法、库也能写进去，
 * 但文件早就没了 —— 界面上就是一个永远加载不出来的破图。
 * 所以写入前先确认文件在，不在就报错让客户端重新上传。
 */
export function uploadExists(urlPath) {
  const m = /^\/uploads\/(.+)$/.exec(String(urlPath || ''))
  if (!m) return false
  const name = path.basename(m[1])
  if (!name || name.startsWith('.')) return false
  return fs.existsSync(path.join(UPLOAD_DIR, name))
}

/* ==================== 消息里的静态资源地址 ==================== */

/**
 * 这个地址是不是「本服务托管的静态资源」—— 即 /uploads/<文件名> 或 /emoji/<文件名>。
 *
 * 为什么要卡这个：消息的 fileUrl 来自请求体，直接落库的话客户端能塞进来
 * 任意 URL —— `http://tracker.example/px.gif`（追踪像素，对方一打开就上报 IP）、
 * `//evil.com/x.js`、`javascript:...`。前端拿它去 <img src> / window.open 都是现成的执行面。
 * 这里只放行两个自家前缀，其余一律 400。
 *
 * 再叠一层「形状」校验：只允许单层 basename、无 .. 穿越、无隐藏文件、
 * 扩展名限定在白名单内 —— 光是前缀匹配挡不住 `/uploads/../../etc/passwd`。
 *
 * 注意：这个函数**只判断地址形态**，不判断文件在不在磁盘上。
 * 消息是历史记录，引用一张后来被清理掉的图是正常现象（前端有破图兜底），
 * 不该因为文件没了就让整条历史消息无法加载。写入时的存在性校验只在头像那条线上做。
 */
/** `/emoji-anim/` 是动画大表情（WebP 动画），和静态 SVG 的 `/emoji/` 是两个目录 ——
 *  `/emoji/` 的前缀匹配挡不住它（开头是 `/emoji-`），必须显式列出来。 */
const ASSET_PREFIXES = ['/uploads/', '/emoji/', '/emoji-anim/', '/api/v1/files/private/']
/* 视频格式单独列出来 —— 前端判断「这条消息是不是视频」用的是同一个清单。
   ⚠️ 两边必须同步：前端认 mp4 而这里不认，用户选完视频发出去会被 400 挡掉，
   而且报错是「文件地址不合法」，看起来像前端拼错了 URL，其实缺的是后端白名单。 */
export const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv', 'ogv']

const ASSET_EXT = new RegExp(
  `\\.(png|jpe?g|gif|webp|svg|bmp|avif|pdf|txt|md|csv|json|zip|mp3|m4a|ogg|opus|wav|docx?|xlsx?|pptx?|pages|numbers|key|${VIDEO_EXT.join('|')})$`,
  'i'
)

export function isStaticAssetUrl(urlPath) {
  const s = String(urlPath || '')
  if (!ASSET_PREFIXES.some((p) => s.startsWith(p))) return false

  const prefix = ASSET_PREFIXES.find((p) => s.startsWith(p))
  const rest = s.slice(prefix.length) // 去掉前缀，留下文件名部分
  // 只允许单层：不含 / 或 \，不含 ..，不以 . 开头
  if (!rest || /[/\\]/.test(rest) || rest.includes('..') || rest.startsWith('.')) return false
  return ASSET_EXT.test(rest)
}
