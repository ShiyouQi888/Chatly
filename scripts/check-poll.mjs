/**
 * 群投票专项自检（PRD §14）
 *
 * 这个功能天然容易做成「看起来能用」的样子 —— 一排选项、一个进度条、
 * 点一下数字加一。所以这里的判据一条都不许停在「元素在不在」：
 *
 *   A. **老库迁移**：一个「投票之前」的库（kind 的 CHECK 里没有 'poll'、
 *      没有 poll_id 列、四张投票表一张都没有）必须**直接启动**就长出投票能力，
 *      且老消息一条不少。开发机上这个路径**永远不会被执行**（库早就是新版了），
 *      所以只能现造一个老库来跑 —— 不然就是「补丁从不触发」那类假绿。
 *
 *   B. **票数必须回库核对**。界面上写着 2 票不算数，`poll_votes` 里有那两行才算。
 *      单选换选项 / 多选改票 / 取消投票，三处都要看到**旧票真的没了** ——
 *      只在界面上加数字的话，取消投票会留下一条永远减不掉的票。
 *
 *   C. **匿名是在服务端就不返回**（不是前端藏着不画）。所以判据是
 *      「接口出参里没有 voters 这个 key」，而不是「界面上看不到名字」——
 *      后者用「前端忘了隐藏」也能过。
 *
 *   D. **结束 / 过期之后接口也必须拒**。界面上把按钮涂灰不算拦截，
 *      所以这里绕过界面直接打接口，期望 400。
 *
 *   E. **实时**：另一个浏览器实例投一票，本实例的票数要自己变（WS poll.updated）。
 *      只断言「我点了数字会变」的话，一个纯本地计数器的假实现也能过。
 *
 *   F. **群设置那条列表要是真的**：它原来写着「未接入」，现在点一条要能
 *      跳到聊天里那条消息（消息没加载出来时得先翻页，翻不到要如实说）。
 *
 * ⚠️ 前提自己造、收尾还原：临时群标题带「自检·」（purgeDebris 连消息一起收），
 *    探针投票按**基线 id** 清（记 id 列表一定会漏 —— 有一条「本以为会被 400 拒掉、
 *    其实建成功了」的用例就会留下一条没人引用的死投票，本轮开发就踩过这个）。
 *
 * 跑法：node scripts/check-poll.mjs     （需要 5198 与 3002 都在跑）
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { db, insert, q } from '../server/src/db.js'
import { purgeDebris, purgeMoments } from './lib/debris.mjs'
import { freePort, waitAppTarget, connectCdp, launchChrome, shoot } from './lib/cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const API = 'http://127.0.0.1:3002/api/v1'
const APP_HOST = 'http://127.0.0.1:5198'
const APP = APP_HOST + '/'
const OUT = path.join(ROOT, 'shots', 'poll')
const PASS = 'chatly123'
const TMP_TITLE = '自检·投票群'

fs.mkdirSync(OUT, { recursive: true })

let pass = 0
let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`)
  cond ? pass++ : failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ================= 接口小工具 ================= */
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
  const t = await r.text()
  let d
  try {
    d = JSON.parse(t)
  } catch {
    d = t
  }
  return { status: r.status, data: d }
}

/* ================= 基线（收尾靠它） ================= */
purgeDebris({ quiet: true })
const maxPollBefore = q.get('SELECT COALESCE(MAX(id),0) v FROM polls').v
const maxMsgBefore = q.get('SELECT COALESCE(MAX(id),0) v FROM messages').v
const pollsBefore = q.get('SELECT COUNT(*) n FROM polls').n
const messagesBefore = q.get('SELECT COUNT(*) n FROM messages').n

const me = await login('chenmo')
const peer = await login('linxiaoxia')
const third = await login('ajie')
const outsider = await login('shenxu')

/* ---- 临时群：陈墨（群主）+ 林小夏 + 阿杰 ---- */
const nowSec = Math.floor(Date.now() / 1000)
const CID = insert(
  'INSERT INTO conversations (type, title, owner_id, created_at, updated_at) VALUES (?,?,?,?,?)',
  'group',
  TMP_TITLE,
  me.user.id,
  nowSec,
  nowSec
)
for (const [uid, role] of [
  [me.user.id, 'owner'],
  [peer.user.id, 'member'],
  [third.user.id, 'member'],
]) {
  q.run('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?,?,?)', CID, uid, role)
}
/* 一条普通消息，好让「投票消息被插在聊天记录里」这件事有参照物 */
const chatMsg = await j('POST', '/messages', { conversationId: CID, kind: 'text', text: '自检·投票前的普通消息' }, me.auth)

console.log(`\n临时群 #${CID}「${TMP_TITLE}」，基线 message#${maxMsgBefore} / poll#${maxPollBefore}`)

/* ============================================================
   A. 老库迁移（现造一个「投票之前」的库）
   ============================================================ */
console.log('\n─── A. 老库迁移 ───')

const MIG_TMP = path.join(ROOT, '.tmp', 'poll-selftest-mig')
fs.rmSync(MIG_TMP, { recursive: true, force: true })
fs.mkdirSync(MIG_TMP, { recursive: true })

const OLD_DDL = `
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, nickname TEXT NOT NULL, avatar TEXT, bio TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('private','group')), title TEXT, avatar TEXT,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TABLE conversation_members (conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  last_read_message_id INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (conversation_id, user_id));
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','file','video','location')),
  content TEXT, file_url TEXT, file_name TEXT, file_size INTEGER,
  reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), revoked_at INTEGER);
CREATE INDEX idx_messages_conv_id ON messages(conversation_id, id);
`

const mkOldDb = (file) => {
  fs.rmSync(file, { force: true })
  const script = path.join(MIG_TMP, 'mk.mjs')
  fs.writeFileSync(
    script,
    `
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(${JSON.stringify(file)})
db.exec(${JSON.stringify(OLD_DDL)})
db.exec("INSERT INTO users (username,password_hash,nickname) VALUES ('a','x','甲'),('b','x','乙')")
db.exec("INSERT INTO conversations (type,title,owner_id) VALUES ('group','老群',1)")
db.exec("INSERT INTO conversation_members (conversation_id,user_id,role) VALUES (1,1,'owner'),(1,2,'member')")
db.exec("INSERT INTO messages (conversation_id,sender_id,kind,content) VALUES (1,1,'text','迁移前 A'),(1,2,'text','迁移前 B')")
db.close()
`
  )
  execFileSync(process.execPath, [script], { encoding: 'utf8' })
}

