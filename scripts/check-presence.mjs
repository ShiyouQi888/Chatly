/**
 * 在线状态自检：本地 presence / Redis 跨实例 / 无 Redis 降级
 *
 * 跑法：node scripts/check-presence.mjs      （需要 5198 与 3002 都在跑）
 *
 * ## 为什么要单独一支
 * 「在线状态可见」这个开关的**读取方有两处**（资料/列表接口的 online 字段、WS 的上下线推送），
 * 而 Redis 那一层还多出两个只在多实例下才走到的新路径：
 *   · `remotePresent()` —— 「A 实例上那个我在线吗」
 *   · pub/sub 投递 —— 事件要送到挂在别的实例上的连接
 * 这两条在单进程开发里**一次都不会执行**，是最容易「写错了也没人知道」的地方。
 *
 * ## 跨实例怎么在没有第二个进程的情况下验
 * 本机不允许从脚本里再拉一个 node 子进程（会被安全策略拒掉），所以不真起实例，而是
 * **直接扮演另一个实例**：
 *   · 读取路径：往 `chatly:presence:<uid>` 里 ZADD 一条「别的实例还持有他」，
 *     然后打 `/users/:id` —— 本进程的 Map 里没有他，能报在线就只可能来自 Redis。
 *   · 投递路径：往 `chatly:events` publish 一条 `origin` 不是本实例的事件，
 *     挂在**本实例**上的 WS 客户端必须收到 —— 这正是「别实例 → 我这里的连接」那一步。
 *
 * ## 环境依赖的处理
 * Redis 没起（docker compose down 之后）时，A/C/D 三段照跑，B 段（Redis 专项）
 * 会**明确标为跳过并计数**，而不是悄悄少跑几条 —— 静默的盲区比红色危险。
 */
import { q, ready as dbReady } from '../server/src/db.js'

const API = 'http://127.0.0.1:3002/api/v1'
const HEALTH = 'http://127.0.0.1:3002/health'

