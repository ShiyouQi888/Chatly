/**
 * 发现页业务逻辑
 *
 * 和 chat.js / moment.js 一样只管数据，不做 HTTP。
 *
 * ⚠️ 这一页最容易犯的错是**编数据** —— 「附近 2.3 km」「1.2 万人已加入」「你们有 3 个共同兴趣」
 * 看着很像真的，但位置、活动和浏览行为都必须有真实来源。
 * 所以这里有三条硬规矩：
 *
 *   1. **推荐理由必须可解释**：只能由「共同群聊 / 共同兴趣标签 / 同城」这几样**库里真的有**的东西算出来，
 *      算不出来就出 `null`，让前端不显示理由 —— 不要写「可能认识」这种无法证伪的话。
 *   2. **附近分享默认关闭**：发现页不主动请求设备定位；只有用户在资料页明确授权并手动定位，
 *      才保存城市中心点。关闭时清除坐标。公里数只在双方都授权后按城市中心点估算。
 *   3. **活动复用真实动态卡片与报名表**；话题榜只聚合公开动态，并用去重后的话题打开行为参与排序。
 */
import { q, insert, tx, DB_DRIVER } from './db.js'
import { publicUser, parseTags } from './auth.js'
/* 距离公式与前端**共用同一份**（`shared/geo-math.mjs`）——
   各写一份的话，前端排序和后端算出来的距离能对不上，而且各自单测都会过。 */
import { haversineKm, formatDistance } from '../../shared/geo-math.mjs'
import { sharedGroupCount } from './profile.js'
import { isFollowing, getMoment } from './moment.js'
import { onlineSetOf, broadcastToUsers } from './ws.js'
import { privacyOfMany, onlineVisible } from './privacy.js'
import { friendStates } from './friends.js'

/* ================= 推荐用户 ================= */

/**
 * 共同兴趣标签数。tags 在 DB 里是 JSON 文本，取出后按数组比。
 * 用自己的标签去比对方的标签 —— 双方都没填就是 0（不是「可能认识」）。
 */
function sharedTags(myTags, otherTags) {
  const a = new Set(myTags || [])
  if (!a.size) return 0
  let n = 0
  for (const t of otherTags || []) if (a.has(t)) n += 1
  return n
}

async function myTagsOf(userId) {
  const row = await q.get('SELECT tags FROM users WHERE id = ?', userId)
  return parseTags(row?.tags)
}