/** 在独立进程里用**真正的 db.js** 打开这个库（迁移发生在 import 时） */
const migrateAndInspect = (dbFile) => {
  const probe = path.join(MIG_TMP, 'probe.mjs')
  fs.writeFileSync(
    probe,
    `
import { db } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'server/src/db.js')).href)}
const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='messages'").get().sql
console.log(JSON.stringify({
  kindHasPoll: sql.includes("'poll'"),
  cols: db.prepare('PRAGMA table_info(messages)').all().map(c => c.name),
  tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name),
  messages: db.prepare('SELECT COUNT(*) n FROM messages').get().n,
  texts: db.prepare('SELECT content FROM messages ORDER BY id').all().map(r => r.content),
  fkOk: db.prepare('PRAGMA foreign_key_check').all().length === 0,
}))
`
  )
  const out = execFileSync(process.execPath, [probe], {
    encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbFile },
  })
  return JSON.parse(out.trim().split('\n').pop())
}

const oldDb = path.join(MIG_TMP, 'old.db')
mkOldDb(oldDb)
const mig = migrateAndInspect(oldDb)
ok(mig.kindHasPoll, '老库启动后 messages.kind 的 CHECK 含 poll')
ok(mig.cols.includes('poll_id'), '老库启动后补上了 poll_id 列', mig.cols.join(','))
ok(
  ['polls', 'poll_options', 'poll_votes', 'poll_replies'].every((t) => mig.tables.includes(t)),
  '四张投票表都建出来了'
)
ok(mig.messages === 2 && mig.texts.join('|') === '迁移前 A|迁移前 B', '老消息一条没少、内容原样', `${mig.messages} 条`)
ok(mig.fkOk, '迁移后外键无断裂')

const mig2 = migrateAndInspect(oldDb)
ok(mig2.messages === mig.messages && mig2.texts.join('|') === mig.texts.join('|'), '再启动一次幂等：不重复迁移、不丢数据')

/* ============================================================
   B. 接口：创建 / 校验
   ============================================================ */
console.log('\n─── B. 发起投票与校验 ───')

const created = await j(
  'POST',
  '/polls',
  { conversationId: CID, question: '自检·周六去哪？', options: ['海边', '看电影', '爬山'], multi: false, anonymous: false },
  me.auth
)
ok(created.status === 201, '创建投票返回 201', `status=${created.status} ${created.data?.error || ''}`)
const P1 = created.data?.poll
ok(!!P1 && P1.options.length === 3, '返回 3 个选项')
ok(created.data?.message?.kind === 'poll' && created.data.message.pollId === P1?.id, '同时建出一条 kind=poll 的消息')
const P1MSG = created.data?.message?.id
ok(
  !!q.get('SELECT 1 FROM messages WHERE id = ? AND poll_id = ?', P1MSG, P1.id),
  '消息与投票在库里真的挂上了（poll_id 非空）'
)
ok(String(created.data?.message?.text || '').includes('自检·周六去哪'), '消息 text 是题目（会话列表预览用）')

/* 会话预览 */
const convList = (await j('GET', '/conversations', null, me.auth)).data.conversations
const tmpConv = convList.find((c) => c.id === CID)
ok(
  String(tmpConv?.lastMessage?.text || '').startsWith('[投票]'),
  '会话列表预览是 [投票] 题目',
  tmpConv?.lastMessage?.text
)

/* 校验用例：期望被拒的那些**不能真的建出投票** */
const badCases = [
  ['标题为空', { conversationId: CID, question: '   ', options: ['a', 'b'] }],
  ['只有 1 个选项', { conversationId: CID, question: 'q', options: ['a'] }],
  ['11 个选项', { conversationId: CID, question: 'q', options: Array.from({ length: 11 }, (_, i) => `o${i}`) }],
  ['选项完全重复', { conversationId: CID, question: 'q', options: ['甲', '甲'] }],
  ['选项只差大小写/空格', { conversationId: CID, question: 'q', options: ['a b', 'A  B'] }],
  ['选项全是空白', { conversationId: CID, question: 'q', options: ['  ', ''] }],
  ['标题超 80 字', { conversationId: CID, question: '字'.repeat(81), options: ['a', 'b'] }],
  ['选项超 40 字', { conversationId: CID, question: 'q', options: ['字'.repeat(41), 'b'] }],
  ['过去的截止时间', { conversationId: CID, question: 'q', options: ['a', 'b'], deadline: Date.now() - 1000 }],
  ['截止时间超过 30 天', { conversationId: CID, question: 'q', options: ['a', 'b'], deadline: Date.now() + 40 * 86400000 }],
]
let badRejected = 0
for (const [label, body] of badCases) {
  const r = await j('POST', '/polls', body, me.auth)
  const madePoll = r.status === 201
  ok(r.status === 400 && !madePoll, `${label} → 400 且没有建出投票`, `status=${r.status}`)
  if (r.status === 400) badRejected++
}
ok(badRejected === badCases.length, `校验用例全部被拒（${badRejected}/${badCases.length}）`)

/* 80 个 emoji 的标题按**码点**算（'😂'.length === 2，按 UTF-16 算会误判超长） */
const emojiPoll = await j(
  'POST',
  '/polls',
  { conversationId: CID, question: '😂'.repeat(80), options: ['甲', '乙'] },
  me.auth
)
ok(emojiPoll.status === 201, '80 个 emoji 的标题（按码点算）允许创建', `status=${emojiPoll.status}`)

/* 私聊不能发起 */
const priv = convList.find((c) => c.type === 'private')
const inPrivate = await j('POST', '/polls', { conversationId: priv.id, question: 'q', options: ['a', 'b'] }, me.auth)
ok(inPrivate.status === 400, '私聊里发起投票 → 400', `status=${inPrivate.status} ${inPrivate.data?.error || ''}`)

/* 群外人不能发起 / 不能投票 / 不能看列表 */
const outCreate = await j('POST', '/polls', { conversationId: CID, question: 'q', options: ['a', 'b'] }, outsider.auth)
ok(outCreate.status === 403, '群外人发起投票 → 403', `status=${outCreate.status}`)
const outVote = await j('POST', `/polls/${P1.id}/vote`, { optionIds: [P1.options[0].id] }, outsider.auth)
ok(outVote.status === 403, '群外人投票 → 403', `status=${outVote.status}`)
const outList = await j('GET', `/polls/of/${CID}`, null, outsider.auth)
ok(outList.status === 403, '群外人看该群投票列表 → 403', `status=${outList.status}`)
const outBatch = await j('GET', `/polls?ids=${P1.id}`, null, outsider.auth)
ok(outBatch.status === 404, '群外人按 id 猜投票 → 404（不泄漏存在性）', `status=${outBatch.status}`)

