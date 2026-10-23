/**
 * 发现页专项自检
 *
 * 这一页上一版**每一块都是假的**：热门动态点了弹「打开：xxx」、活动报名弹「已报名」、
 * 附近的人「打招呼」弹「向 X 打招呼」。界面看着很热闹，一样都不落地。
 * 所以这个脚本的重点不是「元素在不在」，而是**每一次点击有没有真的改变库里的东西**：
 *
 *   1. 关注 → 回后端查 `follows` 表，再取关，确认回到原状态。
 *   2. 加入群 → 回后端查 `conversation_members`，确认多了一行，再退出还原。
 *   3. 打招呼 → 必须是**真的进了聊天房间**（`.room` 出现、抬头是对方昵称），
 *      只弹一句 toast 的话这里会红。
 *   4. 标签筛选 → 结果集**真的变了**，且和服务端 `?tag=` 的结果**逐 id 相同**
 *      （前端自己 filter 会因分页漏人，所以筛选必须在服务端做）。
 *   5. 附近的人 → 只有双方主动授权城市分享后才允许展示行政区划中心点估算距离。
 *   6. 活动 / 话题 → 接口有真实数据形状，发现页入口可打开，不留禁用占位。
 *
 * ⚠️ **前提要自己造，不能假设演示库是干净的**。
 *    发现页上就有「关注 / 加入」按钮，用户会在预览里随手点：他关注一圈、
 *    把公开群都加完，脚本就会崩在「找不到未关注的人」「groups[0] 是 undefined」上，
 *    或者更糟 —— 报出一个方向完全错误的结论。所以：
 *      · 关注测试对象先归一到「未关注」，收尾还原；
 *      · 加入群测试**现造一个公开群**；
 *      · 打招呼对象从库里现查「本来就和他有私聊」的人。
 *
 * 跑法：node scripts/check-discover.mjs
 */
import fs from 'node:fs'

import { db } from '../server/src/db.js'
import { freePort, waitAppTarget, connectCdp, launchChrome, shoot } from './lib/cdp.mjs'
import { purgeDebris } from './lib/debris.mjs'
import { ensureLoggedIn } from './lib/session.mjs'

const API = 'http://127.0.0.1:3002/api/v1'
const APP_HOST = 'http://127.0.0.1:5198'
const APP = APP_HOST + '/'
const OUT = 'D:/BS-chat-os/shots/discover'
const PASS = 'chatly123'

/** 标签筛选用它 —— 作者自己的标签之一，且命中人数明显少于全量 */
const TAG = '摄影'

fs.mkdirSync(OUT, { recursive: true })

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let featureMomentId = null
let featureTopic = null

/* ================= 后端 ================= */
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
  return { status: r.status, d }
}

/** 直接查库 —— 「关注真的落库了吗」只有这一条能证伪，接口自己说 true 不算 */
const dbFollows = (a, b) =>
  !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(a, b)
const dbIsMember = (cid, uid) =>
  !!db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(cid, uid)

const me = await login('chenmo')
await purgeDebris({ quiet: true })
const baseConvs = db.prepare('SELECT id, updated_at FROM conversations').all()

/**
 * 「打招呼」的测试对象：必须挑一个**本来就有私聊**的人 ——
 * 否则点一下就会在库里新建一条私聊会话（演示库里多出一条谁也没说过的对话）。
 * 而且不能写死是谁：用户侧的「删除会话」语义是退出自己，他退过之后就没这条私聊了，
 * 写死的对象会让这一步失败在一个和发现页无关的原因上。所以从库里现查。
 */
const sayUser = db
  .prepare(
    `SELECT u.id, u.nickname FROM users u
      WHERE u.id != ?
        AND EXISTS (
          SELECT 1 FROM conversations c
            JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
            JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = u.id
           WHERE c.type = 'private'
        )
      ORDER BY u.id LIMIT 1`
  )
  .get(me.user.id, me.user.id)
if (!sayUser) throw new Error(`演示库里没有和 ${me.user.nickname} 有私聊的用户，先跑 node server/src/seed.js`)

console.log(`自检开始（我是 ${me.user.nickname}，打招呼对象 ${sayUser.nickname}）\n`)

/* ============ 一、后端：这三条是「没编数据」的底线 ============ */
console.log('─── 后端：数据是不是真的 ───')

const rec = (await j('GET', '/discover/recommend?limit=50', null, me.auth)).d
ok(Array.isArray(rec.users) && rec.users.length > 0, '推荐列表非空', `${rec.users.length} 人`)
ok(!rec.users.some((u) => u.id === me.user.id), '推荐列表里没有我自己')

/* 排序：没关注的必须排在已关注的**前面** —— 否则「推荐」等于把熟人重列一遍。
   第一版就漏了这个，两个共同群聊的熟人一直顶在最前。 */
const firstFollowed = rec.users.findIndex((u) => u.following)
const lastUnfollowed = rec.users.map((u) => !!u.following).lastIndexOf(false)
ok(
  firstFollowed === -1 || lastUnfollowed < firstFollowed,
  '★ 已关注的人排在未关注的人后面（推荐的意义是发现新人）',
  `首个已关注 idx=${firstFollowed} / 末个未关注 idx=${lastUnfollowed}`
)