/** 地区拆成「省 / 市」两段。'广东 · 深圳' → ['广东', '深圳']；'上海' → ['上海'] */
function regionParts(v) {
  return String(v || '')
    .split(/[·•\-—]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 推荐用户
 *
 * 排序理由是「关系由强到弱」：共同群聊 > 共同兴趣 > 同城 > 其余。
 * 这个顺序不是随便排的 —— 共同群聊是最强的「你们有交集」证据，
 * 而「同省」这种弱信号不该压过它。
 */
export async function recommendUsers({ viewerId, tag = '', limit = 20, offset = 0 }) {
  const me = await q.get('SELECT id, region, tags FROM users WHERE id = ?', viewerId)
  if (!me) return { users: [], hasMore: false }
  const mine = parseTags(me.tags)

  /* 标签筛选：tags 是 JSON 文本，用 LIKE 匹配带引号的标签名（'"电影"'），
     避免「电影」误命中「电影院」这种子串。
     ⚠️ PG 侧会把 LIKE 翻成 ILIKE（见 db/sql.js）—— SQLite 的 LIKE 对 ASCII
     不区分大小写、PG 区分，不翻就是「同一个标签，换个数据库搜不出来」。 */
  const where = ['u.id != ?']
  const args = [viewerId]
  if (tag) {
    where.push(`u.tags LIKE ?`)
    args.push(`%"${String(tag).replace(/["%_]/g, '')}"%`)
  }
  const whereSql = where.join(' AND ')

  const rows = await q.all(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.bio, u.gender, u.region, u.tags,
            (SELECT COUNT(*) FROM follows f
              WHERE f.follower_id = ? AND f.followee_id = u.id) AS followed
       FROM users u
      WHERE ${whereSql}
      ORDER BY u.id
      LIMIT ? OFFSET ?`,
    viewerId,
    ...args,
    Number(limit) + 1,
    Number(offset) || 0
  )

  const hasMore = rows.length > Number(limit)
  const page = rows.slice(0, Number(limit))
  const pageIds = page.map((r) => Number(r.id))
  /* 在线状态是**按人**门控的（对方关了「在线状态可见」就是离线），
     且不能逐个人查 —— 在 PG + Redis 下那是 2N 次网络往返。
     先批量取一次隐私设置与在线集合，再在 map 里查表。 */
  const [privacy, present, relationships] = await Promise.all([
    privacyOfMany(pageIds), onlineSetOf(pageIds), friendStates(Number(viewerId), pageIds),
  ])
  const list = await Promise.all(
    page.map(async (r) => {
      const u = publicUser(r)
      const groups = await sharedGroupCount(viewerId, r.id)
      const tags = sharedTags(mine, u.tags)
      const near = regionRank(me.region, r.region)
      const following = !!r.followed
      return {
        ...u,
        online: onlineVisible(privacy.get(Number(r.id))) && present.has(Number(r.id)),
        following,
        friendStatus: relationships.get(Number(r.id)) || 'none',
        mutualGroups: groups,
        mutualTags: tags,
        sameRegion: near === 2,
        /* 推荐理由：只说库里算得出来的，算不出来给 null（前端就不显示这一行） */
        reason: reasonOf({ groups, tags, sameRegion: near === 2, sameProvince: near === 1 }),
        // 排序权重（内部用）：没关注的排前面 —— 推荐的意义是「发现新人」，
        // 把已经关注的人顶在最前面，这个列表等于白做。
        _rank: [following ? 0 : 1, groups, tags, near],
      }
    })
  )

  list.sort((a, b) => {
    for (let i = 0; i < 4; i++) if (b._rank[i] !== a._rank[i]) return b._rank[i] - a._rank[i]
    return a.id - b.id
  })
  for (const u of list) delete u._rank

  return { users: list, hasMore }
}

function reasonOf({ groups, tags, sameRegion, sameProvince }) {
  if (groups > 0) return `和你在 ${groups} 个群里`
  if (tags > 0) return `有 ${tags} 个共同兴趣`
  if (sameRegion) return '和你同城'
  if (sameProvince) return '和你同省'
  return null
}

/* ================= 附近的人 ================= */

/** 地区匹配度：2=同城（完全相同），1=同省，0=其它 */
function regionRank(a, b) {
  const pa = regionParts(a)
  const pb = regionParts(b)
  if (!pa.length || !pb.length) return 0
  if (pa.join('/') === pb.join('/')) return 2
  // 只要省份（第一段）相同就算同省；单段地区（如「上海」）只和自己算同城
  if (pa.length > 1 && pb.length > 1 && pa[0] === pb[0]) return 1
  return 0
}

/**
 * 附近的人
 *
 * 距离标签有两种来源，**取哪个取决于有没有真实坐标**：
 *
 *   1. 双方都存了「行政区划中心点」，且对方开了 `city_public` →
 *      算**真实大圆距离**，写「约 X km」。依据是**行政区划中心点**，界面上要说明。
 *   2. 否则 → 退回按资料里的地区文字匹配，写「同城 / 同省 / 地区名」。
 *
 * ⚠️ 规矩改成「**距离必须有坐标支撑**」，而不是原来的「一律不出公里数」。
 *    原来那条是因为库里压根没有经纬度，任何 "2.3 km" 都是编的；
 *    用户自己未授权城市分享时不使用任何城市坐标；**没坐标时一个数都不出。**
 *
 * ⚠️ 两个人在**同一个行政区**时，中心点坐标是一样的，算出来是 0 km ——
 *    这时候说「0 km」就成了谎话（人不在同一个点上）。所以这种只写「同城」，
 *    也只有在这种情况下才用「同城」这个词。距离数字一律是**两个中心点之间**的距离。
 */
export async function nearbyUsers({ viewerId, limit = 20 }) {
  const me = await q.get('SELECT id, region, city, city_lat, city_lng, city_public AS cityPublic FROM users WHERE id = ?', viewerId)
  if (!me) return { users: [], myRegion: null, myGeo: null }

  const myGeo =
    Number(me.cityPublic) === 1 && Number.isFinite(me.city_lat) && Number.isFinite(me.city_lng)
      ? { lat: me.city_lat, lng: me.city_lng }
      : null

  const rows = await q.all(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.bio, u.gender, u.region, u.tags,
            u.city, u.city_lat, u.city_lng, u.city_public,
            (SELECT COUNT(*) FROM follows f WHERE f.follower_id = ? AND f.followee_id = u.id) AS followed
       FROM users u WHERE u.id != ? ORDER BY u.id`,
    viewerId,
    viewerId
  )

  /* ⚠️ `myTagsOf()` 与 `sharedGroupCount()` 原来是在 `.map()` 里逐行调的，
     而且 `sharedGroupCount` 一行里调了**两次**（mutualGroups 一次、_rank 一次）。
     同步时代价只是重复查询，感知不到；async 化之后那就是 2N 次串行往返。
     两个都提到循环外面 / 只算一次。 */
  const mineTags = await myTagsOf(viewerId)
  const allIds = rows.map((r) => Number(r.id))
  const [privacy, present, relationships] = await Promise.all([
    privacyOfMany(allIds), onlineSetOf(allIds), friendStates(Number(viewerId), allIds),
  ])

  const list = (
    await Promise.all(
      rows.map(async (r) => {
        const u = publicUser(r)
        const rank = regionRank(me.region, r.region)

        /* 对方的坐标**必须过 `city_public` 这道闸**（publicUser 里也拦了一次，
           这里再判一次是因为下面直接读原始字段，绕过了那一层）。 */
        const theirGeo =
          Number(r.city_public) && Number.isFinite(r.city_lat) && Number.isFinite(r.city_lng)
            ? { lat: r.city_lat, lng: r.city_lng }
            : null

        const km = myGeo && theirGeo ? haversineKm(myGeo, theirGeo) : null
        const sameCity = km !== null && km < 0.05 /* 同一个行政区 → 中心点重合 */

        let distanceLabel
        let distanceBasis
        if (km !== null) {
          distanceBasis = 'city-center'
          distanceLabel = sameCity ? '同城' : `约 ${formatDistance(km)}`
        } else {
          distanceBasis = 'region'
          distanceLabel = rank === 2 ? '同城' : rank === 1 ? '同省' : u.region || '未知地区'
        }

        const groups = await sharedGroupCount(viewerId, r.id)

        return {
          ...u,
          online: onlineVisible(privacy.get(Number(r.id))) && present.has(Number(r.id)),
          following: !!r.followed,
          friendStatus: relationships.get(Number(r.id)) || 'none',
          mutualTags: sharedTags(mineTags, u.tags),
          mutualGroups: groups,
          distanceLabel,
          /* 前端要按这个决定「距离是怎么来的」，好把依据写出来 —— 别让用户以为那是精确位置 */
          distanceBasis,
          near: rank,
          /* ⚠️ 排序键必须是**同一个量纲**。
             一开始写成 `km !== null ? -km : rank` 是错的：-120（120 km）比 rank 的 0/1/2 小，
             结果「有坐标但离得远」的人会被排到「没坐标但同省」的人后面，广州的同事直接掉出列表。
             现在先用「有没有距离」分组，组内再各自比较：
               [0, km 升序, …]  有距离的，近的在前
               [1, -rank, …]    没距离的，按地区匹配度 */
          _rank: [km !== null ? 0 : 1, km !== null ? km : -rank, -groups],
        }
      })
    )
  ).sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (a._rank[i] !== b._rank[i]) return a._rank[i] - b._rank[i]
    }
    return a.id - b.id
  })

  /* ⚠️ 对外**不回自己的坐标**，只回「有没有」——
     前端要的只是「要不要显示『约 X km 按行政区划中心点估算』这句提示」。 */
  for (const u of list) delete u._rank
  return {
    users: list.slice(0, Number(limit) || 20),
    myRegion: me.region || null,
    myGeo: myGeo ? { city: me.city || null } : null,
  }
}