/* ============================================================
   C. 投票 / 改票 / 取消：每一步都回库核对
   ============================================================ */
console.log('\n─── C. 投票 / 改票 / 取消（回库核对） ───')

const voteRows = (pollId) =>
  q.all(
    `SELECT v.user_id AS userId, v.option_id AS optionId FROM poll_votes v
     WHERE v.poll_id = ? ORDER BY v.user_id, v.option_id`,
    pollId
  )
const oA = P1.options[0].id
const oB = P1.options[1].id

const v1 = await j('POST', `/polls/${P1.id}/vote`, { optionIds: [oA] }, peer.auth)
ok(v1.status === 200, '林小夏投「海边」')
ok(
  voteRows(P1.id).length === 1 && voteRows(P1.id)[0].optionId === oA && voteRows(P1.id)[0].userId === peer.user.id,
  '库里 poll_votes 真的多了一行（且是那个选项）',
  JSON.stringify(voteRows(P1.id))
)
const P1afterV1 = (await j('GET', `/polls?ids=${P1.id}`, null, me.auth)).data.polls[0]
ok(P1afterV1.options[0].votes === 1 && P1afterV1.options[0].percent === 100, '票数与百分比由服务端给出')
ok(Array.isArray(P1afterV1.voters) && P1afterV1.voters.length === 1, '非匿名：出参带 voters')
ok(!('voters' in (await j('GET', `/polls?ids=${P1.id}`, null, peer.auth)).data.polls[0]) === false, '（voters 对普通成员同样可见）')

/* 改票：单选换选项 —— 旧票必须真的没了 */
const v2 = await j('POST', `/polls/${P1.id}/vote`, { optionIds: [oB] }, peer.auth)
const rows2 = voteRows(P1.id)
ok(
  rows2.length === 1 && rows2[0].optionId === oB,
  '改票后库里**只剩一行**且是新选项（旧票真的删了，不是加了一行）',
  JSON.stringify(rows2)
)
const P1afterV2 = (await j('GET', `/polls?ids=${P1.id}`, null, me.auth)).data.polls[0]
ok(P1afterV2.voterCount === 1 && P1afterV2.totalVotes === 1, '改票不算新增投票人')

/* 重复提交同一份选择：幂等，changed=false */
const v3 = await j('POST', `/polls/${P1.id}/vote`, { optionIds: [oB] }, peer.auth)
ok(v3.data?.changed === false && voteRows(P1.id).length === 1, '重复提交同一份选择：changed=false 且票数不变')

/* 单选一次传两个 → 400 */
const twoForSingle = await j('POST', `/polls/${P1.id}/vote`, { optionIds: [oA, oB] }, third.auth)
ok(twoForSingle.status === 400, '单选投票传两个选项 → 400', `status=${twoForSingle.status}`)

/* 取消投票：票与名册都要清掉 */
const unvote = await j('POST', `/polls/${P1.id}/vote`, { optionIds: [] }, peer.auth)
ok(voteRows(P1.id).length === 0, '取消投票后库里那一行也没了')
ok(
  q.get('SELECT COUNT(*) n FROM poll_replies WHERE poll_id = ?', P1.id).n === 0,
  '取消投票同时清掉「投过票的人」名册（否则会出现 0 票却有头像）'
)

/* 选项不属于该投票 → 400 */
const foreignOpt = await j('POST', `/polls/${P1.id}/vote`, { optionIds: [999999] }, peer.auth)
ok(foreignOpt.status === 400, '传别条投票的选项 id → 400', `status=${foreignOpt.status}`)

/* ============================================================
   D. 多选
   ============================================================ */
console.log('\n─── D. 多选 ───')
const multi = await j(
  'POST',
  '/polls',
  { conversationId: CID, question: '自检·多选：想玩什么', options: ['桌游', 'KTV', '剧本杀'], multi: true, anonymous: false },
  me.auth
)
const P2 = multi.data.poll
const m1 = P2.options[0].id
const m2 = P2.options[1].id
const mv1 = await j('POST', `/polls/${P2.id}/vote`, { optionIds: [m1, m2] }, peer.auth)
ok(voteRows(P2.id).length === 2, '多选一次投两项 → 库里两行')
ok(mv1.data.poll.totalVotes === 2 && mv1.data.poll.voterCount === 1, '多选：总票数 2、投票人数 1（两个数不是一回事）')
await j('POST', `/polls/${P2.id}/vote`, { optionIds: [m1] }, peer.auth)
ok(voteRows(P2.id).length === 1 && voteRows(P2.id)[0].optionId === m1, '多选改成一项 → 整体覆盖（不是累加）')

/* ============================================================
   E. 匿名
   ============================================================ */
console.log('\n─── E. 匿名 ───')
const anon = await j(
  'POST',
  '/polls',
  { conversationId: CID, question: '自检·匿名：谁去', options: ['去', '不去'], anonymous: true },
  me.auth
)
const P3 = anon.data.poll
await j('POST', `/polls/${P3.id}/vote`, { optionIds: [P3.options[0].id] }, peer.auth)
const anonView = (await j('GET', `/polls?ids=${P3.id}`, null, me.auth)).data.polls[0]
ok(!('voters' in anonView), '匿名投票：出参里**根本没有 voters 这个 key**', Object.keys(anonView).join(','))
ok(anonView.totalVotes === 1 && anonView.voterCount === 1, '匿名仍然给出票数与人数')
const anonVoter = (await j('GET', `/polls?ids=${P3.id}`, null, peer.auth)).data.polls[0]
ok(!('voters' in anonVoter) && anonVoter.myOptionIds.length === 1, '投票人自己能看到「我投了哪个」，但仍看不到别人')

/* ============================================================
   F. 截止时间 / 提前结束（绕过界面直接打接口）
   ============================================================ */
console.log('\n─── F. 截止时间与提前结束 ───')
const closing = await j(
  'POST',
  '/polls',
  { conversationId: CID, question: '自检·提前结束', options: ['甲', '乙'], deadline: Date.now() + 3600_000 },
  me.auth
)
const P4 = closing.data.poll
const notCreator = await j('POST', `/polls/${P4.id}/close`, null, peer.auth)
ok(notCreator.status === 403, '非发起人结束投票 → 403', `status=${notCreator.status}`)
const closed = await j('POST', `/polls/${P4.id}/close`, null, me.auth)
ok(closed.data?.poll?.closed === true, '发起人结束 → closed=true')
const closedAgain = await j('POST', `/polls/${P4.id}/close`, null, me.auth)
ok(closedAgain.status === 400, '重复结束 → 400', `status=${closedAgain.status}`)
const voteAfterClose = await j('POST', `/polls/${P4.id}/vote`, { optionIds: [P4.options[0].id] }, peer.auth)
ok(voteAfterClose.status === 400, '结束后投票（绕过界面）→ 400', `status=${voteAfterClose.status}`)