/* 推荐理由必须可解释：库里只可能有这四种来源 */
const REASON = /^(和你在 \d+ 个群里|有 \d+ 个共同兴趣|和你同城|和你同省)$/
ok(
  rec.users.every((u) => u.reason === null || REASON.test(u.reason)),
  '推荐理由只由「共同群聊 / 共同兴趣 / 同城」算出来，算不出给 null',
  JSON.stringify([...new Set(rec.users.map((u) => u.reason))])
)
ok(
  !rec.users.some((u) => /可能认识|猜你|推荐好友/.test(String(u.reason || ''))),
  '没有「可能认识」这类无法证伪的话'
)
/* reason 的每一句都要能被字段验回去 —— 不能出现「有 2 个共同兴趣」而 mutualTags 是 0 */
ok(
  rec.users.every(
    (u) =>
      !u.reason ||
      (u.reason.includes('共同兴趣') ? u.mutualTags > 0 : true) &&
        (u.reason.includes('个群里') ? u.mutualGroups > 0 : true) &&
        (u.reason === '和你同城' ? u.sameRegion === true : true)
  ),
  '每个理由都能被 mutualGroups / mutualTags / sameRegion 字段验回去'
)

/* 标签筛选：结果集要真的变，且命中的人**都带这个标签** */
const tagged = (await j('GET', `/discover/recommend?tag=${encodeURIComponent(TAG)}&limit=50`, null, me.auth)).d
const idAll = rec.users.map((u) => u.id).sort((a, b) => a - b)
const idTag = tagged.users.map((u) => u.id).sort((a, b) => a - b)
ok(tagged.users.length > 0, `按「${TAG}」筛出人来`, `${tagged.users.length} 人`)
ok(
  JSON.stringify(idAll) !== JSON.stringify(idTag),
  '★ 筛选真的改变了结果集（不是把同一批数据换个壳）',
  `${idAll.length} 人 → ${idTag.length} 人`
)
ok(
  tagged.users.every((u) => (u.tags || []).includes(TAG)),
  `筛出来的每个人都有「${TAG}」标签`,
  JSON.stringify(tagged.users.map((u) => u.tags))
)
/* 后端必须真的过滤，而不是「全量返回 + 前端丢弃」—— 拿库里的命中数对一遍 */
const tagInDb = db
  .prepare(`SELECT COUNT(*) AS n FROM users WHERE id != ? AND tags LIKE ?`)
  .get(me.user.id, `%"${TAG}"%`).n
ok(tagged.users.length === tagInDb, '筛出的人数 = 库里带该标签的人数（服务端过滤，没漏没多）', `${tagged.users.length} / ${tagInDb}`)

/* 附近的人：不许有公里数 */
const nb = (await j('GET', '/discover/nearby?limit=50', null, me.auth)).d
ok(Array.isArray(nb.users) && nb.users.length > 0, '附近的人非空', `${nb.users.length} 人`)
ok(!!nb.myRegion, '返回我的地区（基准得说出来）', String(nb.myRegion))
ok(
  nb.users.every((u) => /^(同城|同省|.+)$/.test(String(u.distanceLabel || ''))),
  '每个人都给了距离标签',
  JSON.stringify([...new Set(nb.users.map((u) => u.distanceLabel))])
)
if (!nb.myGeo) {
  ok(!nb.users.some((u) => /\d/.test(String(u.distanceLabel || ''))), '未授权时距离标签不出现公里数')
  const myLocation = db.prepare('SELECT city_public AS cityPublic, city_lat AS lat, city_lng AS lng FROM users WHERE id = ?').get(me.user.id)
  if (!Number(myLocation.cityPublic)) ok(myLocation.lat == null && myLocation.lng == null, '关闭附近分享时数据库不保留城市坐标')
} else {
  ok(nb.users.every((u) => !/\d/.test(String(u.distanceLabel || '')) || u.distanceBasis === 'city-center'), '出现公里数时有城市中心点依据')
}
ok(
  nb.users.every((u) => [0, 1, 2].includes(u.near)),
  'near 只可能是 0 / 1 / 2（其它 / 同省 / 同城）',
  JSON.stringify([...new Set(nb.users.map((u) => u.near))])
)
const nearSeq = nb.users.map((u) => u.near)
ok(
  nearSeq.every((v, i) => i === 0 || nearSeq[i - 1] >= v),
  '★ 按「同城 → 同省 → 其它」降序排（同城的排最前）',
  JSON.stringify(nearSeq)
)
ok(
  nb.users.every((u) => (u.near === 2 ? u.distanceLabel === '同城' : true)),
  'near=2 的人标签就是「同城」',
  JSON.stringify(nb.users.filter((u) => u.near === 2).map((u) => u.distanceLabel))
)

/* 兴趣标签是**聚合**出来的，不是写死那十个 */
const tagRes = (await j('GET', '/discover/tags', null, me.auth)).d
ok(Array.isArray(tagRes.tags) && tagRes.tags.length > 0, '兴趣标签非空', `${tagRes.tags.length} 个`)
const dbTagCount = (t) => db.prepare(`SELECT COUNT(*) AS n FROM users WHERE tags LIKE ?`).get(`%"${t}"%`).n
ok(
  tagRes.tags.every((t) => t.count === dbTagCount(t.tag)),
  '每个标签的人数 = 库里真填了这个标签的人数',
  JSON.stringify(tagRes.tags.slice(0, 4).map((t) => `${t.tag}:${t.count}`))
)

