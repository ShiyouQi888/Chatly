/**
 * 位置服务专项自检（后端接口 + 前端真实交互）
 *
 * 这个功能**天生容易做成假的**，所以这里的判据一条都不用「元素在不在」：
 *
 *   A. 没配 key 时必须是**明确的降级**，不是故障也不是假数据：
 *      接口回 **HTTP 200 + `{configured:false, reason}`**（不是 4xx/5xx —— 用错误码表达会
 *      逼前端写成「出错就假装没这功能」，那就成了点不动的假按钮）；地图位置给**自画的坐标网格**
 *      并写明「这不是地图」。整条路径一个外链请求都不该发出去。
 *
 *   B. **坐标系必须真的换了。** 浏览器 `navigator.geolocation` 给 WGS-84，腾讯要 GCJ-02，
 *      不换会偏 265~621 米 —— 而且偏了界面上完全看不出来（地图照画、地址照给）。
 *      这里用 `Emulation.setGeolocationOverride` 喂一个**已知的 WGS-84 点**，
 *      再断言落库的坐标 ≈ `wgs84ToGcj02(它)`，且**明确不等于**原始 WGS-84 值。
 *      只断言「有坐标」的话，把 WGS-84 直接存下去也会绿。
 *
 *   C. **坐标缺一个就当没有，且绝不补 0。** 位置消息可以只有地点名（用户手输）。
 *      这时库里 geo_lat/geo_lng 必须是 NULL —— (0,0) 是几内亚湾，不是「没有位置」。
 *
 *   D. 静态资源的白名单**不能被位置消息绕过**：
 *      kind='location' 不需要 fileUrl；反过来给 location 塞一个外链 fileUrl 也必须被丢掉
 *      （否则就成了「用位置消息当外链跳板」的口子）。
 *
 *   E. 前端两条分支都要真的把消息**发出去并落库**：
 *      ① 有坐标（走真实定位）→ 气泡能点开全屏地图、看到坐标；
 *      ② 只有地点名 → 气泡写明「只发了地点名，没有坐标」，全屏里是明确的空态而不是一张假地图。
 *      会话列表的预览也要变成 `[位置] xxx`（否则看起来像消息没发出去）。
 *
 *   F. 动态定位走的是**同一个**「选位置」面板（不能各写一份，两处降级行为会漂）。
 *
 * ⚠️ 前提自己造、收尾还原：
 *   · 临时会话直接建成 `自检·位置`（`purgeDebris()` 按标题前缀收尾，连消息一起清掉），
 *     不往演示会话里塞探针消息。
 *   · 临时动态正文带 `自检·`，由 `purgeMoments()` 自动找出来清掉。
 *   · 演示库里原本就**可能**有位置消息（用户手测过），所以断言一律只看「本轮新增的那条」。
 *
 * 跑法：node scripts/check-geo.mjs
 */
import fs from 'node:fs'

import { db, insert } from '../server/src/db.js'
import { freePort, waitAppTarget, connectCdp, launchChrome, shoot } from './lib/cdp.mjs'
import { purgeDebris, purgeMoments } from './lib/debris.mjs'
import { wgs84ToGcj02, haversineKm } from '../shared/geo-math.mjs'

const API = 'http://127.0.0.1:3002/api/v1'
const APP_HOST = 'http://127.0.0.1:5198'
const APP = APP_HOST + '/'
const OUT = 'D:/BS-chat-os/shots/geo'
const PASS = 'chatly123'
const TMP_TITLE = '自检·位置'

/** 喂给浏览器的**已知 WGS-84 点**（深圳市民中心）。预期落库的是它的 GCJ-02 版本。 */
const WGS = { lat: 22.5431, lng: 114.0579 }
const GCJ = wgs84ToGcj02(WGS.lat, WGS.lng)

/** 手输的地点名（走「只有名字没有坐标」那条分支） */
const MANUAL_NAME = '自检·手输地点'

fs.mkdirSync(OUT, { recursive: true })

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

purgeDebris({ quiet: true })
const me = await login('chenmo')
const peer = await login('linxiaoxia')

/* ---- 造一个临时群（标题带「自检·」前缀，收尾由 purgeDebris 连消息一起清掉） ---- */
const now = Math.floor(Date.now() / 1000)
const tmpCid = insert(
  'INSERT INTO conversations (type, title, owner_id, created_at, updated_at) VALUES (?,?,?,?,?)',
  'group',
  TMP_TITLE,
  me.user.id,
  now,
  now
)
insert(
  'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?,?,?)',
  tmpCid,
  me.user.id,
  'owner'
)
insert(
  'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?,?,?)',
  tmpCid,
  peer.user.id,
  'member'
)
/* ⚠️ 一律用**带别名**的 SELECT。`SELECT *` 出来的是 snake_case（`geo_lat`），
   而下面全部按 `geoLat` 读 —— 那会安静地读到 undefined，断言全变成
   「undefined 不等于期望值」，看起来像功能坏了，其实是脚本自己读错了列。 */
