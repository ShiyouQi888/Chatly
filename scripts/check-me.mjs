/**
 * 「我」页设置自检：7 个入口 / 版面 / 真假开关 / 反馈落库
 *
 * ⛔⛔ 本文件里的 `HELP` 是一个**模板字符串**，它内部的注释里
 *     **绝对不能出现反引号**（也不要在里面写 `.foo` 之外的反引号包裹的代码）。
 *     反引号会让模板在该处提前收掉，报出来的却是几十行外那句
 *     「Unexpected identifier」—— 定位方向完全错。
 *     这个坑在本项目已经踩过**五次**，别再踩第六次。
 *
 * ⛔⛔ 比反引号更阴的一种：**转义序列**。
 *     `HELP` 里的 `\\n`、`\\t`、`\\u…` 是在 **Node 侧**就被解掉的。
 *     写成 `out.join('\n')`，注入到浏览器就变成 `out.join('` + 真实换行 + `')`
 *     —— 未闭合的字符串 → `SyntaxError: Invalid or unexpected token`。
 *     阴在 `node --check` **查不出来**（Node 语法完全合法），只有跑起来才炸。
 *     凡是**想让浏览器看到**的反斜杠，都要写两个。
 *
 * 这一页以前有一批「不会报错、也不会有反应」的缺陷，所以断言都盯着**可观测后果**，
 * 不是「元素存在就行」：
 *   · 死按钮的症状是「点了什么都不发生」—— 判据是**页面必须离开主页面**
 *     （`.me-hero` 消失），而不是「出现了某个 div」；
 *   · `.sub-page` 曾经零样式，症状是标题不固定、正文被底栏压住 ——
 *     用几何量证明（根节点 absolute、底边盖过 .tabbar 上沿）；
 *   · 「动态默认可见范围」要证明它**真的被发布面板读到**：改设置 → 去动态页
 *     打开发布面板 → 看初始可见范围是不是跟着变了；
 *   · 「字体大小 / 动效开关」要证明改的是**全局**（--font-scale / .no-motion），
 *     不是一个只在当前页好看的局部状态；
 *   · 「自动下载图片」要先有**正对照**（开关开着时图是能显示的），
 *     再证明关掉之后真的拦住了请求；
 *   · 「提交反馈」要证明真的落库（回 SQLite 查那一行），截图要真的上传成功。
 *
 * ⚠️ 收尾**只能按已捕获的基线 id** 删临时数据；基线没拿到就一条都不删
 *    （踩过一次：基线为 0 时 `id > 0` 把演示库消息全删了）。
 *
 * ⚠️ 全程只动「自检·」标记的数据，收尾删干净并把 localStorage 还原成默认。
 * 跑法：node scripts/check-me.mjs
 */
import fs from 'node:fs'

import { db } from '../server/src/db.js'
import { freePort, waitAppTarget, connectCdp, launchChrome, shoot } from './lib/cdp.mjs'
import { ensureLoggedIn } from './lib/session.mjs'

const API = 'http://127.0.0.1:3002/api/v1'
const APP_HOST = 'http://127.0.0.1:5198'
const OUT = 'D:/BS-chat-os/shots/me'
const PASS = 'chatly123'
const NICK = '陈墨'

const TAG = `自检·反馈-${Date.now()}`

fs.mkdirSync(OUT, { recursive: true })

let failures = 0
let pass = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  cond ? pass++ : failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 七行设置的文案 —— 和 `MeTab.jsx` 里的 Row label 一一对应 */
const ENTRIES = [
  { label: '账号与安全', page: 'security' },
  { label: '隐私设置', page: 'privacy' },
  { label: '通用设置', page: 'general' },
  { label: '主题外观', page: 'theme' },
  { label: '消息通知', page: 'notify' },
  { label: '帮助与反馈', page: 'help' },
  { label: '关于我们', page: 'about' },
]

/* 1×1 的透明 PNG（用来走一遍真实的截图上传路径） */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