/* 过截止时间：自动 closed，且拒投 */
const expiring = await j(
  'POST',
  '/polls',
  { conversationId: CID, question: '自检·即将过期', options: ['甲', '乙'], deadline: Date.now() + 60_000 },
  me.auth
)
const P5 = expiring.data.poll
q.run('UPDATE polls SET deadline = ? WHERE id = ?', Date.now() - 5000, P5.id)
const expiredView = (await j('GET', `/polls?ids=${P5.id}`, null, me.auth)).data.polls[0]
ok(expiredView.closed === true, '过了截止时间：closed 自动为 true')
ok(expiredView.closedAt === null || expiredView.closedAt === undefined, '过期不等于「手动结束」：closedAt 仍是空')
const expiredVote = await j('POST', `/polls/${P5.id}/vote`, { optionIds: [P5.options[0].id] }, peer.auth)
ok(expiredVote.status === 400, '过期后投票 → 400', `status=${expiredVote.status}`)

/* ============================================================
   G. 撤回投票消息
   ============================================================ */
console.log('\n─── G. 撤回 ───')
const toRevoke = await j(
  'POST',
  '/polls',
  { conversationId: CID, question: '自检·待撤回', options: ['甲', '乙'] },
  me.auth
)
const revokeMsgId = toRevoke.data.message.id
const revokePollId = toRevoke.data.poll.id
const rev = await j('DELETE', `/messages/${revokeMsgId}`, null, me.auth)
ok(rev.status === 200, '撤回投票消息成功')
ok(!!q.get('SELECT 1 FROM messages WHERE id = ? AND revoked_at IS NOT NULL', revokeMsgId), '消息被标记撤回')
ok(
  q.get('SELECT COUNT(*) n FROM polls WHERE id = ?', revokePollId).n === 1,
  '撤回**不删**投票行（撤回的语义是「这条消息不作数」，不是抹掉历史）'
)
const listAfterRevoke = (await j('GET', `/polls/of/${CID}`, null, me.auth)).data.polls
ok(
  !listAfterRevoke.some((p) => p.id === revokePollId),
  '但已撤回的投票不出现在群设置的投票列表里'
)

/* ============================================================
   H. 列表与批量查询
   ============================================================ */
console.log('\n─── H. 列表 / 批量查询 ───')
const list = (await j('GET', `/polls/of/${CID}`, null, me.auth)).data.polls
ok(list.length >= 5, '会话投票列表包含本轮创建的几条', `${list.length} 条`)
ok(list.every((p) => Number.isInteger(p.messageId)), '每一条都带 messageId（用于跳转）')
ok(list.every((p) => p.conversationId === CID), '列表只含本群的投票')
ok(list[0].id > list[list.length - 1].id, '列表按新到旧排序')
const batch = (await j('GET', `/polls?ids=${P1.id},${P2.id},${P3.id}`, null, me.auth)).data.polls
ok(batch.length === 3, '批量查询返回 3 条')
const batchEmpty = await j('GET', '/polls?ids=', null, me.auth)
ok(Array.isArray(batchEmpty.data.polls) && batchEmpty.data.polls.length === 0, 'ids 为空 → 空数组（不报错）')
const ghost = await j('GET', '/polls?ids=99999999', null, me.auth)
ok(ghost.status === 404, '不存在的 id → 404', `status=${ghost.status}`)

/* ============================================================
   I. 浏览器：界面与实时
   ============================================================ */
console.log('\n─── I. 浏览器（界面 + 实时） ───')

const port = await freePort()
const profileDir = path.join(ROOT, '.tmp', 'chrome-poll')
fs.mkdirSync(profileDir, { recursive: true })
const proc = launchChrome({ url: APP, port, profileDir })

const issues = []
const target = await waitAppTarget(port, APP_HOST)
const cdp = await connectCdp(target.webSocketDebuggerUrl, (e) => {
  if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) {
    const text = (e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    issues.push(`${e.params.type}: ${text}`.slice(0, 200))
  }
  if (e.method === 'Runtime.exceptionThrown') {
    issues.push('exception: ' + (e.params.exceptionDetails?.exception?.description || '').slice(0, 300))
  }
  if (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)) {
    issues.push(`${e.params.entry.level}: ${e.params.entry.text}`.slice(0, 200))
  }
})
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

const js = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error')
  return r.result.value
}
const waitFor = async (expr, ms = 12000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await js(expr)) return true
    } catch {
      /* 换 context 时会抛 */
    }
    await sleep(250)
  }
  return false
}

