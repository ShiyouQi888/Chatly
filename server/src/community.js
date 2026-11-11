/**
 * 社群业务逻辑
 *
 * 「社群」不是一套新的社交关系 —— 它就是**群聊的聚合视图**：
 * 我加入的群、以及公开可加入的群。所以这里没有任何新表，
 * 读写都落在 `conversations` / `conversation_members` 上。
 *
 * 这和之前的「发现页」是两件事。发现页做的是推荐用户、附近的人、活动报名、
 * 话题榜、兴趣标签 —— 那些是把聊天软件往内容社区推的功能，
 * 与本项目「纯粹做即时通讯」的定位冲突，已整体移除。
 * 只保留了「找群 / 加群」这一条 —— 它是聊天的延伸，不是内容消费。
 *
 * ⚠️ `discoverable` 这一列仍然是公开群唯一的开关。
 *    不加它的话，把「设计部」这种工作群列进社群就变成了把别人的私人群公开挂牌。
 */
import { q, insert, tx } from './db.js'
import { broadcastToUsers } from './ws.js'

/**
 * 我**不在里面**的公开群。
 *
 * 已加入的群由客户端的会话列表提供（那份数据本来就带未读数、最后一条消息），
 * 不在这里再查一遍 —— 两处各查一份，群名改了就会出现两个版本。
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

  /* 群主昵称一次性捞回来，别在 map 里逐条查 —— 群多了就是 N+1。 */
  const ownerIds = [...new Set(rows.map((r) => r.ownerId).filter(Boolean))]
  const owners = ownerIds.length
    ? await q.all(
        `SELECT id, nickname FROM users WHERE id IN (${ownerIds.map(() => '?').join(',')})`,
        ...ownerIds
      )
    : []
  const nameOf = new Map(owners.map((u) => [u.id, u.nickname]))

  return {
    groups: rows.map((r) => ({
      id: r.id,
      title: r.title,
      avatar: r.avatar || null,
      memberCount: Number(r.memberCount) || 0,
      ownerNickname: nameOf.get(r.ownerId) || null,
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
