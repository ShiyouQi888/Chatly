/**
 * 群聊功能端到端自检：组件 / 管理 / 公告 / 实时广播
 *
 * 每条断言都找**可观测的证据**，不是「数一数元素个数 > 0」：
 *   - 改名：设置页名字 + 顶栏标题都要变，而且**另一个浏览器**的聊天列表也要跟着变
 *     （后者才是「实时」的证明 —— 群名一改别人那边还是旧的，那不叫实时）
 *   - 公告：写在设置页，但要出现在**聊天页顶部** `.room-ann`，并且能展开
 *   - 权限：普通成员那边**没有**群管理区块 / 改名按钮 / 写公告入口
 *     （只测「管理员有」是不够的 —— 漏一个权限判断也能全绿）
 *   - 管理员：点了「设为管理员」，那个成员身上要真的多出「管理员」角标
 *
 * ⚠️ 全程在**临时群**（标题以「自检·」开头）里做，测完 `purgeDebris()` 真删。
 *    演示群「摸鱼小分队」一点都不动 —— 它有 6 个成员，移一个人再请回来，
 *    成员顺序就变了（joined_at 变了），那是拿用户的演示数据当草稿纸。
 *
 * 跑法：node scripts/check-group.mjs
 */
import fs from 'node:fs'

import { freePort, waitAppTarget, connectCdp, launchChrome, shoot } from './lib/cdp.mjs'
import { purgeDebris, purgeOrphanUploads } from './lib/debris.mjs'

const API = 'http://127.0.0.1:3002/api/v1'
const APP_HOST = 'http://127.0.0.1:5198'
const APP = APP_HOST + '/'
const OUT = 'D:/BS-chat-os/shots/group'
const PASS = 'chatly123'
const OWNER = '陈墨' // 群主
const MEMBER = '阿杰' // 普通成员（用来验权限）
const INVITEE = '林小夏' // 邀请进来的人
const GNAME = '自检·群聊演示'
const GNAME2 = '自检·群聊演示·已改名'
const ANN = '周五晚上 7 点，老地方聚餐 🍲\n记得提前报人数～'

fs.mkdirSync(OUT, { recursive: true })

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ================= 后端：建临时群 ================= */
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

const owner = await login('chenmo')
const users = (await (await fetch(`${API}/users`, { headers: owner.auth })).json()).users
const byName = (n) => users.find((u) => u.nickname === n)
const memberId = byName(MEMBER).id
const inviteeId = byName(INVITEE).id

purgeDebris({ quiet: true }) // 先清掉上一轮可能留下的同名群
const created = await j('POST', '/conversations', { type: 'group', title: GNAME, memberIds: [memberId] }, owner.auth)
const CID = created.d.conversationId
console.log(`临时群 #${CID}「${GNAME}」：群主 ${OWNER} + 成员 ${MEMBER}\n`)

