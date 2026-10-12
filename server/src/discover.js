/**
 * 发现页业务逻辑
 *
 * 和 chat.js / moment.js 一样只管数据，不做 HTTP。
 *
 * ⚠️ 这一页最容易犯的错是**编数据** —— 「附近 2.3 km」「1.2 万人已加入」「你们有 3 个共同兴趣」
 * 看着很像真的，但库里根本没有位置、没有活动、没有浏览行为。
 * 所以这里有三条硬规矩：
 *
 *   1. **推荐理由必须可解释**：只能由「共同群聊 / 共同兴趣标签 / 同城」这几样**库里真的有**的东西算出来，
 *      算不出来就出 `null`，让前端不显示理由 —— 不要写「可能认识」这种无法证伪的话。
 *   2. **距离必须有坐标支撑**：双方都存了行政区划中心点、且对方开了公开开关，才给「约 X km」，
 *      并注明依据是行政区划中心点；否则退回按资料里的地区匹配，写「同城 / 同省 / 地区名」。
 *      库里没有坐标时**一个数都不出**。（原来是「一律不出公里数」——那是因为当时根本没有经纬度。）
 *      PRD 要求的「默认关闭精准位置展示」由 `users.city_public` 保证，默认 0。
 *   3. **没有数据源的板块不做**：活动、热门话题榜这类库里没有表的，前端一律标未接入并禁用，
 *      不塞一批写死的活动卡片。
 */
import { q, insert, tx } from './db.js'
import { publicUser, parseTags } from './auth.js'
/* 距离公式与前端**共用同一份**（`shared/geo-math.mjs`）——
   各写一份的话，前端排序和后端算出来的距离能对不上，而且各自单测都会过。 */
import { haversineKm, formatDistance } from '../../shared/geo-math.mjs'
import { sharedGroupCount } from './profile.js'
import { isFollowing } from './moment.js'
import { broadcastToUsers, isOnline } from './ws.js'

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

function myTagsOf(userId) {
  const row = q.get('SELECT tags FROM users WHERE id = ?', userId)
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
export function recommendUsers({ viewerId, tag = '', limit = 20, offset = 0 }) {
  const me = q.get('SELECT id, region, tags FROM users WHERE id = ?', viewerId)
  if (!me) return { users: [], hasMore: false }
  const mine = parseTags(me.tags)

  /* 标签筛选：tags 是 JSON 文本，用 LIKE 匹配带引号的标签名（'"电影"'），
     避免「电影」误命中「电影院」这种子串。 */
  const where = ['u.id != ?']
  const args = [viewerId]
  if (tag) {
    where.push(`u.tags LIKE ?`)
    args.push(`%"${String(tag).replace(/["%_]/g, '')}"%`)
  }
  const whereSql = where.join(' AND ')

  const rows = q.all(
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
  const list = rows.slice(0, Number(limit)).map((r) => {
    const u = publicUser(r)
    const groups = sharedGroupCount(viewerId, r.id)
    const tags = sharedTags(mine, u.tags)
    const near = regionRank(me.region, r.region)
    const following = !!r.followed
    return {
      ...u,
      online: isOnline(r.id),
      following,
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
 *    现在坐标有了，再把它藏起来反而是另一种不诚实。**没坐标时仍然一个数都不出。**
 *
 * ⚠️ 两个人在**同一个行政区**时，中心点坐标是一样的，算出来是 0 km ——
 *    这时候说「0 km」就成了谎话（人不在同一个点上）。所以这种只写「同城」，
 *    也只有在这种情况下才用「同城」这个词。距离数字一律是**两个中心点之间**的距离。
 */
export function nearbyUsers({ viewerId, limit = 20 }) {
  const me = q.get('SELECT id, region, city_lat, city_lng FROM users WHERE id = ?', viewerId)
  if (!me) return { users: [], myRegion: null, myGeo: null }

  const myGeo =
    Number.isFinite(me.city_lat) && Number.isFinite(me.city_lng)
      ? { lat: me.city_lat, lng: me.city_lng }
      : null

  const rows = q.all(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.bio, u.gender, u.region, u.tags,
            u.city, u.city_lat, u.city_lng, u.city_public,
            (SELECT COUNT(*) FROM follows f WHERE f.follower_id = ? AND f.followee_id = u.id) AS followed
       FROM users u WHERE u.id != ? ORDER BY u.id`,
    viewerId,
    viewerId
  )

  const list = rows
    .map((r) => {
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

      return {
        ...u,
        online: isOnline(r.id),
        following: !!r.followed,
        mutualTags: sharedTags(myTagsOf(viewerId), u.tags),
        mutualGroups: sharedGroupCount(viewerId, r.id),
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
        _rank: [
          km !== null ? 0 : 1,
          km !== null ? km : -rank,
          -sharedGroupCount(viewerId, r.id),
        ],
      }
    })
    .sort((a, b) => {
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

/* ================= 兴趣标签 ================= */

/**
 * 兴趣标签聚合：库里所有用户填过的标签 → 人数。
 *
 * 我自己的标签排前面并标 `mine`，因为「按我的兴趣找人」是这个列表的主要用法。
 * 别在前端写死那 10 个标签 —— 用户填了「攀岩」就永远找不到同类。
 */
export function tagCloud({ viewerId, limit = 24 }) {
  const rows = q.all(`SELECT tags FROM users WHERE tags IS NOT NULL AND tags != ''`)
  const mine = new Set(myTagsOf(viewerId))
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
export function discoverableGroups({ viewerId, limit = 20 }) {
  const rows = q.all(
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
    groups: rows.map((r) => ({
      id: r.id,
      title: r.title,
      avatar: r.avatar || null,
      memberCount: Number(r.memberCount) || 0,
      ownerNickname: q.get('SELECT nickname FROM users WHERE id = ?', r.ownerId)?.nickname || null,
    })),
  }
}

/**
 * 加入一个公开群。
 *
 * 语义是「自己加自己」—— 不是邀请，所以**不需要**管理权限；
 * 但必须校验群是 discoverable 的，否则这就是一个「任意加入任意群」的越权口子
 * （知道 id 就能进别人的私人群）。
 */
export function joinGroup({ viewerId, groupId }) {
  const c = q.get('SELECT id, type, discoverable FROM conversations WHERE id = ?', groupId)
  if (!c) throw Object.assign(new Error('群不存在'), { status: 404 })
  if (c.type !== 'group') throw Object.assign(new Error('这不是一个群'), { status: 400 })
  if (!c.discoverable) {
    throw Object.assign(new Error('这个群没有公开，需要群里的人邀请'), { status: 403 })
  }
  const already = q.get(
    'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    groupId,
    viewerId
  )
  if (already) return { conversationId: groupId, joined: false }

  const prev = q
    .all('SELECT user_id AS id FROM conversation_members WHERE conversation_id = ?', groupId)
    .map((r) => r.id)

  tx(() => {
    insert(
      'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
      groupId,
      viewerId,
      'member'
    )
    q.run('UPDATE conversations SET updated_at = ? WHERE id = ?', Math.floor(Date.now() / 1000), groupId)
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
export function followState(viewerId, targetId) {
  return {
    following: isFollowing(viewerId, targetId),
    followedBy: isFollowing(targetId, viewerId),
  }
}