featureTopic = `自检话题${Date.now()}`
const featurePost = await j('POST', '/moments', {
  content: '发现页活动与话题回归数据',
  topic: featureTopic,
  visibility: 'public',
  card: { kind: 'activity', data: { title: '发现页自检活动', startsAt: Date.now() + 3 * 60 * 60 * 1000, location: '自检地点', description: '仅用于回归，结束后自动清理。' } },
}, me.auth)
featureMomentId = featurePost.d?.id || null
ok(featurePost.status === 201 && featureMomentId, '活动动态可发布并返回真实记录')

const activityRes = await j('GET', '/discover/activities?limit=30', null, me.auth)
ok(activityRes.status === 200 && Array.isArray(activityRes.d.activities), '活动接口返回当前用户有权访问的活动数组')
ok((activityRes.d.activities || []).some((m) => m.id === featureMomentId && m.card?.kind === 'activity' && m.card.data?.startsAt > Date.now()), '活动列表包含本人可见的未开始活动卡片')
const rsvp = await j('POST', `/moments/${featureMomentId}/activity-rsvp`, { status: 'going' }, me.auth)
ok(rsvp.status === 200 && rsvp.d.card?.myStatus === 'going', '活动报名状态写入并回读')
const rsvpRow = db.prepare('SELECT status FROM moment_card_rsvps WHERE moment_id = ? AND user_id = ?').get(featureMomentId, me.user.id)
ok(rsvpRow?.status === 'going', '报名记录真实写入 moment_card_rsvps')
const cancelRsvp = await j('POST', `/moments/${featureMomentId}/activity-rsvp`, { status: null }, me.auth)
ok(cancelRsvp.status === 200 && !db.prepare('SELECT 1 FROM moment_card_rsvps WHERE moment_id = ? AND user_id = ?').get(featureMomentId, me.user.id), '取消报名会删除本人报名记录')

const topicRes = await j('GET', '/discover/topics', null, me.auth)
ok(topicRes.status === 200 && Array.isArray(topicRes.d.topics), '热门话题接口返回真实聚合结果')
const featureTopicRow = topicRes.d.topics?.find((t) => t.topic === featureTopic)
ok(featureTopicRow?.momentCount === 1 && featureTopicRow.viewerCount === 0, '话题榜聚合公开动态且初始浏览人数为零', JSON.stringify(featureTopicRow))
const viewedTopic = await j('POST', `/discover/topics/${encodeURIComponent(featureTopic)}/view`, {}, me.auth)
ok(viewedTopic.status === 200, '打开话题成功记录浏览行为')
const topicMoments = await j('GET', `/discover/topics/${encodeURIComponent(featureTopic)}/moments`, null, me.auth)
ok(topicMoments.status === 200 && topicMoments.d.moments?.some((m) => m.id === featureMomentId), '话题详情只返回有权限查看的对应动态')
const rankedAgain = await j('GET', '/discover/topics', null, me.auth)
ok(rankedAgain.d.topics?.find((t) => t.topic === featureTopic)?.viewerCount === 1, '话题浏览人数按用户去重计数')
ok(
  tagRes.tags.filter((t) => !t.mine).every((t, i, a) => i === 0 || a[i - 1].count >= t.count),
  '非我标签按人数降序'
)
ok(
  tagRes.tags.every((t, i) => (i === 0 ? true : !(tagRes.tags[i - 1].mine === false && t.mine === true))),
  '我自己填的标签排在最前面',
  JSON.stringify(tagRes.tags.filter((t) => t.mine).map((t) => t.tag))
)

/* ---------- 可加入的群 ----------
   「公开」是 `conversations.discoverable` 这一列：不加的话，把「设计部」这种工作群
   也列进发现页就变成了把别人的私人群公开挂牌。
   ⚠️ 测试对象**现造一个**：种子里的兴趣群用户自己会点「加入」（按钮就在那儿），
      他加完之后 `/discover/groups` 就是空的，自检会崩在 `groups[0]` 上。
      换个账号当群主（陈墨不能在自己建的群里测「加入」），标题带「自检·」前缀留给 purgeDebris。 */
const host = await login('shenxu')
const mate = await login('wenyan')
const made = await j(
  'POST',
  '/conversations',
  { type: 'group', title: `自检·发现页群-${Date.now()}`, memberIds: [mate.user.id] },
  host.auth
)
const TEMP_GROUP = made.d?.conversationId
if (!TEMP_GROUP) throw new Error(`建临时群失败：${JSON.stringify(made.d)}`)
/* 没有「设为公开」的接口 —— 这是数据层的一个开关，自检直接写库，收尾跟群一起清掉 */
db.prepare('UPDATE conversations SET discoverable = 1 WHERE id = ?').run(TEMP_GROUP)

let gs = (await j('GET', '/discover/groups', null, me.auth)).d
ok(Array.isArray(gs.groups), '群列表返回数组')
ok(gs.groups.some((g) => g.id === TEMP_GROUP), '★ 公开群的 id 出现在「可加入」列表里', `#${TEMP_GROUP}`)
ok(gs.groups.every((g) => dbIsMember(g.id, me.user.id) === false), '列表里没有我已经在的群')

