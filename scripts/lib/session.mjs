/**
 * 自检脚本共用：用 API 登录并注入 token，绕开登录 UI。
 *
 * 背景：登录页已改成「手机号/邮箱 + 验证码」，原来的 `.lg-demo-list` 演示账号列表
 * 已经从 UI 删除，但多个自检脚本还在点它 → 登录不成功 → 后面全部取到 null。
 * 这里统一改成：POST /auth/login 拿 token → 写入 localStorage['chatly.token'] → reload。
 *
 * 用法：脚本里已有 js/ev 求值器时，直接调用 ensureLoggedIn(js) 即可；
 * 本文件位于 scripts/lib，从 scripts/ 下的脚本按相对路径引入。
 */
import http from 'node:http'

const API = process.env.CHATLY_API || 'http://127.0.0.1:3002'
const DEFAULT_USER = process.env.CHATLY_DEMO_USER || 'chenmo'
const DEFAULT_PASS = process.env.CHATLY_DEMO_PASS || 'chatly123'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = JSON.stringify(body)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(d))
          } catch {
            reject(new Error('登录接口返回非 JSON：' + d.slice(0, 200)))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

/** 用用户名/手机号 + 密码登录，返回 token */
export async function loginApi(identifier = DEFAULT_USER, password = DEFAULT_PASS) {
  const out = await postJson(`${API}/api/v1/auth/login`, { identifier, password })
  if (!out || !out.token) throw new Error('API 登录失败：' + JSON.stringify(out).slice(0, 200))
  return out.token
}

async function safe(js, expr, fallback = undefined) {
  try {
    return await js(expr)
  } catch {
    return fallback
  }
}

async function waitFor(js, expr, timeout = 30000, every = 300) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await safe(js, expr, false)) return true
    await sleep(every)
  }
  return false
}

/** 等「应用主界面」或「登录页」出现（用于判断页面是否已挂载） */
export async function waitAppOrLogin(js, timeout = 30000) {
  return waitFor(js, `!!document.querySelector('.tabbar, .chat-list .chat-row, .lg-card, .login')`, timeout)
}

/**
 * 保证已登录：
 *   已在主界面 → 返回 'already'（不打扰当前状态）；
 *   在登录页   → API 登录 → 注入 token → reload → 等主界面 → 返回 'seeded'。
 */
export async function ensureLoggedIn(js, { identifier = DEFAULT_USER, password = DEFAULT_PASS } = {}) {
  await waitAppOrLogin(js)
  if (await safe(js, `!!document.querySelector('.tabbar, .chat-list .chat-row')`, false)) {
    // 已在主界面，但必须是「指定的那个人」——profile 里可能残留别人的 token。
    const current = await safe(
      js,
      `(async()=>{try{const t=localStorage.getItem('chatly.token'); if(!t) return null; const r=await fetch('/api/v1/auth/me',{headers:{Authorization:'Bearer '+t}}); if(!r.ok) return null; const d=await r.json(); return (d&&d.user&&(d.user.username||d.user.phone))||null}catch(e){return null}})()`,
      null
    )
    if (current && (current === identifier || String(current).includes(identifier))) return 'already'
  }

  const token = await loginApi(identifier, password)
  let seeded = false
  for (let i = 0; i < 50; i++) {
    try {
      await js(`localStorage.setItem('chatly.token', ${JSON.stringify(token)}); 'ok'`)
      if ((await js(`localStorage.getItem('chatly.token')`)) === token) {
        seeded = true
        break
      }
    } catch {}
    await sleep(200)
  }
  if (!seeded) throw new Error('注入登录令牌失败（localStorage 不可写）')

  await safe(js, 'location.reload()', null)
  const mounted = await waitFor(js, `!!document.querySelector('.tabbar, .chat-list .chat-row')`, 30000)
  if (!mounted) throw new Error('注入令牌后应用未挂载')
  return 'seeded'
}
