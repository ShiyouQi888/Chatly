/**
 * 消息收藏专项自检（PRD §9）
 *
 * 收藏这个功能最容易做错的地方**不在「能不能收」**，而在「收下来之后还算不算数」。
 * 所以判据全部围绕「快照」这一个词：
 *
 *   A. **快照语义**：原消息被撤回后，收藏里的正文与文件地址**必须原样还在**。
 *      做成「引用原消息」的话，对方一撤回，你的收藏就变成一条空记录 ——
 *      那不叫收藏。库里 favorites.content 也要核对（不只是接口出参看着对）。
 *   B. **文件生命周期**：快照的 file_url 是那个文件**最后的引用者**（原消息删了）。
 *      所以 purgeOrphanUploads() 必须把它算作引用方 —— 漏了就是「第一次跑清理，
 *      收藏的图集体变破图」。这条单独验：造一条收藏图片、清掉原消息、
 *      跑一次回收，断言文件**没被挪走**。
 *   C. **幂等**：收藏/取消都是开关，重复点不能炸、也不能多插一行。
 *      且「已收藏过又撤回」要返回既有那条，而不是「已撤回不能收藏」。
 *   D. **权限**：收藏是私人的 —— 别人的列表读不到、别人的 id 删不掉；
 *      收藏**别人会话**里的消息要 403（消息 id 是自增的，很好猜）。
 *   E. **批量**：混着一条已撤回的，其余的照收（不整批失败），skipped 里带原因。
 *   F. **界面**：长按菜单有「收藏」、收藏后变「取消收藏」；
 *      多选模式能进、能批量收藏、底部工具栏显示已选条数；
 *      我页收藏子页读真数据（不再是 mock 的三条）、统计条是真数；
 *      收藏里点「在聊天中查看」能跳到那条消息。
 *
 * ⚠️ 前提自己造、收尾按**基线**清（记 id 列表一定会漏 —— 本轮开发时探针崩在半路，
 *    就是把 2 条撤回空行留在了演示会话里，看起来像产品 bug）。
 *
 * 跑法：node scripts/check-favorite.mjs     （需要 5198 与 3002 都在跑）
 */
import fs from 'node:fs'
import path from 'node:path'

/* ⚠️ 这里刻意用 qSync（SQLite 专有的**同步**直连）而不是 q。
 *    原因：本脚本是「造数据 → 打接口 → 回库核对」的写法，回库核对那一步是
 *    `q.get(...).n` 这种同步取值；而 q 已改成 async（PG 驱动必须异步），
 *    直接用会静默拿到 Promise（`Promise.n === undefined`），断言全红却指向别处。
 *    别改成 await —— 脚本里 60 多处都要动，且脚本本来就绑 SQLite。 */
import { db, qSync as q } from '../server/src/db.js'
import { PRIVATE_UPLOAD_DIR } from '../server/src/upload.js'
import { purgeDebris, purgeOrphanUploads, maxMessageId } from './lib/debris.mjs'
import { freePort, waitAppTarget, connectCdp, launchChrome, shoot } from './lib/cdp.mjs'

const API = 'http://127.0.0.1:3002/api/v1'
const APP_HOST = 'http://127.0.0.1:5198'
const APP = APP_HOST + '/'
const OUT = 'D:/BS-chat-os/shots/favorite'
const PASS = 'chatly123'
const ORPHANS = 'D:/BS-chat-os/.tmp/orphan-uploads'
const PRIVATE_ORPHANS = path.join(ORPHANS, 'private')

fs.mkdirSync(OUT, { recursive: true })

