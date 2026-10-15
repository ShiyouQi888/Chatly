/**
 * 用户资料：字段校验 / 更新 / 查看他人资料
 *
 * 校验原则：
 *   - patch 里 **没出现的键 = 不改**；显式传 null / '' = 清空
 *   - 长度上限与前端输入框的 maxLength 对齐，防止绕过前端直接打接口
 *   - tags 在 DB 里存 JSON 文本，出参统一转数组
 */
import { q } from './db.js'
import { publicUser, USER_COLS } from './auth.js'
import { uploadExists } from './upload.js'
import { parseGeoPair } from '../../shared/geo-math.mjs'

export const LIMITS = {
  nickname: 20,
  bio: 60,
  region: 20,
  tags: 8,
  tagLen: 8,
}

export const GENDERS = ['male', 'female', 'other']

/**
 * 中国大陆手机号。搜人时也用它判断「这串数字是不是在按手机号找」——
 * 两边共用同一个正则，否则会出现「填得进手机号、却搜不到自己」这种对不上的情况。
 */
export const PHONE_RE = /^1[3-9]\d{9}$/

/**
 * 头像只接受两类取值：
 *   preset:<n>      前端内置的预设插画头像（库里只存编号，避免把 SVG 塞进数据库）
 *   /uploads/<file> 本地上传的真实图片
 * 任何外链一律拒绝 —— 既能防 SSRF / 追踪像素，也保证离线可用、不会 404。
 */
export function isValidAvatarValue(v) {
  if (typeof v !== 'string') return false
  if (/^preset:\d{1,2}$/.test(v)) return true
  return /^\/uploads\/[A-Za-z0-9._-]+$/.test(v)
}

/**
 * 封面只接受**本地上传的图片**（不允许 preset —— 那是头像的预设插画，
 * 不是横幅）。校验的是地址形态：外链一律挡掉，理由和头像一样（SSRF / 追踪像素）。
 */
export function isCoverUrlValue(v) {
  return typeof v === 'string' && /^\/uploads\/[A-Za-z0-9._-]+\.(png|jpe?g|gif|webp)$/i.test(v)
}

