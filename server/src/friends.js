import { q, insert, tx } from './db.js'
import { follow, isFollowing } from './moment.js'

/** Relationship state for a viewer and a list of profiles. */
export async function friendStates(viewerId, targetIds) {
  const ids = [...new Set((targetIds || []).map(Number).filter((id) => id && id !== Number(viewerId)))]
  const result = new Map(ids.map((id) => [id, 'none']))
  if (!ids.length) return result

  const marks = ids.map(() => '?').join(',')
  const [requests, outgoing, incoming] = await Promise.all([
    q.all(
      `SELECT requester_id AS requesterId, recipient_id AS recipientId
         FROM friend_requests
        WHERE status = 'pending'
          AND ((requester_id = ? AND recipient_id IN (${marks}))
            OR (recipient_id = ? AND requester_id IN (${marks})))`,
      viewerId, ...ids, viewerId, ...ids
    ),
    q.all(`SELECT followee_id AS id FROM follows WHERE follower_id = ? AND followee_id IN (${marks})`, viewerId, ...ids),
    q.all(`SELECT follower_id AS id FROM follows WHERE followee_id = ? AND follower_id IN (${marks})`, viewerId, ...ids),
  ])

  const requested = new Set(requests.filter((r) => Number(r.requesterId) === Number(viewerId)).map((r) => Number(r.recipientId)))
  const received = new Set(requests.filter((r) => Number(r.recipientId) === Number(viewerId)).map((r) => Number(r.requesterId)))
  const followsOut = new Set(outgoing.map((r) => Number(r.id)))
  const followsIn = new Set(incoming.map((r) => Number(r.id)))
  for (const id of ids) {
    result.set(id,
      followsOut.has(id) && followsIn.has(id) ? 'friends'
        : received.has(id) ? 'incoming'
          : requested.has(id) ? 'outgoing'
            : 'none')
  }
  return result
}

/** Private conversations require mutual friendship; a pending request is not permission to message. */
export async function privatePairGate(senderId, peerId) {
  const removed = await q.get(
    'SELECT 1 FROM removed_contacts WHERE (user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)',
    peerId, senderId, senderId, peerId
  )
  if (removed) return { code: 'friend_removed', error: '对方已将你删除，消息未发送' }

  const friends = await isFollowing(senderId, peerId) && await isFollowing(peerId, senderId)
  if (!friends) return { code: 'friend_required', error: '你们还不是好友，请先发送好友申请并等待对方同意' }
  return null
}

export async function privateMessageGate(conversationId, senderId) {
  const conversation = await q.get('SELECT type FROM conversations WHERE id = ?', conversationId)
  if (conversation?.type !== 'private') return null
  const peer = await q.get(
    'SELECT user_id AS userId FROM conversation_members WHERE conversation_id = ? AND user_id <> ? LIMIT 1',
    conversationId, senderId
  )
  return peer ? privatePairGate(senderId, peer.userId) : null
}

export async function createFriendRequest(requesterId, recipientId) {
  try {
    return await tx(async () => {
      if (await isFollowing(requesterId, recipientId) && await isFollowing(recipientId, requesterId)) {
        return { status: 'friends', requestId: null, created: false }
      }
      const outgoing = await q.get(
        "SELECT id FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'",
        requesterId, recipientId
      )
      if (outgoing) return { status: 'outgoing', requestId: Number(outgoing.id), created: false }
      const incoming = await q.get(
        "SELECT id FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'",
        recipientId, requesterId
      )
      if (incoming) return { status: 'incoming', requestId: Number(incoming.id), created: false }

      const now = Date.now()
      const requestId = await insert(
        `INSERT INTO friend_requests (requester_id, recipient_id, status, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)`,
        requesterId, recipientId, now, now
      )
      return { status: 'outgoing', requestId: Number(requestId), created: true }
    })
  } catch (error) {
    /* 两端同时点申请时，唯一索引保住「一对用户最多一条待处理申请」；
       把并发插入输掉的一端折叠成现有状态，避免偶发 500。 */
    const outgoing = await q.get(
      "SELECT id FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'",
      requesterId, recipientId
    )
    if (outgoing) return { status: 'outgoing', requestId: Number(outgoing.id), created: false }
    const incoming = await q.get(
      "SELECT id FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'",
      recipientId, requesterId
    )
    if (incoming) return { status: 'incoming', requestId: Number(incoming.id), created: false }
    throw error
  }
}

function userSelect(direction) {
  const actor = direction === 'incoming' ? 'requester' : 'recipient'
  return `SELECT fr.id AS requestId, fr.created_at AS createdAt,
                 u.id, u.username, u.nickname, u.avatar, u.bio
            FROM friend_requests fr
            JOIN users u ON u.id = fr.${actor}_id
           WHERE fr.${direction === 'incoming' ? 'recipient' : 'requester'}_id = ?
             AND fr.status = 'pending'
           ORDER BY fr.created_at DESC, fr.id DESC`
}

export async function listFriendRequests(userId) {
  const [incoming, outgoing] = await Promise.all([
    q.all(userSelect('incoming'), userId),
    q.all(userSelect('outgoing'), userId),
  ])
  const shape = (row) => ({
    requestId: Number(row.requestId),
    createdAt: Number(row.createdAt),
    user: {
      id: Number(row.id), username: row.username, nickname: row.nickname,
      avatar: row.avatar, bio: row.bio,
    },
  })
  return { incoming: incoming.map(shape), outgoing: outgoing.map(shape) }
}

export async function decideFriendRequest(requestId, recipientId, decision) {
  return tx(async () => {
    const request = await q.get(
      "SELECT id, requester_id AS requesterId, recipient_id AS recipientId FROM friend_requests WHERE id = ? AND status = 'pending'",
      requestId
    )
    if (!request || Number(request.recipientId) !== Number(recipientId)) return null
    const now = Date.now()
    await q.run('UPDATE friend_requests SET status = ?, updated_at = ? WHERE id = ?', decision, now, requestId)
    if (decision === 'accepted') {
      await follow(Number(request.requesterId), Number(request.recipientId))
      await follow(Number(request.recipientId), Number(request.requesterId))
      await q.run(
        'DELETE FROM removed_contacts WHERE (user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)',
        Number(request.requesterId), Number(request.recipientId),
        Number(request.recipientId), Number(request.requesterId)
      )
    }
    return { requestId: Number(request.id), requesterId: Number(request.requesterId), recipientId: Number(request.recipientId), status: decision }
  })
}

export async function cancelFriendRequest(requestId, requesterId) {
  const out = await q.run(
    "UPDATE friend_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND requester_id = ? AND status = 'pending'",
    Date.now(), requestId, requesterId
  )
  return Number(out?.changes || 0) > 0
}