const MSG_COLS = `id, kind, content, file_url AS fileUrl, file_name AS fileName,
                  geo_name AS geoName, geo_address AS geoAddress,
                  geo_lat AS geoLat, geo_lng AS geoLng`
const msgRow = (id) => db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(id)
const lastMsgOf = (cid) =>
  db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`).get(cid)

/**
 * 坐标落库的容差。
 * 服务端 `parseGeoPair()` 会把坐标收到 5 位小数（≈1.1 m），
 * 所以**不能**拿 `1e-6` 去比原值 —— 那是 0.1 毫米，永远差一点点。
 * 判据是「差在 10 米内（说明存的就是这个点）」+「离 WGS-84 有 250 米以上（说明真的换算了）」，
 * 这一对合起来才既能证明换算、又不会被舍入误差搞红。
 */
const NEAR_M = 1e-4
const SHIFT_M = 0.002

console.log('\n─── A. 没配 key 时是降级，不是故障 ───')
{
  const st = await j('GET', '/geo/status', null, me.auth)
  ok(st.status === 200, '/geo/status 有鉴权时正常返回', `HTTP ${st.status}`)
  ok(st.d?.configured === false, '未配置 TENCENT_MAP_KEY 时 configured=false', JSON.stringify(st.d))

  const lo = await j('GET', `/geo/locate?lat=${GCJ.lat}&lng=${GCJ.lng}`, null, me.auth)
  /* ★ 用 HTTP 200 表达「没配 key」是刻意设计：4xx/5xx 会逼前端写成「出错就当没这功能」 */
  ok(lo.status === 200, '/geo/locate 没配 key 也是 HTTP 200（不是 4xx/5xx）', `HTTP ${lo.status}`)
  ok(lo.d?.configured === false, '降级响应带 configured=false')
  ok(
    typeof lo.d?.reason === 'string' && lo.d.reason.length >= 6,
    '降级响应写明原因（不是空对象）',
    String(lo.d?.reason).slice(0, 40)
  )

  /* 参数错误必须还是 400 —— 降级只针对「没配 key」，不能把脏参数一起放过 */
  const bad1 = await j('GET', '/geo/locate?lng=114', null, me.auth)
  ok(bad1.status === 400, '/geo/locate 缺 lat → 400', `HTTP ${bad1.status}`)
  const bad2 = await j('GET', '/geo/locate?lat=200&lng=114', null, me.auth)
  ok(bad2.status === 400, '/geo/locate 纬度越界 → 400', `HTTP ${bad2.status}`)

  const noAuth = await j('GET', '/geo/status')
  ok(noAuth.status === 401, '/geo/status 需要登录', `HTTP ${noAuth.status}`)
}

console.log('\n─── B/C/D. 位置消息的落库形状 ───')
{
  /* ① 带坐标 */
  const r1 = await j(
    'POST',
    '/messages',
    {
      conversationId: tmpCid,
      kind: 'location',
      geo: { name: '深圳市民中心', address: '广东省深圳市福田区福中三路', lat: GCJ.lat, lng: GCJ.lng },
    },
    me.auth
  )
  ok(r1.status === 201, '发一条带坐标的位置消息', `HTTP ${r1.status} ${JSON.stringify(r1.d).slice(0, 60)}`)
  const m1 = msgRow(r1.d?.message?.id)
  ok(!!m1, '消息落库了')
  ok(m1.kind === 'location', 'kind = location')
  ok(m1.geoName === '深圳市民中心', 'geo_name 落库', String(m1.geoName))
  ok(
    Math.abs(m1.geoLat - GCJ.lat) < NEAR_M && Math.abs(m1.geoLng - GCJ.lng) < NEAR_M,
    'geo_lat/lng 落库（5 位小数精度内）',
    `${m1.geoLat}, ${m1.geoLng}`
  )
  ok(
    Math.abs(m1.geoLat - WGS.lat) > SHIFT_M,
    '落库的不是原始 WGS-84（GCJ-02 换算是真的发生了）',
    `WGS ${WGS.lat} vs 库 ${m1.geoLat}`
  )
  /* ★ 位置消息不占 content / file_url —— 否则会话预览会变成一坨 JSON */
  ok(m1.content == null && m1.fileUrl == null, '位置消息不写 content / file_url')

  const api = await j('GET', `/conversations/${tmpCid}/messages`, null, me.auth)
  const back = (api.d?.messages || []).find((x) => x.id === m1.id)
  ok(!!back?.geo, '读回来带 geo 字段')
  ok(
    back?.geo?.name === '深圳市民中心' && Math.abs(back.geo.lat - GCJ.lat) < NEAR_M,
    'geo.name / geo.lat 形状正确',
    JSON.stringify(back?.geo)
  )
  ok(back?.geo?.address?.includes('福田'), 'geo.address 透传', String(back?.geo?.address))

  const list = await j('GET', '/conversations', null, me.auth)
  const conv = (list.d?.conversations || []).find((c) => c.id === tmpCid)
  ok(
    /^\[位置\]/.test(String(conv?.preview || '')),
    '会话列表预览是 `[位置] 地点名`（不是空白）',
    String(conv?.preview)
  )
  ok(String(conv?.preview).includes('深圳市民中心'), '预览里带地点名')

  /* ② 只有名字没有坐标 */
  const r2 = await j(
    'POST',
    '/messages',
    { conversationId: tmpCid, kind: 'location', geo: { name: MANUAL_NAME } },
    me.auth
  )
  ok(r2.status === 201, '发一条只有地点名的位置消息', `HTTP ${r2.status}`)
  const m2 = msgRow(r2.d?.message?.id)
  /* ★ 必须是 NULL，不是 0 —— 补 0 会在地图上落到几内亚湾 */
  ok(m2.geoLat === null && m2.geoLng === null, '没有坐标时落 NULL（**不是 0**）', `${m2.geoLat} / ${m2.geoLng}`)
  ok(m2.geoName === MANUAL_NAME, '地点名照常落库')

  /* ③ 坐标缺一个 → 整体当作没有坐标 */
  const r3 = await j(
    'POST',
    '/messages',
    { conversationId: tmpCid, kind: 'location', geo: { name: '半个坐标', lat: 22.5 } },
    me.auth
  )
  const m3 = msgRow(r3.d?.message?.id)
  ok(
    r3.status === 201 && m3.geoLat === null && m3.geoLng === null,
    '只给了一个坐标 → 两个都当没有（半个坐标画出来是错的）',
    `${m3.geoLat} / ${m3.geoLng}`
  )

  /* ③b ★ 显式传 null（前端手输地点名时就是这样传的）。
     这条专盯 `Number(null) === 0` —— 写错的话这里会变成 (0, 0)，
     界面上是一张几内亚湾的地图，而且不会报任何错。 */
  const r3b = await j(
    'POST',
    '/messages',
    { conversationId: tmpCid, kind: 'location', geo: { name: '显式 null 坐标', lat: null, lng: null } },
    me.auth
  )
  const m3b = msgRow(r3b.d?.message?.id)
  ok(
    r3b.status === 201 && m3b.geoLat === null && m3b.geoLng === null,
    '坐标显式传 null → 落 NULL（`Number(null)===0` 会让它变成 0，这条专盯它）',
    `${m3b.geoLat} / ${m3b.geoLng}`
  )

  /* ④ 坐标越界同样当没有 */
  const r4 = await j(
    'POST',
    '/messages',
    { conversationId: tmpCid, kind: 'location', geo: { name: '越界', lat: 200, lng: 114 } },
    me.auth
  )
  const m4 = msgRow(r4.d?.message?.id)
  ok(m4.geoLat === null && m4.geoLng === null, '坐标越界 → 当没有坐标', `${m4.geoLat} / ${m4.geoLng}`)

  /* ⑤ 没有地点名 → 400（位置消息的本体就是地点名） */
  const r5 = await j('POST', '/messages', { conversationId: tmpCid, kind: 'location', geo: {} }, me.auth)
  ok(r5.status === 400, '位置消息缺地点名 → 400', `HTTP ${r5.status}`)

  /* ⑥ 位置消息**不需要** fileUrl（这条是防止路由还写着 `kind !== 'text'` 就要求 fileUrl） */
  ok(r1.status === 201, '位置消息不需要 fileUrl 也能发出去（不是「缺少文件地址」）')

  /* ⑦ 但**给了**外链 fileUrl 也必须被丢掉 —— 否则 location 成了绕过白名单的口子 */
  const r7 = await j(
    'POST',
    '/messages',
    {
      conversationId: tmpCid,
      kind: 'location',
      geo: { name: '外链试探', lat: GCJ.lat, lng: GCJ.lng },
      fileUrl: 'https://tracker.example.com/x.gif',
      fileName: 'x.gif',
      fileSize: 12,
    },
    me.auth
  )
  const m7 = msgRow(r7.d?.message?.id)
  ok(
    r7.status === 201 && m7.fileUrl === null && Object.is(m7.fileName, null),
    '位置消息带外链 fileUrl 时被丢弃（不能当外链跳板）',
    `fileUrl=${m7.fileUrl}`
  )
}

console.log('\n─── 动态定位的坐标 ───')
{
  const pub = await j(
    'POST',
    '/moments',
    {
      content: '自检·带定位的动态',
      location: '深圳市民中心',
      locationLat: GCJ.lat,
      locationLng: GCJ.lng,
      visibility: 'private',
    },
    me.auth
  )
  ok(pub.status === 201, '发布一条带坐标的动态', `HTTP ${pub.status}`)
  const mid = pub.d?.id
  const row = () => db.prepare('SELECT location, location_lat AS lat, location_lng AS lng FROM moments WHERE id = ?').get(mid)
  const r1 = row()
  ok(
    Math.abs(r1.lat - GCJ.lat) < NEAR_M && Math.abs(r1.lng - GCJ.lng) < NEAR_M,
    'location_lat/lng 落库（5 位小数精度内）',
    `${r1.lat}, ${r1.lng}`
  )
  ok(
    Math.abs(r1.lat - WGS.lat) > SHIFT_M,
    '动态坐标也换了坐标系（不是原始 WGS-84）',
    `WGS ${WGS.lat} vs 库 ${r1.lat}`
  )
  ok(pub.d?.moment?.locationLat != null, '出参里有 locationLat（前端画地图要靠它）')

  /* 只改名字：坐标必须原样保留（局部更新不能把坐标冲成 null） */
  const ed = await j('PATCH', `/moments/${mid}`, { location: '深圳·市民中心' }, me.auth)
  const r2 = row()
  ok(
    ed.status === 200 && r2.location === '深圳·市民中心' && Math.abs(r2.lat - GCJ.lat) < NEAR_M,
    '改地点名不会顺手把坐标清掉',
    `${r2.location} / ${r2.lat}`
  )

  /* 显式传 null → 坐标真的被清掉（编辑时「取消定位」要走得通） */
  await j('PATCH', `/moments/${mid}`, { locationLat: null, locationLng: null }, me.auth)
  ok(row().lat === null && row().lng === null, '显式传 null 能清掉坐标（不是变成 0）', String(row().lat))

  /* 只传一个 → 两个都是 null（不补 0） */
  await j('PATCH', `/moments/${mid}`, { locationLat: 22.5, locationLng: null }, me.auth)
  ok(row().lat === null && row().lng === null, '只传一个坐标 → 两个都是 NULL', String(row().lat))

  /* 老动态（只有地名）读回来坐标必须是 null，不能是 0 */
  const legacy = await j('POST', '/moments', { content: '自检·只有地名', location: '某个地方' }, me.auth)
  ok(
    legacy.d?.moment?.locationLat === null && legacy.d?.moment?.locationLng === null,
    '只有地名的动态读回来坐标是 null（不是 0）'
  )
}

/* ================= 浏览器 ================= */
const port = await freePort()
const profileDir = 'D:/BS-chat-os/.tmp/chrome-geo'
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

/* ★ 关键：喂一个**已知的 WGS-84 点**并授予定位权限。
   不然无头 Chrome 会直接把定位请求判成「权限被拒」，整条坐标链路（含 WGS→GCJ 换算）
   一次都跑不到 —— 而那正是最容易悄悄写错的地方。 */
try {
  await cdp.send('Browser.grantPermissions', { origin: APP_HOST, permissions: ['geolocation'] })
} catch (e) {
  console.log(`   ! 授予定位权限失败：${e.message}`)
}
await cdp.send('Emulation.setGeolocationOverride', { latitude: WGS.lat, longitude: WGS.lng, accuracy: 20 })

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
window.__plus = (label) => {
  const b = [...document.querySelectorAll('.plus-item')].find(x => x.textContent.trim().startsWith(label))
  if (!b) return 'missing'
  if (b.disabled) return 'disabled'
  return 'ready' }
window.__plusTap = (label) => {
  const b = [...document.querySelectorAll('.plus-item')].find(x => x.textContent.trim().startsWith(label))
  if (!b || b.disabled) return false
  b.click(); return true }
window.__openPlus = () => {
  const b = document.querySelector('.cp-btn[aria-label="更多"]'); if (!b) return false
  b.click(); return true }
window.__lp = (sel) => document.querySelector('.lp-root ' + sel)
window.__lpRow = (which) => {
  const sel = which === 'current' ? '[data-testid="lp-row-current"]' : '[data-testid="lp-row-poi"]'
  const r = window.__lp(sel); if (!r) return false
  r.scrollIntoView({ block: 'center' }); r.click(); return true }
/* 全部位置气泡的快照（按 DOM 顺序）。
   ⚠️ 这个助手原来**根本不存在** —— 源码里只有单数的 __card(msgId)，
   而下面两处调用的是复数的 __cards()，一跑就
   TypeError: window.__cards is not a function。属于重构时改名漏了一头，
   整个脚本因此从来没有真正跑通过（也说明它没被纳入回归）。
   这里按调用点的用法补齐：coord='1'/'0' 看 data-has-coord，
   hasMini 是「没配 key 时的坐标占位」、hasCanvas 是「真地图画出来了」。
   ⚠️ 本段在 HELP 模板字符串内部，不能出现反引号。 */
window.__cards = () => [...document.querySelectorAll('.loc-card')].map((w) => ({
  coord: w.dataset.hasCoord,
  text: w.textContent.trim(),
  hasMini: !!w.querySelector('.mv-ph-mini'),
  hasCanvas: !!w.querySelector('.mv-canvas'),
  w: Math.round(w.getBoundingClientRect().width),
}))
/* 按**消息 id** 精确定位气泡 —— 不能只写 .loc-card：
   这个房间在浏览器启动前就已经被接口塞过几条位置消息了，
   按「最后一个 .loc-card」取到的会是接口那条，断言会指向完全错误的对象。
   ⚠️ 这段注释在 HELP 模板字符串**内部**，所以里面不能出现反引号 ——
   反引号会把模板字符串提前收掉，整个脚本会直接语法错误。 */
window.__card = (msgId) => {
  const w = document.querySelector('.msg[data-id="' + msgId + '"] .loc-card')
  if (!w) return null
  return { coord: w.dataset.hasCoord, text: w.textContent.trim(),
           hasMini: !!w.querySelector('.mv-ph-mini'), hasCanvas: !!w.querySelector('.mv-canvas'),
           w: Math.round(w.getBoundingClientRect().width) } }
window.__openCard = (msgId) => {
  const w = document.querySelector('.msg[data-id="' + msgId + '"] .loc-card')
  if (!w) return false
  w.scrollIntoView({ block: 'center' }); w.click(); return true }
`
const injectHelp = () => js(HELP)