/* ================= 活动与话题 ================= */

/** 发现页只展示当前用户有权查看的、尚未开始的活动动态。 */
export async function upcomingActivities({ viewerId, limit = 20 }) {
  const startsAtSql = DB_DRIVER === 'postgres' || DB_DRIVER === 'pg'
    ? "CAST(mc.payload::jsonb ->> 'startsAt' AS BIGINT)"
    : "CAST(json_extract(mc.payload, '$.startsAt') AS INTEGER)"
  const ids = await q.all(
    `SELECT m.id
       FROM moments m
       JOIN moment_cards mc ON mc.moment_id = m.id AND mc.kind = 'activity'
      WHERE ${startsAtSql} > ?
        AND (
          m.user_id = ? OR (m.visibility = 'public' AND NOT EXISTS (
            SELECT 1 FROM removed_contacts rc WHERE rc.user_id = m.user_id AND rc.contact_id = ?
          ))
          OR (m.visibility = 'friends'
            AND EXISTS (SELECT 1 FROM follows f1 WHERE f1.follower_id = m.user_id AND f1.followee_id = ?)
            AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = ? AND f2.followee_id = m.user_id))
        )
      ORDER BY ${startsAtSql} ASC, m.id DESC
      LIMIT ?`,
    Date.now(), viewerId, viewerId, viewerId, viewerId, Number(limit) || 20
  )
  const moments = await Promise.all(ids.map((row) => getMoment(row.id, viewerId)))
  return { activities: moments.filter((m) => m?.card?.kind === 'activity') }
}