const openIds = db.prepare(`SELECT id FROM conversations WHERE type='group' AND discoverable=1`).all().map((r) => r.id)
const closedIds = db.prepare(`SELECT id FROM conversations WHERE type='group' AND discoverable=0`).all().map((r) => r.id)
ok(gs.groups.every((g) => openIds.includes(g.id)), '★ 列出的都是 `discoverable=1` 的公开群', JSON.stringify(gs.groups.map((g) => g.id)))
ok(
  !gs.groups.some((g) => closedIds.includes(g.id)),
  '★ 未公开的群一个都没露出来（「设计部」这种工作群不能被挂牌）',
  `库里非公开群 ${JSON.stringify(closedIds)}`
)
ok(
  gs.groups.every((g) => g.memberCount > 0),
  '每个群都带真实成员数',
  JSON.stringify(gs.groups.map((g) => `${g.title}:${g.memberCount}`))
)

/* 加入的权限边界 —— 这三条是「不越权」的证据 */
const privateJoin = await j('POST', `/discover/groups/${closedIds[0]}/join`, null, me.auth)
ok(privateJoin.status === 403, '★ 加入未公开的群 → 403（不是「知道 id 就能进」）', `${privateJoin.status} ${privateJoin.d?.error || ''}`)
const ghostJoin = await j('POST', '/discover/groups/999999/join', null, me.auth)
ok(ghostJoin.status === 404, '加入不存在的群 → 404', String(ghostJoin.status))
const privConv = db.prepare(`SELECT id FROM conversations WHERE type='private' LIMIT 1`).get().id
const convJoin = await j('POST', `/discover/groups/${privConv}/join`, null, me.auth)
ok(convJoin.status === 400, '加入一个私聊会话 → 400（它不是群）', `${convJoin.status} ${convJoin.d?.error || ''}`)

/* 关注测试的对象：挑一个候选并**归一到「未关注」**，记下原状收尾还原。
   库里谁没被关注是用户能改的 —— 他随手关注一圈，写死的对象就全绿不了。 */
const followTarget = rec.users.find((u) => !u.following) || rec.users[0]
const followTargetHadEdge = dbFollows(me.user.id, followTarget.id)
if (followTargetHadEdge) await j('DELETE', `/users/${followTarget.id}/follow`, null, me.auth)
ok(
  dbFollows(me.user.id, followTarget.id) === false,
  `关注测试对象 ${followTarget.nickname} 已归一到「未关注」`,
  followTargetHadEdge ? '（原来关注过，收尾会还原）' : '（本来就没关注）'
)

/* ================= 浏览器 ================= */
const port = await freePort()
const profileDir = 'D:/BS-chat-os/.tmp/chrome-discover'
fs.mkdirSync(profileDir, { recursive: true })
const proc = launchChrome({ url: APP, port, profileDir })
const target = await waitAppTarget(port, APP_HOST)
const issues = []
const cdp = await connectCdp(target.webSocketDebuggerUrl, (e) => {
  if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) {
    const text = (e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    issues.push(`${e.params.type}: ${text}`.slice(0, 200))
  }
  if (e.method === 'Runtime.exceptionThrown') {
    issues.push('exception: ' + (e.params.exceptionDetails?.exception?.description || '').slice(0, 200))
  }
  if (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)) {
    issues.push(`${e.params.entry.level}: ${e.params.entry.text}`.slice(0, 200))
  }
})
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('DOM.enable')
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
      /* 换 context 时会抛，等下一轮 */
    }
    await sleep(250)
  }
  return false
}

/**
 * 真实鼠标事件。
 * ⚠️ 必须先 `scrollIntoView`：`Input.dispatchMouseEvent` 用的是**视口坐标**，
 * 发现页是一长条滚动列表，直接按 rect 派发会点到别的卡片上（甚至点出屏幕）。
 */
const tapAt = async (sel, fx = 0.5, fy = 0.5) => {
  const seen = await js(
    `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false
      e.scrollIntoView({ block: 'center' }); return true })()`
  )
  if (!seen) return false
  await sleep(350)
  const box = await js(
    `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null
      const r=e.getBoundingClientRect(); return { x: r.left + r.width*${fx}, y: r.top + r.height*${fy} } })()`
  )
  if (!box) return false
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 })
  return true
}