const HELP = `
window.__tab = (i) => { const t=[...document.querySelectorAll('.tabbar .tab')][i]; if(!t) return false; t.click(); return true }
window.__setVal = (sel, v) => { const i=document.querySelector(sel); if(!i) return false
  const proto = i.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(i, v)
  i.dispatchEvent(new Event('input',{bubbles:true})); return true }
window.__openTmpChat = () => {
  const row = [...document.querySelectorAll('.chat-row')].find(r => (r.querySelector('.cr-name')?.textContent||'').includes(${JSON.stringify(TMP_TITLE)}))
  if (!row) return false
  row.scrollIntoView({ block: 'center' }); row.click(); return true }
window.__openPlus = () => { const b=document.querySelector('.cp-btn[aria-label="更多"]'); if(!b) return false; b.click(); return true }
window.__plusState = (label) => {
  const b = [...document.querySelectorAll('.plus-item')].find(x => x.textContent.trim().startsWith(label))
  if (!b) return 'missing'
  return b.disabled ? 'disabled' : 'ready' }
window.__plusTap = (label) => {
  const b = [...document.querySelectorAll('.plus-item')].find(x => x.textContent.trim().startsWith(label))
  if (!b || b.disabled) return false
  b.click(); return true }
/* 投票气泡的状态。**按 data-poll-id 取**，不按「第几个 .poll-bubble」——
   房间里已经有好几条投票了，按序号会指向完全错误的那条。 */
window.__pb = (pollId) => {
  const b = document.querySelector('.poll-bubble[data-poll-id="' + pollId + '"]')
  if (!b) return null
  const opts = [...b.querySelectorAll('.pb-opt')].map(o => ({ id: Number(o.dataset.testid.replace('pb-opt-','')),
    votes: Number(o.dataset.votes), sel: o.dataset.selected === '1', text: o.querySelector('.pb-text')?.textContent }))
  return { state: b.dataset.state, anon: b.dataset.anonymous, multi: b.dataset.multi,
           question: b.querySelector('[data-testid="pb-question"]')?.textContent,
           count: b.querySelector('[data-testid="pb-voter-count"]')?.textContent.trim(),
           hasVoters: !!b.querySelector('[data-testid="poll-voters"]'),
           hasConfirm: !!b.querySelector('[data-testid="pb-confirm"]'),
           note: b.querySelector('[data-testid="poll-note"]')?.textContent.trim() || '',
           opts }
}
window.__pbTap = (pollId, optId) => {
  const o = document.querySelector('.poll-bubble[data-poll-id="' + pollId + '"] [data-testid="pb-opt-' + optId + '"]')
  if (!o) return false
  o.scrollIntoView({ block: 'center' }); o.click(); return true }
window.__pbConfirm = (pollId) => {
  const b = document.querySelector('.poll-bubble[data-poll-id="' + pollId + '"] [data-testid="pb-confirm"]')
  if (!b || b.disabled) return false
  b.click(); return true }
window.__openGset = () => { const b=[...document.querySelectorAll('.rh-btn')].find(x=>x.getAttribute('aria-label')==='会话设置'); if(!b) return false; b.click(); return true }
window.__gsetPoll = (pollId) => {
  const b = document.querySelector('[data-testid="gs-poll-' + pollId + '"]')
  if (!b) return false
  b.scrollIntoView({ block: 'center' }); b.click(); return true }
window.__msgSeen = (mid) => {
  const m = document.querySelector('.msg[data-mid="' + mid + '"]')
  if (!m) return null
  return { flash: m.classList.contains('is-flash'), y: Math.round(m.getBoundingClientRect().top) }
}
`
const injectHelp = () => js(HELP)

/**
 * 等**真实文档**挂载。
 *
 * ⚠️ `waitAppTarget` 返回的 target 还在 `about:blank` —— 真正的导航发生在其后。
 * 这个空档里 `Runtime.evaluate` 打的还是初始上下文：`document.body` 是空的、
 * 任何选择器都匹配不到，看起来就像「应用没挂载」（这个坑 LESSONS 里记过，
 * 报出来的结论会指向完全错误的方向）。判据要同时认「已离开 about:blank」
 * 「body 有内容」「登录页或主界面在」。
 */
const booted = await waitFor(
  `(() => {
     if (location.protocol === 'about:') return false
     if (!document.body || document.body.innerText.trim().length < 2) return false
     return !!document.querySelector('.lg-demo-list button') || !!document.querySelector('.tabbar')
   })()`,
  40000
)
if (!booted) {
  const where = await js(`location.href + ' | body=' + (document.body?.innerText||'').slice(0,80)`).catch(() => 'n/a')
  throw new Error(`应用没挂载 —— ${where}`)
}
await sleep(400)
await injectHelp()

/**
 * ⚠️ 点击之后不能立刻断言界面：投票是先本地乐观更新、再等服务端响应覆盖，
 * 中间那几十毫秒里 DOM 还是旧值。「点了之后立刻量」是本轮自检反复踩的坑
 * （时而绿时而红）。所以下面凡是由异步动作驱动的断言，都写成
 * 「**轮询到条件成立**」而不是「sleep 一个固定值再量」——
 * 固定 sleep 只是在赌机器够快，CI 或忙的时候必然偶发红。
 */

const tapAt = async (sel) => {
  const okSeen = await js(
    `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false
      e.scrollIntoView({ block: 'center' }); return true })()`
  )
  if (!okSeen) return false
  await sleep(280)
  const box = await js(
    `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null
      const r=e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 } })()`
  )
  if (!box) return false
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 })
  return true
}

/* ---- 上号 ---- */
if (await js(`!!document.querySelector('.lg-demo-list button')`)) {
  await js(
    `(() => { const b=[...document.querySelectorAll('.lg-demo-list button')].find(x=>x.textContent.includes('陈墨')); if(b) b.click(); return !!b })()`
  )
  await waitFor(`!!document.querySelector('.tabbar')`, 15000)
}
await sleep(800)
await injectHelp()

/* ---- 私聊里**根本不该有**「投票」这一项 ----
   注意判据是「这一格不存在」，不是「它是 disabled」。投票不适用于单聊，
   所以入口要被移除；摆一个永远点不动的灰按钮只会让人以为功能坏了。
   ⚠️ 顺带断言其它项还在（图片/视频/位置/文件）—— 否则「整个面板没渲染」
   也会让「找不到投票」这条通过，那是假绿。 */
await js(`window.__tab(0)`)
await waitFor(`!!document.querySelector('.chat-row')`, 12000)
const privRow = await js(
  `(() => { const r=[...document.querySelectorAll('.chat-row')].find(x=>x.querySelector('.cr-name')?.textContent?.includes('林小夏'))
    if(!r) return false; r.click(); return true })()`
)
ok(privRow, '能从列表进入一个私聊（用于验证单聊面板）')
if (privRow) {
  await waitFor(`!!document.querySelector('.room')`, 12000)
  await js(`window.__openPlus()`)
  await waitFor(`!!document.querySelector('.plus-item')`, 8000)
  const privItems = await js(
    `[...document.querySelectorAll('.plus-item')].map(b => b.textContent.trim())`
  )
  ok(
    !privItems.some((t) => t.startsWith('投票')),
    '单聊的加号面板里**没有**「投票」这一项（不是禁用，是不存在）',
    JSON.stringify(privItems)
  )
  ok(
    ['图片', '视频', '位置', '文件'].every((l) => privItems.some((t) => t.startsWith(l))),
    '单聊面板的其它项照常还在（排除「整个面板没渲染」的假绿）',
    JSON.stringify(privItems)
  )
  /* 连按「投票」都无从按起 —— 面板里确实没有这个 testid */
  ok(
    (await js(`!!document.querySelector('[data-testid="plus-投票"]')`)) === false,
    '单聊面板里不存在 plus-投票 这个按钮'
  )
  await tapAt('.plus-mask')
  await sleep(300)
  await js(`document.querySelector('.room-back')?.click()`)
  await sleep(500)
}

/* ---- 群聊：发起一条投票（走完整界面） ---- */
await js(`window.__tab(0)`)
await waitFor(`!!document.querySelector('.chat-row')`, 12000)
ok(await js(`window.__openTmpChat()`), `进入临时群「${TMP_TITLE}」`)
await waitFor(`!!document.querySelector('.room')`, 12000)
await shoot(cdp, path.join(OUT, '01-room-before.png'))

