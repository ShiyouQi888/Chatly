/**
 * 原生壳（Capacitor）跨域支持。
 *
 * ## 为什么 Web 端不需要、原生壳需要
 *
 * Web 端所有请求都是同源的 `/api/v1`，由 Vite dev proxy（开发）或同源部署（生产）
 * 转发到后端，浏览器根本不会发预检。
 *
 * 原生壳里页面由 WebView 从 `http://localhost` 加载，而 API 指向
 * `http://10.0.2.2:3002/api/v1`（模拟器）或局域网 IP（真机）—— **跨域**。
 * 带 `Authorization` 头的请求会先发 OPTIONS 预检，不显式放行的话
 * 浏览器在预检阶段就把请求挡掉，界面表现为「一直转圈 / 登录失败」，
 * 而后端日志里连一条请求都看不到（最难查的那种）。
 *
 * ## 白名单而不是 `*`
 *
 * 只对 Capacitor 的已知 origin 放行，其它来源一律不加 CORS 头
 * （等于保持原来的同源策略）。用 `*` 会把任意网站都能带 token 调接口
 * 这件事变成默认行为 —— 即使现在 fetch 不带 credentials，也不该开这个口子。
 *
 * 自定义：`NATIVE_CORS_ORIGINS=https://example.com,http://192.168.1.20`
 */

/** Capacitor 在 iOS / Android / 不同 scheme 下会用的 origin */
const DEFAULT_ORIGINS = [
  'http://localhost',
  'https://localhost',
  'capacitor://localhost',
  'http://127.0.0.1',
  'https://127.0.0.1',
]

function allowedOrigins() {
  const custom = String(process.env.NATIVE_CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return custom.length ? custom : DEFAULT_ORIGINS
}

/**
 * Express 中间件。放在所有路由之前（express.json 之前即可）。
 * 不在白名单里的请求直接 next()，行为与加这个中间件之前完全一致。
 */
export function nativeCors(req, res, next) {
  const origin = req.headers.origin
  if (!origin || !allowedOrigins().includes(origin)) return next()

  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Max-Age', '600')

  if (req.method === 'OPTIONS') return res.sendStatus(204)
  return next()
}