async function openBrowser() {
  const port = await freePort()
  const profileDir = 'D:/BS-chat-os/.tmp/chrome-me'
  fs.mkdirSync(profileDir, { recursive: true })
  const proc = launchChrome({ url: APP_HOST + '/', port, profileDir })
  const target = await waitAppTarget(port, APP_HOST)

  const issues = []
  const cdp = await connectCdp(target.webSocketDebuggerUrl, (e) => {
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error')
    return r.result.value
  }
  const waitFor = async (expr, ms = 10000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      try {
        if (await js(expr)) return true
      } catch {
        /* 页面换 context 时 evaluate 会抛，等下一轮 */
      }
      await sleep(200)
    }
    return false
  }

  const HELP = `
window.__click = (s) => { const e=document.querySelector(s); if(!e) return false; e.click(); return true }
window.__tab = (i) => { const t=[...document.querySelectorAll('.tabbar .tab')][i]; if(!t) return false; t.click(); return true }
window.__toast = () => document.querySelector('.toast')?.textContent.trim() || null
/* 按文案点一行设置。⚠️ 必须限定 .row：
   页面里别处也有同名文字（比如侧栏、提示语），不限定会点到别的元素上。 */
window.__row = (label) => [...document.querySelectorAll('.row')]
  .find(r => (r.querySelector('.row-label')?.textContent || '').trim() === label)
window.__rowTap = (label) => { const r = window.__row(label); if(!r) return false; r.click(); return true }
/* 子页标题（根节点可能是 .sub-page 也可能是 .subpage，两个名字都得认） */
window.__pageTitle = () => document.querySelector('.sub-page .sub-head h2, .subpage .sub-head h2')?.textContent.trim() || null
window.__pageClass = () => { const p=document.querySelector('.sub-page, .subpage'); return p ? p.className : null }
window.__onMainMe = () => !!document.querySelector('.me-hero')
window.__back = () => { const b=document.querySelector('.sub-back'); if(!b) return false; b.click(); return true }
/* 一行右侧是不是禁用开关 / 「未接入」徽标 */
window.__rowState = (label) => {
  const r = window.__row(label); if(!r) return null
  const sw = r.querySelector('.switch')
  return {
    hasSwitch: !!sw,
    switchDisabled: sw ? sw.disabled === true : null,
    /* Switch 组件把状态写在 aria-checked 上 —— 读它比读 class 稳，class 随时可能改名 */
    switchOn: sw ? sw.getAttribute('aria-checked') === 'true' : null,
    off: !!r.querySelector('.tag-off'),
    sub: r.querySelector('.row-sub')?.textContent.trim() || '',
    /* Row 有 onClick 时渲染成 button，没有就是 div（见 ui.jsx 里 Tag = onClick ? button : div）。
       这是判断「这一行到底能不能点」的唯一可靠依据 —— 光看有没有箭头不行，
       纯展示的 Row 也能手动塞一个箭头。 */
    clickable: r.tagName === 'BUTTON',
  }
}
window.__rowValue = (label) => {
  const r = window.__row(label); if(!r) return null
  return r.querySelector('.row-value')?.textContent.trim() ?? null
}
/* 通用设置页用的是原生 .settings-item（不是 Group/Row），单独的取值入口。
   ⚠️ 别拿 __row 去取它 —— __row 只查 .row，会一直返回 null，
      看着像「标签写错了」，其实只是找错了容器。 */
window.__settingItem = (label) => [...document.querySelectorAll('.settings-item')]
  .find(x => (x.querySelector('.settings-label')?.textContent || '').trim() === label)
window.__settingLabel = (label) => window.__settingItem(label)?.querySelector('.settings-label')?.textContent.trim() ?? null
window.__settingToggle = (label) => {
  const it = window.__settingItem(label); if (!it) return 'no-item'
  const cb = it.querySelector('input[type=checkbox]'); if (!cb) return 'no-cb'
  if (cb.checked) cb.click()
  return cb.checked
}
/* FAQ 的答案在**折叠**里（没展开就不在 DOM 里）。
   ⚠️ 这是**单开**手风琴（展开一条会收起上一条），所以不能「全点一遍再读」——
      那样最后只剩一条是开的。必须**逐条**：展开 → 读 → 收起 → 下一条。 */
window.__allFaqText = async () => {
  const out = []
  for (const q of [...document.querySelectorAll('.faq-question')]) {
    if (q.getAttribute('aria-expanded') !== 'true') {
      q.click()
      await new Promise(r => setTimeout(r, 80))
    }
    const item = q.closest('.faq-item')
    out.push(item?.querySelector('.faq-answer')?.textContent || '')
    if (q.getAttribute('aria-expanded') === 'true') {
      q.click()
      await new Promise(r => setTimeout(r, 60))
    }
  }
  return out.join('\\n')
}
`
  const boot = async () => {
    await js(HELP)
    await waitFor(`!!document.querySelector('.lg-card, .login') || !!document.querySelector('.tabbar')`, 25000)
    await ensureLoggedIn(js)
    await sleep(600)
    await js(HELP)
    await js(`window.__tab(3)`) // 「我」
    await waitFor(`!!document.querySelector('.me-hero')`, 10000)
    await sleep(300)
    await js(HELP)
  }

  return { proc, cdp, js, waitFor, boot, issues, help: HELP }
}

/* ================= 后端 ================= */
async function login(username) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASS }),
  })
  const d = await r.json()
  if (!d.token) throw new Error(`${username} 登录失败：${JSON.stringify(d)}`)
  return d
}

const me = await login('chenmo')

/* 记下原始设置，收尾还原 */
const settingsBefore = (await (await fetch(`${API}/settings`, { headers: { Authorization: `Bearer ${me.token}` } })).json()) || {}
const baselineFeedbackIds = db.prepare('SELECT id FROM feedbacks').all().map((r) => r.id)
/* 临时造物（图片消息 + 上传文件）的收尾信息 */
const probe = { baselineMsgId: 0, msgIds: [], uploadUrl: null }

const A = await openBrowser()