const HELP = `
window.__tab = (label) => { const t=[...document.querySelectorAll('.tabbar .tab')].find(x=>x.textContent.includes(label)); if(!t) return false; t.click(); return true }
/* 分段切换 */
window.__seg = (label) => { const c=[...document.querySelectorAll('.disc-segs .chip')].find(x=>x.textContent.trim()===label); if(!c) return false; c.click(); return true }
/* 标签云里点某个标签 */
window.__tag = (t) => { const c=[...document.querySelectorAll('.tag-cloud .chip')].find(x=>x.textContent.trim().startsWith(t)); if(!c) return false; c.click(); return true }
/* 发现页快照 —— 全部从渲染出来的 DOM 读，不读 store（读 store 等于自己验算自己） */
window.__disc = () => ({
  segs: [...document.querySelectorAll('.disc-segs .chip')].map(e=>e.textContent.trim()),
  activeSeg: (document.querySelector('.disc-segs .chip.is-active')||{}).textContent?.trim() || null,
  chips: [...document.querySelectorAll('.tag-cloud .chip')].map(e=>e.textContent.trim()),
  rows: [...document.querySelectorAll('.rc-row')].map(e=>({
    id: +e.dataset.id,
    name: e.querySelector('.rc-meta b')?.textContent.trim().replace(/已关注$/,'') || null,
    reason: e.querySelector('.rc-meta em')?.textContent.trim() || null,
    tags: [...e.querySelectorAll('.rc-tags span')].map(s=>s.textContent.trim()),
    follow: e.querySelector('.rc-follow')?.textContent.trim() || null,
    pressed: e.querySelector('.rc-follow')?.getAttribute('aria-pressed') || null,
  })),
  nearby: [...document.querySelectorAll('.nb-card')].map(e=>({
    id: +e.dataset.id,
    name: e.querySelector('.nb-meta b')?.textContent.trim() || null,
    dist: e.querySelector('.nb-dist')?.textContent.trim() || null,
    basis: e.dataset.distanceBasis || null,
    same: !!e.querySelector('.nb-dist.is-same'),
    say: !!e.querySelector('.nb-btn--primary'),
  })),
  groups: [...document.querySelectorAll('.ig-card')].map(e=>({
    id: +e.dataset.id,
    title: e.querySelector('.ig-body b')?.textContent.trim() || null,
    meta: e.querySelector('.ig-body em')?.textContent.trim() || null,
  })),
  hot: [...document.querySelectorAll('.hot-row')].map(e=>({
    text: e.querySelector('.hot-body b')?.textContent.trim() || null,
    by: e.querySelector('.hot-body em')?.textContent.trim() || null,
    heat: e.querySelector('.hot-heat')?.textContent.trim() || null,
  })),
  activityCards: [...document.querySelectorAll('.da-card')].map(e=>({id:+e.dataset.id, title:e.querySelector('h3')?.textContent.trim() || null, actions:e.querySelectorAll('.da-actions button').length})),
  topicRows: [...document.querySelectorAll('.dt-row')].map(e=>e.querySelector('strong')?.textContent.trim() || null),
  filterChip: document.querySelector('.dg-filter .chip')?.textContent.trim() || null,
  hint: [...document.querySelectorAll('.disc-hint')].map(e=>e.textContent.trim()),
  room: !!document.querySelector('.room'),
  roomTitle: document.querySelector('.room-head .rh-name b')?.textContent.trim() || null,
  detail: !!document.querySelector('.md-root'),
  toast: document.querySelector('.toast')?.textContent.trim() || null,
})
`

let joinedGroupId = null