let pass = 0
let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`)
  cond ? pass++ : failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ================= 接口小工具 ================= */
const req = async (p, { method = 'GET', token, body } = {}) => {
  const r = await fetch(API + p, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: r.status, data }
}
const login = async (u) => {
  const d = (await req('/auth/login', { method: 'POST', body: { username: u, password: PASS } })).data
  if (!d.token) throw new Error(`${u} 登录失败：${JSON.stringify(d)}`)
  return { ...d, auth: { Authorization: `Bearer ${d.token}` } }
}

/* ================= 基线 ================= */
await purgeDebris({ quiet: true })
/**
 * ⚠️ 开跑前先把**上一次崩在半路**留下的自检收藏清掉。
 *
 * 为什么需要：本脚本的收尾是按基线删（`DELETE FROM favorites WHERE id > 基线`），
 * 但那一步只在**跑到收尾**时才执行。中途断言抛异常 / 进程被杀，残留就留在库里了，
 * 而且它们指向的探针消息同样还在 —— 界面上就是「我的收藏」里躺着几条
 * 「自检·批量一」这种只有自检看得懂的东西。
 * 本轮开发就留下了 7 条。清理判据用内容标记（`自检·` / `自检`），
 * 与演示数据和用户手测数据都不会撞。
 */
const staleFavs = db
  .prepare("SELECT id FROM favorites WHERE content LIKE '%自检%'")
  .all()
  .map((r) => r.id)
for (const id of staleFavs) db.prepare('DELETE FROM favorites WHERE id = ?').run(id)
if (staleFavs.length) console.log(`（开跑前清掉 ${staleFavs.length} 条上次残留的自检收藏）`)

const msgBaseline = await maxMessageId()
const favBaseline = q.get('SELECT COALESCE(MAX(id),0) v FROM favorites').v
const favCountBefore = q.get('SELECT COUNT(*) n FROM favorites').n
const msgCountBefore = q.get('SELECT COUNT(*) n FROM messages').n

const me = await login('chenmo')
const peer = await login('linxiaoxia')
const outsider = await login('shenxu')

const convs = (await req('/conversations', { token: me.token })).data.conversations
const priv = convs.find(
  (c) => c.type === 'private' && (c.members || []).some((m) => m.user.username === 'linxiaoxia')
)
const group = convs.find((c) => c.type === 'group' && (c.members || []).some((m) => m.user.username === 'linxiaoxia'))
if (!priv || !group) throw new Error('找不到可用的私聊/群，自检无法继续')
console.log(`\n基线 message#${msgBaseline} / favorite#${favBaseline}（现有收藏 ${favCountBefore} 条）`)
console.log(`用私聊 #${priv.id} 与群 #${group.id}\n`)

const send = async (token, conversationId, text) =>
  (await req('/messages', { method: 'POST', token, body: { conversationId, kind: 'text', text } })).data.message

/* ============================================================
   A. 收藏与快照语义
   ============================================================ */
console.log('─── A. 收藏与快照 ───')

const m1 = await send(peer.token, priv.id, '自检·收藏目标一')
ok(!!m1?.id, '造一条探针消息', `#${m1?.id}`)

const f1 = await req('/favorites', { method: 'POST', token: me.token, body: { messageId: m1.id } })
ok(f1.status === 201 && f1.data.created === true, '首次收藏 → 201 created')
ok(f1.data.favorite?.text === '自检·收藏目标一', '快照存下了正文', f1.data.favorite?.text)
ok(f1.data.favorite?.sender?.nickname === '林小夏', '发送者现查（快照只存 id，名字变了要跟着变）')
ok(f1.data.favorite?.canJump === true, 'canJump=true（消息与会话都还在）')
ok(f1.data.favorite?.conversationId === priv.id, '记下了会话 id（跳转要用）')

const again = await req('/favorites', { method: 'POST', token: me.token, body: { messageId: m1.id } })
ok(again.status === 200 && again.data.created === false, '重复收藏 → 200 created=false（幂等）')
ok(
  q.get('SELECT COUNT(*) n FROM favorites WHERE user_id = ? AND message_id = ?', me.user.id, m1.id).n === 1,
  '库里只有一行（没重复插入）'
)

/* ★ 撤回原消息 —— 收藏必须活下来 */
const rev = await req(`/messages/${m1.id}`, { method: 'DELETE', token: peer.token })
ok(rev.status === 200, '发送者撤回原消息')
const msgsAfter = (await req(`/conversations/${priv.id}/messages`, { token: me.token })).data.messages
const revMsg = msgsAfter.find((m) => m.id === m1.id)
ok(revMsg?.revoked === true && revMsg?.text === '', '原消息确实变成「已撤回」（正文被抹空）')

const listAfter = (await req('/favorites', { token: me.token })).data.favorites
const kept = listAfter.find((f) => f.id === f1.data.favorite.id)
ok(!!kept, '★ 收藏里那一条**还在**')
ok(kept?.text === '自检·收藏目标一', '★ 接口出参的正文仍是原文', JSON.stringify(kept?.text))
ok(
  q.get('SELECT content FROM favorites WHERE id = ?', f1.data.favorite.id).content === '自检·收藏目标一',
  '★ 库里 favorites.content 也没被改动（不是只在出参上做的样子）'
)
ok(kept?.messageId === m1.id, '仍然记着原消息 id（「在聊天中查看」还要用）')

/* 已收藏过 + 又撤回 → 要返回既有那条，而不是「已撤回不能收藏」 */
const reAfterRevoke = await req('/favorites', { method: 'POST', token: me.token, body: { messageId: m1.id } })
ok(
  reAfterRevoke.status === 200 && reAfterRevoke.data.created === false,
  '★ 已收藏过的消息被撤回后再点收藏 → 幂等返回既有那条（不是 400）',
  `status=${reAfterRevoke.status}`
)