/** 话题仅由最近 30 天的公开动态聚合；浏览热度按独立用户去重，避免反复点击刷榜。 */
export async function trendingTopics({ limit = 20 } = {}) {
  const now = Date.now()
  const rows = await q.all(
    `SELECT m.topic,
            COUNT(DISTINCT m.id) AS momentCount,
            COUNT(DISTINCT v.user_id) AS viewerCount
       FROM moments m
       LEFT JOIN moment_topic_views v
         ON v.topic = m.topic AND v.viewed_at >= ?
      WHERE m.visibility = 'public' AND m.topic IS NOT NULL AND TRIM(m.topic) != ''
        AND m.created_at >= ?
      GROUP BY m.topic
      ORDER BY (COUNT(DISTINCT m.id) + 2 * COUNT(DISTINCT v.user_id)) DESC,
               COUNT(DISTINCT m.id) DESC, m.topic ASC
      LIMIT ?`,
    now - 7 * 24 * 60 * 60 * 1000,
    now - 30 * 24 * 60 * 60 * 1000,
    Number(limit) || 20
  )
  return {
    topics: rows.map((r) => ({
      topic: r.topic,
      momentCount: Number(r.momentCount) || 0,
      viewerCount: Number(r.viewerCount) || 0,
    })),
  }
}

/** 用户主动打开话题时记录一次浏览信号；每人每话题仅保留最近一次，限制刷榜。 */
export async function recordTopicView({ viewerId, topic }) {
  const value = String(topic || '').trim().slice(0, 40)
  if (!value) throw Object.assign(new Error('话题不能为空'), { status: 400 })
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000
  const exists = await q.get(
    "SELECT 1 FROM moments WHERE topic = ? AND visibility = 'public' AND created_at >= ? LIMIT 1",
    value, since
  )
  if (!exists) throw Object.assign(new Error('话题不存在或已过期'), { status: 404 })
  await q.run(
    `INSERT INTO moment_topic_views (topic, user_id, viewed_at) VALUES (?, ?, ?)
     ON CONFLICT(topic, user_id) DO UPDATE SET viewed_at = excluded.viewed_at`,
    value, viewerId, Date.now()
  )
  return { ok: true }
}

/* ================= 兴趣标签 ================= */

/**
 * 兴趣标签聚合：库里所有用户填过的标签 → 人数。
 *
 * 我自己的标签排前面并标 `mine`，因为「按我的兴趣找人」是这个列表的主要用法。
 * 别在前端写死那 10 个标签 —— 用户填了「攀岩」就永远找不到同类。
 */