try {
  await js(HELP)
  const up = await waitFor(`!!document.querySelector('.lg-card, .login, .tabbar')`, 30000)
  if (!up) throw new Error('应用没挂载')
  await ensureLoggedIn(js)
  await waitFor(`!!document.querySelector('.tabbar')`, 15000)
  await sleep(700)
  await js(HELP)
  await js(`window.__tab('发现')`)
  ok(await waitFor(`!!document.querySelector('.disc-segs')`, 12000), '进入发现页')
  /* 「推荐」分段里渲染的是标签云 + 热门动态，`.rc-row` 只属于「用户」分段 ——
     在这里等 `.rc-row` 会一直等到超时（第一版就是这么误报的）。 */
  ok(
    await waitFor(
      `document.querySelectorAll('.tag-cloud .chip').length > 0 && document.querySelectorAll('.hot-row').length > 0`,
      15000
    ),
    '推荐分段的标签云与热门动态都加载出来'
  )
  await js(HELP)
  await sleep(400)

  let d = await js(`window.__disc()`)

  /* ---------- 分段 ---------- */
  console.log('\n─── 分段与结构 ───')
  ok(JSON.stringify(d.segs) === JSON.stringify(['推荐', '附近', '活动', '话题', '群组', '用户']), '六个分段齐全', JSON.stringify(d.segs))
  ok(d.activeSeg === '推荐', '默认停在「推荐」', String(d.activeSeg))
  ok(d.chips.length === tagRes.tags.length, '标签云渲染的标签数 = 后端聚合数', `${d.chips.length} / ${tagRes.tags.length}`)
  ok(
    d.chips.every((c) => {
      const [name, n] = c.split(/\s+/)
      const hit = tagRes.tags.find((t) => t.tag === name)
      return hit && Number(n) === hit.count
    }),
    '每个标签后面的人数与后端一致（不是写死的数字）',
    JSON.stringify(d.chips.slice(0, 4))
  )
  await shoot(cdp, `${OUT}/01-recommend.png`)

  /* ---------- 热门动态：真数据 ---------- */
  console.log('\n─── 热门动态（必须是真的） ───')
  const hotApi = (await j('GET', '/moments?scope=hot&limit=10', null, me.auth)).d.moments || []
  ok(d.hot.length === hotApi.length, '热门动态条数 = 后端返回条数', `${d.hot.length} / ${hotApi.length}`)
  ok(d.hot.length > 0, '热门动态非空')
  ok(
    d.hot.every((h) => {
      const m = hotApi.find((x) => (x.content || '').startsWith((h.text || '').slice(0, 12)))
      return !m || Number((h.heat || '').replace(/\D/g, '')) === Number(m.likeCount || 0)
    }),
    '每条右侧的赞数与后端 likeCount 一致',
    JSON.stringify(d.hot.map((h) => h.heat))
  )
  /* 点第一条 —— 必须进详情页，而不是弹一句「打开：xxx」 */
  await tapAt('.hot-row')
  ok(await waitFor(`!!document.querySelector('.md-root')`, 10000), '★ 点热门动态进的是**详情页**（不是弹一句 toast 假装打开）')
  ok((await js(`document.querySelector('.toast')?.textContent || ''`)) === '', '点热门动态没有弹 toast')
  await shoot(cdp, `${OUT}/02-hot-detail.png`)
  await js(`document.querySelector('.md-back')?.click()`)
  ok(await waitFor(`!document.querySelector('.md-root')`, 8000), '从详情页返回')
  await js(HELP)

  /* ---------- 活动与话题入口 ---------- */
  console.log('\n─── 活动与话题入口 ───')
  d = await js(`window.__disc()`)
  ok(d.segs.includes('活动') && d.segs.includes('话题'), '发现页提供活动与话题入口', JSON.stringify(d.segs))
  await js(`window.__seg('活动')`)
  await sleep(250)
  ok(await js(`!!document.querySelector('.da-list') || !!document.querySelector('.disc-block .empty') || !!document.querySelector('.dg-muted')`), '活动分段打开并显示列表或空态')
  ok(await js(`!!document.querySelector('.da-card[data-id="${featureMomentId}"] .da-actions .is-primary')`), '活动卡片提供可用的「我要参加」按钮')
  await tapAt(`.da-card[data-id="${featureMomentId}"] .da-actions .is-primary`)
  await sleep(700)
  ok(db.prepare('SELECT status FROM moment_card_rsvps WHERE moment_id = ? AND user_id = ?').get(featureMomentId, me.user.id)?.status === 'going', '界面报名按钮真实写入报名表')
  await js(`window.__seg('话题')`)
  await sleep(250)
  ok(await js(`!!document.querySelector('.dt-list') || !!document.querySelector('.empty')`), '话题分段打开并显示榜单或空态')
  await js(`(() => { const b=[...document.querySelectorAll('.dt-row')].find(x=>x.textContent.includes(${JSON.stringify(featureTopic)})); b?.click(); return !!b })()`)
  ok(await waitFor(`!!document.querySelector('.dt-moments')`, 10000), '打开热门话题后显示对应动态')

  /* ---------- 用户分段：关注真的落库 ---------- */
  console.log('\n─── 关注：真的写进 follows ───')
  await js(`window.__seg('用户')`)
  await waitFor(`!!document.querySelector('.rc-row')`, 10000)
  await sleep(400)
  await js(HELP)
  d = await js(`window.__disc()`)
  const target0 = d.rows.find((r) => r.id === followTarget.id)
  ok(!!target0 && target0.follow === '关注', `${followTarget.nickname} 在界面上是「未关注」态`, JSON.stringify(target0))
  ok(target0?.pressed === 'false', '按钮 aria-pressed=false')

  await tapAt(`.rc-row[data-id="${followTarget.id}"] .rc-follow`)
  await sleep(800)
  let after = await js(`window.__disc()`)
  const t1 = after.rows.find((r) => r.id === followTarget.id)
  ok(t1?.follow === '已关注', '★ 按钮文案变成「已关注」', String(t1?.follow))
  ok(t1?.pressed === 'true', '★ aria-pressed 变成 true（无障碍状态同步了）', String(t1?.pressed))
  ok(dbFollows(me.user.id, followTarget.id) === true, '★ 库里 `follows` 真的多了一行（不是只有界面变）', `${me.user.id} → ${followTarget.id}`)
  const viaApi = (await j('GET', `/users/${followTarget.id}`, null, me.auth)).d
  ok(viaApi?.following === true, '接口复查 following=true（别是「数量」冒充的）', JSON.stringify(viaApi?.following))
  await shoot(cdp, `${OUT}/03-followed.png`)

  /* 取关 —— 回到「未关注」 */
  await tapAt(`.rc-row[data-id="${followTarget.id}"] .rc-follow`)
  await sleep(800)
  after = await js(`window.__disc()`)
  ok(after.rows.find((r) => r.id === followTarget.id)?.follow === '关注', '★ 再点一次变回「关注」')
  ok(dbFollows(me.user.id, followTarget.id) === false, '★ 库里 `follows` 那行也删掉了（取关不是只改文案）')
  ok(
    after.rows.some((r) => r.reason && /个群里|共同兴趣|同城|同省/.test(r.reason)),
    '推荐理由在界面上显示出来了',
    JSON.stringify(after.rows.slice(0, 3).map((r) => r.reason))
  )

  /* ---------- 标签筛选：结果集真的变 ---------- */
  console.log('\n─── 标签筛选 ───')
  await js(`window.__seg('推荐')`)
  await sleep(300)
  await js(`window.__tag(${JSON.stringify(TAG)})`)
  ok(await waitFor(`!!document.querySelector('.dg-filter')`, 10000), `点「${TAG}」后出现筛选标记`)
  ok(
    await waitFor(
      `!!document.querySelector('.disc-segs .chip.is-active') && document.querySelector('.disc-segs .chip.is-active').textContent.trim() === '用户'`,
      6000
    ),
    '筛选后自动切到「用户」分段（不是留在原地让人找不到结果）'
  )
  await sleep(600)
  await js(HELP)
  d = await js(`window.__disc()`)
  ok(d.filterChip?.startsWith(TAG), '筛选标记显示当前标签，可点击取消', String(d.filterChip))
  const domTagIds = d.rows.map((r) => r.id).sort((a, b) => a - b)
  ok(
    JSON.stringify(domTagIds) === JSON.stringify(idTag),
    '★ 界面上的结果集与后端 `?tag=` 的结果**逐 id 相同**（筛选是在服务端做的）',
    `${JSON.stringify(domTagIds)} vs ${JSON.stringify(idTag)}`
  )
  ok(d.rows.every((r) => r.tags.includes(TAG)), `★ 列表里每个人的标签都含「${TAG}」`, JSON.stringify(d.rows.map((r) => r.tags)))
  ok(d.rows.length === tagged.users.length, '界面条数 = 后端条数', `${d.rows.length} / ${tagged.users.length}`)
  await shoot(cdp, `${OUT}/04-tag-filter.png`)

  /* 取消筛选 → 回到全量 */
  await tapAt('.dg-filter .chip')
  ok(await waitFor(`!document.querySelector('.dg-filter')`, 8000), '点筛选标记能取消筛选')
  await sleep(600)
  await js(HELP)
  const back = await js(`window.__disc()`)
  ok(back.rows.length > d.rows.length, '取消后回到全量列表（人数变多）', `${d.rows.length} → ${back.rows.length}`)

  /* ---------- 附近的人 ---------- */
  console.log('\n─── 附近的人 ───')
  await js(`window.__seg('附近')`)
  await waitFor(`!!document.querySelector('.nb-card')`, 10000)
  await sleep(400)
  await js(HELP)
  d = await js(`window.__disc()`)
  ok(d.nearby.length === nb.users.length, '附近卡片数 = 后端条数', `${d.nearby.length} / ${nb.users.length}`)
  if (!nb.myGeo) {
    ok(d.nearby.every((p) => p.dist && !/\d/.test(p.dist)), '未授权时附近卡片不显示公里数', JSON.stringify(d.nearby.map((p) => p.dist)))
  } else {
    ok(d.nearby.every((p) => !/\d/.test(p.dist || '') || nb.users.find((u) => u.id === p.id)?.distanceBasis === 'city-center'), '公里数只在城市中心点依据下出现')
  }
  ok(
    d.nearby.every((p) => ['同城', '同省'].includes(p.dist) || p.dist.length >= 2),
    '距离只可能是「同城 / 同省 / 地区名」',
    JSON.stringify([...new Set(d.nearby.map((p) => p.dist))])
  )
  const sameCount = nb.users.filter((u) => u.near === 2).length
  ok(
    d.nearby.filter((p) => p.same).length === sameCount,
    '同城的人都有 `.is-same` 高亮',
    `${d.nearby.filter((p) => p.same).length} / ${sameCount}`
  )
  if (sameCount > 0) {
    ok(d.nearby[0]?.same === true, '★ 排在第一的是同城的人（排序真的生效了）', `${d.nearby[0]?.name} / ${d.nearby[0]?.dist}`)
  }
  ok(d.hint.some((h) => /附近分享默认关闭|主动开启城市级附近分享/.test(h)), '页面说明附近分享授权和距离依据', JSON.stringify(d.hint))
  await shoot(cdp, `${OUT}/05-nearby.png`)

  /* ---------- 打招呼：真的进房间 ---------- */
  console.log('\n─── 打招呼：进的是真房间 ───')
  const sayRow = d.nearby.find((p) => p.id === sayUser.id)
  ok(!!sayRow, `附近列表里有 ${sayUser.nickname}（库里和他本来就有私聊）`, JSON.stringify(sayRow))
  const convCountBefore = db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n
  /* 只盯这一个私聊里的消息数（用全局的会误报：用户可能同时在别的会话里打字） */
  const sayConvId = db
    .prepare(
      `SELECT c.id FROM conversations c
        WHERE c.type='private'
          AND EXISTS(SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=?)
          AND EXISTS(SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=?)
        LIMIT 1`
    )
    .get(me.user.id, sayUser.id)?.id
  const msgsOf = (cid) => (cid ? db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(cid).n : -1)
  const msgsBefore = msgsOf(sayConvId)
  await tapAt(`.nb-card[data-id="${sayUser.id}"] .nb-btn--primary`)
  ok(await waitFor(`!!document.querySelector('.room')`, 10000), '★ 点「打招呼」进的是**聊天房间**（不是只弹一句 toast）')
  await sleep(700)
  d = await js(`window.__disc()`)
  ok(d.room === true, '`.room` 出现')
  ok(String(d.roomTitle || '').includes(sayUser.nickname), '抬头显示的是对方的昵称', String(d.roomTitle))
  ok(
    db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n === convCountBefore,
    '★ 没有偷偷新建会话（走的是复用已有私聊的分支）',
    `${convCountBefore} → ${db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n}`
  )
  /* 「打招呼」只应把人领进房间，不该替他发一句「你好」——
     那句话是我们编的，真发出去就成了「我没说过的话出现在我的聊天记录里」。 */
  ok(
    !!sayConvId && msgsOf(sayConvId) === msgsBefore,
    '★ 没有替用户发那句「你好」（这个私聊里一条消息都没多）',
    `${msgsBefore} 条消息`
  )
  await shoot(cdp, `${OUT}/06-say-hi.png`)
  await js(`document.querySelector('.rh-back')?.click()`)
  await sleep(500)
  await js(HELP)

  /* ---------- 群组：加入真的进成员表 ---------- */
  console.log('\n─── 加入兴趣群 ───')
  await js(`window.__tab('发现')`)
  await waitFor(`!!document.querySelector('.disc-segs')`, 8000)
  await js(HELP)
  await js(`window.__seg('群组')`)
  await waitFor(`!!document.querySelector('.ig-card')`, 10000)
  await sleep(400)
  await js(HELP)
  d = await js(`window.__disc()`)
  ok(d.groups.length === gs.groups.length, '群卡片数 = 后端可加入群数', `${d.groups.length} / ${gs.groups.length}`)
  const g0 = d.groups.find((g) => g.id === TEMP_GROUP)
  ok(!!g0, '自检建的公开群出现在列表里', JSON.stringify(d.groups.map((g) => g.id)))
  joinedGroupId = TEMP_GROUP
  ok(dbIsMember(TEMP_GROUP, me.user.id) === false, '前置条件：库里此时我还不在这个群里', `群 ${TEMP_GROUP}`)
  ok(/位成员/.test(g0?.meta || ''), '卡片上写了真实成员数', String(g0?.meta))
  await shoot(cdp, `${OUT}/07-groups.png`)

  await tapAt(`.ig-card[data-id="${TEMP_GROUP}"] .ig-join`)
  await sleep(1200)
  ok(dbIsMember(TEMP_GROUP, me.user.id) === true, '★ 库里 `conversation_members` 真的多了一行（加入不是只弹 toast）', `${me.user.id} 进了群 ${TEMP_GROUP}`)
  d = await js(`window.__disc()`)
  ok(!d.groups.some((g) => g.id === TEMP_GROUP), '★ 加入后该群从「可加入」列表里消失', JSON.stringify(d.groups.map((g) => g.id)))
  ok(d.groups.length === gs.groups.length - 1, '列表条数减一', String(d.groups.length))
  ok(d.room === true, '加入后直接进了群聊房间')
  await shoot(cdp, `${OUT}/08-joined.png`)

  /* 退出还原 */
  const left = await j('DELETE', `/conversations/${TEMP_GROUP}/members/${me.user.id}`, null, me.auth)
  ok(left.status < 300, '自检收尾：退出这个群', String(left.status))
  ok(dbIsMember(TEMP_GROUP, me.user.id) === false, '库里成员行也删掉了')
  gs = (await j('GET', '/discover/groups', null, me.auth)).d
  ok(gs.groups.some((g) => g.id === TEMP_GROUP), '退出后它又回到「可加入」列表（状态是真算出来的）')
} catch (e) {
  console.error('\n💥 自检中断：', e.message)
  failures++
} finally {
  proc.kill()

  if (featureMomentId) {
    await j('DELETE', `/moments/${featureMomentId}`, null, me.auth).catch(() => {})
    if (featureTopic) db.prepare('DELETE FROM moment_topic_views WHERE topic = ? AND user_id = ?').run(featureTopic, me.user.id)
  }

  /* 兜底还原。只动这一轮自己碰过的东西 —— 不做全表还原，
     因为用户可能同时在预览里手测，一把梭会把他的改动一起冲掉。 */
  if (joinedGroupId && dbIsMember(joinedGroupId, me.user.id)) {
    db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(joinedGroupId, me.user.id)
    console.log(`\n兜底：已把 ${me.user.id} 从群 ${joinedGroupId} 里移出`)
  }
  if (followTargetHadEdge) {
    db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)').run(me.user.id, followTarget.id)
    console.log(`兜底：已还原「${me.user.nickname} → ${followTarget.nickname}」的关注关系`)
  }
  /* 「加入」会把会话的 updated_at 顶到最新 —— 聊天列表会因此把它排到最上面。
     还原成开跑前的时间戳，演示库的列表顺序不受自检影响。 */
  for (const c of baseConvs) {
    if (c.id === joinedGroupId) db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(c.updated_at, c.id)
  }
  /* 临时群、以及万一留下的自检会话，一起清掉（只认「自检·」前缀和无成员孤儿） */
  await purgeDebris({ quiet: true })

  const noise = /favicon|DevTools|ExperimentalWarning|Autoplay is only allowed/i
  const real = [...new Set(issues.filter((x) => !noise.test(x)))]
  if (real.length) {
    console.log(`\n❌ 控制台有 ${real.length} 条问题：`)
    real.forEach((x) => console.log('  •', x))
    failures += real.length
  }
}

console.log(`\n${failures === 0 ? '✅ 发现页自检全部通过' : `❌ ${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
