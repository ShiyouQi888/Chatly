/**
 * 动态（轻量内容流）业务逻辑
 *
 * 和 chat.js 一样只管数据，不做 HTTP。路由层负责取 `req.user.id` 和转 camelCase。
 *
 * 两条容易做错的规则，写在最前面：
 *
 * 1. **可见范围必须是真的**。`public` 谁都能看；`friends` 只有**互相关注**的人能看；
 *    `private` 只有作者自己能看。没有 `follows` 这张表的话，「仅好友」就是一个
 *    点了没反应的假开关 —— 所以可见范围的判定统一走 `visibleTo()`，
 *    列表和详情都用它（只在一处判，才不会出现「列表看不见、点进去却能看」）。
 * 2. **编辑与删除只有作者能做**，而且删除要连带清掉媒体行 / 点赞 / 评论
 *    （表上都有 ON DELETE CASCADE，但媒体**文件**要按 `conversations` 那套思路另说）。
 */
import { q, insert, tx } from './db.js'
import { publicUser } from './auth.js'
import { isStaticAssetUrl, uploadExists, removeUpload } from './upload.js'
import { parseGeoPair } from '../../shared/geo-math.mjs'

/** 一条动态最多几张图 —— 九宫格是这类产品的通用上限，再多就退化成相册了 */
export const MAX_MEDIA = 9
/** 一条动态最多几个视频 —— 1 个。视频动态是「一段视频 + 一段话」，
 *  放开数量的话列表里每条都要起好几个解码器，滚动起来手机直接发烫。 */
export const MAX_VIDEO = 1
const CONTENT_MAX = 2000
const TOPIC_MAX = 40
const LOCATION_MAX = 60
const COMMENT_MAX = 500

export const VISIBILITIES = ['public', 'friends', 'private']
export const MOMENT_KINDS = ['text', 'image', 'video', 'music']

/* ================= 关注关系 ================= */

export async function isFollowing(followerId, followeeId) {
  return !!(
    await q.get('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?', followerId, followeeId)
  )
}

/** 互相关注才算「好友」—— 单向关注是关注，不是好友 */
export async function isMutual(aId, bId) {
  if (!aId || !bId || aId === bId) return false
  return (await isFollowing(aId, bId)) && (await isFollowing(bId, aId))
}

export async function follow(followerId, followeeId) {
  if (followerId === followeeId) return false
  if (await isFollowing(followerId, followeeId)) return false
  await q.run('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)', followerId, followeeId)
  return true
}

export async function unfollow(followerId, followeeId) {
  await q.run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', followerId, followeeId)
}

/**
 * 我关注的全部人（一个 Set）。
 * 给「找人」搜索结果用：逐行 `isFollowing` 在 PG 模式下就是 N 次往返，
 * 而这个列表上限只有 20 条 —— 一次拉全量再在内存里判，比逐条查便宜得多。
 */
export async function followingIds(followerId) {
  const rows = await q.all('SELECT followee_id FROM follows WHERE follower_id = ?', followerId)
  return new Set(rows.map((r) => Number(r.followee_id)))
}

/**
 * 关注数 / 粉丝数。
 *
 * ⚠️ 字段名必须是 `followingCount` / `followerCount`，**不能叫 `following`**。
 * 路由里是 `{ ...followCounts(id), following: isFollowing(...) }` 这样拼的，
 * 一旦这里也叫 `following`，对象展开就会把那个布尔值**盖成一个数字** ——
 * 客户端 `!!out.following` 恒为 true（数量 > 0），于是「取关」之后按钮还写着「已关注」。
 * 这个 bug 界面上一眼看不出（库里其实已经删了），只有回查数据才会露。
 */
export async function followCounts(userId) {
  const followingCount = (await q.get('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?', userId)).n
  const followerCount = (await q.get('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?', userId)).n
  return { followingCount, followerCount }
}

/* ================= 可见性 ================= */

const VISIBLE_SQL = `
  m.user_id = @viewer
  OR (
    m.visibility = 'public'
    AND NOT EXISTS (
      SELECT 1 FROM removed_contacts rc
      WHERE rc.user_id = m.user_id AND rc.contact_id = @viewer
    )
  )
  OR (
    m.visibility = 'friends'
    AND EXISTS (SELECT 1 FROM follows f1 WHERE f1.follower_id = m.user_id AND f1.followee_id = @viewer)
    AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = @viewer AND f2.followee_id = m.user_id)
  )
`