await js(`window.__openPlus()`)
await waitFor(`!!document.querySelector('.plus-item')`, 8000)
/* 群聊里必须有「投票」，而且是可用的 —— 与单聊那三条构成一组对照：
   同一份代码，只因为 conversation.type 不同就一个有一个没有。 */
const groupItems = await js(`[...document.querySelectorAll('.plus-item')].map(b => b.textContent.trim())`)
ok(
  groupItems.some((t) => t.startsWith('投票')),
  '群聊的加号面板里**有**「投票」（和单聊形成对照）',
  JSON.stringify(groupItems)
)
const gst = await js(`window.__plusState('投票')`)
ok(gst === 'ready', '群聊里「投票」可用', `state=${gst}`)
await js(`window.__plusTap('投票')`)
ok(await waitFor(`!!document.querySelector('[data-testid="poll-sheet"]')`, 10000), '打开发起投票面板')
await injectHelp()

/* 未填完时「发起」必须是禁用的 */
ok(
  await js(`document.querySelector('[data-testid="poll-submit"]')?.disabled === true`),
  '什么都没填时「发起」禁用（不给先点再报错这条路）'
)

/* 填两个选项 → 再删掉一个 → 加回来，顺带验证选项增删 */
await js(`window.__setVal('[data-testid="poll-question"]', '自检·界面发起：周末怎么过')`)
await js(`window.__setVal('[data-testid="poll-option-0"]', '露营')`)
await js(`window.__setVal('[data-testid="poll-option-1"]', '宅家')`)
await sleep(200)
ok(
  await js(`document.querySelector('[data-testid="poll-submit"]')?.disabled === false`),
  '填完标题与选项后「发起」可用'
)
const optCount0 = await js(`document.querySelectorAll('.poll-opt').length`)
await js(`document.querySelector('[data-testid="poll-add-option"]').click()`)
await sleep(150)
const optCount1 = await js(`document.querySelectorAll('.poll-opt').length`)
ok(optCount1 === optCount0 + 1, '「添加选项」真的加了一行', `${optCount0} → ${optCount1}`)
await js(`window.__setVal('[data-testid="poll-option-2"]', '桌游')`)
/* 多选 + 匿名 + 24 小时，把三个开关都打开，界面形态才看得全 */
await js(`document.querySelector('[data-testid="poll-multi"]').click()`)
await js(`document.querySelector('[data-testid="poll-anonymous"]').click()`)
await js(`document.querySelector('[data-testid="poll-deadline-24h"]').click()`)
await sleep(200)
const ariaMulti = await js(`document.querySelector('[data-testid="poll-multi"]').getAttribute('aria-pressed')`)
const ariaAnon = await js(`document.querySelector('[data-testid="poll-anonymous"]').getAttribute('aria-pressed')`)
ok(ariaMulti === 'true' && ariaAnon === 'true', '多选 / 匿名开关状态可读（aria-pressed）')

await shoot(cdp, path.join(OUT, '02-compose.png'))
await js(`document.querySelector('[data-testid="poll-submit"]').click()`)
ok(await waitFor(`!document.querySelector('[data-testid="poll-sheet"]')`, 10000), '发起后面板关闭')

/* 新投票进库 + 落成消息 */
const uiPollRow = q.get('SELECT id, question, multi, anonymous, deadline FROM polls WHERE question = ?', '自检·界面发起：周末怎么过')
ok(!!uiPollRow, '界面上发起的投票真的落库了')
ok(uiPollRow?.multi === 1 && uiPollRow?.anonymous === 1, '多选 / 匿名落库为 1')
ok(Number(uiPollRow?.deadline) > Date.now(), '截止时间落库且在未来')
const P6 = { id: uiPollRow.id, options: q.all('SELECT id, text FROM poll_options WHERE poll_id = ? ORDER BY sort', uiPollRow.id) }
const P6MSG = q.get('SELECT id FROM messages WHERE poll_id = ?', P6.id)?.id
ok(!!P6MSG, '投票挂上了一条消息')

/* 气泡渲染 */
ok(await waitFor(`!!document.querySelector('.poll-bubble[data-poll-id="${P6.id}"]')`, 12000), '聊天里出现投票气泡')
const b1 = await js(`window.__pb(${P6.id})`)
ok(b1?.question === '自检·界面发起：周末怎么过', '气泡显示题目', b1?.question)
ok(b1?.multi === '1' && b1?.anon === '1', '气泡标出多选 / 匿名')
ok(b1?.hasVoters === false, '匿名投票：气泡里没有投票人头像簇')
ok(b1?.hasConfirm === true, '多选投票有「确认投票」按钮')
ok(b1?.opts?.length === 3, '气泡有 3 个选项')
await shoot(cdp, path.join(OUT, '03-bubble-multi-anon.png'))