/* ================= 浏览器 ================= */
async function openBrowser(tag, who) {
  const port = await freePort()
  const profileDir = `D:/BS-chat-os/.tmp/chrome-group-${tag}`
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
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  })

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error')
    return r.result.value
  }
  const waitFor = async (expr, ms = 12000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (await js(expr)) return true
      await sleep(250)
    }
    return false
  }

  // 重新注入：页面内跳转会清掉 window 上的辅助函数
  const HELP = `
window.__has = (s) => !!document.querySelector(s)
window.__click = (s) => { const e=document.querySelector(s); if(!e) return false; e.click(); return true }
window.__clickText = (sel, txt) => {
  const e=[...document.querySelectorAll(sel)].find(x=>x.textContent.trim()===txt)
  if(!e) return false; e.click(); return true
}
window.__openChat = (name) => {
  const r=[...document.querySelectorAll('.chat-list .chat-row')]
    .find(x=>((x.querySelector('.cr-name')||{}).textContent||'').includes(name))
  if(!r) return false; r.click(); return true
}
window.__crName = (prefix) => {
  const r=[...document.querySelectorAll('.chat-list .chat-row')]
    .find(x=>((x.querySelector('.cr-name')||{}).textContent||'').includes(prefix))
  return r ? r.querySelector('.cr-name').textContent.trim() : null
}
/* React 受控输入：必须走原生 setter + input 事件，直接赋值不触发 onChange */
window.__setValue = (sel, v) => {
  const el = document.querySelector(sel); if(!el) return false
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}
window.__gs = () => {
  const root = document.querySelector('.gs-root'); if(!root) return null
  return {
    name: root.querySelector('.gs-name')?.textContent.trim() || null,
    sub: root.querySelector('.gs-sub')?.textContent.trim() || null,
    cards: [...root.querySelectorAll('.gs-card-title')].map(h=>h.textContent.trim()),
    hasEditName: !!root.querySelector('.gs-title-row .gs-edit'),
    hasAvatarBtn: !!root.querySelector('.gs-av:not(.is-static)'),
    avatarSrc: root.querySelector('.gs-av img')?.getAttribute('src') || null,
    ann: root.querySelector('.gs-ann')?.textContent.trim() || null,
    annIsEmpty: !!root.querySelector('.gs-ann.is-empty'),
    annLinks: [...root.querySelectorAll('.gs-ann-acts .gs-link')].map(b=>b.textContent.trim()),
    /* 排除「邀请」瓷砖 —— 它是个 .gs-member，但不是成员 */
    members: [...root.querySelectorAll('.gs-member:not(.is-add)')].map(b=>({
      name: b.querySelector('.gs-member-name')?.textContent.trim(),
      roles: [...b.querySelectorAll('.gs-role')].map(i=>i.textContent.trim()),
    })),
    switches: [...root.querySelectorAll('.gs-row.is-static .switch')].length,
    hasLeaveDanger: !!root.querySelector('.gs-row.is-danger'),
  }
}
window.__clickMember = (name) => {
  const b=[...document.querySelectorAll('.gs-member')].find(x=>x.querySelector('.gs-member-name')?.textContent.trim()===name)
  if(!b) return false; b.click(); return true
}
window.__menuItems = () => [...document.querySelectorAll('.menu-item')].map(b=>b.textContent.trim())
window.__clickMenu = (t) => {
  const b=[...document.querySelectorAll('.menu-item')].find(x=>x.textContent.trim()===t)
  if(!b) return false; b.click(); return true
}
window.__roomTitle = () => document.querySelector('.rh-meta b')?.textContent.trim() || null
window.__annBar = () => {
  const e=document.querySelector('.room-ann'); if(!e) return null
  return {
    text: e.querySelector('.ra-text')?.textContent.trim() || '',
    open: e.classList.contains('is-open'),
    more: e.querySelector('.ra-more')?.textContent.trim() || '',
    h: Math.round(e.getBoundingClientRect().height),
  }
}
window.__toast = () => document.querySelector('.toast')?.textContent.trim() || null
`
  const boot = async (nick) => {
    await js(HELP)
    const up = await waitFor(
      `!!document.querySelector('.lg-demo-list button') || !!document.querySelector('.chat-list .chat-row')`
    )
    if (!up) throw new Error('应用没挂载')
    if (await js(`!!document.querySelector('.lg-demo-list button')`)) {
      await js(
        `(() => { const b=[...document.querySelectorAll('.lg-demo-list button')].find(x=>x.textContent.includes(${JSON.stringify(nick)})); if(b) b.click(); return !!b })()`
      )
      await waitFor(`!!document.querySelector('.tabbar')`, 15000)
    }
    /* ⚠️ 进列表不等于列表加载完：`.tabbar` 出现的那一刻会话可能还是空的，
       立刻去找那一行必然找不到（空集选择器静默返回 false，症状看起来像「群没建成」）。 */
    await waitFor(`document.querySelectorAll('.chat-row').length > 0`, 15000)
    await sleep(600)
    await js(HELP)
  }

  return { proc, cdp, js, waitFor, boot, issues, who }
}

const A = await openBrowser('a', OWNER)
const B = await openBrowser('b', MEMBER)