export async function tagCloud({ viewerId, limit = 24 }) {
  const rows = await q.all(`SELECT tags FROM users WHERE tags IS NOT NULL AND tags != ''`)
  const mine = new Set(await myTagsOf(viewerId))
  const counter = new Map()
  for (const r of rows) {
    for (const t of parseTags(r.tags)) counter.set(t, (counter.get(t) || 0) + 1)
  }
  const list = [...counter.entries()]
    .map(([tag, count]) => ({ tag, count, mine: mine.has(tag) }))
    .sort((a, b) => {
      if (a.mine !== b.mine) return a.mine ? -1 : 1
      if (b.count !== a.count) return b.count - a.count
      return a.tag.localeCompare(b.tag, 'zh')
    })
  return { tags: list.slice(0, Number(limit) || 24) }
}

/* ================= 可加入的兴趣群 ================= */

/**
 * 我**不在里面**的公开群。
 *
 * 「公开」是 `conversations.discoverable` 这一列（幂等 ADD COLUMN 加的）：
 * 不加这一列的话，把「设计部」这种工作群也列进发现页就变成了把别人的私人群公开挂牌。
 */
export async function discoverableGroups({ viewerId, limit = 20 }) {
  const rows = await q.all(
    `SELECT c.id, c.title, c.avatar, c.owner_id AS ownerId, c.created_at AS createdAt,
            (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) AS memberCount
       FROM conversations c
      WHERE c.type = 'group'
        AND c.discoverable = 1
        AND NOT EXISTS (
          SELECT 1 FROM conversation_members m2
           WHERE m2.conversation_id = c.id AND m2.user_id = ?
        )
      ORDER BY memberCount DESC, c.id DESC
      LIMIT ?`,
    viewerId,
    Number(limit) || 20
  )
  return {
    groups: await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        title: r.title,
        avatar: r.avatar || null,
        memberCount: Number(r.memberCount) || 0,
        ownerNickname: (await q.get('SELECT nickname FROM users WHERE id = ?', r.ownerId))?.nickname || null,
      }))
    ),
  }
}

/**
 * 加入一个公开群。
 *
 * 语义是「自己加自己」—— 不是邀请，所以**不需要**管理权限；
 * 但必须校验群是 discoverable 的，否则这就是一个「任意加入任意群」的越权口子
 * （知道 id 就能进别人的私人群）。
 */
export async function joinGroup({ viewerId, groupId }) {
  const c = await q.get('SELECT id, type, discoverable FROM conversations WHERE id = ?', groupId)
  if (!c) throw Object.assign(new Error('群不存在'), { status: 404 })
  if (c.type !== 'group') throw Object.assign(new Error('这不是一个群'), { status: 400 })
  if (!c.discoverable) {
    throw Object.assign(new Error('这个群没有公开，需要群里的人邀请'), { status: 403 })
  }
  const already = await q.get(
    'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    groupId,
    viewerId
  )
  if (already) return { conversationId: groupId, joined: false }

  const prev = (
    await q.all('SELECT user_id AS id FROM conversation_members WHERE conversation_id = ?', groupId)
  ).map((r) => r.id)

  /* 插入成员 + 推进 updated_at 必须是一个事务 —— 否则「人进去了但会话没冒到列表顶部」
     会成为一个真实可达的中间态（第二条语句失败时）。 */
  await tx(async () => {
    await insert(
      'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
      groupId,
      viewerId,
      'member'
    )
    await q.run('UPDATE conversations SET updated_at = ? WHERE id = ?', Math.floor(Date.now() / 1000), groupId)
  })

  /* 加入后要通知**群里已有的人**：不然他们的成员列表还停在旧状态，
     新成员冒出来发消息时列表里查不到他（显示成「某位成员」）。
     本人也要收到 —— 他的会话列表得立刻出现这个群。 */
  broadcastToUsers([...prev, viewerId], 'conversation.updated', {
    conversationId: groupId,
    reason: 'member.joined',
  })

  return { conversationId: groupId, joined: true }
}

/* ================= 关注（发现页用） ================= */

/** 关注状态快照 —— 列表每次返回时带上，前端不用再猜 */
export async function followState(viewerId, targetId) {
  return {
    following: await isFollowing(viewerId, targetId),
    followedBy: await isFollowing(targetId, viewerId),
  }
}
