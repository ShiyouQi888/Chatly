/**
 * 社群专项自检（API + 落库，不启浏览器）
 *
 * 社群取代了原来的「发现页」。这一页只有一件事要做对：**找群 → 加群 → 真的进去了**。
 * 所以断言全部围绕库里的行，而不是接口自己说的 `ok: true`：
 *
 *   1. `/communities` 只返回 `discoverable = 1` 的群，且**不含我已经在里面的**；
 *   2. 加入之后 `conversation_members` 真的多了一行，会话列表里真的出现了这个群；
 *   3. 重复加入是幂等的（`joined: false`），不会插入第二行；
 *   4. 非公开群 403、不存在的群 404 —— 知道 id 也进不去别人的私人群；
 *   5. 未登录 401。
 *
 * ⚠️ 测试用的群**自己造、自己收**：演示库里用户会在预览里随手加群，
 *    写死某个群 id 或假设「公开群列表非空」都会得出方向完全错误的结论。
 *
 * 跑法：node scripts/check-community.mjs
 * 前提：后端已在 3002 运行，且已执行过 seed。
 */
import { db } from '../server/src/db.js'

const API = 'http://127.0.0.1:3002/api/v1'
const PASS = 'chatly123'

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

async function login(username) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASS }),
  })
  const d = await r.json()
  if (!d.token) throw new Error(`${username} 登录失败：${JSON.stringify(d)}`)
  return { token: d.token, user: d.user, auth: { Authorization: `Bearer ${d.token}` } }
}

const j = async (m, p, body, auth) => {
  const r = await fetch(API + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(auth || {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let d
  try {
    d = JSON.parse(text)
  } catch {
    d = text
  }
  return { status: r.status, d }
}

const me = await login('chenmo')
const now = Math.floor(Date.now() / 1000)

/* 造两个群：一个公开、一个不公开。名字带时间戳，跑多少次都不会撞。 */
const stamp = Date.now().toString(36)
const created = []
function makeGroup(title, discoverable) {
  const id = Number(
    db
      .prepare(
        `INSERT INTO conversations (type, title, owner_id, discoverable, created_at, updated_at)
         VALUES ('group', ?, ?, ?, ?, ?)`
      )
      .run(title, me.user.id, discoverable ? 1 : 0, now, now).lastInsertRowid
  )
  db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(
    id,
    me.user.id,
    'owner'
  )
  created.push(id)
  return id
}

/* 公开群：**我自己不加入**，才能验证「列表里会出现、加了就消失」。
   但建群的 owner 必须已经不在成员表里 —— 所以先按 owner 建群再删掉自己的成员行，
   模拟「别人建了一个公开群」。 */
function makeJoinableGroup(title) {
  const id = makeGroup(title, true)
  db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(id, me.user.id)
  return id
}

const publicId = makeJoinableGroup(`自检公开群·${stamp}`)
const privateId = makeGroup(`自检私密群·${stamp}`, false)

const memberRows = (cid, uid) =>
  db.prepare('SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(cid, uid).n

try {
  console.log(`自检开始（我是 ${me.user.nickname}）\n`)

  /* ---------- 未登录 ---------- */
  const anon = await j('GET', '/communities')
  ok(anon.status === 401, '未登录访问 /communities 返回 401', String(anon.status))

  /* ---------- 列表契约 ---------- */
  const list = (await j('GET', '/communities?limit=50', null, me.auth)).d
  const groups = Array.isArray(list.groups) ? list.groups : []
  ok(groups.length > 0, '社群列表非空', `${groups.length} 个群`)
  ok(groups.some((g) => g.id === publicId), '刚建的公开群出现在列表里')
  ok(!groups.some((g) => g.id === privateId), '非公开群**不**出现在列表里')
  ok(!groups.some((g) => g.memberCount === undefined), '每个群都带真实成员数')
  ok(memberRows(publicId, me.user.id) === 0, '加入之前，我确实不在这个群里')

  /* ---------- 加入 ---------- */
  const joined = await j('POST', `/communities/${publicId}/join`, null, me.auth)
  ok(joined.status === 200 && joined.d.joined === true, '加入公开群成功', JSON.stringify(joined.d))
  ok(memberRows(publicId, me.user.id) === 1, '★ conversation_members 真的多了一行')
  const convs = (await j('GET', '/conversations', null, me.auth)).d
  ok(
    (convs.conversations || []).some((c) => Number(c.id) === publicId),
    '★ 加入后会话列表里出现了这个群'
  )

  /* ---------- 重复加入 ---------- */
  const again = await j('POST', `/communities/${publicId}/join`, null, me.auth)
  ok(again.status === 200 && again.d.joined === false, '重复加入是幂等的（joined: false）')
  ok(memberRows(publicId, me.user.id) === 1, '★ 不会插入第二行成员')

  const after = (await j('GET', '/communities?limit=50', null, me.auth)).d
  ok(!(after.groups || []).some((g) => g.id === publicId), '加入之后它从「可加入」列表里消失')

  /* ---------- 越权 ---------- */
  const priv = await j('POST', `/communities/${privateId}/join`, null, me.auth)
  ok(priv.status === 403, '非公开群加入被 403 挡下', String(priv.status))
  ok(memberRows(privateId, me.user.id) === 1, '失败请求没有把我塞进非公开群')

  const ghost = await j('POST', '/communities/999999/join', null, me.auth)
  ok(ghost.status === 404, '不存在的群返回 404', String(ghost.status))

  const bad = await j('POST', '/communities/abc/join', null, me.auth)
  ok(bad.status === 400, '非法 id 返回 400', String(bad.status))
} finally {
  /* 收尾：把自己加的成员行、临时群和它们的成员/消息都删掉，别污染演示库 */
  for (const id of created) {
    db.prepare('DELETE FROM conversation_members WHERE conversation_id = ?').run(id)
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }
  console.log('\n已清理自检临时群')
}

if (failures) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n全部通过 ✅')