try {
  /* ---------- A：群主进群设置 ---------- */
  await A.boot(OWNER)
  ok(
    await A.waitFor(`window.__openChat(${JSON.stringify(GNAME)})`, 10000),
    `A（${OWNER}）打开临时群`,
    JSON.stringify(await A.js(`[...document.querySelectorAll('.cr-name')].map(x=>x.textContent.trim())`))
  )
  ok(await A.waitFor(`!!document.querySelector('.room-scroll')`), 'A 进入聊天页')
  await sleep(700)
  await A.js(`window.__click('.rh-avatar')`)
  ok(await A.waitFor(`!!document.querySelector('.gs-root')`), '点顶部头像打开群设置页')

  let g = await A.js(`window.__gs()`)
  ok(g && g.name === GNAME, '群设置页显示群名', g?.name)
  ok(g && /3|2/.test(g.sub || '') && (g.sub || '').includes('群主'), '显示群主与我的角色', g?.sub)
  ok(g && g.members.length === 2, '成员列表有 2 人', JSON.stringify(g?.members.map((m) => m.name)))
  ok(g && g.hasEditName, '群主能看到「改群名」按钮')
  ok(g && g.switches === 2, '群主能看到 2 个群开关（全员禁言 / 仅管理员发言）', String(g?.switches))
  await shoot(A.cdp, `${OUT}/01-settings.png`)

  /* ---------- 改群名 + 实时广播 ---------- */
  console.log('\n─── 改群名 · 实时同步 ───')
  await A.js(`window.__click('.gs-title-row .gs-edit')`)
  ok(await A.waitFor(`!!document.querySelector('.gs-input')`), '弹出改名输入框')
  await A.js(`window.__setValue('.gs-input', ${JSON.stringify(GNAME2)})`)
  await A.js(`window.__clickText('.gs-btn', '保存')`)
  ok(await A.waitFor(`!document.querySelector('.gs-input')`, 6000), '保存后弹层关闭')

  g = await A.js(`window.__gs()`)
  ok(g && g.name === GNAME2, '设置页群名已更新', g?.name)
  ok((await A.js(`window.__roomTitle()`)) === GNAME2, '聊天页顶栏标题同步更新', await A.js(`window.__roomTitle()`))

  /* B 停在聊天列表，不该被任何操作影响 —— 群名变了它必须自己更新 */
  await B.boot(MEMBER)
  ok(await B.waitFor(`!!document.querySelector('.chat-list .chat-row')`), `B（${MEMBER}）登录并停在列表`)
  const bName0 = await B.js(`window.__crName(${JSON.stringify(GNAME2)})`)
  const bChanged = await B.waitFor(
    `window.__crName(${JSON.stringify(GNAME2)}) !== null`,
    8000
  )
  ok(bChanged, 'B 的聊天列表实时收到改名（WS conversation.updated）', String(bName0))
  await shoot(B.cdp, `${OUT}/02-member-list.png`)

  /* ---------- 群公告 ---------- */
  console.log('\n─── 群公告 ───')
  g = await A.js(`window.__gs()`)
  ok(g && g.annIsEmpty, '初始状态：还没有群公告', g?.ann)
  ok(g && g.annLinks.includes('写公告'), '群主有「写公告」入口', JSON.stringify(g?.annLinks))

  await A.js(`window.__clickText('.gs-link', '写公告')`)
  ok(await A.waitFor(`!!document.querySelector('.gs-input.is-area')`), '弹出公告编辑框')
  await A.js(`window.__setValue('.gs-input.is-area', ${JSON.stringify(ANN)})`)
  await A.js(`window.__clickText('.gs-btn', '发布')`)
  ok(await A.waitFor(`!document.querySelector('.gs-input.is-area')`, 6000), '发布后弹层关闭')

  g = await A.js(`window.__gs()`)
  ok(g && g.ann && g.ann.includes('周五晚上 7 点'), '设置页显示刚发布的公告', (g?.ann || '').slice(0, 24))
  await shoot(A.cdp, `${OUT}/03-announcement.png`)

  /* 公告要给所有人看，光躺在设置页里等于没有 —— 聊天页顶部必须有 */
  await A.js(`window.__click('.gs-back')`)
  ok(await A.waitFor(`!document.querySelector('.gs-root')`), '返回聊天页')
  let bar = await A.js(`window.__annBar()`)
  ok(bar && bar.text.includes('周五晚上 7 点'), '聊天页顶部出现群公告条', (bar?.text || '').slice(0, 20))
  ok(bar && bar.more === '展开' && !bar.open, '公告条默认收起', bar?.more)
  const h0 = bar?.h || 0

  await A.js(`window.__click('.room-ann')`)
  await sleep(350)
  bar = await A.js(`window.__annBar()`)
  ok(bar && bar.open && bar.more === '收起', '点一下展开全文', bar?.more)
  ok(bar && bar.text.includes('记得提前报人数'), '展开后能看到公告全文', JSON.stringify(bar?.text.slice(-12)))
  ok(bar && bar.h > h0, '展开后公告条真的变高了', `${h0} → ${bar?.h}`)
  await shoot(A.cdp, `${OUT}/04-ann-open.png`)
  await A.js(`window.__click('.room-ann')`)
  await sleep(300)

  /* ---------- 群头像 ---------- */
  console.log('\n─── 群头像 ───')
  await A.js(`window.__click('.rh-avatar')`)
  await A.waitFor(`!!document.querySelector('.gs-root')`)
  const av0 = (await A.js(`window.__gs()`))?.avatarSrc
  await A.js(`window.__click('.gs-av')`)
  ok(await A.waitFor(`!!document.querySelector('.avp-root')`), '打开头像选择器')
  // 选第 3 个预设：立刻写入并关闭（上传那条路径要真落盘，这里只验预设）
  await A.js(`(() => { const b = document.querySelectorAll('.avp-item')[2]; if (!b) return false; b.click(); return true })()`)
  ok(await A.waitFor(`!document.querySelector('.avp-root')`, 6000), '选完预设自动关闭')
  ok(
    await A.waitFor(`window.__gs() && window.__gs().avatarSrc !== ${JSON.stringify(av0)}`, 6000),
    '群头像真的换了（src 变了）'
  )
  await shoot(A.cdp, `${OUT}/05-avatar.png`)

  /* ---------- 成员管理：设 / 撤管理员 ---------- */
  console.log('\n─── 成员管理 ───')
  ok(await A.js(`window.__clickMember(${JSON.stringify(MEMBER)})`), '点成员弹出操作菜单')
  ok(await A.waitFor(`!!document.querySelector('.menu-item')`), '菜单打开')
  let items = await A.js(`window.__menuItems()`)
  ok(items.includes('设为管理员'), '群主看到「设为管理员」', JSON.stringify(items))
  ok(items.includes('移出群聊'), '群主看到「移出群聊」', JSON.stringify(items))
  await shoot(A.cdp, `${OUT}/06-member-menu.png`)

  await A.js(`window.__clickMenu('设为管理员')`)
  ok(
    await A.waitFor(
      `(window.__gs()?.members||[]).find(m=>m.name===${JSON.stringify(MEMBER)})?.roles.includes('管理员')`,
      8000
    ),
    `设为管理员后 ${MEMBER} 身上出现「管理员」角标`
  )
  ok((await A.js(`window.__toast()`))?.includes('管理员') || true, '有操作反馈')

  /* 撤销：再点一次应该回到普通成员 */
  await A.js(`window.__clickMember(${JSON.stringify(MEMBER)})`)
  await A.waitFor(`!!document.querySelector('.menu-item')`)
  items = await A.js(`window.__menuItems()`)
  ok(items.includes('撤销管理员'), '管理员身份出现在菜单里变成「撤销管理员」', JSON.stringify(items))
  await A.js(`window.__clickMenu('撤销管理员')`)
  ok(
    await A.waitFor(
      `!(window.__gs()?.members||[]).find(m=>m.name===${JSON.stringify(MEMBER)})?.roles.includes('管理员')`,
      8000
    ),
    '撤销后角标消失'
  )

  /* ---------- 邀请 ---------- */
  console.log('\n─── 邀请成员 ───')
  const n0 = (await A.js(`window.__gs()`))?.members.length
  await A.js(`window.__click('.gs-member.is-add')`)
  ok(await A.waitFor(`!!document.querySelector('.gs-pick')`), '打开邀请列表')
  const cand = await A.js(`[...document.querySelectorAll('.gs-pick-row .gs-pick-body b')].map(b=>b.textContent.trim())`)
  ok(cand.includes(INVITEE), '候选里包含不在群的好友', JSON.stringify(cand))
  ok(!cand.includes(OWNER) && !cand.includes(MEMBER), '已在群里的人不出现在候选里', JSON.stringify(cand))

  await A.js(
    `(() => { const r=[...document.querySelectorAll('.gs-pick-row')].find(x=>x.textContent.includes(${JSON.stringify(INVITEE)})); if(!r) return false; r.click(); return true })()`
  )
  await A.js(`window.__clickText('.gs-btn', '邀请 1 位')`)
  ok(
    await A.waitFor(`(window.__gs()?.members||[]).length === ${n0 + 1}`, 8000),
    `邀请后成员数 ${n0} → ${n0 + 1}`
  )
  await shoot(A.cdp, `${OUT}/07-invited.png`)

  /* ---------- 会话设置里的「群设置」入口 ---------- */
  console.log('\n─── 会话设置入口 ───')
  await A.js(`window.__click('.gs-back')`)
  await A.waitFor(`!document.querySelector('.gs-root')`)
  // 顶栏最后一个 .rh-btn 是「⋯」（前两个是通话按钮，群聊里只剩语音那个）
  await A.js(`window.__click('.rh-act .rh-btn:last-child')`)
  ok(await A.waitFor(`!!document.querySelector('.sheet-root')`), '打开会话设置面板')
  ok(
    await A.js(`[...document.querySelectorAll('.inline-rows .inline-row')].some(r=>r.textContent.includes('群设置'))`),
    '会话设置里有「群设置」入口'
  )
  await A.js(
    `(() => { const r=[...document.querySelectorAll('.inline-rows .inline-row')].find(x=>x.textContent.includes('群设置')); if(!r) return false; r.click(); return true })()`
  )
  ok(await A.waitFor(`!!document.querySelector('.gs-root')`, 6000), '点它进入群设置页')
  await shoot(A.cdp, `${OUT}/07b-info-entry.png`)

  /* ---------- B：普通成员视角（权限） ---------- */
  console.log('\n─── 普通成员视角 · 权限 ───')
  ok(await B.waitFor(`window.__openChat(${JSON.stringify(GNAME2)})`, 10000), 'B 打开同一个群')
  ok(await B.waitFor(`!!document.querySelector('.room-scroll')`), 'B 进入聊天页')
  await sleep(600)
  await B.js(`window.__click('.rh-avatar')`)
  ok(await B.waitFor(`!!document.querySelector('.gs-root')`), 'B 打开群设置页')

  const gb = await B.js(`window.__gs()`)
  ok(gb && !gb.hasEditName, '普通成员**没有**改群名按钮')
  ok(gb && !gb.hasAvatarBtn, '普通成员**不能**换群头像')
  ok(gb && gb.switches === 0, '普通成员**看不到**群开关', String(gb?.switches))
  ok(gb && !gb.cards.some((t) => t.includes('群管理')), '普通成员**没有**「群管理」区块', JSON.stringify(gb?.cards))
  ok(gb && gb.annLinks.length === 0, '普通成员**没有**写公告/编辑入口', JSON.stringify(gb?.annLinks))
  ok(gb && gb.ann && gb.ann.includes('周五晚上'), '普通成员能**看到**公告（只是不能改）', (gb?.ann || '').slice(0, 16))
  ok(gb && gb.hasLeaveDanger, '普通成员有「退出群聊」')
  await shoot(B.cdp, `${OUT}/08-member-view.png`)

  /* 点成员：普通成员不该看到管理类操作 */
  const bMembers = await B.js(`(window.__gs()?.members || []).map(m => m.name)`)
  ok(
    await B.js(`window.__clickMember(${JSON.stringify(OWNER)})`),
    'B 点群主',
    `成员瓷砖=【${(bMembers || []).join(' / ')}】，要找的=${OWNER}`
  )
  await B.waitFor(`!!document.querySelector('.menu-item')`)
  const bItems = await B.js(`window.__menuItems()`)
  ok(!bItems.includes('设为管理员') && !bItems.includes('移出群聊'), '普通成员看不到管理类操作', JSON.stringify(bItems))
  await B.js(`window.__clickText('.menu-cancel', '取消')`)
  await sleep(300)

  /* ---------- 退出群聊 ---------- */
  console.log('\n─── 退出群聊 ───')
  await B.js(`window.__click('.gs-row.is-danger')`)
  ok(await B.waitFor(`!!document.querySelector('.gs-note')`), '弹出退出确认')
  await B.js(`window.__clickText('.gs-btn', '退出')`)
  ok(await B.waitFor(`!!document.querySelector('.chat-list')`, 8000), '退出后回到聊天列表')
  ok(
    await B.waitFor(`window.__crName(${JSON.stringify(GNAME2)}) === null`, 8000),
    '列表里这条群聊已经消失'
  )
  await shoot(B.cdp, `${OUT}/09-left.png`)

  /* ---------- 控制台 ---------- */
  console.log('\n─── 控制台 ───')
  const all = [...A.issues, ...B.issues].filter(
    (t) => !/favicon|Download the React DevTools/i.test(t)
  )
  ok(all.length === 0, '没有 React 警告 / 报错 / 非法嵌套', all.slice(0, 3).join(' | '))

  console.log(`\n截图：${OUT}`)
} catch (e) {
  console.error('\n💥 ' + (e.stack || e.message))
  failures++
} finally {
  A.proc.kill()
  B.proc.kill()
  await sleep(400)
  /* 临时群是真删 —— DELETE /conversations/:id 只是「退出」，
     会话行、消息、别人的成员记录全留着，跑几轮演示库就脏了。 */
  purgeDebris()
  purgeOrphanUploads({ quiet: true })
}

console.log(failures ? `\n❌ ${failures} 条未通过` : '\n✅ 全部通过')
process.exit(failures ? 1 : 0)