/* 没收藏过的 + 已撤回 → 400 */
const mRev = await send(me.token, priv.id, '自检·待撤回的')
await req(`/messages/${mRev.id}`, { method: 'DELETE', token: me.token })
const favRevoked = await req('/favorites', { method: 'POST', token: me.token, body: { messageId: mRev.id } })
ok(favRevoked.status === 400, '收藏一条**没收藏过**的已撤回消息 → 400', `status=${favRevoked.status} ${favRevoked.data?.error || ''}`)

/* ============================================================
   B. ★ 文件生命周期：快照的图不能被当孤儿回收
   ============================================================ */
console.log('\n─── B. 快照文件不被误回收 ───')

/* 造一张真图上传，发成图片消息，收藏它，然后**把原消息删掉**，
   这时只有 favorites.file_url 还指着那个文件。跑一次回收，它必须还在。 */
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)
const up = await fetch(`${API}/messages/upload`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${me.token}` },
  body: (() => {
    const fd = new FormData()
    fd.append('file', new Blob([pngBytes], { type: 'image/png' }), 'fav-shot.png')
    return fd
  })(),
})
const upBody = await up.json()
const fileUrl = upBody.url
const imgMsg = (
  await req('/messages', {
    method: 'POST',
    token: me.token,
    body: { conversationId: priv.id, kind: 'image', fileUrl, fileName: '收藏用图.png', fileSize: upBody.fileSize },
  })
).data.message
ok(!!imgMsg?.id, '发一条图片消息', `${fileUrl}`)

const favImg = await req('/favorites', { method: 'POST', token: me.token, body: { messageId: imgMsg.id } })
ok(favImg.data.favorite?.fileUrl === fileUrl, '收藏快照记下了文件地址', String(favImg.data.favorite?.fileUrl))

/* 把原消息物理删掉（模拟「消息被清理」——产品侧只有撤回，但自检与级联会真删） */
db.prepare('DELETE FROM messages WHERE id = ?').run(imgMsg.id)
ok(
  q.get('SELECT COUNT(*) n FROM messages WHERE file_url = ?', fileUrl).n === 0,
  '原消息已物理删除（现在只有收藏还指着这个文件）'
)
const favStill = q.get('SELECT file_url AS f FROM favorites WHERE id = ?', favImg.data.favorite.id).f
ok(favStill === fileUrl, '收藏里仍指着它')

/* 跑一次孤儿回收 */
const reclaim = await purgeOrphanUploads({ quiet: true })
const privateFilePath = path.join(PRIVATE_UPLOAD_DIR, path.basename(fileUrl))
const privateOrphanPath = path.join(PRIVATE_ORPHANS, path.basename(fileUrl))
const stillOnDisk = fs.existsSync(privateFilePath)
ok(
  stillOnDisk,
  '★ 回收**没有**把收藏引用的文件挪走（purgeOrphanUploads 认了 favorites.file_url）',
  `本轮回收 ${reclaim.moved} 个文件；被挪走的：${reclaim.files.slice(0, 5).join(',')}`
)
ok(
  !reclaim.files.includes(path.basename(fileUrl)),
  '被回收清单里没有这个文件'
)

/* 反例：把收藏删掉之后，它就该被回收了 —— 证明上一条不是因为「回收压根没生效」 */
await req(`/favorites/${favImg.data.favorite.id}`, { method: 'DELETE', token: me.token })
const reclaim2 = await purgeOrphanUploads({ quiet: true })
ok(
  !fs.existsSync(privateFilePath),
  '★ 反例：取消收藏后同一个文件**确实被回收了**（证明回收本身有效）',
  `回收 ${reclaim2.moved} 个`
)
/* 从 orphan 里捞回来删掉，不给下次留垃圾 */
try {
  fs.rmSync(privateOrphanPath, { force: true })
} catch {}

/* ============================================================
   C. 权限：收藏是私人的
   ============================================================ */
console.log('\n─── C. 权限 ───')
const peerList = (await req('/favorites', { token: peer.token })).data
ok(
  !(peerList.favorites || []).some((f) => f.id === f1.data.favorite.id),
  '别人看不到我的收藏（列表里没有我那条）'
)
const peerDel = await req(`/favorites/${f1.data.favorite.id}`, { method: 'DELETE', token: peer.token })
ok(peerDel.data?.removed === false, '别人拿我的收藏 id 去删 → removed=false（删不掉）', JSON.stringify(peerDel.data))
ok(
  q.get('SELECT COUNT(*) n FROM favorites WHERE id = ?', f1.data.favorite.id).n === 1,
  '我的那条收藏还在'
)

const outsiderInPriv = db
  .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
  .get(priv.id, outsider.user.id)
if (!outsiderInPriv) {
  const m2 = await send(me.token, priv.id, '自检·别人私聊里的')
  const stolen = await req('/favorites', { method: 'POST', token: outsider.token, body: { messageId: m2.id } })
  ok(stolen.status === 403, '收藏**别人私聊**里的消息 → 403（消息 id 很好猜，必须挡）', `status=${stolen.status}`)
  const stolenBatch = await req('/favorites/batch', { method: 'POST', token: outsider.token, body: { messageIds: [m2.id] } })
  ok(stolenBatch.status === 403, '批量收藏里混一条别人的 → 整批 403', `status=${stolenBatch.status}`)
} else {
  ok(true, '（沈叙恰在该私聊里，跳过越权用例）')
}

const ghost = await req('/favorites', { method: 'POST', token: me.token, body: { messageId: 99999999 } })
ok(ghost.status === 404, '收藏不存在的消息 → 404', `status=${ghost.status}`)
ok((await req('/favorites', { method: 'POST', token: me.token, body: {} })).status === 400, '缺 messageId → 400')

/* ============================================================
   D. 批量（混着一条已撤回的）
   ============================================================ */
console.log('\n─── D. 批量收藏 ───')
const g1 = await send(me.token, group.id, '自检·批量一')
const g2 = await send(me.token, group.id, '自检·批量二')
const batch = await req('/favorites/batch', {
  method: 'POST',
  token: me.token,
  body: { messageIds: [g1.id, g2.id, mRev.id] },
})
ok(batch.status === 200, '批量收藏 → 200', `status=${batch.status}`)
ok(batch.data.added?.length === 2, '收下 2 条', `added=${batch.data.added?.length}`)
ok(
  batch.data.skipped?.length === 1 && batch.data.skipped[0].messageId === mRev.id,
  '★ 已撤回的那条被**跳过并带原因**（不是整批失败）',
  JSON.stringify(batch.data.skipped)
)
ok(
  q.get('SELECT COUNT(*) n FROM favorites WHERE message_id IN (?,?)', g1.id, g2.id).n === 2,
  '库里确实两行'
)
ok(typeof batch.data.total === 'number', '批量返回里带 total（前端直接更新计数）', String(batch.data.total))

/* ============================================================
   E. 列表分页与计数
   ============================================================ */
console.log('\n─── E. 列表 / 计数 ───')
const list = (await req('/favorites', { token: me.token })).data
ok(list.favorites.length >= 3, '列表拿到多条', String(list.favorites.length))
ok(list.favorites[0].id > list.favorites[list.favorites.length - 1].id, '新到旧排序')
ok(list.total === q.get('SELECT COUNT(*) n FROM favorites WHERE user_id = ?', me.user.id).n, 'total 与库里一致', String(list.total))
const limited = (await req('/favorites?limit=2', { token: me.token })).data
ok(limited.favorites.length === 2 && limited.hasMore === true, 'limit=2 时有 2 条且 hasMore=true')
const page2 = (await req(`/favorites?limit=2&beforeId=${limited.favorites[1].id}`, { token: me.token })).data
ok(
  page2.favorites.every((f) => f.id < limited.favorites[1].id),
  'beforeId 游标翻页拿到更旧的一批（不重复）'
)

/* 消息出参带 favorited */
const msgs2 = (await req(`/conversations/${group.id}/messages`, { token: me.token })).data.messages
const mm1 = msgs2.find((m) => m.id === g1.id)
ok(mm1?.favorited === true, '会话消息出参里 favorited=true（长按菜单要靠它显示「取消收藏」）')
/* ⚠️ 找「确定没被收藏过」的消息：演示库不是只属于自检的，用户可能在预览里
   随手收藏过群里的某条消息 —— 直接取「非 g1/g2 的第一条」会误伤。
   所以先查库确认它真的没被收藏过，找不到就跳过这条（不是否定功能）。 */
const notFavId = q.get(
  `SELECT m.id FROM messages m
   WHERE m.conversation_id = ? AND m.revoked_at IS NULL AND m.id NOT IN (?, ?)
     AND NOT EXISTS (SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.message_id = m.id)
   ORDER BY m.id DESC LIMIT 1`,
  group.id, g1.id, g2.id, me.user.id
)?.id
const notFav = notFavId ? msgs2.find((m) => m.id === notFavId) : null
if (notFav) ok(notFav.favorited === false, '没收藏的那条 favorited=false', `#${notFav.id}`)
else ok(true, '（群里每条都被收藏过或没有其它消息，跳过 favorited=false 断言）')

/* ============================================================
   F. 浏览器：界面
   ============================================================ */
console.log('\n─── F. 浏览器界面 ───')

const port = await freePort()
const profileDir = path.join('D:/BS-chat-os/.tmp', 'chrome-favorite')
fs.mkdirSync(profileDir, { recursive: true })
const proc = launchChrome({ url: APP, port, profileDir })

const issues = []
const failedResources = []
const target = await waitAppTarget(port, APP_HOST)
const cdp = await connectCdp(target.webSocketDebuggerUrl, (e) => {
  if (e.method === 'Network.responseReceived' && e.params.response.status >= 400) {
    const failedUrl = new URL(e.params.response.url)
    failedUrl.search = ''
    failedResources.push(`${e.params.response.status} ${failedUrl.toString()}`.slice(0, 240))
  }
  if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) {
    issues.push(`${e.params.type}: ${(e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 200))
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
await cdp.send('Network.enable')
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
await cdp.send('Network.clearBrowserCache')
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
window.__openPriv = () => {
  const row = [...document.querySelectorAll('.chat-row')].find(r => (r.querySelector('.cr-name')?.textContent||'').includes('林小夏'))
  if (!row) return false
  row.scrollIntoView({ block:'center' }); row.click(); return true }
/* 长按消息：产品走 useLongPress（真实触摸 480ms / 桌面右键 contextmenu）。
   自检派发 **contextmenu**（等价于桌面右键，也是产品绑的路径之一）——
   触摸路径由 check-longpress 用 Input.dispatchTouchEvent 专门验证
   （那才是「手机上能不能用」的证据；这里只需覆盖菜单逻辑）。
   ⚠️ 本段在 HELP 模板字符串内部，注释里不能出现反引号。 */
window.__longPress = (mid) => {
  const el = document.querySelector('.msg[data-mid="' + mid + '"] .bubble')
    || document.querySelector('.msg[data-mid="' + mid + '"] .msg-col')
    || document.querySelector('.msg[data-mid="' + mid + '"]')
  if (!el) return false
  el.scrollIntoView({ block:'center' })
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true }))
  return true }
window.__menu = () => [...document.querySelectorAll('.menu-item')].map(b => b.textContent.trim())
window.__tapMenu = (label) => {
  const b = [...document.querySelectorAll('.menu-item')].find(x => x.textContent.trim().startsWith(label))
  if (!b) return false
  b.click(); return true }
/* 长按 → 多选模式（PRD §9）：同样走 contextmenu */
window.__enterMulti = (mid) => {
  if (!window.__longPress(mid)) return false
  const b = [...document.querySelectorAll('.menu-item')].find(x2 => x2.textContent.trim().startsWith('多选'))
  if (!b) return false
  b.click(); return true }
window.__multiBar = () => {
  const bar = document.querySelector('.msel-bar'); if (!bar) return null
  return { text: bar.textContent.trim(), count: document.querySelectorAll('.msg.is-selected').length } }
window.__pickMsg = (mid) => {
  const el = document.querySelector('.msg[data-mid="' + mid + '"]')
  if (!el) return false
  el.click(); return true }
window.__multiAct = (label) => {
  const b = [...document.querySelectorAll('.msel-bar button')].find(x => x.textContent.trim().startsWith(label))
  if (!b) return 'missing'
  if (b.disabled) return 'disabled'
  b.click(); return 'ok' }
/* 我页收藏子页 */
window.__meTab = () => { const t=[...document.querySelectorAll('.tabbar .tab')][4]; if(!t) return false; t.click(); return true }
window.__openFav = () => {
  const b = [...document.querySelectorAll('.quick-item')].find(x => x.textContent.trim() === '收藏')
  if (!b) return false
  b.scrollIntoView({ block:'center' }); b.click(); return true }
window.__favRows = () => [...document.querySelectorAll('[data-testid="fav-row"]')].map(r => ({
  id: r.dataset.favId, kind: r.dataset.kind,
  title: r.querySelector('.fav-body b')?.textContent || '',
  sub: r.querySelector('.fav-body em')?.textContent || '' }))
window.__favStat = () => {
  const b = [...document.querySelectorAll('.me-stats button')].find(x => x.textContent.includes('收藏'))
  return b ? b.querySelector('b')?.textContent : null }
window.__favJump = (label) => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(label))
  if (!b) return false
  b.click(); return true }
window.__msgFlash = (mid) => {
  const m = document.querySelector('.msg[data-mid="' + mid + '"]')
  if (!m) return null
  return { flash: m.classList.contains('is-flash'), y: Math.round(m.getBoundingClientRect().top) } }
`
const injectHelp = () => js(HELP)

/**
 * 点长按菜单里的一项，**先等过 ActionMenu 的防误触窗**（450ms）。
 *
 * ⚠️ 这个等待是必须的，不是「为了让测试稳定」的保险。
 * ActionMenu 会给刚弹出的 450ms 加一道 click 防护：长按松手时浏览器会补发一个
 * click，它可能正好落在某个 `.menu-item` 上 —— 不防的话，用户只是长按了一下，
 * 却会「被撤回」或「被取消收藏」。所以菜单项在那 450ms 内**故意不响应**点击。
 * 脚本点得太快就落进这个窗口，表现是「点了没反应 / 没落库」，
 * 而产品行为完全正确（真人不可能 450ms 内看完菜单再点中某一项）。
 *
 * 本轮给长按加防护时就撞过这个：check-favorite 里 10 条断言集体变红，
 * 真因只是「脚本比真人手快」。
 */
const MENU_GUARD_MS = 550
const tapMenu = async (label) => {
  await sleep(MENU_GUARD_MS)
  return js(`window.__tapMenu(${JSON.stringify(label)})`)
}

/* A persistent Chrome profile may hold a token removed by a previous suite. */
await cdp.send('Page.navigate', { url: APP })
await waitFor(`location.origin === ${JSON.stringify(APP_HOST)}`)
await js(`localStorage.removeItem('chatly.token')`)
await cdp.send('Page.reload')

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

if (await js(`!!document.querySelector('.lg-demo-list button')`)) {
  await js(`[...document.querySelectorAll('.lg-demo-list button')].find(x=>x.textContent.includes('陈墨'))?.click()`)
  await waitFor(`!!document.querySelector('.tabbar')`, 15000)
}
await sleep(800)
await injectHelp()

/* ---- 加号面板里不该再有「收藏」 ---- */
await js(`window.__tab(0)`)
await waitFor(`!!document.querySelector('.chat-row')`, 12000)
ok(await js(`window.__openPriv()`), '进入与林小夏的私聊')
await waitFor(`!!document.querySelector('.room')`, 12000)
await js(`(() => { const b=document.querySelector('.cp-btn[aria-label="更多"]'); if(b) b.click(); return !!b })()`)
await waitFor(`!!document.querySelector('.plus-item')`, 8000)
const plusItems = await js(`[...document.querySelectorAll('.plus-item')].map(b => b.textContent.trim())`)
ok(
  !plusItems.some((t) => t.trim().startsWith('收藏')),
  '加号面板里**不再有**「收藏」入口（长按消息就能收藏，那里没有独立意义）',
  JSON.stringify(plusItems)
)
await js(`document.querySelector('.plus-mask')?.click()`)
await sleep(300)

/* ---- 长按消息 → 收藏 ---- */
console.log('\n  · 长按菜单')
const uiMsg = await send(peer.token, priv.id, '自检·界面收藏目标')
ok(await waitFor(`!!document.querySelector('.msg[data-mid="${uiMsg.id}"]')`, 12000), '目标消息出现在聊天里')
ok(await js(`window.__longPress(${uiMsg.id})`), '长按目标消息')
ok(await waitFor(`!!document.querySelector('.menu-item')`, 8000), '弹出长按菜单')
const menu = await js(`window.__menu()`)
ok(menu.includes('收藏'), '★ 长按菜单里有「收藏」', JSON.stringify(menu))
await shoot(cdp, path.join(OUT, '01-menu.png'))

await tapMenu('收藏')
await sleep(900)
const apiFav = q.get('SELECT id FROM favorites WHERE user_id = ? AND message_id = ?', me.user.id, uiMsg.id)
ok(!!apiFav, '★ 点「收藏」后**回库核对**：favorites 里多了一行', apiFav ? `#${apiFav.id}` : '没有')
/* ⚠️ 上一条失败时 apiFav 是 undefined，直接往下查会抛
   `Provided value cannot be bound to SQLite parameter 1` ——
   那个异常会**中断整个脚本**，把后面几十条断言全部埋掉。
   所以这里必须先把「没有」这条分支挡掉，让失败可见但不致命。 */
if (!apiFav) {
  console.log('   ! 收藏没有落库，跳过后续依赖它的断言')
} else {
  ok(
    q.get('SELECT content FROM favorites WHERE id = ?', apiFav.id).content === '自检·界面收藏目标',
    '快照正文正确'
  )
}

/* 再长按 → 应该变成「取消收藏」 */
await sleep(500)
await js(`window.__longPress(${uiMsg.id})`)
await waitFor(`!!document.querySelector('.menu-item')`, 8000)
const menu2 = await js(`window.__menu()`)
ok(menu2.includes('取消收藏'), '★ 已收藏的消息，菜单变成「取消收藏」', JSON.stringify(menu2))
await shoot(cdp, path.join(OUT, '02-menu-faved.png'))

/* 点「取消收藏」→ 回库核对 */
await tapMenu('取消收藏')
await sleep(900)
ok(
  q.get('SELECT COUNT(*) n FROM favorites WHERE user_id = ? AND message_id = ?', me.user.id, uiMsg.id).n === 0,
  '★ 点「取消收藏」后回库核对：那一行真的没了'
)
/* 再收藏回来，后面「我页」要用 */
await js(`window.__longPress(${uiMsg.id})`)
await waitFor(`!!document.querySelector('.menu-item')`, 8000)
await tapMenu('收藏')
await sleep(800)
ok(
  q.get('SELECT COUNT(*) n FROM favorites WHERE user_id = ? AND message_id = ?', me.user.id, uiMsg.id).n === 1,
  '再收藏一次（为后面的我页断言准备数据）'
)

/* ---- 多选模式 ---- */
console.log('\n  · 多选批量收藏（PRD §9）')
const p1 = await send(peer.token, priv.id, '自检·多选甲')
const p2 = await send(peer.token, priv.id, '自检·多选乙')
ok(await waitFor(`!!document.querySelector('.msg[data-mid="${p2.id}"]')`, 12000), '两条多选目标都在聊天里')

/* 进入多选：长按 → 菜单里点「多选」。
   ⚠️ 菜单是异步渲染的（ActionMenu 要等 React 提交），
   `onClick` 里同步去 querySelector 会扑空 —— 必须先等菜单出现。 */
ok(await js(`window.__longPress(${p1.id})`), '长按第一条目标消息')
ok(await waitFor(`!!document.querySelector('.menu-item')`, 8000), '长按菜单弹出')
ok(await tapMenu('多选'), '菜单里有「多选」并点了它')
ok(await waitFor(`!!document.querySelector('.msel-bar')`, 8000), '★ 出现多选工具栏（.msel-bar）')

const bar = await js(`window.__multiBar()`)
ok(!!bar, '读得到多选工具栏状态', JSON.stringify(bar))
ok(bar?.count >= 1, '进入多选时把长按的那条**默认选中**（否则用户还得再点一下）', `已选 ${bar?.count}`)
await js(`window.__pickMsg(${p2.id})`)
await sleep(400)
const bar2 = await js(`window.__multiBar()`)
ok(bar2?.count === 2, '再点一条 → 已选 2 条', `已选 ${bar2?.count}`)
ok(String(bar2?.text || '').includes('2'), '工具栏上显示已选条数', bar2?.text)
await shoot(cdp, path.join(OUT, '03-multi.png'))

const multiAct = await js(`window.__multiAct('收藏')`)
ok(multiAct === 'ok', '多选工具栏里有可点的「收藏」', String(multiAct))
await sleep(1200)
ok(
  q.get('SELECT COUNT(*) n FROM favorites WHERE message_id IN (?,?)', p1.id, p2.id).n === 2,
  '★ 多选批量收藏后回库核对：两条都在库里'
)
ok(await waitFor(`!document.querySelector('.msel-bar')`, 8000), '操作完成后退出多选模式')

/* ---- 我页：真实收藏 ---- */
console.log('\n  · 我页收藏子页')
/* ⚠️ 返回按钮的类名是 `.rh-back`（Header 里的），不是 `.room-back`。
   写错的话 `?.click()` 静默不生效，人就还留在聊天室里 ——
   后面「找不到 quick-item」会一路红下去，而真因只是这一个选择器写错了。 */
ok(await waitFor(`!!document.querySelector('.rh-back')`, 8000), '聊天室左上角有返回按钮')
await js(`document.querySelector('.rh-back').click()`)
ok(await waitFor(`!!document.querySelector('.tabbar')`, 8000), '返回到主界面（Tab 栏出现）')
await js(`window.__meTab()`)
ok(await waitFor(`!!document.querySelector('.quick-item')`, 10000), '打开「我」页')
await injectHelp()
const statBefore = await js(`window.__favStat()`)
const realCount = q.get('SELECT COUNT(*) n FROM favorites WHERE user_id = ?', me.user.id).n
ok(
  String(statBefore) === String(realCount),
  '★ 我页统计条的收藏数是**真数**（不是 mock 数组长度）',
  `界面 ${statBefore} / 库里 ${realCount}`
)
ok(await js(`window.__openFav()`), '打开「我的收藏」')
ok(await waitFor(`!!document.querySelector('[data-testid="fav-row"]')`, 10000), '收藏列表渲染出条目')
const rows = await js(`window.__favRows()`)
ok(rows.length > 0, '列表里有条目', `${rows.length} 条`)
ok(
  rows.some((r) => r.title.includes('自检·界面收藏目标')),
  '★ 列表里能看到刚收藏的那条（读的是真数据）',
  JSON.stringify(rows.slice(0, 3))
)
ok(
  !rows.some((r) => r.title.includes('海边日落摄影局')),
  '不再出现 mock 里的假数据（「海边日落摄影局 · 活动」）'
)
await shoot(cdp, path.join(OUT, '04-my-favorites.png'))

/* ---- 在聊天中查看 ---- */
console.log('\n  · 在聊天中查看')
/* ⚠️ 不能按 `apiFav.id` 定位：中间做过一次「取消收藏 → 再收藏」，
   那会**生成新的 favorites 行**（id 变了），旧 id 在列表里已经不存在。
   收藏行的定位应该以**消息**为准 —— 那才是用户眼里的「同一条」。 */
const favRowId = q.get(
  'SELECT id FROM favorites WHERE user_id = ? AND message_id = ?',
  me.user.id,
  uiMsg.id
)?.id
ok(!!favRowId, '刚收藏的那条在库里能找到', favRowId ? `fav#${favRowId}` : '没有')
const jumpSel = `[data-fav-id="${favRowId}"] [data-testid="fav-jump"]`
const hasJump = await js(`!!document.querySelector('${jumpSel}')`)
ok(hasJump === true, '刚收藏的那条上有「在聊天中查看」按钮', `fav#${favRowId}`)
if (hasJump) {
  await js(`document.querySelector('${jumpSel}').click()`)
  ok(await waitFor(`!!document.querySelector('.room')`, 10000), '跳转后回到了聊天室')
  ok(await waitFor(`window.__msgFlash(${uiMsg.id}) !== null`, 8000), '目标消息在视野里')
  const flash = await js(`window.__msgFlash(${uiMsg.id})`)
  ok(flash?.flash === true, '★ 目标消息被高亮（用户知道「就是这条」）', JSON.stringify(flash))
  await shoot(cdp, path.join(OUT, '05-jumped.png'))
}

/* ---- 控制台 ---- */
const realIssues = [...issues, ...failedResources].filter((t) => !/favicon|Download the React DevTools/i.test(t))
ok(realIssues.length === 0, '浏览器控制台无报错 / 无非法嵌套告警', realIssues.slice(0, 3).join(' | '))

try {
  proc.kill()
} catch {}

/* ============================================================
   收尾：按基线清理
   ============================================================ */
console.log('\n─── 收尾 ───')
const favRows = q.get('SELECT COUNT(*) n FROM favorites WHERE id > ?', favBaseline).n
db.prepare('DELETE FROM favorites WHERE id > ?').run(favBaseline)
q.run('DELETE FROM messages WHERE id > ?', msgBaseline)
await purgeDebris({ quiet: true })
/* ⚠️ 顺序：先清消息/收藏，再回收文件 —— 反过来的话刚发的图还被指着，扫不到 */
const reclaimed = await purgeOrphanUploads({ quiet: true })
if (reclaimed.moved) console.log(`  回收 ${reclaimed.moved} 个无引用文件`)

ok(
  q.get('SELECT COUNT(*) n FROM favorites').n === favCountBefore,
  `收藏数回到基线（${favCountBefore}）`,
  `现在 ${q.get('SELECT COUNT(*) n FROM favorites').n}，本轮清了 ${favRows} 条`
)
ok(
  q.get('SELECT COUNT(*) n FROM messages').n === msgCountBefore,
  `消息数回到基线（${msgCountBefore}）`,
  `现在 ${q.get('SELECT COUNT(*) n FROM messages').n}`
)
ok(
  q.get('SELECT COUNT(*) n FROM favorites WHERE id <= ?', favBaseline).n === favCountBefore,
  '原有的收藏一条没动'
)
ok(
  q.get("SELECT COUNT(*) n FROM favorites WHERE message_id IS NOT NULL AND message_id NOT IN (SELECT id FROM messages)").n === 0,
  '没有留下指向已删消息的收藏（message_id 该被 SET NULL）'
)
ok(db.prepare('PRAGMA foreign_key_check').all().length === 0, '外键无断裂')

console.log(`\n${failures === 0 ? '✅ 收藏自检全部通过' : '❌ 有失败项'} —— ${pass} 通过 / ${failures} 失败`)
console.log(`截图：${path.relative('D:/BS-chat-os', OUT)}\n`)
process.exit(failures ? 1 : 0)