/* 多选：点两下 → 确认 → 回库核对 */
const tap0 = await js(`window.__pbTap(${P6.id}, ${P6.options[0].id})`)
await sleep(250)
const tap1 = await js(`window.__pbTap(${P6.id}, ${P6.options[1].id})`)
await sleep(400)
await injectHelp()
const bPending = await js(`window.__pb(${P6.id})`)
if (!bPending) {
  const dump = await js(
    `JSON.stringify({ bubbles: [...document.querySelectorAll('.poll-bubble')].map(b => b.dataset.pollId + ':' + b.dataset.state),
      room: !!document.querySelector('.room'), taps: ${JSON.stringify([tap0, tap1])}, target: ${P6.id} })`
  )
  await shoot(cdp, path.join(OUT, '99-no-bubble.png'))
  ok(false, '点选项后气泡应该还在', dump)
} else {
  ok(
    bPending.opts.filter((o) => o.sel).length === 2,
    '多选：点两下有两个选中（本地态）'
  )
  ok(
    q.get('SELECT COUNT(*) n FROM poll_votes WHERE poll_id = ?', P6.id).n === 0,
    '★ 只选未确认时**一票都没提交**（否则点第一下就把「只选了 A」发出去）'
  )
  await js(`window.__pbConfirm(${P6.id})`)
  await sleep(900)
  ok(
    q.get('SELECT COUNT(*) n FROM poll_votes WHERE poll_id = ? AND user_id = ?', P6.id, me.user.id).n === 2,
    '确认后回库核对：poll_votes 里我有两行'
  )
  /* 确认后：两个选项各 1 票且都是「我投的」。等 DB 先确认两行落库，
     再等界面跟上（乐观更新 → 服务端响应覆盖之间有一小段窗口）。 */
  let rowsOk = 0
  for (let i = 0; i < 30 && rowsOk !== 2; i++) {
    rowsOk = q.get('SELECT COUNT(*) n FROM poll_votes WHERE poll_id = ? AND user_id = ?', P6.id, me.user.id).n
    if (rowsOk !== 2) await sleep(150)
  }
  ok(rowsOk === 2, '确认后回库核对：poll_votes 里我有两行', `实际 ${rowsOk} 行`)

  let bAfter = null
  for (let i = 0; i < 30 && !bAfter; i++) {
    const b = await js(`window.__pb(${P6.id})`)
    const selCount = (b?.opts || []).filter((o) => o.sel === true).length
    const allOne = (b?.opts || []).length === 3 && (b?.opts || []).every((o) => o.votes === 1 || o.votes === 0)
    const twoVoted = (b?.opts || []).filter((o) => o.votes === 1).length
    if (b && selCount === 2 && twoVoted === 2 && allOne) bAfter = b
    else await sleep(150)
  }
  ok(!!bAfter, '确认后两个选项各 1 票', bAfter ? '' : JSON.stringify(await js(`window.__pb(${P6.id})`)))
  ok(String(bAfter?.count || '').includes('1 人已投'), '气泡底部显示 1 人已投', bAfter?.count)
  await shoot(cdp, path.join(OUT, '04-bubble-voted.png'))

  /* 取消投票：再点两下（取消选中）→ 确认 → 票数归零 */
  await js(`window.__pbTap(${P6.id}, ${P6.options[0].id})`)
  await sleep(150)
  await js(`window.__pbTap(${P6.id}, ${P6.options[1].id})`)
  await sleep(250)
  await js(`window.__pbConfirm(${P6.id})`)
  await sleep(900)
  ok(
    q.get('SELECT COUNT(*) n FROM poll_votes WHERE poll_id = ?', P6.id).n === 0,
    '★ 全部取消并确认后：库里一票不剩（界面能减掉才是真的取消）'
  )
  const bReset = await js(`window.__pb(${P6.id})`)
  ok(bReset.opts.every((o) => o.votes === 0) && bReset.count.includes('0 人已投'), '取消后气泡票数归零', bReset.count)
}

/* ---- 单选 + 非匿名：点一下立刻投出去，并出现头像簇 ---- */
const single = await j(
  'POST',
  '/polls',
  { conversationId: CID, question: '自检·单选：喝什么', options: ['咖啡', '茶'], multi: false, anonymous: false },
  me.auth
)
const P7 = single.data.poll
const P7MSG = q.get('SELECT id FROM messages WHERE poll_id = ?', P7.id)?.id
ok(
  await waitFor(`!!document.querySelector('.poll-bubble[data-poll-id="${P7.id}"]')`, 12000),
  '单选投票气泡出现（未打开会话时靠 WS message.new）'
)
const b2 = await js(`window.__pb(${P7.id})`)
ok(b2?.hasConfirm === false, '单选投票**没有**确认按钮（点一下就是一次完整的投票）')
await js(`window.__pbTap(${P7.id}, ${P7.options[0].id})`)
await sleep(900)
ok(
  q.get('SELECT COUNT(*) n FROM poll_votes WHERE poll_id = ? AND option_id = ?', P7.id, P7.options[0].id).n === 1,
  '单选：点一下立刻提交并落库'
)
const b3 = await js(`window.__pb(${P7.id})`)
ok(b3.opts[0].votes === 1 && b3.opts[0].sel === true, '单选：气泡显示我投的那项 1 票且选中')
ok(b3.hasVoters === true, '非匿名：气泡里出现投票人头像簇')
ok(b3.count.includes('1 人已投'), '非匿名：人数正确', b3.count)
await shoot(cdp, path.join(OUT, '05-bubble-single.png'))

/* 再点一次同一项 = 取消投票 */
await js(`window.__pbTap(${P7.id}, ${P7.options[0].id})`)
await sleep(900)
ok(
  q.get('SELECT COUNT(*) n FROM poll_votes WHERE poll_id = ?', P7.id).n === 0,
  '再点已选项 = 取消投票（界面上的唯一反悔入口）'
)

/* ---- 详情层 ---- */
await js(`window.__pbTap(${P7.id}, ${P7.options[1].id})`)
await sleep(800)
await js(
  `document.querySelector('.poll-bubble[data-poll-id="${P7.id}"] [data-testid="poll-detail"]').click()`
)
ok(await waitFor(`!!document.querySelector('[data-testid="poll-detail-sheet"]')`, 10000), '打开投票详情层')
await injectHelp()
const pdVoters = await js(`!!document.querySelector('[data-testid="pd-voters"]')`)
ok(pdVoters === true, '详情里列出已投票的人')
await shoot(cdp, path.join(OUT, '06-detail.png'))
await js(`document.querySelector('.poll-detail .poll-cancel').click()`)
await sleep(400)

/* 匿名详情：必须写明「不显示谁投的」，而不是画一片空白 */
await js(
  `document.querySelector('.poll-bubble[data-poll-id="${P6.id}"] [data-testid="poll-detail"]').click()`
)
await waitFor(`!!document.querySelector('[data-testid="poll-detail-sheet"]')`, 8000)
ok(
  await waitFor(`!!document.querySelector('[data-testid="pd-anonymous"]')`, 6000),
  '匿名投票的详情里写明「不显示谁投了票」'
)
await shoot(cdp, path.join(OUT, '07-detail-anonymous.png'))
await js(`document.querySelector('.poll-detail .poll-cancel').click()`)
await sleep(400)

/* ---- 实时：另一个身份投一票，本实例要自己变 ---- */
const beforeLive = await js(`window.__pb(${P7.id})`)
await j('POST', `/polls/${P7.id}/vote`, { optionIds: [P7.options[0].id] }, peer.auth)
const liveChanged = await waitFor(
  `(window.__pb(${P7.id})?.opts?.[0]?.votes || 0) === 1 && (window.__pb(${P7.id})?.count || '').includes('2 人已投')`,
  8000
)
ok(liveChanged, '★ 别人投票后，本实例的票数**自己**变了（WS poll.updated）', `投前 ${beforeLive?.count}`)
await shoot(cdp, path.join(OUT, '08-realtime.png'))