try {
  await A.boot()
  ok(await A.js(`window.__onMainMe()`), '「我」页主界面就绪（有 .me-hero）')

  /* 留一张主界面底部（七行设置）的图 —— 用户报的就是这一屏。
     滚到底再截，截完滚回去，别影响后面的断言。 */
  await A.js(`(() => { const s=document.querySelector('.me-scroll'); if(s) s.scrollTop = s.scrollHeight; return true })()`)
  await sleep(300)
  await shoot(A.cdp, `${OUT}/00-me-main.png`)
  await A.js(`(() => { const s=document.querySelector('.me-scroll'); if(s) s.scrollTop = 0; return true })()`)

  /* ================= 1. 七个入口逐一点开 ================= */
  console.log('\n─── 七个设置入口 ───')
  for (const e of ENTRIES) {
    const tapped = await A.js(`window.__rowTap(${JSON.stringify(e.label)})`)
    ok(tapped, `${e.label} 是一个可点击的行`)
    /* ★ 死按钮的判据：点了之后必须**离开主页面**。
       以前 general/help/about 三条没有渲染分支，page 变了却仍然渲染主页面 ——
       只断言「出现了某个元素」是抓不到的。 */
    const left = await A.waitFor(`!window.__onMainMe()`, 5000)
    ok(left, `${e.label} 点开后真的离开了主页面（不是死按钮）`)
    const title = await A.js(`window.__pageTitle()`)
    ok(title === e.label, `${e.label} 子页标题正确`, String(title))

    /* 文案守卫：markdown 标记漏进渲染文本。JSX 的字符串属性里写了
       `⚠️ 本项目**没有实现端到端加密**` 这种，星号会**原样**显示给用户 ——
       这类问题不报错、不崩，只有肉眼看截图才发现得了，所以在这里拦一道。
       ⚠️ 表达式里的 `\\*` 会被 Node 的模板字符串先解一层，要写两个反斜杠。 */
    const mdLeak = await A.js(
      `(document.querySelector('.sub-page, .subpage')?.innerText || '').match(/\\*\\*/g)?.length || 0`
    )
    ok(mdLeak === 0, `${e.label} 页面上没有漏出 markdown 的星号标记`, `发现 ${mdLeak} 处`)

    /* 版面几何：根节点必须绝对定位铺满，且底边盖过底部导航上沿 */
    const geo = await A.js(`(() => {
      const p = document.querySelector('.sub-page, .subpage')
      const sb = document.querySelector('.screen-body')
      const tb = document.querySelector('.tabbar')
      if (!p || !sb) return null
      const pr = p.getBoundingClientRect(), sr = sb.getBoundingClientRect()
      const tr = tb ? tb.getBoundingClientRect() : null
      const cs = getComputedStyle(p)
      return { pos: cs.position, display: cs.display,
               pTop: Math.round(pr.top), pBottom: Math.round(pr.bottom),
               sTop: Math.round(sr.top), sBottom: Math.round(sr.bottom),
               pW: Math.round(pr.width), sW: Math.round(sr.width),
               tTop: tr ? Math.round(tr.top) : null }
    })()`)
    ok(geo?.pos === 'absolute', `${e.label} 根节点是 absolute 定位`, geo?.pos)
    ok(geo?.display === 'flex', `${e.label} 根节点是 flex 纵向排布（标题才不会跟着滚）`, geo?.display)
    ok(geo && Math.abs(geo.pTop - geo.sTop) <= 1, `${e.label} 顶边与 .screen-body 对齐`)
    ok(geo && geo.pW === geo.sW, `${e.label} 宽度铺满可视区`, `${geo?.pW}/${geo?.sW}`)
    /* ★ 关键：底边必须越过导航栏上沿，否则正文最后一段被 tabbar 压住 */
    ok(geo && geo.tTop !== null && geo.pBottom >= geo.tTop, `${e.label} 底边盖过底部导航栏上沿（正文不被压住）`, `panel.bottom=${geo?.pBottom} tabbar.top=${geo?.tTop}`)

    await shoot(A.cdp, `${OUT}/${e.page}.png`)
    await A.js(`window.__back()`)
    ok(await A.waitFor(`window.__onMainMe()`, 5000), `${e.label} 返回后回到「我」页`)
    await A.js(A.help)
  }

  /* ================= 2. 账号与安全：不能有编出来的数据 ================= */
  console.log('\n─── 账号与安全 ───')
  await A.js(`window.__rowTap('账号与安全')`)
  await A.waitFor(`window.__pageTitle() === '账号与安全'`, 5000)
  /* ⚠️ 这一页要先拉设备列表，`loading` 为 true 时只渲染「加载中…」——
     不等它加载完就取文本，会得到一个空页面（然后断言全红）。
     等一个必定在加载完成后才出现的行。 */
  ok(await A.waitFor(`!!window.__row('手机号')`, 8000), '账号与安全加载完成（出现了数据行）')
  await A.js(A.help)

  const secText = await A.js(`document.querySelector('.sub-page, .subpage').textContent`)
  ok(!/138\*{0,4}6721/.test(secText), '不再出现硬编码的手机号 138****6721')
  /* 手机号现在**库里真有** phone 字段（users.phone，编辑资料页真保存），
     安全页如实显示脱敏值或「未填写」—— 反过来，绝不能再出现
     「数据库中没有手机号字段」这句**谎话**（它曾经是对的，字段加进来后就过时了）。 */
  ok(/数据库中没有手机号字段/.test(secText) === false, '手机号不再谎称「库里没有字段」（字段已存在）')
  ok(/未填写|\*{4}/.test(secText), '手机号行如实显示（未填写 / 脱敏形态）', secText.match(/手机号[\s\S]{0,24}/)?.[0])
  ok(/数据库中没有邮箱字段/.test(secText), '邮箱如实标注「库里没有字段」')

  /* 密码：从「未接入」升级成真功能 —— 这一行必须**可点**（打开改密码弹层），
     不能再带「未接入」字样。 */
  const pwRow = await A.js(`window.__rowState('密码')`)
  ok(pwRow?.clickable === true, '「密码」这一行真的可点（打开修改密码弹层）', JSON.stringify(pwRow))
  ok(/未接入/.test(pwRow?.sub || '') === false, '密码行不再标注「未接入」', pwRow?.sub)

  /* 点开弹层：三个密码输入框都得在。
     ⚠️ **不要**在这里真的提交 —— 那会把演示账号的密码改掉，
     后面所有自检（以及别人本地跑的种子数据）都会登不进去。
     接口层面的完整验证走 tmp 脚本 / 手工，见 routes/auth.js 的 /me/password。 */
  ok(await A.js(`window.__rowTap('密码')`), '点击「密码」行')
  ok(await A.waitFor(`!!document.querySelector('.sheet-root')`, 5000), '★ 修改密码弹层真的打开')
  const pwFields = await A.js(`(() => {
    const s = document.querySelector('.sheet-root')
    if (!s) return null
    const inputs = [...s.querySelectorAll('input[type=password]')]
    return {
      title: document.querySelector('.sheet-title')?.textContent.trim() || null,
      count: inputs.length,
      hasOld: inputs.some(i => i.id === 'pw-old'),
      hasNew: inputs.some(i => i.id === 'pw-new'),
      hasConfirm: inputs.some(i => i.id === 'pw-confirm'),
      text: s.textContent,
    }
  })()`)
  ok(pwFields?.count === 3 && pwFields.hasOld && pwFields.hasNew && pwFields.hasConfirm,
    '弹层里是「当前 / 新 / 确认」三个密码框', JSON.stringify(pwFields?.count))
  ok(/不会.*强制退出|不会被踢|其它设备/.test(pwFields?.text || ''),
    '如实写明改密码不会踢掉其它设备（JWT 无状态，不假装更安全）', (pwFields?.text || '').slice(0, 60))
  await A.js(`document.querySelector('.sheet-mask')?.click()`)
  await A.waitFor(`!document.querySelector('.sheet-root')`, 5000)
  ok(await A.js(`!document.querySelector('.sheet-root')`), '弹层能关掉')

  const bio = await A.js(`window.__rowState('生物识别')`)
  ok(bio?.hasSwitch && bio.switchDisabled === true, '生物识别开关是 disabled（未接通的开关不能拨）', JSON.stringify(bio))
  ok(/未接入/.test(bio?.sub || ''), '生物识别写明了未接入的原因', bio?.sub)
  const twofa = await A.js(`window.__rowState('二次验证')`)
  ok(twofa?.hasSwitch && twofa.switchDisabled === true, '二次验证开关是 disabled', JSON.stringify(twofa))

  /* 退出登录必须是真的：点了之后回到登录页 */
  ok(await A.js(`window.__rowTap('退出登录')`), '账号与安全页有「退出登录」')
  ok(await A.waitFor(`!!document.querySelector('.lg-card, .login')`, 8000), '★ 退出登录真的退出了（回到登录页，不是只弹提示）')
  await shoot(A.cdp, `${OUT}/logout.png`)

  /* 退出去之后要重新登录，继续后面的检查 */
  await A.boot()
  ok(await A.js(`window.__onMainMe()`), '重新登录回到「我」页')

  /* ================= 3. 隐私设置：动态默认可见范围真的生效 ================= */
  console.log('\n─── 隐私设置 ───')
  await A.js(`window.__rowTap('隐私设置')`)
  await A.waitFor(`window.__pageTitle() === '隐私设置'`, 5000)
  /* 这一页也是先拉后端设置再渲染，等一个加载完才有的行 */
  await A.waitFor(`!!window.__row('默认范围')`, 8000)
  await A.js(A.help)

  const beforeVis = await A.js(`window.__rowValue('默认范围')`)
  /* 循环切换一轮，拿到一个**和当前不同**的值 */
  await A.js(`window.__rowTap('默认范围')`)
  await sleep(500)
  const afterVis = await A.js(`window.__rowValue('默认范围')`)
  ok(afterVis !== beforeVis, '点「默认范围」真的能切换', `${beforeVis} → ${afterVis}`)

  /* 后端核对：设置真的落库了 */
  const visInDb = await (await fetch(`${API}/settings`, { headers: { Authorization: `Bearer ${me.token}` } })).json()
  const VIS_MAP = { 公开: 'public', 仅好友: 'friends', 仅自己: 'private' }
  ok(
    visInDb.moment_visibility === VIS_MAP[afterVis],
    '后端核对：可见范围真的存进 user_settings',
    `${visInDb.moment_visibility} vs ${afterVis}`
  )

  /* ★ 最强的一条：发布面板的初始值必须跟着变。
     以前这一项存得进库、但没人读 —— 只有走完这条链路才能证明它是真的。 */
  await A.js(`window.__back()`)
  await A.waitFor(`window.__onMainMe()`, 5000)
  await A.js(A.help)
  await A.js(`window.__tab(1)`) // 动态
  await A.waitFor(`!!document.querySelector('.moment-filters')`, 10000)
  await sleep(500)
  await A.js(A.help)
  /* 等 MomentTab 把设置拉回来（它有 useEffect 调 getSettings） */
  await sleep(1200)
  await A.js(`document.querySelector('[aria-label="发布动态"]')?.click()`)
  ok(await A.waitFor(`!!document.querySelector('.mc-root')`, 8000), '打开发布面板')
  const scopeOn = await A.js(`document.querySelector('.mc-scope.is-on b')?.textContent.trim()`)
  ok(scopeOn === afterVis, '★ 发布面板的默认可见范围跟着设置变了（这个设置是真生效的）', `面板=${scopeOn} 设置=${afterVis}`)
  await shoot(A.cdp, `${OUT}/privacy-default-scope.png`)
  await A.js(`document.querySelector('.mc-cancel')?.click()`)
  await A.waitFor(`!document.querySelector('.mc-root')`, 5000)

  /* 未接通的项必须禁用 */
  await A.js(`window.__tab(3)`)
  await A.waitFor(`window.__onMainMe()`, 5000)
  await A.js(A.help)
  await A.js(`window.__rowTap('隐私设置')`)
  await A.waitFor(`window.__pageTitle() === '隐私设置'`, 5000)
  await A.waitFor(`!!window.__row('消息加密')`, 8000)
  await A.js(A.help)
  const enc = await A.js(`window.__rowState('消息加密')`)
  ok(enc?.off === true, '★「消息加密」标为未接入（不能显示成「已开启」的假开关）', JSON.stringify(enc))
  const encText = await A.js(`document.querySelector('.sub-page, .subpage').textContent`)
  ok(!/已开启/.test(encText) || /没有实现/.test(encText), '页面上没有「消息加密 · 已开启」这种虚假安全声明')
  /* 仍未接通的项必须禁用。
     ⚠️「在线状态可见」**不在**这个列表里 —— 它已经接通了（见下面那一段），
     继续断言它 disabled 会把一个真功能判成缺陷。 */
  for (const label of ['已读回执', '阅后即焚', '截屏提醒']) {
    const st = await A.js(`window.__rowState(${JSON.stringify(label)})`)
    ok(st?.hasSwitch && st.switchDisabled === true, `${label} 开关是 disabled`, JSON.stringify(st))
  }

  /* 接通了的四项必须**可以拨**。
     「可以拨」和「拨了真的生效」是两件事 —— 生效的端到端验证在 check-privacy.mjs
     （那边用第二个账号证明「关掉之后别人真的搜不到我」），这里先证明它不是死的。 */
  for (const label of ['通过手机号添加', '通过二维码添加', '通过搜索添加', '在线状态可见']) {
    const st = await A.js(`window.__rowState(${JSON.stringify(label)})`)
    ok(st?.hasSwitch && st.switchDisabled === false, `${label} 开关可以拨动（已接通）`, JSON.stringify(st))
  }

  /* 真的拨一下：开关状态要变，而且要**回库确认**落库了。
     只看界面变没变等于只测了 React 的局部状态（以前那些假开关也能通过）。 */
  const visBefore = await A.js(`window.__rowState('在线状态可见').switchOn`)
  await A.js(`window.__row('在线状态可见').querySelector('.switch').click()`)
  await sleep(900)
  const visAfter = await A.js(`window.__rowState('在线状态可见').switchOn`)
  ok(visBefore !== visAfter, '拨「在线状态可见」后开关状态真的翻转了', `${visBefore} -> ${visAfter}`)
  const visDb = db
    .prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'online_status_visible'`)
    .get(me.user.id)
  ok(!!visDb && JSON.parse(visDb.value) === visAfter, '这个状态确实写进了 user_settings', JSON.stringify(visDb))
  /* 拨回去，别把演示账号的在线状态留在「隐身」上 */
  await A.js(`window.__row('在线状态可见').querySelector('.switch').click()`)
  await sleep(900)
  const visBack = await A.js(`window.__rowState('在线状态可见').switchOn`)
  ok(visBack === visBefore, '再拨一次能回到原值（不是只往一个方向生效）', `${visBack} vs ${visBefore}`)
  const shotMsg = await A.js(`document.querySelector('.mc-root, .sub-page, .subpage').textContent`)
  ok(/端到端加密/.test(shotMsg) && /没有实现|没有实现端到端加密/.test(shotMsg), '明确写出「没有实现端到端加密」')
  await A.js(`window.__back()`)
  await A.waitFor(`window.__onMainMe()`, 5000)

  /* ================= 4. 通用设置：字体大小真的改全局 ================= */
  console.log('\n─── 通用设置 ───')
  await A.js(A.help)
  await A.js(`window.__rowTap('通用设置')`)
  await A.waitFor(`window.__pageTitle() === '通用设置'`, 5000)

  const fsBefore = await A.js(`getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim()`)
  const h2Before = await A.js(`getComputedStyle(document.querySelector('.sub-head h2')).fontSize`)
  await A.js(`[...document.querySelectorAll('.font-size-btn')].find(b=>b.textContent.trim()==='大')?.click()`)
  await sleep(500)
  const fsAfter = await A.js(`getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim()`)
  const h2After = await A.js(`getComputedStyle(document.querySelector('.sub-head h2')).fontSize`)
  ok(fsAfter === '1.1', '选「大」后 --font-scale 变成 1.1', fsAfter)
  ok(h2Before !== h2After, '★ 真实字号跟着变了（不是只改了一个变量名）', `${h2Before} → ${h2After}`)
  const savedScale = await A.js(`localStorage.getItem('chatly-font-size')`)
  ok(savedScale === 'large', '字体大小持久化到 localStorage', String(savedScale))

  const enterLabel = await A.js(`window.__settingLabel('回车键发送')`)
  ok(enterLabel === '回车键发送', '开关标签写的是它真的做的事（回车键发送）', String(enterLabel))
  const oldLabelGone = await A.js(`!document.querySelector('.sub-page, .subpage').textContent.includes('发送键回车换行')`)
  ok(oldLabelGone, '不再出现语义相反的旧标签「发送键回车换行」')
  await shoot(A.cdp, `${OUT}/general.png`)
  await A.js(`window.__back()`)
  await A.waitFor(`window.__onMainMe()`, 5000)

  /* ---------- 自动下载图片：正对照 + 开关真的拦住请求 ----------
     先造一条**真实上传**的图片消息（演示库里没有 /uploads 图片消息，
     只有大表情，而大表情走的是另一个组件，试不到这条路径）。
     ⚠️ 不要用「元素不存在」当判据 —— 必须先证明**开关开着时这张图是能显示的**，
        否则「找不到占位」和「图片本来就没渲染出来」分不清。 */
  console.log('\n─── 自动下载图片 ───')
  const pngBytes = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))
  const fd = new FormData()
  fd.append('file', new Blob([pngBytes], { type: 'image/png' }), 'check-me-chat.png')
  const upRes = await fetch(`${API}/messages/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${me.token}` },
    body: fd,
  })
  const upJson = await upRes.json()
  probe.uploadUrl = upJson.url
  ok(upRes.status === 201 && !!probe.uploadUrl, '上传了一张真实图片用于本项验证', String(probe.uploadUrl))

  probe.baselineMsgId = db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM messages').get().n
  const imgMsg = await (
    await fetch(`${API}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${me.token}` },
      body: JSON.stringify({
        conversationId: 2,
        kind: 'image',
        fileUrl: probe.uploadUrl,
        fileName: 'check-me-chat.png',
        fileSize: pngBytes.length,
      }),
    })
  ).json()
  probe.msgIds.push(imgMsg?.message?.id ?? imgMsg?.id)
  ok(!!probe.msgIds[0], '图片消息已发送到私聊会话 #2', String(probe.msgIds[0]))

  const openConv2 = async () => {
    await A.js(`window.__tab(0)`)
    await A.waitFor(`!!document.querySelector('.chat-list')`, 8000)
    await sleep(600)
    await A.js(A.help)
    const clicked = await A.js(`(() => {
      const r = [...document.querySelectorAll('.chat-row')].find(x => x.textContent.includes('陈宇'))
      if (!r) return false
      r.click(); return true
    })()`)
    if (!clicked) return false
    const opened = await A.waitFor(`!!document.querySelector('.room')`, 8000)
    await sleep(900) // 等历史消息拉回来
    return opened
  }

  /* 正对照：开关开着时，图片必须真的显示出来（naturalWidth > 0） */
  await A.js(A.help)
  ok(await openConv2(), '能进入会话 #2')
  const posOk = await A.waitFor(
    `(() => { const im = [...document.querySelectorAll('.img-bubble img')]; return im.length > 0 && im.every(i => i.complete && i.naturalWidth > 0) })()`,
    10000
  )
  const imgCount = await A.js(`document.querySelectorAll('.img-bubble img').length`)
  ok(posOk && imgCount > 0, '★ 正对照：自动下载开着时图片正常显示（naturalWidth > 0）', `img=${imgCount}`)
  await shoot(A.cdp, `${OUT}/img-autoload-on.png`)
  await A.js(`document.querySelector('.rh-back')?.click()`)
  await A.waitFor(`!document.querySelector('.room')`, 6000)

  /* 关掉开关 */
  await A.js(A.help)
  await A.js(`window.__tab(3)`)
  await A.waitFor(`window.__onMainMe()`, 6000)
  await A.js(A.help)
  await A.js(`window.__rowTap('通用设置')`)
  await A.waitFor(`window.__pageTitle() === '通用设置'`, 5000)
  const toggled = await A.js(`(() => {
    const it=[...document.querySelectorAll('.settings-item')].find(x=>x.textContent.includes('自动下载图片'))
    const cb=it?.querySelector('input[type=checkbox]')
    if (!cb) return 'no-cb'
    if (cb.checked) cb.click()
    return cb.checked
  })()`)
  await sleep(400)
  ok(toggled === false, '已把「自动下载图片」关掉', String(toggled))
  ok((await A.js(`localStorage.getItem('chatly-auto-download')`)) === 'false', '设置已持久化到 localStorage')
  await A.js(`window.__back()`)
  await A.waitFor(`window.__onMainMe()`, 5000)

  /* 再进同一个会话：这一次必须出现「点击加载」占位，且**没有发起图片请求** */
  await A.js(A.help)
  ok(await openConv2(), '再次进入会话 #2')
  const lockedShown = await A.waitFor(`!!document.querySelector('[data-testid="img-locked"]')`, 8000)
  ok(lockedShown, '★ 关掉自动下载后，图片显示为「点击加载」占位（开关真的生效了）')
  const noImg = await A.js(`document.querySelectorAll('.img-bubble img').length`)
  ok(noImg === 0, '占位状态下没有 <img> 挂上去（确实没有去下载）', `img=${noImg}`)
  const hint = await A.js(`document.querySelector('.img-lock-hint')?.textContent.trim()`)
  ok(hint === '点击加载图片', '占位上写清了怎么加载', String(hint))
  await shoot(A.cdp, `${OUT}/img-locked.png`)

  /* 点一下要真的能加载出来（不然就只是把图藏了） */
  await A.js(`document.querySelector('[data-testid="img-locked"]')?.click()`)
  const unlockedOk = await A.waitFor(
    `(() => { const im=[...document.querySelectorAll('.img-bubble img')]; return im.length > 0 && im.every(i=>i.complete && i.naturalWidth > 0) })()`,
    10000
  )
  ok(unlockedOk, '★ 点击占位后图片真的加载出来了（不是把图藏了）')
  await shoot(A.cdp, `${OUT}/img-unlocked.png`)
  await A.js(`document.querySelector('.rh-back')?.click()`)
  await A.waitFor(`!document.querySelector('.room')`, 6000)

  /* 把开关还原成开 */
  await A.js(A.help)
  await A.js(`window.__tab(3)`)
  await A.waitFor(`window.__onMainMe()`, 6000)
  await A.js(A.help)
  await A.js(`window.__rowTap('通用设置')`)
  await A.waitFor(`window.__pageTitle() === '通用设置'`, 5000)
  await A.js(`(() => {
    const it=[...document.querySelectorAll('.settings-item')].find(x=>x.textContent.includes('自动下载图片'))
    const cb=it?.querySelector('input[type=checkbox]'); if (cb && !cb.checked) cb.click(); return true
  })()`)
  await sleep(300)
  await A.js(`window.__back()`)
  await A.waitFor(`window.__onMainMe()`, 5000)

  /* ================= 5. 主题外观：动效开关真的挂上 .no-motion ================= */
  console.log('\n─── 主题外观 ───')
  await A.js(A.help)
  await A.js(`window.__tab(3)`)
  await A.waitFor(`window.__onMainMe()`, 6000)
  await A.js(A.help)
  await A.js(`window.__rowTap('主题外观')`)
  /* ⚠️ 这里以前写成 `等待标题 === '外观主题'`（旧名字），改名后**永远等不到** ——
     而 `waitFor` 超时是**静默**的（返回 false 不报错），于是白等 5 秒还全绿。
     凡是「等某个状态」都必须落到一条 `ok(...)` 上，否则就是假绿。 */
  const themeTitleOk = await A.waitFor(`window.__pageTitle() === '主题外观'`, 5000)
  ok(themeTitleOk, '子页标题与入口同名（「主题外观」，不是「外观主题」）', String(await A.js(`window.__pageTitle()`)))
  await A.js(A.help)

  ok((await A.js(`document.querySelector('.sec-action')`)) === null, '「使用中」不再是假按钮（改成纯文字说明）')
  ok((await A.js(`!!document.querySelector('.sec-hint')`)) === true, '「使用中」以纯文字 hint 呈现')
  for (const label of ['聊天背景', '气泡颜色', '强调色']) {
    const st = await A.js(`window.__rowState(${JSON.stringify(label)})`)
    ok(st?.off === true, `${label} 标为未接入（不再点了只弹 toast）`, JSON.stringify(st))
  }
  /* 判据要写成「有『未接入』的徽标 **且** 页面上写着未接入」。
     原来的 `!querySelector('.tag-off') || …` 前半段会让「一个徽标都没渲染」也通过
     —— 那正是最该失败的情形。 */
  ok(
    (await A.js(`document.querySelectorAll('.tag-off').length >= 3`)) === true &&
      (await A.js(`document.querySelector('.sub-page, .subpage').textContent.includes('未接入')`)) === true,
    '主题外观页把未接入的三项都标了出来',
  )

  const motionOn = await A.js(`!document.documentElement.classList.contains('no-motion')`)
  ok(motionOn, '动效开关初始为开（未挂 .no-motion）')
  await A.js(`(() => { const r=window.__row('动效开关'); r?.querySelector('.switch')?.click(); return true })()`)
  await sleep(400)
  ok(await A.js(`document.documentElement.classList.contains('no-motion')`), '★ 关掉动效后 <html> 真的挂上了 .no-motion')
  ok((await A.js(`localStorage.getItem('chatly-motion')`)) === 'off', '动效偏好已持久化')
  /* 动画真的被停掉：读实际生效的动画时长。
     ⚠️ 浏览器会把 `0.001ms` 归一化成 `1e-06s`，所以**不能**拿字面量比 ——
        按秒解析再判断「短到看不见」，换任何一台机器都成立。 */
  const animInfo = await A.js(`(() => {
    const el = document.querySelector('.theme-card') || document.querySelector('.sub-head')
    if (!el) return null
    const cs = getComputedStyle(el)
    return { dur: cs.animationDuration, trans: cs.transitionDuration }
  })()`)
  const secs = (v) => parseFloat(String(v || '').replace('s', ''))
  ok(
    animInfo && secs(animInfo.dur) <= 0.001 && secs(animInfo.trans) <= 0.001,
    '全站动画与过渡时长被压到不可见（≤ 0.001s）',
    JSON.stringify(animInfo)
  )
  await shoot(A.cdp, `${OUT}/theme-no-motion.png`)

  /* 还原成开 */
  await A.js(`(() => { const r=window.__row('动效开关'); r?.querySelector('.switch')?.click(); return true })()`)
  await sleep(300)
  ok(!(await A.js(`document.documentElement.classList.contains('no-motion')`)), '再点一下能恢复动效（双向可用）')
  await A.js(`window.__back()`)
  await A.waitFor(`window.__onMainMe()`, 5000)

  /* ================= 6. 帮助与反馈 ================= */
  console.log('\n─── 帮助与反馈 ───')
  await A.js(A.help)
  await A.js(`window.__rowTap('帮助与反馈')`)
  await A.waitFor(`window.__pageTitle() === '帮助与反馈'`, 5000)
  await sleep(500)
  await A.js(A.help)

  /* 逐条展开读全文（单开手风琴，不能全点一遍） */
  const faqText = await A.js(`window.__allFaqText()`)
  const helpText = (await A.js(`document.querySelector('.sub-page, .subpage').textContent`)) + '\n' + faqText
  ok((faqText || '').length > 200, 'FAQ 答案逐条展开成功（答案文本进入了 DOM）', `${(faqText || '').length} 字符`)
  /* FAQ 必须和实现对得上 —— 这几条以前都是错的 */
  ok(!/仅支持 ?2 ?分钟内/.test(helpText), 'FAQ 不再谎称「撤回仅支持 2 分钟内」（服务端没有时间窗）')
  ok(!/将使用端到端加密/.test(helpText), '★ FAQ 不再谎称「开启后新会话将使用端到端加密」')
  ok(!/长按消息 ?→「?转发」?/.test(helpText), 'FAQ 不再教人「长按 → 转发」（转发是禁用态）')
  ok(!/点击右下角「?\+」?/.test(helpText), 'FAQ 不再说发布按钮在右下角（实际在右上角）')
  ok(!/更换手机号？[\s\S]{0,60}验证原手机号/.test(helpText), 'FAQ 不再教人换手机号（没有该字段）')
  ok(/未接入/.test(helpText), 'FAQ 对未实现的能力明确写「未接入」')
  ok(/不是。消息以明文存储/.test(helpText), 'FAQ 如实说明没有端到端加密')

  /* 提交一条反馈（带截图），并回库核对 */
  const desc = `${TAG} 反馈表单可用性`
  await A.js(`(() => {
    const ta = document.querySelector('.form-textarea')
    const proto = HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(ta, ${JSON.stringify(desc)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return ta.value.includes('反馈表单可用性')
  })()`).then((v) => ok(v, '问题描述能输入'))

  /* 注入一张真 PNG —— 走完整的表单上传路径（不是直接调接口） */
  const injected = await A.js(`(() => {
    const label = document.querySelector('.screenshot-upload')
    if (!label) return 'no-label'
    const input = label.querySelector('input[type=file]')
    if (!input) return 'no-input'
    const bin = atob(${JSON.stringify(PNG_B64)})
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const file = new File([bytes], 'check-me.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return input.files.length
  })()`)
  ok(injected === 1, '截图文件注入成功', String(injected))
  ok(await A.waitFor(`!!document.querySelector('.upload-area.is-picked')`, 4000), '选中后出现「已选」状态与移除按钮')

  await A.js(`document.querySelector('.submit-btn')?.click()`)
  ok(await A.waitFor(`!!document.querySelector('.form-hint.is-ok')`, 12000), '提交成功后有如实的结果说明')

  const row = db.prepare('SELECT * FROM feedbacks WHERE description = ?').get(desc)
  ok(!!row, '★ 反馈真的落库了（回 SQLite 查得到）', row ? `id=${row.id}` : '没查到')
  ok(row?.type === 'bug', '问题类型正确落库', String(row?.type))
  ok(!!row?.screenshot_url, '截图地址落库', String(row?.screenshot_url))
  if (row?.screenshot_url) {
    const p = `D:/BS-chat-os/server/uploads/${row.screenshot_url.split('/').pop()}`
    ok(fs.existsSync(p), '★ 截图文件真的在磁盘上（不是只存了个地址）', p)
  }
  await shoot(A.cdp, `${OUT}/help-submitted.png`)
  await A.js(`window.__back()`)
  await A.waitFor(`window.__onMainMe()`, 5000)

  /* ================= 7. 控制台 ================= */
  console.log('\n─── 控制台 ───')
  const consoleIssues = A.issues.filter((s) => !/favicon|Failed to load resource: the server responded with a status of 404/i.test(s))
  ok(consoleIssues.length === 0, '全程无 console 报错 / 未捕获异常', consoleIssues.slice(0, 4).join(' | '))
  if (consoleIssues.length) console.log(consoleIssues.map((s) => '   · ' + s).join('\n'))
} catch (e) {
  /* ⚠️ 必须把中断原因打出来。以前这里没有 catch，
     异常被 finally 里的 `process.exit()` 直接吞掉 —— 屏幕上只看到
     「收尾」然后退出，**完全不知道死在哪一步**，而收尾还照样跑了。 */
  failures++
  console.error(`\n💥 自检中断：${e && e.message ? e.message : e}`)
  if (e && e.stack) console.error(String(e.stack).split('\n').slice(1, 4).join('\n'))
} finally {
  /* ================= 收尾 ================= */
  console.log('\n─── 收尾 ───')
  /* ⚠️⚠️ 临时消息只能按**已捕获的基线 id** 删，基线没有就**一条都不删**。
     这里踩过一次真实的坑：脚本在某一步抛错 → 走到收尾时
     `probe.baselineMsgId` 还是初值 0 → `DELETE FROM messages WHERE id > 0`
     **把演示库的消息全删了**（67 条）。
     「删除范围 = 基线之后」这种写法，基线一旦没有意义就变成「删除全部」，
     所以必须先判基线本身是否可用。 */
  if (!probe.baselineMsgId) {
    console.log('⚠️ 本轮没有捕获到消息基线（脚本在造数据之前就退出了）—— 跳过消息清理，不做任何删除')
  } else {
    try {
      const killed = db.prepare('DELETE FROM messages WHERE id > ?').run(Number(probe.baselineMsgId)).changes
      console.log(`已清理本轮消息 ${killed} 条（id > ${probe.baselineMsgId}）`)
    } catch (e) {
      console.log('清理消息失败：' + e.message)
    }
  }
  try {
    if (probe.uploadUrl) {
      const p = `D:/BS-chat-os/server/uploads/${probe.uploadUrl.split('/').pop()}`
      if (fs.existsSync(p)) {
        fs.unlinkSync(p)
        console.log('已删除临时上传的图片')
      }
    }
  } catch (e) {
    console.log('删除临时图片失败（可在清理脚本里回收）：' + e.message)
  }
  try {
    /* 只删本轮新增的反馈行（按基线 id） */
    const now = db.prepare('SELECT id FROM feedbacks').all().map((r) => r.id)
    const fresh = now.filter((id) => !baselineFeedbackIds.includes(id))
    if (fresh.length) {
      db.prepare(`DELETE FROM feedbacks WHERE id IN (${fresh.map(() => '?').join(',')})`).run(...fresh)
    }
    console.log(`已清理本轮反馈 ${fresh.length} 条（基线之外的新增）`)
  } catch (e) {
    console.log('清理反馈失败：' + e.message)
  }
  /* 把可见范围还原成原来的值（不然演示库的默认范围被自检改掉了） */
  try {
    if (settingsBefore.moment_visibility) {
      await fetch(`${API}/settings/moment_visibility`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${me.token}` },
        body: JSON.stringify({ value: settingsBefore.moment_visibility }),
      })
      console.log(`已还原动态默认可见范围 → ${settingsBefore.moment_visibility}`)
    }
  } catch {}
  /* 前端 localStorage 也还原（字体 / 自动下载 / 动效），别把演示环境改花 */
  try {
    await A.js(`localStorage.setItem('chatly-font-size','standard'); localStorage.setItem('chatly-auto-download','true'); localStorage.setItem('chatly-motion','on'); 1`)
    console.log('已还原前端偏好（字体标准 / 自动下载开 / 动效开）')
  } catch {}
  try { A.cdp.close() } catch {}
  try { A.proc.kill() } catch {}

  console.log(
    failures
      ? `\n❌ 「我」页设置自检有失败项 —— ${pass} 通过 / ${failures} 失败`
      : `\n✅ 「我」页设置自检全部通过 —— ${pass} 通过 / 0 失败`,
  )
  process.exit(failures ? 1 : 0)
}
