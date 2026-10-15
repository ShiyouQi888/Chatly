/**
 * 数据层跨驱动契约自检 —— 同一支用例，**两种数据库都要过**
 *
 * 跑法：
 *   node scripts/check-driver.mjs                                   # SQLite（默认）
 *   DB_DRIVER=postgres DATABASE_URL=... node scripts/check-driver.mjs   # PostgreSQL
 *
 * ## 这支自检为什么存在
 *
 * 双驱动的承诺是「业务代码只认门面，看不到驱动差异」。
 * 但**没有任何东西保证两个驱动返回的东西长得一样** —— 门面做得再厚，
 * 驱动层只要有一处细节不同，业务代码就会在一种库上对、另一种库上错。
 *
 * 最典型的一次（2026-10-14，本支自检的由来）：
 *   PostgreSQL 把**未加引号的标识符折成小写**，SQLite 原样保留。
 *   于是 `SELECT m.user_id AS userId` 在 PG 上返回的键是 `userid`。
 *   `row.userId === undefined` → `chat.js` 的
 *   `members.find(m => m.user.id !== userId)` **恒为真** → `find` 永远返回第一个成员
 *   → **私聊会话名显示成自己**。
 *   症状是「本地 SQLite 全绿、切到 PG 就变成自己跟自己聊天」，
 *   而且**不报任何错** —— 正是双驱动最该被抓住、也最难靠人眼发现的那一类。
 *
 * ## 断言分两层
 *   ① **驱动层**：主键类型、别名大小写、占位符、事务、命名参数、LIKE 语义。
 *      这一层错了，任何业务代码都可能在另一种库上悄悄失效。
 *   ② **业务层**：`listMembers` / `listConversations` 的出参形状。
 *      这一层是「跨驱动契约」真正的验收点 —— 前一次就是它红的。
 *
 * ## 纪律
 *  · 全程**只读演示数据**，唯一的写操作（事务回滚 + INSERT OR IGNORE）
 *    都落在 `user_settings` 上，收尾按基线删干净。
 *  · ⚠️ 本脚本**绝不 import `db` / `qSync` / `insertSync`** ——
 *    那三个是 SQLite 专有的，import 了在 PG 下会直接抛错，
 *    等于把「这支自检只能在 SQLite 下跑」写死在第一行。
 */
import { q, insert, tx, ready as dbReady, info } from '../server/src/db.js'
import { listMembers, listConversations } from '../server/src/chat.js'

let pass = 0
let fail = 0
const ok = (c, l, e = '') =>
  c ? (pass++, console.log(`  ✅ ${l}`)) : (fail++, console.log(`  ❌ ${l}${e ? ' — ' + e : ''}`))

await dbReady()
const { driver } = info()
console.log(`\n══════ 数据层跨驱动契约（驱动 = ${driver}） ══════`)
console.log(`（想验另一种库：换 DB_DRIVER / DATABASE_URL 再跑一遍本支）\n`)

/* 演示账号：陈墨是 1 号，注册顺序即 id */
const me = await q.get('SELECT id, nickname FROM users ORDER BY id LIMIT 1')
if (!me) {
  console.error('❌ 演示库是空的 —— 先跑 `cd server && npm run seed`。本支自检不做任何清理以外的写操作。')
  process.exit(1)
}
const ME_ID = Number(me.id)

/* ================= ① 驱动层 ================= */
console.log('─── ① 驱动层：两种库必须返回同样的形状 ───')

/* 1. 主键必须是 **number**。
      PG 的 int4 由 node-postgres 解析成 number，BIGINT 会解析成 **string**；
      SQLite 一律 number。哪边是 string，`=== userId` 这类比较就会静默失效。 */
ok(typeof ME_ID === 'number' && Number.isFinite(ME_ID), '主键读出的是 number（不是字符串）', typeof me.id)

/* 2. ★ 别名大小写 —— 本支自检的由来。
      SQLite：`AS userId` → 键就是 `userId`
      PG 未加引号：→ 键是 `userid`（折叠成小写）
      门面/方言层必须把它掰回来（见 db/sql.js 的 quoteMixedCaseAlias）。 */
const aliasRow = await q.get('SELECT id AS userId, nickname AS camelCaseNick FROM users LIMIT 1')
ok(aliasRow.userId !== undefined, '★ camelCase 别名原样保留（AS userId）', `实际键：${Object.keys(aliasRow).join(',')}`)
ok(typeof aliasRow.userId === 'number', '★ 别名列的值也是 number', typeof aliasRow.userId)
ok(aliasRow.camelCaseNick !== undefined, '★ 多词 camelCase 别名也保留（AS camelCaseNick）')

/* 对照：全小写别名不能被误伤（加了引号也应当照常работать） */
const lowerRow = await q.get('SELECT id AS n, nickname FROM users LIMIT 1')
ok(lowerRow.n !== undefined && lowerRow.nickname !== undefined, '对照：全小写别名照常（AS n / 无别名）')

/* 3. 位置占位符 */
const one = await q.get('SELECT ? AS a', 7)
ok(Number(one.a) === 7, '位置占位符 `?` 可用')

/* 4. 命名参数（moment.js 用的是这一套：`q.all(sql, { viewer, limit })`）。
      PG 不认 `@name` 语法，方言层必须翻成 `$n` 并**同名复用同一个编号**。 */
const named = await q.get('SELECT @a AS a, @b AS b, @a AS a2', { a: 11, b: 22 })
ok(
  Number(named.a) === 11 && Number(named.b) === 22 && Number(named.a2) === 11,
  '★ 命名参数 `@name` 可用，且同名复用同一个值',
  JSON.stringify(named),
)