/** 这条动态 viewer 看得见吗 —— 列表与详情共用同一份判定 */
export async function visibleTo(momentId, viewerId) {
  const row = await q.get('SELECT user_id AS userId, visibility FROM moments WHERE id = ?', momentId)
  if (!row) return false
  if (Number(row.userId) === Number(viewerId)) return true
  const removed = await q.get(
    'SELECT 1 FROM removed_contacts WHERE user_id = ? AND contact_id = ?',
    row.userId, viewerId
  )
  if (removed) return false
  return row.visibility === 'public' || (row.visibility === 'friends' && (await isMutual(row.userId, viewerId)))
}

/* ================= 查询 ================= */

async function mediaOf(momentId) {
  return (
    await q.all(
      `SELECT id, kind, url, file_name AS fileName, file_size AS fileSize, sort,
              width, height, duration
       FROM moment_media WHERE moment_id = ? ORDER BY sort, id`,
      momentId
    )
  ).map((r) => ({
    id: r.id,
    kind: r.kind,
    url: r.url,
    fileName: r.fileName,
    fileSize: Number(r.fileSize) || 0,
    /* 宽高时长可能为 NULL（老数据 / 客户端没读到）—— 交给前端决定兜底比例，
       这里不要编一个 0 或 16:9 出来：0 会让 aspect-ratio 直接失效。 */
    width: r.width ? Number(r.width) : null,
    height: r.height ? Number(r.height) : null,
    duration: Number.isFinite(Number(r.duration)) && r.duration > 0 ? Number(r.duration) : null,
  }))
}

async function authorOf(userId) {
  const u = await q.get('SELECT id, username, nickname, avatar, bio FROM users WHERE id = ?', userId)
  return publicUser(u)
}

function invalidCard(message) {
  return Object.assign(new Error(message), { status: 400 })
}