/** 把用户提交的 patch 收敛成可写库的字段集合，返回 { fields, errors } */
export function sanitizeProfile(patch = {}) {
  const out = {}
  const errors = []

  if (patch.nickname !== undefined) {
    const v = String(patch.nickname ?? '').trim()
    if (!v) errors.push('昵称不能为空')
    else if ([...v].length > LIMITS.nickname) errors.push(`昵称不能超过 ${LIMITS.nickname} 个字符`)
    else out.nickname = v
  }

  if (patch.bio !== undefined) {
    const v = String(patch.bio ?? '').trim()
    if ([...v].length > LIMITS.bio) errors.push(`个性签名不能超过 ${LIMITS.bio} 个字符`)
    else out.bio = v
  }

  if (patch.gender !== undefined) {
    const v = patch.gender === null || patch.gender === '' ? null : String(patch.gender)
    if (v !== null && !GENDERS.includes(v)) errors.push('性别取值非法')
    else out.gender = v
  }

  if (patch.birthday !== undefined) {
    const v = patch.birthday === null || patch.birthday === '' ? null : String(patch.birthday)
    if (v !== null) {
      // 必须是真实存在的 YYYY-MM-DD（2 月 30 日这种要被 Date 归一化后对不上而拒绝）
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
      const d = m ? new Date(`${v}T00:00:00Z`) : null
      const real = !!d && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
      if (!real) errors.push('生日格式应为 YYYY-MM-DD')
      else if (d.getTime() > Date.now()) errors.push('生日不能是未来的日期')
      else out.birthday = v
    } else out.birthday = null
  }

  if (patch.region !== undefined) {
    const v = String(patch.region ?? '').trim()
    if ([...v].length > LIMITS.region) errors.push(`地区不能超过 ${LIMITS.region} 个字符`)
    else out.region = v
  }

  /* ---------- 手机号 ----------
     注册时通过短信验证码验证的手机号可作为登录身份；资料编辑不更换已验证身份，
     避免绕过验证码把账号绑定到未经验证的号码。 */
  if (patch.phone !== undefined) {
    const v = patch.phone === null || patch.phone === '' ? null : String(patch.phone).replace(/[\s-]/g, '')
    if (v !== null && !PHONE_RE.test(v)) errors.push('手机号格式应为 11 位中国大陆号码')
    else out.phone = v
  }

  if (patch.tags !== undefined) {
    const raw = Array.isArray(patch.tags) ? patch.tags : []
    const tags = []
    let tooLong = false
    for (const t of raw) {
      const s = String(t ?? '').trim()
      if (!s) continue
      if ([...s].length > LIMITS.tagLen) {
        tooLong = true
        continue
      }
      if (!tags.includes(s)) tags.push(s)
    }
    if (tooLong) errors.push(`单个兴趣标签不能超过 ${LIMITS.tagLen} 个字符`)
    else if (tags.length > LIMITS.tags) errors.push(`兴趣标签最多 ${LIMITS.tags} 个`)
    else out.tags = JSON.stringify(tags)
  }

  if (patch.avatar !== undefined) {
    const v = patch.avatar === null || patch.avatar === '' ? null : String(patch.avatar)
    if (v !== null && !isValidAvatarValue(v)) errors.push('头像取值非法（只支持本地上传或内置预设）')
    // 语法合法不等于文件还在：换头像会删掉上一张，拿着旧地址来「还原」会写进一个悬空引用
    else if (v !== null && v.startsWith('/uploads/') && !uploadExists(v))
      errors.push('这张头像文件已经不在了，请重新上传')
    else out.avatar = v
  }

  /* ---------- 个人主页封面（「我」页顶部大图） ----------
     和头像同一套规矩：只收本服务托管的图片地址，写入前确认文件还在。 */
  if (patch.profileCover !== undefined) {
    const v = patch.profileCover === null || patch.profileCover === '' ? null : String(patch.profileCover)
    if (v !== null && !isCoverUrlValue(v)) errors.push('背景图取值非法（只支持本地上传的图片）')
    else if (v !== null && !uploadExists(v)) errors.push('这张背景图已经不在了，请重新上传')
    else out.profile_cover = v
  }

  /* ---------- 位置 ----------
     ⚠️ 这四个字段是**服务端替用户存下来的「行政区划中心点」**，不是实时位置。
     允许客户端写，是因为只有客户端拿得到浏览器定位；但必须卡死形态：
     坐标成对出现、在合法范围内、且**只能是自己**（PATCH /auth/me 本来就只改自己）。

     为什么要卡得这么死：这是个能写成「把某人定位到任意地点」的入口，
     而位置数据一旦被随手放宽，就是合规问题（不得收集、存储他人的位置数据）。
     `city` 存的也必须是行政区划名（由 /geo/locate 返回），不是任意字符串。 */
  if (patch.city !== undefined) {
    const v = patch.city === null || patch.city === '' ? null : String(patch.city).trim()
    if (v !== null && [...v].length > 20) errors.push('城市名不能超过 20 个字符')
    else out.city = v
  }

  if (patch.cityLat !== undefined || patch.cityLng !== undefined) {
    /* 数值校验统一走 `parseGeoPair()`（和消息 / 动态用同一份），别在这里再写一遍
       `Number.isFinite(Number(v))` —— `Number(null) === 0`，会把「清空坐标」
       判成合法的 (0, 0)。资料这边只多一条语义：**要能区分「清空」和「给错了」**，
       所以先判是不是两边都空。 */
    const empty = (v) => v === null || v === undefined || v === ''
    const bothEmpty = empty(patch.cityLat) && empty(patch.cityLng)
    const pair = parseGeoPair(patch.cityLat, patch.cityLng)
    if (!bothEmpty && !pair) errors.push('城市坐标必须成对给出，且在合法经纬度范围内')
    else if (pair && patch.cityPublic !== true) errors.push('请先明确开启「参与附近」再保存城市中心点')
    else {
      /* 存到 4 位小数就够了（≈11 m）。库里不需要比这更细 ——
         反正它代表的是行政区划中心点，多存几位只会让人误以为这是「精确位置」。
         （`parseGeoPair` 给的是 5 位，这里再收一位。） */
      out.city_lat = pair ? Math.round(pair.lat * 1e4) / 1e4 : null
      out.city_lng = pair ? Math.round(pair.lng * 1e4) / 1e4 : null
    }
  }

  if (patch.cityPublic !== undefined && typeof patch.cityPublic !== 'boolean') {
    errors.push('附近分享设置必须是布尔值')
  } else if (patch.cityPublic !== undefined) {
    out.city_public = patch.cityPublic ? 1 : 0
    if (!patch.cityPublic) {
      out.city_lat = null
      out.city_lng = null
    }
  }

  return { fields: Object.keys(out).length ? out : null, errors }
}

