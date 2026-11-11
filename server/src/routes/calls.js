import { Router } from 'express'
import { createHmac } from 'node:crypto'
import { authRequired } from '../auth.js'
import { q } from '../db.js'

const router = Router()
router.use(authRequired)

/**
 * 通话记录。
 *
 * 只回元数据：谁呼谁、语音还是视频、通了多久、结果是什么。
 * **不回任何媒体地址** —— 这一版没有录音录像，将来也不该由一个列表接口顺手带出来。
 *
 * 分页用 `before`（上一页最后一条的 createdAt），不用偏移量：
 * 边翻页边有新通话进来时，offset 会让人重复看到同一条。
 */
router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 30, 1), 100)
  const before = Math.floor(Number(req.query.before)) || 0
  const uid = Number(req.user.id)

  const base = `SELECT vc.call_id AS callId, vc.conversation_id AS conversationId,
                       vc.caller_id AS callerId, vc.callee_id AS calleeId,
                       vc.state, vc.media, vc.created_at AS createdAt, vc.started_at AS startedAt,
                       vc.ended_at AS endedAt, vc.duration_sec AS durationSec, vc.end_reason AS endReason,
                       cu.id AS callerUid, cu.nickname AS callerNickname, cu.username AS callerUsername, cu.avatar AS callerAvatar,
                       pu.id AS calleeUid, pu.nickname AS calleeNickname, pu.username AS calleeUsername, pu.avatar AS calleeAvatar
                  FROM voice_calls vc
                  JOIN users cu ON cu.id = vc.caller_id
                  JOIN users pu ON pu.id = vc.callee_id
                 WHERE (vc.caller_id = ? OR vc.callee_id = ?)`
  const rows = before
    ? await q.all(`${base} AND vc.created_at < ? ORDER BY vc.created_at DESC LIMIT ?`, uid, uid, before, limit)
    : await q.all(`${base} ORDER BY vc.created_at DESC LIMIT ?`, uid, uid, limit)

  res.json({
    calls: rows.map((r) => {
      const outgoing = Number(r.callerId) === uid
      return {
        callId: r.callId,
        conversationId: Number(r.conversationId),
        direction: outgoing ? 'outgoing' : 'incoming',
        media: r.media === 'video' ? 'video' : 'audio',
        state: r.state,
        /* 只有真正接通过才有值；未接通是 null，不是 0 —— 前端据此区分
           「0 秒通话」和「根本没通」。 */
        durationSec: r.durationSec == null ? null : Number(r.durationSec),
        endReason: r.endReason || null,
        createdAt: Number(r.createdAt),
        endedAt: r.endedAt == null ? null : Number(r.endedAt),
        peer: {
          id: Number(outgoing ? r.calleeUid : r.callerUid),
          nickname: outgoing ? r.calleeNickname : r.callerNickname,
          username: outgoing ? r.calleeUsername : r.callerUsername,
          avatar: outgoing ? r.calleeAvatar : r.callerAvatar,
        },
      }
    }),
    hasMore: rows.length === limit,
    nextBefore: rows.length ? Number(rows[rows.length - 1].createdAt) : null,
  })
})

/*
 * STUN is enough for many local/development networks. Production should set
 * TURN_URLS plus short-lived TURN credentials in the server environment;
 * these values are returned only to an authenticated user and never logged.
 */
router.get('/ice-config', (req, res) => {
  const split = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
  const stunUrls = split(process.env.WEBRTC_STUN_URLS || 'stun:stun.l.google.com:19302')
  const turnUrls = split(process.env.WEBRTC_TURN_URLS)
  const iceServers = stunUrls.map((urls) => ({ urls }))
  const sharedSecret = process.env.WEBRTC_TURN_SHARED_SECRET
  const expires = Math.floor(Date.now() / 1000) + 60 * 60
  const username = sharedSecret
    ? `${expires}:${Number(req.user.id)}`
    : process.env.WEBRTC_TURN_USERNAME
  const credential = sharedSecret
    ? createHmac('sha1', sharedSecret).update(username).digest('base64')
    : process.env.WEBRTC_TURN_PASSWORD
  if (turnUrls.length && username && credential) {
    iceServers.push({
      urls: turnUrls,
      username,
      credential,
    })
  }
  res.set('Cache-Control', 'private, no-store')
  res.json({ iceServers })
})

export default router