let pass = 0
let fail = 0
let skipped = 0
const ok = (c, l, e = '') => (c ? (pass++, console.log(`  ✅ ${l}`)) : (fail++, console.log(`  ❌ ${l}${e ? ' — ' + e : ''}`)))
const skip = (l) => (skipped++, console.log(`  ⏭️  ${l}（跳过）`))
const skipN = (n, l) => {
  skipped += n
  console.log(`  ⏭️  ${l} —— 跳过 ${n} 条断言`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const req = async (p, { method = 'GET', token, body } = {}) => {
  const r = await fetch(API + p, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
const login = async (u) => {
  const r = await req('/auth/login', { method: 'POST', body: { username: u, password: 'chatly123' } })
  if (!r.data?.token) throw new Error(`${u} 登录失败`)
  return r.data
}

/* ws / redis 都装在 server/node_modules 里（ESM 不认 NODE_PATH，只能走相对路径；
   两个都是 CJS，具名导出能不能拿到取决于 cjs-module-lexer 的判定，所以都兜一下 default） */
const wsMod = await import('../server/node_modules/ws/index.js')
const WebSocket = wsMod.WebSocket || wsMod.default
const redisMod = await import('../server/node_modules/redis/dist/index.js')
const createClient = redisMod.createClient || redisMod.default?.createClient

await dbReady()
const A = await login('chenmo')
const B = await login('linxiaoxia')
const AID = A.user.id
const BID = B.user.id

/* 只做「观察者」的 WS 连接，把收到的事件攒起来 */
function openWs(token) {
  const ws = new WebSocket(`ws://127.0.0.1:3002/ws?token=${encodeURIComponent(token)}`)
  ws.seen = []
  ws.on('message', (raw) => {
    try {
      ws.seen.push(JSON.parse(raw.toString()))
    } catch {}
  })
  ws.on('error', () => {})
  return ws
}
const waitOpen = (ws) => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
const presenceOf = (ws) => ws.seen.filter((e) => e.type === 'presence').map((e) => e.payload)
const clearSeen = (ws) => (ws.seen.length = 0)

/* 记录原值，收尾还原 —— 不还原会把演示账号留在「隐身」状态，后面几支自检会莫名变红 */
const visRow = await q.get(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'online_status_visible'`, BID)
const visOriginal = visRow ? JSON.parse(visRow.value) : true
const setVis = (v) => req('/settings/online_status_visible', { method: 'PUT', token: B.token, body: { value: v } })

const health = await (await fetch(HEALTH)).json()
console.log(`\n数据层 ${health.db?.driver} · Redis ${health.redis?.state}${health.redis?.url ? ` (${health.redis.url})` : ''}\n`)

let aWs = null
let bWs = null
let redis = null
try {
  /* ================= ① 本地 presence（不依赖 Redis） ================= */
  console.log('─── ① 本地上下线推送 ───')
  await setVis(true)
  aWs = openWs(A.token)
  await waitOpen(aWs)
  await sleep(400)

  clearSeen(aWs)
  bWs = openWs(B.token)
  await waitOpen(bWs)
  await sleep(800)
  const up = presenceOf(aWs)
  ok(up.some((p) => Number(p.userId) === BID && p.online === true), '★ B 上线后，同为会话成员的 A 收到 online=true', JSON.stringify(up))

  clearSeen(aWs)
  bWs.close()
  await sleep(800)
  const down = presenceOf(aWs)
  ok(down.some((p) => Number(p.userId) === BID && p.online === false), '★ B 下线后 A 收到 online=false', JSON.stringify(down))
  bWs = null

  /* 关掉「在线状态可见」之后，上下线都不该再推给任何人 */
  await setVis(false)
  await sleep(300)
  clearSeen(aWs)
  bWs = openWs(B.token)
  await waitOpen(bWs)
  await sleep(900)
  ok(presenceOf(aWs).length === 0, '★ 关掉「在线状态可见」后上线不再推送（不是推一条 online:false）', JSON.stringify(presenceOf(aWs)))

  clearSeen(aWs)
  bWs.close()
  await sleep(800)
  ok(presenceOf(aWs).length === 0, '关掉后下线也不推送')
  bWs = null

  /* 重新打开时**不能**无条件宣布「在线」—— 此刻 B 根本没连上。
     这条正是刚修掉的那个缺陷：无条件报 online:true 会在朋友那边留下一个假的在线圆点，
     比「没反应」更糟。要报的必须是**他此刻真实的状态**。 */
  clearSeen(aWs)
  await setVis(true)
  await sleep(900)
  const reOn = presenceOf(aWs).filter((p) => Number(p.userId) === BID)
  ok(
    reOn.every((p) => p.online === false),
    '★ 离线状态下打开开关，不会宣布「在线」（报的是真实状态）',
    JSON.stringify(reOn)
  )

  /* 真正的「不用等重连」：人**在线**时关 → 立刻变灰；再开 → 立刻变亮。 */
  bWs = openWs(B.token)
  await waitOpen(bWs)
  await sleep(700)
  clearSeen(aWs)
  await setVis(false)
  await sleep(900)
  const offEvt = presenceOf(aWs).filter((p) => Number(p.userId) === BID).slice(-1)[0]
  ok(offEvt?.online === false, '★ B 在线时关掉开关 → 立刻推 online=false（朋友那边马上变灰）', JSON.stringify(offEvt))
  clearSeen(aWs)
  await setVis(true)
  await sleep(900)
  const onEvt = presenceOf(aWs).filter((p) => Number(p.userId) === BID).slice(-1)[0]
  ok(onEvt?.online === true, '★ 再打开 → 立刻推 online=true（不用等重连）', JSON.stringify(onEvt))
  bWs.close()
  bWs = null
  await sleep(500)

  /* ================= ② 界面：会话列表的在线圆点 ================= */
  console.log('\n─── ② 界面上的在线圆点（需要 5198）───')
  const APP_HOST = 'http://127.0.0.1:5198'
  const { freePort, waitAppTarget, connectCdp, launchChrome, shoot } = await import('./lib/cdp.mjs')
  const fs = await import('node:fs')
  const OUT = 'D:/BS-chat-os/shots/presence'
  fs.mkdirSync(OUT, { recursive: true })
  const port = await freePort()
  const profileDir = 'D:/BS-chat-os/.tmp/chrome-presence'
  try {
    fs.rmSync(profileDir, { recursive: true, force: true })
  } catch {}
  fs.mkdirSync(profileDir, { recursive: true })
  const proc = launchChrome({ url: APP_HOST + '/', port, profileDir })
  try {
    const target = await waitAppTarget(port, APP_HOST)
    const cdp = await connectCdp(target.webSocketDebuggerUrl, () => {})
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
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
        } catch {}
        await sleep(200)
      }
      return false
    }

    ok(await waitFor(`!!document.querySelector('.lg-demo-list button') || !!document.querySelector('.tabbar')`), '应用挂载')
    if (await js(`!!document.querySelector('.lg-demo-list button')`)) {
      await js(`[...document.querySelectorAll('.lg-demo-list button')].find(x=>x.textContent.includes('陈墨'))?.click()`)
    }
    ok(await waitFor(`!!document.querySelector('.chat-row')`, 10000), '会话列表已加载')

    /* 界面上的圆点是 `.av-online`，判据要落到「林小夏那一行」上，
       不能全页找 `.av-online` —— 别的行也可能有在线的头像。 */
    const dotOfB = `[...document.querySelectorAll('.chat-row')].find(r=>r.textContent.includes('林小夏'))?.querySelector('.av-online')`

    bWs = openWs(B.token)
    await waitOpen(bWs)
    await sleep(1200)
    ok(await waitFor(`!!(${dotOfB})`, 8000), '★ B 在线时，她的会话行上出现了在线圆点')
    await shoot(cdp, `${OUT}/01-presence-dot.png`)

    /* 断开后圆点要消失 —— 这才是「实时」的证据：
       只看「连上就出现」，一个只在首次加载时算出来的静态值也能通过。 */
    bWs.close()
    bWs = null
    ok(await waitFor(`!(${dotOfB})`, 8000), '★ B 断开后圆点实时消失（不是只在首次加载时算过一次）')
  } finally {
    try {
      proc.kill()
    } catch {}
  }

  /* ================= ③ Redis 专项 ================= */
  console.log('\n─── ③ Redis 专项（跨实例读写）───')
  if (health.redis?.state !== 'on') {
    /* ⚠️ 明确报出跳过了几条，不做静默少跑。
       要跑全这几条：`docker compose up -d` 之后重跑本支。 */
    skipN(8, 'Redis 未启用（/health 的 redis.state 不是 on），跨实例读写这 8 条没跑')
  } else {
    redis = createClient({ url: health.redis.url })
    await redis.connect()
    const PKEY = (uid) => `chatly:presence:${uid}`

    /* 干净的起点 */
    await redis.del(PKEY(BID))
    const off1 = await req(`/users/${BID}`, { token: A.token })
    ok(off1.data.online === false, '起点：B 没有连接、Redis 里也没有记录 → offline', String(off1.data.online))

    /* ★ TTL 必须验**真实代码路径写出来的键**。
       一开始我是自己 ZADD 一条再查 TTL —— 那验的是测试自己（当然没 TTL），
       而不是 redis.js 的 touch()。改成先让 B 真的连上。 */
    bWs = openWs(B.token)
    await waitOpen(bWs)
    await sleep(700)
    const zcard = await redis.zCard(PKEY(BID))
    ok(zcard >= 1, 'B 连上后 Redis 里出现他的存在记录（跨实例读取的前提）', `zcard=${zcard}`)
    const ttl = await redis.ttl(PKEY(BID))
    ok(ttl > 0, '★ 这个键带 TTL（进程被 kill -9 收不到 close 时，靠它自己过期）', `ttl=${ttl}`)
    bWs.close()
    bWs = null
    await sleep(700)
    const zcard2 = await redis.zCard(PKEY(BID))
    ok(zcard2 === 0, '★ 断开时只摘掉自己那一条（这里只有一个实例，所以应该剩 0）', `zcard=${zcard2}`)

    /* 读取路径：本进程 Map 里没有 B，只可能来自 Redis。
       这就是「另一个实例报上来的在线」。 */
    await redis.zAdd(PKEY(BID), [{ score: Date.now() + 60000, value: 'fake-instance-other' }])
    const off2 = await req(`/users/${BID}`, { token: A.token })
    ok(off2.data.online === true, '★ 只往 Redis 写一条「别实例持有他」→ 接口就报在线（跨实例读取路径）', String(off2.data.online))

    /* 过期成员要被剪掉，不能一直算在线 */
    await redis.del(PKEY(BID))
    await redis.zAdd(PKEY(BID), [{ score: Date.now() - 10000, value: 'fake-instance-stale' }])
    const off3 = await req(`/users/${BID}`, { token: A.token })
    ok(off3.data.online === false, '★ 已经过期的成员算离线（陈旧记录不会把人永远算成在线）', String(off3.data.online))

    /* 投递路径：模拟别的实例 publish 一条，挂在本实例上的连接必须收到 */
    clearSeen(aWs)
    const evt = { origin: 'fake-instance-other', targets: [AID], type: 'presence', payload: { userId: 9999, online: true } }
    await redis.publish('chatly:events', JSON.stringify(evt))
    await sleep(800)
    const got = aWs.seen.filter((e) => e.type === 'presence' && Number(e.payload?.userId) === 9999)
    ok(got.length === 1, '★ 别实例 publish 的事件被送到了本实例上的连接（跨实例投递路径）', JSON.stringify(aWs.seen))

    /* 自己发的事件不该被自己再投一遍（否则每条消息都会双投） */
    clearSeen(aWs)
    await redis.publish(
      'chatly:events',
      JSON.stringify({ origin: health.redis.instanceId, targets: [AID], type: 'presence', payload: { userId: 9998, online: true } })
    )
    await sleep(700)
    ok(aWs.seen.filter((e) => Number(e.payload?.userId) === 9998).length === 0, '★ origin 是本实例的事件被跳过（不会双投）', JSON.stringify(aWs.seen))

    await redis.del(PKEY(BID))
  }

  /* ================= ④ 无 Redis 时降级，不是崩溃 ================= */
  console.log('\n─── ④ Redis 不可用时的降级 ───')
  /* 用带 query 的 URL 让 ESM 缓存失效、重新求值一次 redis.js ——
     `process.loadEnvFile()` 是**已有环境变量优先**，所以这里直接覆盖 env 就能改掉它的行为。
     （同一招在 check-poll 的「老库迁移」里用过。） */
  process.env.REDIS_URL = 'redis://127.0.0.1:6399'
  const dead = await import(`../server/src/redis.js?dead=${Date.now()}`)
  const deadReady = await dead.ready()
  ok(deadReady === false, '连不上 Redis 时 ready() 返回 false（不抛异常）')
  ok(dead.status().state === 'degraded', '状态标为 degraded（/health 能查到，不是静默失效）', JSON.stringify(dead.status()))
  let threw = null
  try {
    dead.markLocalPresence(AID, true)
    dead.publishTo([AID], 'presence', { ok: 1 })
    dead.markLocalPresence(AID, false)
  } catch (e) {
    threw = e
  }
  ok(threw === null, '降级后 markLocalPresence / publishTo 都是安全空操作（不抛）', threw?.message || '')

  process.env.REDIS_URL = ''
  const none = await import(`../server/src/redis.js?none=${Date.now()}`)
  ok(none.status().state === 'off' && (await none.ready()) === false, '没配 REDIS_URL 时状态是 off，且 ready() 不抛', JSON.stringify(none.status()))
  ok(none.status().configured === false, 'off 与 degraded 是两种状态（一个是没配、一个是配了但坏了）')
} catch (e) {
  fail++
  console.log(`\n❌ 自检中途中断：${e?.message}\n${String(e?.stack || '').split('\n').slice(0, 6).join('\n')}`)
} finally {
  try {
    if (bWs) bWs.close()
  } catch {}
  try {
    if (aWs) aWs.close()
  } catch {}
  await setVis(visOriginal).catch(() => {})
  await sleep(200)
  const back = await q.get(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'online_status_visible'`, BID)
  ok((back ? JSON.parse(back.value) : true) === visOriginal, '收尾：B 的「在线状态可见」已还原', `${visOriginal}`)
  try {
    await redis?.quit()
  } catch {}
}

console.log(
  `\n${fail === 0 ? '✅ 在线状态自检全部通过' : '❌ 有失败项'} —— ${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ''}\n`
)
process.exit(fail ? 1 : 0)
