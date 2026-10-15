import { q, insert, tx } from './db.js'
import { publicUser } from './auth.js'

export const STATUS_MOODS = ['✨', '☀️', '☕', '🎧', '💼', '🏖️', '🌙', '😊', '🏃', '📚', '🍜']
export const STATUS_LIFETIME = 24 * 60 * 60 * 1000

function statusError(status, message) {
  return Object.assign(new Error(message), { status })
}

function canSeeStatusSql() {
  return `(s.user_id = ? OR (
    EXISTS (SELECT 1 FROM follows f1 WHERE f1.follower_id = s.user_id AND f1.followee_id = ?)
    AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = ? AND f2.followee_id = s.user_id)
  ))`
}

export async function listStatuses(viewerId) {
  const now = Date.now()
  const rows = await q.all(
    `SELECT s.id, s.user_id AS userId, s.content, s.mood, s.created_at AS createdAt,
            s.expires_at AS expiresAt, u.username, u.nickname, u.avatar,
            mine.viewed_at AS viewedAt
     FROM user_statuses s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN status_views mine ON mine.status_id = s.id AND mine.user_id = ?
     WHERE s.expires_at > ? AND ${canSeeStatusSql()}
     ORDER BY CASE WHEN s.user_id = ? THEN 0 ELSE 1 END, mine.viewed_at IS NOT NULL, s.created_at DESC`,
    viewerId, now, viewerId, viewerId, viewerId, viewerId
  )

  const ownIds = rows.filter((row) => Number(row.userId) === Number(viewerId)).map((row) => row.id)
  let viewersByStatus = new Map()
  if (ownIds.length) {
    const viewers = await q.all(
      `SELECT v.status_id AS statusId, v.viewed_at AS viewedAt,
              u.id, u.username, u.nickname, u.avatar
       FROM status_views v JOIN users u ON u.id = v.user_id
       WHERE v.status_id IN (${ownIds.map(() => '?').join(',')})
       ORDER BY v.viewed_at DESC`,
      ...ownIds
    )
    viewersByStatus = new Map()
    for (const viewer of viewers) {
      const list = viewersByStatus.get(viewer.statusId) || []
      list.push({ user: publicUser(viewer), viewedAt: Number(viewer.viewedAt) })
      viewersByStatus.set(viewer.statusId, list)
    }
  }

  return rows.map((row) => {
    const own = Number(row.userId) === Number(viewerId)
    const viewers = viewersByStatus.get(row.id) || []
    return {
      id: row.id,
      userId: Number(row.userId),
      user: publicUser({ id: row.userId, username: row.username, nickname: row.nickname, avatar: row.avatar }),
      content: row.content,
      mood: row.mood,
      createdAt: Number(row.createdAt),
      expiresAt: Number(row.expiresAt),
      viewed: own || !!row.viewedAt,
      viewCount: own ? viewers.length : undefined,
      viewers: own ? viewers : undefined,
    }
  })
}

export async function createStatus(userId, { content, mood = '✨' } = {}) {
  const text = String(content || '').trim()
  if (!text) throw statusError(400, '请写一句状态')
  if (text.length > 140) throw statusError(400, '状态最多 140 个字符')
  if (!STATUS_MOODS.includes(mood)) throw statusError(400, '状态心情无效')

  const now = Date.now()
  return tx(async () => {
    await q.run('DELETE FROM user_statuses WHERE user_id = ?', userId)
    const id = await insert(
      'INSERT INTO user_statuses (user_id, content, mood, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      userId, text, mood, now, now + STATUS_LIFETIME
    )
    return id
  })
}

export async function recordStatusView(statusId, viewerId) {
  const now = Date.now()
  const row = await q.get(
    `SELECT s.id, s.user_id AS userId FROM user_statuses s
     WHERE s.id = ? AND s.expires_at > ? AND ${canSeeStatusSql()}`,
    statusId, now, viewerId, viewerId, viewerId
  )
  if (!row) throw statusError(404, '状态不存在或已过期')
  if (Number(row.userId) !== Number(viewerId)) {
    await q.run(
      'INSERT INTO status_views (status_id, user_id, viewed_at) VALUES (?, ?, ?) ON CONFLICT(status_id, user_id) DO NOTHING',
      statusId, viewerId, now
    )
  }
  return { ok: true }
}

export async function deleteStatus(statusId, userId) {
  const result = await q.run('DELETE FROM user_statuses WHERE id = ? AND user_id = ?', statusId, userId)
  if (!result.changes) throw statusError(404, '状态不存在或已删除')
}
