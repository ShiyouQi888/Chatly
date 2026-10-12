/**
 * 群投票业务逻辑（PRD §14）
 *
 * 只管数据，不做 HTTP —— 与 chat.js / moment.js / discover.js 同一套分层。
 * DB 层 snake_case，出参 camelCase。
 *
 * ## 四条硬规矩
 *
 * 1. **票数只有一个真相来源。** `poll_votes` 一张表，票数一律 COUNT 出来，
 *    绝不在 poll_options 上存一个 `count` 列 —— 投票 / 改票 / 取消投票三处都要记得
 *    加减一，漏一处就是一个永远对不上、而且界面上看不出来的数字。
 *
 * 2. **只有群聊能投票。** PRD §14 是「群投票」。私聊两个人投票没有意义，
 *    界面上也照实禁用并写明，而不是让它能用却语义可疑。
 *
 * 3. **匿名是真的匿名 —— 在服务端就不返回。** 非匿名时出参带 `voters`（投了哪些人，
 *    只到「人」不到「选了哪项」）；匿名时**整个 `voters` 字段都不出现**（不是空数组）。
 *    前端据此渲染即可，不需要自己判断该不该显示 —— 判断放在前端就等于把数据发出去了。
 *
 * 4. **结束就是结束。** 截止时间到了 / 发起人提前结束，都走同一个 `closedAt` 判定
 *    （`isClosed()`），投票一律拒绝。不存在「界面禁用了但接口还能改」的缝。
 */
import { q, insert, tx } from './db.js'

/** 选项数上下限：低于 2 不叫投票，高于 10 气泡里排不下（微信也是 10） */
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 10
const MAX_QUESTION = 80
const MAX_OPTION_TEXT = 40
/** 截止时间最远 30 天 —— 再远对群聊投票没有意义，也让「剩余时间」文案没法定 */
const MAX_DEADLINE_AHEAD = 30 * 24 * 60 * 60 * 1000
/** 最多回传多少人的头像（前 N 个投过票的人），再多前端也放不下 */
const VOTER_LIMIT = 12

function bad(status, error) {
  return Object.assign(new Error(error), { status })
}

/** 截止时间到了（或发起人手动关了）就算结束。两个条件合成一处判定，别在别处分头写。 */
export function isClosed(poll, now = Date.now()) {
  if (!poll) return true
  if (poll.closedAt) return true
  return Number.isFinite(poll.deadline) && poll.deadline !== null && now >= poll.deadline
}

/* ================= 创建 ================= */

/**
 * 发起投票。校验全部在服务端 —— 前端做的那一份只是提前拦，不是防线。
 *
 * @param {{conversationId:number, creatorId:number, question:string,
 *          options:string[], multi?:boolean, anonymous?:boolean, deadline?:number|null}} input
 * @returns {{ok:true, poll:object} | never} 校验失败抛 status 错误
 */