/* ---- 结束投票（界面按钮） ---- */
const mineOpen = await j(
  'POST',
  '/polls',
  { conversationId: CID, question: '自检·界面结束', options: ['甲', '乙'] },
  me.auth
)
const P8 = mineOpen.data.poll
ok(await waitFor(`!!document.querySelector('.poll-bubble[data-poll-id="${P8.id}"]')`, 12000), '待结束的投票气泡出现')
ok(
  await js(`!!document.querySelector('.poll-bubble[data-poll-id="${P8.id}"] [data-testid="poll-end"]')`),
  '发起人看得到「结束投票」入口'
)
const peerEnd = await js(`window.__pb(${P8.id})`)
await js(`document.querySelector('.poll-bubble[data-poll-id="${P8.id}"] [data-testid="poll-end"]').click()`)
await waitFor(`window.__pb(${P8.id})?.state === 'closed'`, 8000)
ok((await js(`window.__pb(${P8.id})`)).state === 'closed', '结束后气泡变成已结束态')
/* ⚠️ 界面变成「已结束」是**客户端**跟着响应刷新的，不等于服务端已经落库。
   立刻查 DB 会偶发读到 null（本轮就是这么红的）—— 要等库里的 closed_at 出现。 */
let closePersisted = false
for (let i = 0; i < 20 && !closePersisted; i++) {
  closePersisted = !!q.get('SELECT closed_at AS c FROM polls WHERE id = ?', P8.id).c
  if (!closePersisted) await sleep(150)
}
ok(closePersisted, '结束时间落库（closed_at 非空）')
const endVote = await j('POST', `/polls/${P8.id}/vote`, { optionIds: [P8.options[0].id] }, peer.auth)
ok(endVote.status === 400, '结束后再投 → 400（界面与接口一致）')
await shoot(cdp, path.join(OUT, '09-closed.png'))

/* ---- 非发起人看不到结束入口 ---- */
const notMine = await j(
  'POST',
  '/polls',
  { conversationId: CID, question: '自检·别人发的', options: ['甲', '乙'] },
  peer.auth
)
const P9 = notMine.data.poll
await waitFor(`!!document.querySelector('.poll-bubble[data-poll-id="${P9.id}"]')`, 12000)
ok(
  (await js(`!!document.querySelector('.poll-bubble[data-poll-id="${P9.id}"] [data-testid="poll-end"]')`)) === false,
  '非发起人**看不到**结束入口（服务端才是真拦截，这里只是不给按钮）'
)

/* ---- 群设置里的群投票列表 + 跳转 ---- */
await js(`window.__openGset()`)
ok(await waitFor(`!!document.querySelector('.inline-row')`, 10000), '打开会话设置面板')
/* 会话设置（sheet）→「群设置」那一行 —— 群资料只在群设置里改，会话设置只放入口 */
const toGset = await js(
  `(() => { const b=[...document.querySelectorAll('.inline-row')].find(x=>x.textContent.includes('群设置')); if(!b) return false; b.click(); return true })()`
)
ok(toGset === true, '从会话设置进入群设置')
ok(await waitFor(`!!document.querySelector('.gs-root')`, 10000), '群设置页打开')
await injectHelp()
ok(await waitFor(`!!document.querySelector('[data-testid="gs-poll-${P7.id}"]')`, 10000), '群设置里有「群投票」列表并列出这条投票')
const gsText = await js(
  `document.querySelector('[data-testid="gs-poll-${P7.id}"]')?.textContent || ''`
)
ok(gsText.includes('自检·单选：喝什么'), '列表里是题目', gsText.slice(0, 60))
ok(!gsText.includes('未接入'), '「群投票」不再是「未接入」的禁用项')
await shoot(cdp, path.join(OUT, '10-group-settings.png'))

/* 点一条 → 关掉设置页并跳到聊天里那条消息 */
await js(`window.__gsetPoll(${P7.id})`)
ok(await waitFor(`!document.querySelector('.gs-root')`, 8000), '点投票后设置页关闭')
const jumped = await waitFor(`window.__msgSeen(${P7MSG}) !== null`, 8000)
ok(jumped, '跳到了发起的那条投票消息（消息在视口里）')
if (P7) {
  const target = q.get('SELECT id FROM messages WHERE poll_id = ?', P7.id)?.id
  const seen = await js(`window.__msgSeen(${target})`)
  ok(seen && seen.flash === true, '跳过去的那条消息被高亮了', JSON.stringify(seen))
}
await shoot(cdp, path.join(OUT, '11-jumped.png'))

/* ---- 控制台干净 ---- */
const realIssues = issues.filter((t) => !/favicon|Download the React DevTools/i.test(t))
ok(realIssues.length === 0, '浏览器控制台无报错 / 无非法嵌套告警', realIssues.slice(0, 3).join(' | '))

try {
  proc.kill()
} catch {}

/* ============================================================
   收尾：按基线清理，并核对库跟开跑前一致
   ============================================================ */
console.log('\n─── 收尾 ───')
const pollRows = q.get('SELECT COUNT(*) n FROM polls WHERE id > ?', maxPollBefore).n
db.prepare('DELETE FROM polls WHERE id > ?').run(maxPollBefore)
q.run('DELETE FROM messages WHERE id > ?', maxMsgBefore)
purgeDebris({ quiet: true })
fs.rmSync(MIG_TMP, { recursive: true, force: true })

const pollsAfter = q.get('SELECT COUNT(*) n FROM polls').n
const messagesAfter = q.get('SELECT COUNT(*) n FROM messages').n
ok(pollsAfter === pollsBefore, `投票数回到基线（${pollsBefore}）`, `现在 ${pollsAfter}，本轮清了 ${pollRows} 条`)
ok(messagesAfter === messagesBefore, `消息数回到基线（${messagesBefore}）`, `现在 ${messagesAfter}`)
ok(
  q.get('SELECT COUNT(*) n FROM polls p WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.poll_id = p.id)').n === 0,
  '没有留下「没有消息引用的投票」'
)
ok(
  q.get('SELECT COUNT(*) n FROM poll_options WHERE poll_id NOT IN (SELECT id FROM polls)').n === 0,
  '没有留下孤儿选项'
)
ok(
  q.get('SELECT COUNT(*) n FROM poll_votes WHERE poll_id NOT IN (SELECT id FROM polls)').n === 0,
  '没有留下孤儿投票记录'
)
ok(db.prepare('PRAGMA foreign_key_check').all().length === 0, '外键无断裂')

console.log(`\n${failures === 0 ? '✅ 群投票自检全部通过' : '❌ 有失败项'} —— ${pass} 通过 / ${failures} 失败`)
console.log(`截图：${path.relative(ROOT, OUT)}\n`)
process.exit(failures ? 1 : 0)