/* 5. 事务：能提交、也能回滚 */
const TXKEY = '__driver_check_tx__'
await tx(async () => {
  await q.run(
    `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    ME_ID, TXKEY, '"rolled-back"',
  )
  throw new Error('__rollback__')
}).catch(() => {})
const afterRollback = await q.get('SELECT value FROM user_settings WHERE user_id = ? AND key = ?', ME_ID, TXKEY)
ok(!afterRollback, '★ 事务回滚后行**不存在**（不是「提交了但以为回滚了」）')

await tx(async () => {
  await q.run(
    `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    ME_ID, TXKEY, '"committed"',
  )
})
const afterCommit = await q.get('SELECT value FROM user_settings WHERE user_id = ? AND key = ?', ME_ID, TXKEY)
ok(!!afterCommit, '对照：事务提交后行**存在**')

/* 6. `insert()` 要能从两种库里都拿回自增 id
      —— PG 没有 lastInsertRowid，得靠方言层补 `RETURNING id`。
      挑 `feedbacks`（有自增 id 且必填列只有 user_id / description），
      别用 `user_settings` —— 那张表的主键是 (user_id, key)，**根本没有 id 列**。 */
const fbId = await insert(
  `INSERT INTO feedbacks (user_id, type, description) VALUES (?, ?, ?)`,
  ME_ID, 'other', '__driver_check__',
)
ok(fbId !== undefined && fbId !== null && Number(fbId) > 0, '★ insert() 两种驱动都回得出新行 id', String(fbId))

/* 7. LIKE 大小写：SQLite 的 LIKE 对 ASCII 不区分大小写，PG 的要翻成 ILIKE 才一致。
      不翻的话 `file_name LIKE '%.zip'` 在 PG 上匹配不到 '.ZIP' —— 行为悄悄变了。
      这里拿用户的 username（全是 ASCII 小写）大写之后去 LIKE，必须仍匹配得到。 */
const { username } = await q.get('SELECT username FROM users WHERE id = ?', ME_ID)
const likeRow = await q.get(`SELECT username FROM users WHERE username LIKE ?`, username.toUpperCase())
ok(!!likeRow, '★ LIKE 对大小写不敏感（与 SQLite 语义一致）', `${username.toUpperCase()} → ${likeRow?.username ?? '(无匹配)'}`)

/* 收尾：把本段造的行清干净（含事务段那两行） */
await q.run('DELETE FROM feedbacks WHERE id = ?', Number(fbId))
await q.run('DELETE FROM user_settings WHERE user_id = ? AND key IN (?, ?)', ME_ID, TXKEY, '__driver_check_insert__')
const leftover = await q.get('SELECT id FROM feedbacks WHERE description = ?', '__driver_check__')
ok(!leftover, '收尾：临时数据已清干净')

/* ================= ② 业务层跨驱动契约 ================= */
console.log('\n─── ② 业务层：出参形状必须一致 ───')

const priv = (await q.get(`SELECT id FROM conversations WHERE type = 'private' ORDER BY id LIMIT 1`))
ok(!!priv, '预检：演示库里至少有一条私聊（否则下面两条无从谈起）')

if (priv) {
  const members = await listMembers(priv.id)
  ok(members.length >= 2, `预检：这条私聊有 ≥2 个成员（实际 ${members.length}）`)
  ok(
    members.every((m) => typeof m.user.id === 'number' && Number.isFinite(m.user.id)),
    '★ listMembers() 里**每个人**的 user.id 都是 number',
    JSON.stringify(members.map((m) => m.user.id)),
  )
  ok(
    members.every((m) => typeof m.user.nickname === 'string' && m.user.nickname.length > 0),
    '★ listMembers() 里每个人都有昵称（昵称是会话名的来源）',
  )
}

const convs = await listConversations(ME_ID)
const privateConvs = convs.filter((c) => c.type === 'private')
ok(privateConvs.length > 0, `预检：陈墨有私聊（实际 ${privateConvs.length} 条）`)
/* ★★ 前一次就是这条红的：别名被折成小写之后 `resolveTitle` 找不到「对方」，
       `find` 退回第一个成员 = 自己 → 私聊名变成自己的昵称。 */
ok(
  privateConvs.every((c) => c.name !== me.nickname),
  '★★ 私聊会话名**不是自己**（别名大小写错了就会变成自己）',
  JSON.stringify(privateConvs.map((c) => c.name)),
)
ok(
  privateConvs.every((c) => typeof c.name === 'string' && c.name.length > 0),
  '★ 每条私聊都有会话名',
)
/* 群聊走的是 `c.title`，不该受影响 —— 配一条对照，排除「整个列表都没名字」 */
ok(
  convs.filter((c) => c.type === 'group').every((c) => typeof c.name === 'string' && c.name.length > 0),
  '对照：群聊名照常（群名走 title，与别名折叠无关）',
)
/* unread / memberCount 这类 camelCase 出参也要是数字，否则界面上会出现 NaN */
ok(
  convs.every((c) => Number.isFinite(Number(c.unread)) && Number.isFinite(Number(c.memberCount))),
  '★ 会话列表的 unread / memberCount 都是数字（不是 undefined/NaN）',
  JSON.stringify(convs.map((c) => [c.unread, c.memberCount])),
)

/* ================= 结果 ================= */
console.log(`\n${fail === 0 ? '✅ 跨驱动契约自检全部通过' : '❌ 有失败项'} —— ${pass} 通过 / ${fail} 失败`)
console.log(`驱动 = ${driver}（换 DB_DRIVER 再跑一遍，两边都必须绿）`)
process.exit(fail === 0 ? 0 : 1)