export async function readProfile(userId) {
  return q.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, userId)
}

/**
 * 按 username（界面上的「ID: xxxx」）反查数字 id。
 * 扫一扫 / 手输 ID 只能拿到 username，得先换成 id 才能复用资料与关注那套逻辑。
 * 查不到返回 null —— 调用方据此回 404，不要拿 0 当兜底（0 会匹配到别的判断分支）。
 */
export async function userIdByUsername(username) {
  const row = await q.get('SELECT id FROM users WHERE username = ?', String(username || '').trim())
  return row ? Number(row.id) : null
}

/**
 * 写库并**回读原始行**（不再是 publicUser 形状）。
 *
 * 为什么改：`users` 现在有「只对自己可见」的字段（phone）。回传 publicUser 的话，
 * 路由想给「我」看手机号也拿不回来；回传 raw row 则由调用方显式选择
 * `selfUser(row)`（给我）还是 `publicUser(row)`（推给同会话的人）。
 * 调用点只有 routes/auth.js 的两处，都已经是显式塑形。
 */
export async function updateProfile(userId, fields) {
  const keys = Object.keys(fields)
  if (keys.length) {
    await q.run(
      `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => fields[k]),
      userId
    )
  }
  return readProfile(userId)
}

/* ================= 他人资料 ================= */

/** 共同群聊数：两人都在的 group 会话有几个 */
export async function sharedGroupCount(aId, bId) {
  if (Number(aId) === Number(bId)) return 0
  const row = await q.get(
    `SELECT COUNT(*) AS n
       FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
      WHERE c.type = 'group'`,
    aId,
    bId
  )
  return Number(row?.n) || 0
}

/**
 * 查看者视角的他人资料。
 * 生日只给「月-日」+ 年龄，不给完整年份 —— 资料页展示生日不需要暴露出生年。
 */
export async function profileForViewer(viewerId, targetId) {
  const row = await readProfile(targetId)
  if (!row) return null
  const user = publicUser(row)
  const sharedGroups = await sharedGroupCount(viewerId, targetId)

  let birthday = null
  let age = null
  if (user.birthday) {
    const [y, m, d] = user.birthday.split('-')
    birthday = `${m}-${d}`
    const now = new Date()
    let a = now.getUTCFullYear() - Number(y)
    const beforeBirthday =
      now.getUTCMonth() + 1 < Number(m) || (now.getUTCMonth() + 1 === Number(m) && now.getUTCDate() < Number(d))
    if (beforeBirthday) a -= 1
    if (a >= 0 && a <= 120) age = a
  }

  return { ...user, birthday, age, sharedGroups }
}

/** 我参与的、也包含目标用户的私聊会话 id（资料页「发消息」直接跳过去） */
export async function privateConversationWith(aId, bId) {
  // 自己跟自己没有「私聊会话」。不加这个判断的话，下面两个 join 会匹配到
  // 同一行成员记录，把我自己随便一个私聊返回出去。
  if (Number(aId) === Number(bId)) return null
  const row = await q.get(
    `SELECT c.id AS id
       FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
      WHERE c.type = 'private'
      LIMIT 1`,
    aId,
    bId
  )
  return row?.id ?? null
}

/**
 * 和我有共同会话的所有人 —— 资料变更后要把新昵称 / 新头像推给他们。
 * 没有共同会话的人看不到我，也就没必要通知。
 */
export async function peersOf(userId) {
  return (
    await q.all(
      `SELECT DISTINCT m2.user_id AS id
         FROM conversation_members m1
         JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
        WHERE m1.user_id = ? AND m2.user_id != ?`,
      userId,
      userId
    )
  ).map((r) => Number(r.id))
}