function validateCard(input, { allowPastActivity = false } = {}) {
  if (input == null) return null
  const kind = input?.kind
  const data = input?.data || {}
  if (kind === 'poll') {
    const question = cleanText(data.question, 120)
    const options = [...new Set((Array.isArray(data.options) ? data.options : []).map((v) => cleanText(v, 60)).filter(Boolean))]
    if (!question) throw invalidCard('请填写投票问题')
    if (options.length < 2 || options.length > 6) throw invalidCard('投票需要 2 到 6 个不同选项')
    return { kind, data: { question, options, multi: !!data.multi } }
  }
  if (kind === 'activity') {
    const title = cleanText(data.title, 100)
    const startsAt = Number(data.startsAt)
    if (!title) throw invalidCard('请填写活动名称')
    if (!Number.isSafeInteger(startsAt) || (!allowPastActivity && startsAt <= Date.now())) throw invalidCard('活动时间必须晚于现在')
    return {
      kind,
      data: {
        title,
        startsAt,
        location: cleanText(data.location, 120),
        description: cleanText(data.description, 500),
      },
    }
  }
  if (kind === 'link') {
    const rawUrl = cleanText(data.url, 2048)
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch {
      throw invalidCard('请输入有效的链接地址')
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw invalidCard('链接只支持 http 或 https')
    const title = cleanText(data.title, 120)
    if (!title) throw invalidCard('请填写链接标题')
    return { kind, data: { url: parsed.href, title, description: cleanText(data.description, 300) } }
  }
  throw invalidCard('动态卡片类型无效')
}

async function storeCard(momentId, card) {
  const previous = await q.get('SELECT kind, payload FROM moment_cards WHERE moment_id = ?', momentId)
  const nextPayload = card ? JSON.stringify(card.data) : null
  const isChangingVotedPoll = previous?.kind === 'poll' &&
    (!card || card.kind !== previous.kind || nextPayload !== previous.payload)
  if (isChangingVotedPoll) {
    const existing = await q.get('SELECT 1 AS found FROM moment_card_voters WHERE moment_id = ? LIMIT 1', momentId)
    if (existing) throw Object.assign(new Error('投票已有成员参与，不能编辑或删除投票卡片'), { status: 409 })
  }
  if (!card) {
    await q.run('DELETE FROM moment_card_votes WHERE moment_id = ?', momentId)
    await q.run('DELETE FROM moment_card_rsvps WHERE moment_id = ?', momentId)
    await q.run('DELETE FROM moment_cards WHERE moment_id = ?', momentId)
    return
  }
  if (previous && (previous.kind !== card.kind || previous.payload !== JSON.stringify(card.data))) {
    /* 问题、选项或活动内容改过后，旧票和旧报名已不再对应新卡片。 */
    await q.run('DELETE FROM moment_card_votes WHERE moment_id = ?', momentId)
    await q.run('DELETE FROM moment_card_rsvps WHERE moment_id = ?', momentId)
  }
  await q.run(
    `INSERT INTO moment_cards (moment_id, kind, payload) VALUES (?, ?, ?)
     ON CONFLICT(moment_id) DO UPDATE SET kind = excluded.kind, payload = excluded.payload`,
    momentId,
    card.kind,
    JSON.stringify(card.data)
  )
}

async function cardOf(momentId, viewerId) {
  const row = await q.get('SELECT kind, payload FROM moment_cards WHERE moment_id = ?', momentId)
  if (!row) return null
  let data = {}
  try { data = JSON.parse(row.payload) } catch { return null }
  if (row.kind === 'poll') {
    const counts = await q.all(
      'SELECT option_idx AS optionIdx, COUNT(*) AS count FROM moment_card_votes WHERE moment_id = ? GROUP BY option_idx',
      momentId
    )
    const mine = await q.all('SELECT option_idx AS optionIdx FROM moment_card_votes WHERE moment_id = ? AND user_id = ?', momentId, viewerId)
    const options = Array.isArray(data.options) ? data.options : []
    const voteCounts = Array(options.length).fill(0)
    for (const count of counts) {
      const index = Number(count.optionIdx)
      if (index >= 0 && index < voteCounts.length) voteCounts[index] = Number(count.count) || 0
    }
    return {
      kind: 'poll',
      data: data.question && Array.isArray(data.options) ? data : { question: '', options: [] },
      counts: voteCounts,
      myOptions: mine.map((r) => Number(r.optionIdx)),
      totalVotes: Number((await q.get('SELECT COUNT(DISTINCT user_id) AS n FROM moment_card_votes WHERE moment_id = ?', momentId))?.n) || 0,
    }
  }
  if (row.kind === 'activity') {
    const counts = await q.all('SELECT status, COUNT(*) AS count FROM moment_card_rsvps WHERE moment_id = ? GROUP BY status', momentId)
    const mine = await q.get('SELECT status FROM moment_card_rsvps WHERE moment_id = ? AND user_id = ?', momentId, viewerId)
    return { kind: 'activity', data, going: Number(counts.find((r) => r.status === 'going')?.count) || 0, interested: Number(counts.find((r) => r.status === 'interested')?.count) || 0, myStatus: mine?.status || null }
  }
  return { kind: 'link', data }
}

export async function voteMomentCard(momentId, userId, optionIndexes) {
  const card = await cardOf(momentId, userId)
  if (!card || card.kind !== 'poll') throw Object.assign(new Error('投票卡片不存在'), { status: 404 })
  const indexes = [...new Set((Array.isArray(optionIndexes) ? optionIndexes : []).map(Number))]
  if (!indexes.length || indexes.some((i) => !Number.isInteger(i) || i < 0 || i >= card.data.options.length)) {
    throw invalidCard('请选择有效选项')
  }
  if (!card.data.multi && indexes.length > 1) throw invalidCard('该投票只能选择一个选项')
  await tx(async () => {
    const existing = await q.get('SELECT 1 AS found FROM moment_card_voters WHERE moment_id = ? AND user_id = ?', momentId, userId)
    if (existing) throw Object.assign(new Error('你已经投过票，不能修改或撤销'), { status: 409 })
    const marker = await q.run(
      'INSERT OR IGNORE INTO moment_card_voters (moment_id, user_id, created_at) VALUES (?, ?, ?)',
      momentId,
      userId,
      Date.now()
    )
    if (marker.changes !== 1) throw Object.assign(new Error('你已经投过票，不能修改或撤销'), { status: 409 })
    for (const optionIdx of indexes) {
      await q.run('INSERT INTO moment_card_votes (moment_id, user_id, option_idx, created_at) VALUES (?, ?, ?, ?)', momentId, userId, optionIdx, Date.now())
    }
  })
  return cardOf(momentId, userId)
}

export async function respondToMomentActivity(momentId, userId, status) {
  if (!['going', 'interested', null].includes(status)) throw invalidCard('活动状态无效')
  const card = await cardOf(momentId, userId)
  if (!card || card.kind !== 'activity') throw Object.assign(new Error('活动卡片不存在'), { status: 404 })
  if (status !== null && Number(card.data?.startsAt) <= Date.now()) {
    throw Object.assign(new Error('活动已经开始，不能再报名'), { status: 400 })
  }
  if (status === null) await q.run('DELETE FROM moment_card_rsvps WHERE moment_id = ? AND user_id = ?', momentId, userId)
  else await q.run(
    `INSERT INTO moment_card_rsvps (moment_id, user_id, status, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(moment_id, user_id) DO UPDATE SET status = excluded.status, created_at = excluded.created_at`,
    momentId, userId, status, Date.now()
  )
  return cardOf(momentId, userId)
}

async function shape(row, viewerId) {
  const media = await mediaOf(row.id)
  return {
    id: row.id,
    kind: row.kind,
    content: row.content || '',
    topic: row.topic || '',
    location: row.location || '',
    /* 定位的坐标。可能为 null（老动态只有地点名，或用户手动输入的地点名）——
       前端据此决定「能不能画地图」，所以不能在这里补 0。 */
    locationLat: Number.isFinite(row.locationLat) ? row.locationLat : null,
    locationLng: Number.isFinite(row.locationLng) ? row.locationLng : null,
    visibility: row.visibility,
    music:
      row.kind === 'music'
        ? {
            title: row.music_title || '',
            artist: row.music_artist || '',
            duration: row.music_duration || '',
          }
        : null,
    media,
    card: await cardOf(row.id, viewerId),
    author: await authorOf(row.userId),
    mine: row.userId === viewerId,
    liked: !!row.liked,
    likeCount: Number(row.likeCount) || 0,
    commentCount: Number(row.commentCount) || 0,
    createdAt: Number(row.createdAt),
    editedAt: row.editedAt ? Number(row.editedAt) : null,
  }
}

const SELECT_COLS = `
  m.id, m.user_id AS userId, m.kind, m.content, m.topic, m.location, m.visibility,
  m.location_lat AS locationLat, m.location_lng AS locationLng,
  m.music_title AS musicTitle, m.music_artist AS musicArtist, m.music_duration AS musicDuration,
  m.created_at AS createdAt, m.edited_at AS editedAt,
  (SELECT COUNT(*) FROM moment_likes l WHERE l.moment_id = m.id) AS likeCount,
  (SELECT COUNT(*) FROM moment_comments c WHERE c.moment_id = m.id) AS commentCount,
  EXISTS (SELECT 1 FROM moment_likes l WHERE l.moment_id = m.id AND l.user_id = @viewer) AS liked
`

/**
 * 动态列表。
 * scope:
 *   friends —— 我能看到的所有人的（含自己），按时间倒序
 *   mine    —— 只看自己发的
 *   hot     —— 我能看到的，按热度（赞 + 评论加权）排，时间次之
 */
export async function listMoments({ viewerId, scope = 'friends', topic = '', beforeId = null, limit = 20 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 50)
  const where = [`(${VISIBLE_SQL})`]
  /* ⚠️ 这里是**命名参数**（`@viewer`，PG 侧由 db/sql.js 翻成 `$n`）。
     加新条件时记得往 params 里补键 —— 少一个键会在翻译层直接报错并指出名字，
     不会像位置参数那样「少一个就整体错位」。 */
  const params = { viewer: viewerId, limit: cap }

  if (topic) {
    where.push('m.topic = @topic')
    params.topic = String(topic).trim().slice(0, 40)
  }

  if (scope === 'mine') where.push('m.user_id = @viewer')
  if (beforeId) {
    where.push('m.id < @beforeId')
    params.beforeId = Number(beforeId)
  }

  const order =
    scope === 'hot'
      ? `((SELECT COUNT(*) FROM moment_likes l WHERE l.moment_id = m.id)
          + 2 * (SELECT COUNT(*) FROM moment_comments c WHERE c.moment_id = m.id)) DESC,
         m.created_at DESC`
      : 'm.created_at DESC, m.id DESC'

  const rows = await q.all(
    `SELECT ${SELECT_COLS}
     FROM moments m
     WHERE ${where.join(' AND ')}
     ORDER BY ${order}
     LIMIT @limit`,
    params
  )

  return {
    moments: await Promise.all(rows.map((r) => shape(r, viewerId))),
    hasMore: rows.length === cap,
  }
}

export async function getMoment(momentId, viewerId) {
  const row = await q.get(
    `SELECT ${SELECT_COLS} FROM moments m WHERE m.id = @id`,
    { viewer: viewerId, id: momentId }
  )
  return row ? await shape(row, viewerId) : null
}

/* ================= 发布 / 编辑 / 删除 ================= */

function cleanText(v, max) {
  if (v == null) return null
  /* 按 Unicode 码点计数，与前端计数一致；String#slice 会把补充平面字符拆成代理项。 */
  const s = [...String(v).trim()].slice(0, max).join('')
  return s || null
}

/** 正整数或 null（宽高） */
function positiveInt(v) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 动态定位的坐标 —— 走 `shared/geo-math.mjs` 的 `parseGeoPair()`，**不在这里再写一份**。
 *
 * ⚠️ 别改回 `Number.isFinite(Number(lat))` 那种写法：`Number(null) === 0`，
 *    于是「只给了一个坐标」「显式清空坐标」都会被判成合法的 (0, 0) ——
 *    那落在几内亚湾，界面上会认真画出一张非洲西海岸的地图。
 *    这个坑不报错、不崩，只是安静地指错地方（自检里两条断言就是专门盯它的）。
 */
function cleanGeoPair(lat, lng) {
  return parseGeoPair(lat, lng)
}

/** 正数或 null（时长，秒，带小数） */
function positiveNum(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 媒体地址白名单校验。和消息的 fileUrl 用同一个 `isStaticAssetUrl()` ——
 * 不校验的话客户端能把任意 URL 写进动态，别人刷到就去请求那个地址（外链 / 追踪像素）。
 */
function assertMedia(media) {
  const list = Array.isArray(media) ? media : []
  if (list.length > MAX_MEDIA) {
    throw Object.assign(new Error(`一张动态最多 ${MAX_MEDIA} 个媒体`), { status: 400 })
  }
  /* 视频最多 1 个 —— 这也是朋友圈的规则：视频动态是「一段视频 + 一段话」，
     不是九宫格里塞满小视频。放开数量的话，列表里每条都要起好几个解码器，
     滚动起来手机直接发烫，而收益几乎为零。 */
  if (list.filter((m) => m?.kind === 'video').length > MAX_VIDEO) {
    throw Object.assign(new Error(`一条动态最多 ${MAX_VIDEO} 个视频`), { status: 400 })
  }
  /* 视频与图片互斥 —— 前端已经在选文件那一步挡了，这里还要再挡一次：
     只挡在前端的话，绕过界面直接 POST 就能混着发，而列表渲染是按
     「有视频就走播放器、否则走网格」分的，混着发会有一半媒体永远显示不出来。 */
  if (list.some((m) => m?.kind === 'video') && list.some((m) => m?.kind !== 'video')) {
    throw Object.assign(new Error('视频和图片不能混发 —— 一条动态要么是一段视频，要么是几张图'), { status: 400 })
  }
  return list.map((m, i) => {
    const url = String(m?.url || '')
    if (!isStaticAssetUrl(url)) {
      throw Object.assign(new Error('媒体地址不合法'), { status: 400 })
    }
    /* 地址形态合法还不够，文件得真的在磁盘上。
       和消息那边的取舍不同：消息是历史记录，图被清理掉是正常现象（前端有破图兜底）；
       动态是**刚发布**的，图/视频刚传上来，文件不在就说明客户端拿了个旧地址或凭空编的地址 ——
       放过去就是一条永远加载不出来的动态。 */
    if (url.startsWith('/uploads/') && !uploadExists(url)) {
      throw Object.assign(new Error('有个媒体文件已经不在了，请重新上传'), { status: 400 })
    }
    const kind = m?.kind === 'video' ? 'video' : 'image'
    return {
      kind,
      url,
      fileName: cleanText(m?.fileName, 200) || null,
      fileSize: Number(m?.fileSize) || 0,
      sort: i,
      /* 宽高只认正整数（客户端读视频元数据得来的）；给个 0 或负数会让
         前端的 aspect-ratio 变成非法值，整块塌成一条线。 */
      width: positiveInt(m?.width),
      height: positiveInt(m?.height),
      duration: positiveNum(m?.duration),
    }
  })
}

export async function createMoment({
  userId,
  content,
  topic,
  location,
  locationLat,
  locationLng,
  visibility = 'public',
  media = [],
  music = null,
  card = null,
}) {
  const text = cleanText(content, CONTENT_MAX)
  const savedCard = validateCard(card)
  const hasMedia = Array.isArray(media) && media.length > 0
  const hasMusic = music && (music.title || music.artist)
  if (!text && !hasMedia && !hasMusic && !savedCard) {
    throw Object.assign(new Error('写点什么，或者至少配一张图'), { status: 400 })
  }

  const vis = VISIBILITIES.includes(visibility) ? visibility : 'public'
  const kind = hasMedia ? (media.some((m) => m?.kind === 'video') ? 'video' : 'image') : hasMusic ? 'music' : 'text'
  const items = assertMedia(media)
  const geo = cleanGeoPair(locationLat, locationLng)

  return tx(async () => {
    const id = await insert(
      `INSERT INTO moments (user_id, kind, content, topic, location, location_lat, location_lng, visibility,
                            music_title, music_artist, music_duration, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      kind,
      text,
      cleanText(topic, TOPIC_MAX),
      cleanText(location, LOCATION_MAX),
      geo?.lat ?? null,
      geo?.lng ?? null,
      vis,
      hasMusic ? cleanText(music.title, 120) : null,
      hasMusic ? cleanText(music.artist, 120) : null,
      hasMusic ? cleanText(music.duration, 20) : null,
      Date.now()
    )
    for (const it of items) {
      await insert(
        `INSERT INTO moment_media (moment_id, kind, url, file_name, file_size, sort,
                                   width, height, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        it.kind,
        it.url,
        it.fileName,
        it.fileSize,
        it.sort,
        it.width,
        it.height,
        it.duration
      )
    }
    await storeCard(id, savedCard)
    return id
  })
}

async function removeUnreferencedMomentUploads(urls) {
  const unique = [...new Set((urls || []).filter((url) => isStaticAssetUrl(url) && uploadExists(url)))]
  const referenceChecks = [
    'SELECT 1 FROM moment_media WHERE url = ? LIMIT 1',
    'SELECT 1 FROM messages WHERE file_url = ? LIMIT 1',
    'SELECT 1 FROM favorites WHERE file_url = ? LIMIT 1',
    'SELECT 1 FROM feedbacks WHERE screenshot_url = ? LIMIT 1',
    'SELECT 1 FROM users WHERE avatar = ? OR profile_cover = ? LIMIT 1',
    'SELECT 1 FROM conversations WHERE avatar = ? LIMIT 1',
  ]
  for (const url of unique) {
    let referenced = false
    for (const sql of referenceChecks) {
      const args = sql.includes('avatar = ? OR profile_cover = ?') ? [url, url] : [url]
      if (await q.get(sql, ...args)) {
        referenced = true
        break
      }
    }
    if (!referenced) removeUpload(url)
  }
}

/**
 * 改一条动态。只改传进来的字段（局部更新不能把别的冲成 null），
 * 但**媒体是整体替换** —— 单独做「增删某一张」的接口会让前后端都为顺序和 id 打架。
 */
export async function updateMoment(momentId, userId, patch = {}) {
  const m = await q.get('SELECT id, user_id AS userId FROM moments WHERE id = ?', momentId)
  if (!m) throw Object.assign(new Error('动态不存在'), { status: 404 })
  if (m.userId !== userId) {
    throw Object.assign(new Error('只能编辑自己发布的动态'), { status: 403 })
  }
  const oldMediaUrls = patch.media !== undefined
    ? (await q.all('SELECT url FROM moment_media WHERE moment_id = ?', momentId)).map((row) => row.url)
    : []

  const sets = []
  const args = []

  if (patch.content !== undefined) {
    const t = cleanText(patch.content, CONTENT_MAX)
    if (!t) throw Object.assign(new Error('内容不能为空'), { status: 400 })
    sets.push('content = ?')
    args.push(t)
  }
  if (patch.topic !== undefined) {
    sets.push('topic = ?')
    args.push(cleanText(patch.topic, TOPIC_MAX))
  }
  if (patch.location !== undefined) {
    sets.push('location = ?')
    args.push(cleanText(patch.location, LOCATION_MAX))
  }
  /* 坐标和地点名分开传（改名字不该顺手把坐标清掉）；
     只要动了任一坐标，就按「成对校验」整体重写 —— 半个坐标是脏数据，不留。
     传 null 是**有效输入**（「取消定位」），`cleanGeoPair` 会还回 null，
     两个列一起写成 NULL。别改成 `if (patch.locationLat)`：那样传 null 就清不掉了。 */
  if (patch.locationLat !== undefined || patch.locationLng !== undefined) {
    const geo = cleanGeoPair(patch.locationLat, patch.locationLng)
    sets.push('location_lat = ?', 'location_lng = ?')
    args.push(geo?.lat ?? null, geo?.lng ?? null)
  }
  if (patch.visibility !== undefined) {
    if (!VISIBILITIES.includes(patch.visibility)) {
      throw Object.assign(new Error('可见范围取值非法'), { status: 400 })
    }
    sets.push('visibility = ?')
    args.push(patch.visibility)
  }
  if (patch.music !== undefined) {
    const mu = patch.music || null
    sets.push('music_title = ?', 'music_artist = ?', 'music_duration = ?')
    args.push(
      mu ? cleanText(mu.title, 120) : null,
      mu ? cleanText(mu.artist, 120) : null,
      mu ? cleanText(mu.duration, 20) : null
    )
  }
  const savedCard = patch.card !== undefined ? validateCard(patch.card, { allowPastActivity: true }) : undefined

  const updated = await tx(async () => {
    if (sets.length) {
      sets.push('edited_at = ?')
      args.push(Date.now())
      await q.run(`UPDATE moments SET ${sets.join(', ')} WHERE id = ?`, ...args, momentId)
    }
    if (patch.media !== undefined) {
      const items = assertMedia(patch.media)
      await q.run('DELETE FROM moment_media WHERE moment_id = ?', momentId)
      for (const it of items) {
        await insert(
          `INSERT INTO moment_media (moment_id, kind, url, file_name, file_size, sort,
                                     width, height, duration)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          momentId,
          it.kind,
          it.url,
          it.fileName,
          it.fileSize,
          it.sort,
          it.width,
          it.height,
          it.duration
        )
      }
      // 媒体换过之后 kind 要跟着变：原来只有文字、现在配了图，卡片得按图片渲染
      const kind = items.length
        ? items.some((i) => i.kind === 'video')
          ? 'video'
          : 'image'
        : (await q.get('SELECT music_title AS t FROM moments WHERE id = ?', momentId)).t
          ? 'music'
          : 'text'
      await q.run('UPDATE moments SET kind = ?, edited_at = ? WHERE id = ?', kind, Date.now(), momentId)
    }
    if (savedCard !== undefined) {
      await storeCard(momentId, savedCard)
      if (!sets.length && patch.media === undefined) {
        await q.run('UPDATE moments SET edited_at = ? WHERE id = ?', Date.now(), momentId)
      }
    }
    return true
  })
  if (patch.media !== undefined) await removeUnreferencedMomentUploads(oldMediaUrls)
  return updated
}

/** 删自己的动态。媒体 / 点赞 / 评论靠表上的 ON DELETE CASCADE 一起清掉 */
export async function deleteMoment(momentId, userId) {
  const m = await q.get('SELECT id, user_id AS userId FROM moments WHERE id = ?', momentId)
  if (!m) throw Object.assign(new Error('动态不存在'), { status: 404 })
  if (m.userId !== userId) {
    throw Object.assign(new Error('只能删除自己发布的动态'), { status: 403 })
  }
  const mediaUrls = (await q.all('SELECT url FROM moment_media WHERE moment_id = ?', momentId)).map((row) => row.url)
  await q.run('DELETE FROM moments WHERE id = ?', momentId)
  await removeUnreferencedMomentUploads(mediaUrls)
  return true
}

/* ================= 点赞 ================= */

export async function toggleLike(momentId, userId) {
  const m = await q.get('SELECT id FROM moments WHERE id = ?', momentId)
  if (!m) throw Object.assign(new Error('动态不存在'), { status: 404 })

  const had = await q.get(
    'SELECT 1 FROM moment_likes WHERE moment_id = ? AND user_id = ?',
    momentId,
    userId
  )
  if (had) {
    await q.run('DELETE FROM moment_likes WHERE moment_id = ? AND user_id = ?', momentId, userId)
  } else {
    await q.run(
      'INSERT INTO moment_likes (moment_id, user_id, created_at) VALUES (?, ?, ?)',
      momentId,
      userId,
      Date.now()
    )
  }
  const likeCount = (await q.get('SELECT COUNT(*) AS n FROM moment_likes WHERE moment_id = ?', momentId)).n
  return { liked: !had, likeCount }
}

/** 谁赞了这条（详情页的赞列表） */
export async function likedBy(momentId, limit = 20) {
  return (
    await q.all(
      `SELECT u.id, u.username, u.nickname, u.avatar, u.bio, l.created_at AS createdAt
       FROM moment_likes l JOIN users u ON u.id = l.user_id
       WHERE l.moment_id = ? ORDER BY l.created_at DESC LIMIT ?`,
      momentId,
      limit
    )
  ).map((r) => ({ user: publicUser(r), createdAt: Number(r.createdAt) }))
}

/* ================= 评论 ================= */

export async function listComments(momentId, limit = 100) {
  return (
    await q.all(
      `SELECT c.id, c.parent_id AS parentId, c.content, c.created_at AS createdAt,
              c.user_id AS userId,
              u.username, u.nickname, u.avatar, u.bio,
              r.id AS replyId, r.username AS replyUsername, r.nickname AS replyNickname
       FROM moment_comments c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN users r ON r.id = c.reply_to_user_id
       WHERE c.moment_id = ?
       ORDER BY c.id
       LIMIT ?`,
      momentId,
      limit
    )
  ).map((r) => ({
    id: r.id,
    parentId: r.parentId ? Number(r.parentId) : null,
    content: r.content,
    createdAt: Number(r.createdAt),
    author: publicUser({
      id: r.userId,
      username: r.username,
      nickname: r.nickname,
      avatar: r.avatar,
      bio: r.bio,
    }),
    replyTo: r.replyId ? { id: r.replyId, nickname: r.replyNickname } : null,
  }))
}

export async function addComment({ momentId, userId, content, parentId = null }) {
  const text = cleanText(content, COMMENT_MAX)
  if (!text) throw Object.assign(new Error('评论不能为空'), { status: 400 })

  const m = await q.get('SELECT id FROM moments WHERE id = ?', momentId)
  if (!m) throw Object.assign(new Error('动态不存在'), { status: 404 })

  let parent = null
  if (parentId) {
    parent = await q.get(
      'SELECT id, user_id AS userId FROM moment_comments WHERE id = ? AND moment_id = ?',
      Number(parentId),
      momentId
    )
    if (!parent) throw Object.assign(new Error('要回复的评论不存在'), { status: 404 })
  }

  const id = await insert(
    `INSERT INTO moment_comments (moment_id, user_id, parent_id, reply_to_user_id, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    momentId,
    userId,
    parent ? parent.id : null,
    parent ? parent.userId : null,
    text,
    Date.now()
  )
  const count = (await q.get('SELECT COUNT(*) AS n FROM moment_comments WHERE moment_id = ?', momentId)).n
  return { id, commentCount: count }
}

/**
 * 删评论：评论本人可以删，动态作者也可以删自己动态下的评论。
 * 传了 momentId 就再校验「这条评论确实属于这条动态」——
 * 否则接口形如 `DELETE /moments/:id/comments/:commentId` 时，
 * `:id` 只是个摆设，拿别的动态 id 也能删掉自己那条评论。
 */
export async function deleteComment(commentId, userId, momentId = null) {
  const c = await q.get(
    `SELECT c.id, c.user_id AS userId, c.moment_id AS momentId, m.user_id AS momentOwner
     FROM moment_comments c JOIN moments m ON m.id = c.moment_id
     WHERE c.id = ?`,
    commentId
  )
  if (!c) throw Object.assign(new Error('评论不存在'), { status: 404 })
  if (momentId != null && Number(c.momentId) !== Number(momentId)) {
    throw Object.assign(new Error('这条评论不属于该动态'), { status: 404 })
  }
  if (c.userId !== userId && c.momentOwner !== userId) {
    throw Object.assign(new Error('只能删除自己的评论，或自己动态下的评论'), { status: 403 })
  }
  await q.run('DELETE FROM moment_comments WHERE id = ?', commentId)
  return true
}

/** 我的动态数（个人空间要用） */
export async function momentCount(userId) {
  return (await q.get('SELECT COUNT(*) AS n FROM moments WHERE user_id = ?', userId)).n
}