export function createPoll({
  conversationId,
  creatorId,
  question,
  options,
  multi = false,
  anonymous = false,
  deadline = null,
}) {
  const conv = q.get('SELECT id, type FROM conversations WHERE id = ?', conversationId)
  if (!conv) throw bad(404, '会话不存在')
  if (conv.type !== 'group') throw bad(400, '投票只能在群聊里发起')

  const title = String(question ?? '').trim()
  if (!title) throw bad(400, '投票标题不能为空')
  /* 按**码点**算长度：'😂'.length === 2，按 UTF-16 长度算会把一条 emoji 标题判超长 */
  if ([...title].length > MAX_QUESTION) throw bad(400, `投票标题最多 ${MAX_QUESTION} 个字`)

  const list = (Array.isArray(options) ? options : [])
    .map((o) => String(o ?? '').trim())
    .filter((o) => o.length > 0)
  if (list.length < MIN_OPTIONS) throw bad(400, `至少 ${MIN_OPTIONS} 个选项`)
  if (list.length > MAX_OPTIONS) throw bad(400, `最多 ${MAX_OPTIONS} 个选项`)
  for (const o of list) {
    if ([...o].length > MAX_OPTION_TEXT) throw bad(400, `每个选项最多 ${MAX_OPTION_TEXT} 个字`)
  }
  /* 重复选项必须拒：界面上会出现两个长得一模一样的按钮，
     票数被劈成两半，看的人只会以为「这个投票算错了」。
     大小写 / 空格差异也算重复（trim 过了，再折叠一下内部空白）。 */
  const norm = list.map((o) => o.replace(/\s+/g, ' ').toLowerCase())
  if (new Set(norm).size !== norm.length) throw bad(400, '选项不能重复')

  let dl = null
  if (deadline !== null && deadline !== undefined && deadline !== '') {
    const n = Number(deadline)
    if (!Number.isFinite(n)) throw bad(400, '截止时间不合法')
    if (n <= Date.now()) throw bad(400, '截止时间必须晚于当前时间')
    if (n - Date.now() > MAX_DEADLINE_AHEAD) throw bad(400, '截止时间最远 30 天')
    dl = Math.round(n)
  }

  const pollId = tx(() => {
    const id = insert(
      `INSERT INTO polls (conversation_id, creator_id, question, multi, anonymous, deadline, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      conversationId,
      creatorId,
      title,
      multi ? 1 : 0,
      anonymous ? 1 : 0,
      dl,
      Date.now()
    )
    list.forEach((text, i) => {
      insert('INSERT INTO poll_options (poll_id, text, sort) VALUES (?, ?, ?)', id, text, i)
    })
    return id
  })

  return { ok: true, poll: viewPoll(pollId, creatorId) }
}

/* ================= 查询 ================= */

function rawPoll(pollId) {
  return q.get(
    `SELECT id, conversation_id AS conversationId, creator_id AS creatorId, question,
            multi, anonymous, deadline, closed_at AS closedAt, created_at AS createdAt
     FROM polls WHERE id = ?`,
    pollId
  )
}

const asUser = (row) =>
  row ? { id: row.id, nickname: row.nickname, avatar: row.avatar, username: row.username } : null

/**
 * 一条投票的完整出参。
 *
 * 一次把选项票数、投票人、我的选择、发起人、附言人数都算好 —— 让前端拿到就能画。
 * 拆成多个接口的话，气泡渲染会变成「先画一次、票数回来再跳一下」。
 */
export function viewPoll(pollId, viewerId = null) {
  const p = rawPoll(pollId)
  if (!p) return null

  const options = q.all(
    `SELECT o.id, o.text,
            (SELECT COUNT(*) FROM poll_votes v WHERE v.option_id = o.id) AS votes
     FROM poll_options o WHERE o.poll_id = ? ORDER BY o.sort, o.id`,
    pollId
  )

  const myOptionIds = viewerId
    ? q.all('SELECT option_id AS id FROM poll_votes WHERE poll_id = ? AND user_id = ?', pollId, viewerId).map((r) => r.id)
    : []

  const totalVotes = options.reduce((n, o) => n + o.votes, 0)
  const voterCount = q.get('SELECT COUNT(DISTINCT user_id) AS n FROM poll_votes WHERE poll_id = ?', pollId).n
  /* 附言表就是「投过票的人」（未投票不会写行）—— 省掉一次「投过票的人」查询 */
  const joinedCount = q.get('SELECT COUNT(*) AS n FROM poll_replies WHERE poll_id = ?', pollId).n

  const closed = isClosed(p)
  const creator = asUser(q.get('SELECT id, username, nickname, avatar FROM users WHERE id = ?', p.creatorId))

  const out = {
    id: p.id,
    conversationId: p.conversationId,
    question: p.question,
    multi: !!p.multi,
    anonymous: !!p.anonymous,
    deadline: p.deadline,
    closedAt: p.closedAt,
    /** 结束 = 手动结束 或 过了截止时间。前端只认这一个布尔，不自己再算一次。 */
    closed,
    createdAt: p.createdAt,
    creator,
    options: options.map((o) => ({
      id: o.id,
      text: o.text,
      votes: o.votes,
      /* 百分比在**服务端**算好：前端各算一份的话，四舍五入方式不同会出现
         「各项加起来 99%」这种看着像 bug 的东西。 */
      percent: totalVotes ? Math.round((o.votes / totalVotes) * 100) : 0,
      mine: myOptionIds.includes(o.id),
    })),
    myOptionIds,
    /** 有多少人投过票（多选时和「总票数」不是一回事，两个都给） */
    voterCount,
    totalVotes,
    joinedCount,
  }

  /* 匿名：**整个字段都不出现**。空数组也别说 —— 前端就没得渲染，
     也不存在「某次改动不小心把名字画出来」的可能。 */
  if (!p.anonymous) {
    /* 出参形状和 `message.sender` / 群成员里的 user 一致（id / username / nickname / avatar），
       前端可以直接复用 avatarOf()。这里刻意不走 publicUser()：
       那会顺带带出 bio / gender / birthday / region / tags 一大堆这个场景用不上的字段，
       而「有哪些人投过票」只需要一张脸和一个名字。附言时间目前界面没用，不返回。 */
    out.voters = q.all(
      `SELECT u.id, u.username, u.nickname, u.avatar
       FROM poll_replies r JOIN users u ON u.id = r.user_id
       WHERE r.poll_id = ?
       GROUP BY u.id ORDER BY MIN(r.created_at) LIMIT ?`,
      pollId,
      VOTER_LIMIT
    )
  }

  return out
}

/**
 * 批量取投票（聊天记录里每条 kind='poll' 的消息都要画气泡）。
 *
 * 为什么不把投票塞进消息出参：一条投票有选项、票数、投票人、我的选择，
 * 塞进 `listMessages` 就是「拉 50 条历史 = 50 份投票详情」，
 * 而其中绝大多数根本不需要票数明细。所以消息只带 `pollId`，
 * 前端拿 id 集合来这里批量换一次。**这条路径只按 pollId 查，不按会话过滤** ——
 * 调用方（路由）必须已经确认过这些 id 属于同一个他有权访问的会话。
 */
export function viewPollsByIds(ids, viewerId = null) {
  const seen = new Set()
  const out = []
  for (const raw of ids) {
    const id = Number(raw)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const p = viewPoll(id, viewerId)
    if (p) out.push(p)
  }
  return out
}

/**
 * pollId → conversationId 的映射，给路由做批量授权用。
 * 单独抽出来是为了**不为了鉴权去算整份投票详情**（选项 / 票数 / 投票人全是白算的）。
 */
export function pollConversations(ids) {
  const map = new Map()
  for (const raw of ids) {
    const id = Number(raw)
    if (!id || map.has(id)) continue
    const row = q.get('SELECT conversation_id AS conversationId FROM polls WHERE id = ?', id)
    if (row) map.set(id, row.conversationId)
  }
  return map
}

/** 会话里的投票列表（群设置 → 群投票，也用来给「跳到那条消息」定位） */
export function listPolls(conversationId, viewerId = null) {
  const rows = q.all(
    `SELECT p.id, m.id AS messageId
     FROM polls p
     JOIN messages m ON m.poll_id = p.id AND m.revoked_at IS NULL
     WHERE p.conversation_id = ?
     ORDER BY p.id DESC`,
    conversationId
  )
  return rows.map((r) => {
    const poll = viewPoll(r.id, viewerId)
    return poll ? { ...poll, messageId: r.messageId } : null
  }).filter(Boolean)
}

/* ================= 投票 ================= */

/**
 * 投票 / 改票 / 取消投票。三件事共用一个入口是有意的 —— `optionIds` 就是**投票后的完整状态**：
 *   - 单选传 1 个 → 换选项
 *   - 多选传 N 个 → 整体覆盖
 *   - 传空数组 → 取消投票（改错了得能退出来；不给这条路，用户就只能一直错着）
 *
 * 幂等：同一份 `optionIds` 重复提交结果相同，不会重复计票。
 *
 * @returns {{ok:true, poll:object, changed:boolean}}
 */
export function votePoll(pollId, userId, optionIds) {
  const p = rawPoll(pollId)
  if (!p) throw bad(404, '投票不存在')
  if (isClosed(p)) throw bad(400, '投票已结束')

  const wanted = Array.from(new Set((Array.isArray(optionIds) ? optionIds : []).map(Number).filter(Boolean)))
  const valid = q
    .all('SELECT id FROM poll_options WHERE poll_id = ?', pollId)
    .map((r) => r.id)
  const validSet = new Set(valid)

  for (const id of wanted) {
    if (!validSet.has(id)) throw bad(400, '选项不属于这条投票')
  }
  if (!p.multi && wanted.length > 1) throw bad(400, '这是单选投票，只能选一个')

  const prev = q
    .all('SELECT option_id AS id FROM poll_votes WHERE poll_id = ? AND user_id = ?', pollId, userId)
    .map((r) => r.id)
  const same = prev.length === wanted.length && prev.every((id) => wanted.includes(id))
  if (same) return { ok: true, poll: viewPoll(pollId, userId), changed: false }

  const now = Date.now()
  tx(() => {
    q.run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', pollId, userId)
    for (const optionId of wanted) {
      insert(
        'INSERT INTO poll_votes (poll_id, user_id, option_id, created_at) VALUES (?, ?, ?, ?)',
        pollId,
        userId,
        optionId,
        now
      )
    }
    /* poll_replies 在这里只当「投过票的人」的花名册用（见文件头）。
       取消投票（wanted 为空）就要把名册上这一行一起去掉 ——
       留着的话，界面上会出现「0 人投票，但头像簇里有我」。
       附言内容目前没有入口写入，所以直接删掉不会丢用户写过的字。 */
    if (wanted.length) {
      /* ⚠️ 这里必须是 `INSERT OR IGNORE`，**不能**写 `ON CONFLICT(poll_id,user_id) DO NOTHING`：
         `uniq_poll_reply_user` 是个**部分索引**（带 WHERE user_id IS NOT NULL），
         而 SQLite 的 UPSERT 冲突目标只认完整的主键 / 唯一索引，
         拿部分索引当目标会直接报 "ON CONFLICT clause does not match any PRIMARY KEY or
         UNIQUE constraint"。`INSERT OR IGNORE` 不问目标，任何唯一冲突都跳过，
         语义正好就是这里要的「已经在名册上就别动」。 */
      q.run(
        `INSERT OR IGNORE INTO poll_replies (poll_id, user_id, content, created_at)
         VALUES (?, ?, '', ?)`,
        pollId,
        userId,
        now
      )
    } else {
      q.run('DELETE FROM poll_replies WHERE poll_id = ? AND user_id = ?', pollId, userId)
    }
  })

  return { ok: true, poll: viewPoll(pollId, userId), changed: true }
}

/**
 * 发起人提前结束投票。PRD 没写，但这是「截止时间定错了」的唯一补救手段 ——
 * 没有它，一条把截止时间设成 30 天后的投票就只能挂在那里。
 */
export function closePoll(pollId, userId) {
  const p = rawPoll(pollId)
  if (!p) throw bad(404, '投票不存在')
  if (p.creatorId !== userId) throw bad(403, '只有发起人可以结束投票')
  if (p.closedAt) throw bad(400, '投票已经结束了')
  /* 到期但没手动关的，也只当「已结束」——不要把 closed_at 补上，
     那个字段的语义是「谁什么时候手动关的」，补上就分不清两种结束了。 */
  if (isClosed(p)) throw bad(400, '投票已结束')

  q.run('UPDATE polls SET closed_at = ? WHERE id = ?', Date.now(), pollId)
  return { ok: true, poll: viewPoll(pollId, userId) }
}