const up = await waitFor(
  `document.readyState !== 'loading' && (!!document.querySelector('.lg-demo-list button') || !!document.querySelector('.tabbar'))`,
  30000
)
if (!up) throw new Error('应用没挂载')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await sleep(400)
await injectHelp()

const tapAt = async (sel) => {
  const seen = await js(
    `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false
      e.scrollIntoView({ block: 'center' }); return true })()`
  )
  if (!seen) return false
  await sleep(300)
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
await sleep(700)
await injectHelp()
ok((await js(`window.innerWidth`)) === 390, '视口已按 390×844 移动端覆盖')

console.log('\n─── E①. 聊天里发一条**带坐标**的位置 ───')
await js(`window.__tab(0)`)
await waitFor(`!!document.querySelector('.chat-row')`, 12000)
ok(await js(`window.__openTmpChat()`), `进入临时会话「${TMP_TITLE}」`)
await waitFor(`!!document.querySelector('.room')`, 12000)

ok(await js(`window.__openPlus()`), '打开加号面板')
await sleep(350)
const plusState = await js(`window.__plus('位置')`)
ok(plusState !== 'missing', '加号面板里有「位置」入口')
ok(plusState === 'ready', '「位置」是能点的（不是 disabled 的假入口）', `状态=${plusState}`)

await js(`window.__plusTap('位置')`)
ok(await waitFor(`!!document.querySelector('.lp-root')`, 12000), '打开了选位置面板')
ok(await js(`!document.querySelector('.tabbar')`), '选位置是整屏覆盖层')
await waitFor(`document.querySelector('.lp-root')?.dataset.phase === 'ready'`, 15000)

/* 没配 key：必须是坐标占位 + 明确说明，而不是一张糊出来的假地图 */
ok(
  await waitFor(`!!document.querySelector('[data-testid="map-nokey"]')`, 12000),
  '没配地图 key 时给出坐标占位（不是空白，也不是假底图）'
)
ok(
  await js(`!document.querySelector('.mv-canvas')`),
  '没配 key 时**没有**去加载真地图 SDK（零外链请求）'
)
const phLat = await js(`Number(document.querySelector('[data-testid="map-nokey"]')?.dataset.lat)`)
/* ★ 送进 MapView 的必须是 GCJ-02 —— 拿 WGS-84 直接画会偏几百米，而且看不出来 */
ok(
  Math.abs(phLat - GCJ.lat) < 1e-6,
  '占位图收到的是 GCJ-02 坐标（不是浏览器的 WGS-84）',
  `${phLat} vs ${GCJ.lat}`
)
ok(
  Math.abs(phLat - WGS.lat) > 0.002,
  'WGS-84 → GCJ-02 的偏移确实发生了（差得足够明显）',
  `偏移约 ${Math.round(
    haversineKm(WGS.lat, WGS.lng, GCJ.lat, GCJ.lng) * 1000
  )} m`
)
const noticeTxt = await js(`document.querySelector('.lp-notice')?.textContent.trim() || ''`)
ok(/还没配置位置服务/.test(noticeTxt), '降级说明写明「服务端还没配置位置服务」', noticeTxt.slice(0, 40))

ok(
  await js(`!!document.querySelector('[data-testid="lp-row-current"]')`),
  '定位成功后列表里有「当前位置」'
)
const curName = await js(`document.querySelector('[data-testid="lp-row-current"] .lp-main b')?.textContent.trim() || ''`)
ok(curName.length > 0, '「当前位置」有一个真名字（不是空字符串）', String(curName).slice(0, 20))
ok(
  await js(`!!document.querySelector('[data-testid="lp-row-current"] .lp-cur-tag')`),
  '标了「当前位置」标签，和附近地点区分开'
)
ok(
  await js(`document.querySelector('[data-testid="lp-send"]')?.disabled === true`),
  '还没选地点时「发送」是禁用的（不给「先点发送再报错」这条路）'
)
await shoot(cdp, `${OUT}/01-picker-nokey.png`)

await js(`window.__lpRow('current')`)
await sleep(300)
ok(
  await js(`!!document.querySelector('[data-testid="lp-row-current"].is-sel')`),
  '点一下选中了该地点'
)
ok(
  await js(`document.querySelector('[data-testid="lp-send"]')?.disabled === false`),
  '选中之后「发送」才可用'
)
await shoot(cdp, `${OUT}/02-picker-selected.png`)

await js(`document.querySelector('[data-testid="lp-send"]').click()`)
ok(await waitFor(`!document.querySelector('.lp-root')`, 12000), '发送后面板关闭')
ok(await waitFor(`!!document.querySelector('.loc-card')`, 12000), '消息列表里出现了位置卡片')

/* ★ 判据是**回库查**：「界面上有张卡片」不等于消息存下来了 */
const sent1 = lastMsgOf(tmpCid)
ok(sent1.kind === 'location', '界面发出的这条落库 kind=location', String(sent1.kind))
ok(
  Math.abs(sent1.geoLat - GCJ.lat) < 1e-3 && Math.abs(sent1.geoLng - GCJ.lng) < 1e-3,
  '落库坐标 ≈ GCJ-02(浏览器给的点)',
  `库 ${sent1.geoLat?.toFixed(5)},${sent1.geoLng?.toFixed(5)} / 期望 ${GCJ.lat.toFixed(5)},${GCJ.lng.toFixed(5)}`
)
ok(
  Math.abs(sent1.geoLat - WGS.lat) > 0.002,
  '落库的不是原始 WGS-84（真的换算了）',
  `WGS ${WGS.lat} vs 库 ${sent1.geoLat?.toFixed(5)}`
)
const cards1 = await js(`window.__cards()`)
const mineCard = cards1[cards1.length - 1]
ok(mineCard?.coord === '1', '气泡标记「有坐标」', JSON.stringify(mineCard))
ok(mineCard?.hasMini === true && mineCard?.hasCanvas === false, '气泡里是缩略坐标占位（没去加载真地图）')
await shoot(cdp, `${OUT}/03-loc-bubble-coord.png`)

/* 几何：位置卡片不能撑破消息列 */
const fit = await js(`(() => {
  const c = [...document.querySelectorAll('.loc-card')].pop(); if(!c) return null
  const col = c.closest('.msg-col'); if(!col) return null
  const a = c.getBoundingClientRect(), b = col.getBoundingClientRect()
  return { overflow: Math.round(a.right - b.right), w: Math.round(a.width), colW: Math.round(b.width) }
})()`)
ok(fit && fit.overflow <= 1, '位置卡片没有溢出消息列', JSON.stringify(fit))

/* 点开全屏 */
await js(`[...document.querySelectorAll('.loc-card')].pop().click()`)
ok(await waitFor(`!!document.querySelector('[data-testid="loc-viewer"]')`, 12000), '点气泡打开全屏位置页')
const coordTxt = await js(`document.querySelector('.lv-coord')?.textContent.trim() || ''`)
ok(/\d+\.\d+,\s*\d+\.\d+/.test(coordTxt), '全屏页写出真实坐标（可核对）', coordTxt)
ok(
  await js(`document.querySelector('.lv-foot b')?.textContent.trim() === ${JSON.stringify(sent1.geoName)}`),
  '全屏页显示的正是消息里的地点名',
  String(await js(`document.querySelector('.lv-foot b')?.textContent.trim()`))
)
await shoot(cdp, `${OUT}/04-loc-fullscreen-coord.png`)
await js(`document.querySelector('.lv-btn').click()`)
ok(await waitFor(`!document.querySelector('[data-testid="loc-viewer"]')`, 10000), '关闭全屏位置页')

console.log('\n─── E②. 只有地点名（手输）的位置 ───')
await js(`window.__openPlus()`)
await sleep(350)
await js(`window.__plusTap('位置')`)
ok(await waitFor(`!!document.querySelector('.lp-root')`, 12000), '再次打开选位置面板')
await waitFor(`document.querySelector('.lp-root')?.dataset.phase === 'ready'`, 15000)
await js(`window.__setVal('[data-testid="lp-search"]', ${JSON.stringify(MANUAL_NAME)})`)
await sleep(300)
ok(
  await js(`!!document.querySelector('.lp-row em')?.textContent?.includes('只发地点名')`),
  '手输时明确提示「只发地点名，不带坐标」',
  String(await js(`document.querySelector('.lp-row em')?.textContent`)).slice(0, 30)
)
await js(`document.querySelector('.lp-row').click()`)
await sleep(250)
ok(
  await js(`document.querySelector('[data-testid="lp-send"]')?.disabled === false`),
  '手输的地点也能选中并发送'
)
await js(`document.querySelector('[data-testid="lp-send"]').click()`)
ok(await waitFor(`!document.querySelector('.lp-root')`, 12000), '手输位置发送完成')

const sent2 = lastMsgOf(tmpCid)
ok(sent2.geoName === MANUAL_NAME, '手输的地点名落库', String(sent2.geoName))
ok(sent2.geoLat === null && sent2.geoLng === null, '手输位置**不带坐标**（NULL，不是 0）', `${sent2.geoLat}`)
const cards2 = await js(`window.__cards()`)
const manualCard = cards2[cards2.length - 1]
ok(manualCard?.coord === '0', '气泡标记「没有坐标」', JSON.stringify(manualCard))
ok(
  /只发了地点名，没有坐标/.test(manualCard?.text || ''),
  '气泡里写明「只发了地点名，没有坐标」（不画假地图）',
  String(manualCard?.text).slice(0, 40)
)
ok(manualCard?.hasMini === false, '没有坐标时连坐标占位都不给（不给任何像地图的东西）')
await shoot(cdp, `${OUT}/05-loc-bubble-nocord.png`)

await js(`[...document.querySelectorAll('.loc-card')].pop().click()`)
ok(await waitFor(`!!document.querySelector('[data-testid="loc-viewer"]')`, 12000), '没有坐标也能点开全屏')
ok(
  await js(`!!document.querySelector('[data-testid="map-invalid"]')`),
  '全屏里是明确的「没有坐标」空态（不是一张假地图）'
)
ok(
  /只有地点名，没有坐标/.test(await js(`document.querySelector('.lv-coord')?.textContent || ''`)),
  '全屏页写明这条位置没有坐标'
)
await shoot(cdp, `${OUT}/06-loc-fullscreen-nocord.png`)
await js(`document.querySelector('.lv-btn').click()`)
await sleep(400)

/* 会话列表的预览 */
await js(`document.querySelector('.rh-back').click()`)
await waitFor(`!!document.querySelector('.chat-row')`, 12000)
const preview = await js(`(() => {
  const row = [...document.querySelectorAll('.chat-row')].find(r => (r.querySelector('.cr-name')?.textContent||'').includes(${JSON.stringify(TMP_TITLE)}))
  return row ? row.querySelector('.cr-msg')?.textContent.trim() : null })()`)
ok(
  /^\[位置\]/.test(String(preview)) && String(preview).includes(MANUAL_NAME),
  '会话列表预览显示 `[位置] 地点名`',
  String(preview)
)

console.log('\n─── F. 动态定位走同一个面板 ───')
await js(`window.__tab(1)`)
await waitFor(`!!document.querySelector('[aria-label="发布动态"]')`, 12000)
await js(`document.querySelector('[aria-label="发布动态"]').click()`)
ok(await waitFor(`!!document.querySelector('.mc-root')`, 12000), '打开动态发布面板')
ok(await js(`!!document.querySelector('[data-testid="mc-loc-pick"]')`), '发布面板上的位置入口是真的按钮')
ok(
  await js(`document.querySelector('[data-testid="mc-loc-pick"]').tagName === 'BUTTON'`),
  '位置入口是 button（不是只读输入框）'
)
await js(`window.__setVal('.mc-textarea', '自检·位置面板共用')`)
await js(`document.querySelector('[data-testid="mc-loc-pick"]').click()`)
ok(await waitFor(`!!document.querySelector('.lp-root')`, 12000), '动态里打开的是**同一个**选位置面板')
ok(
  await waitFor(`!!document.querySelector('[data-testid="map-nokey"]')`, 12000),
  '同一套降级：没 key 也是坐标占位 + 说明'
)
await waitFor(`document.querySelector('.lp-root')?.dataset.phase === 'ready'`, 15000)
ok(
  await js(`!!document.querySelector('[data-testid="lp-row-current"]')`),
  '动态里同样能拿到「当前位置」'
)
await js(`window.__lpRow('current')`)
await sleep(250)
await js(`document.querySelector('[data-testid="lp-send"]').click()`)
ok(await waitFor(`!document.querySelector('.lp-root')`, 12000), '确定后回到发布面板')
ok(
  await js(`!!document.querySelector('[data-testid="mc-loc-pick"] .mc-loc-body b')`),
  '发布面板上显示了选中的地点名'
)
ok(
  /带坐标/.test(await js(`document.querySelector('[data-testid="mc-loc-pick"] .mc-loc-body em:last-child')?.textContent || ''`)),
  '并写明「带坐标，可在地图上看」',
  String(await js(`document.querySelector('[data-testid="mc-loc-pick"] .mc-loc-body em:last-child')?.textContent`)).slice(0, 20)
)
await shoot(cdp, `${OUT}/07-moment-loc.png`)
await js(`document.querySelector('.mc-send').click()`)
await waitFor(`!document.querySelector('.mc-root')`, 15000)

const newMoment = db
  .prepare("SELECT id, location, location_lat AS lat, location_lng AS lng FROM moments WHERE content LIKE '%自检·位置面板共用%' ORDER BY id DESC LIMIT 1")
  .get()
ok(!!newMoment, '动态真的发布落库了')
ok(
  newMoment && Math.abs(newMoment.lat - GCJ.lat) < 1e-3,
  '动态落库的坐标 ≈ GCJ-02（同一个换算链路）',
  `库 ${newMoment?.lat?.toFixed(5)} / 期望 ${GCJ.lat.toFixed(5)}`
)
await sleep(600)

/* ================= 收尾 ================= */
console.log('\n─── 收尾 ───')
const before = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(tmpCid).n
ok(before >= 2, `临时会话里确实有本轮消息（${before} 条）`)
const cleaned = purgeDebris({ quiet: true })
ok(
  db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE title = ?').get(TMP_TITLE).n === 0,
  '临时会话已清掉（不是留在演示库里）',
  `清理了 ${cleaned.conversations} 个会话 / ${cleaned.messages} 条消息`
)
const pm = purgeMoments()
const leftoverMoments = db
  .prepare("SELECT COUNT(*) AS n FROM moments WHERE content LIKE '%自检·%' OR location LIKE '%自检·%'")
  .get().n
ok(leftoverMoments === 0, '临时动态已清掉', `清了 ${pm.moments} 条`)

console.log('\n─── 控制台 ───')
if (issues.length) {
  ok(false, '全程无 console 报错 / 未捕获异常', issues.slice(0, 4).join(' | '))
} else {
  ok(true, '全程无 console 报错 / 未捕获异常')
}

cdp.close()
proc.kill()

console.log(`\n${'─'.repeat(52)}`)
console.log(failures ? `❌ ${failures} 项未通过` : '✅ 全部通过')
console.log(`截图：${OUT}`)
process.exit(failures ? 1 : 0)
