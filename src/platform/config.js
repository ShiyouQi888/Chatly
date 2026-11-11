/**
 * 运行时配置 —— 原生壳能连上后端的前提。
 *
 * ## 为什么需要
 *
 * 现有代码里 API 地址是**相对路径**（`/api/v1`），靠 Vite 的 dev proxy
 * 转发到 `127.0.0.1:3002`。这对浏览器成立，但**对原生壳不成立**：
 *
 * - 壳里加载的是 `capacitor://localhost`（或 `https://localhost`），
 *   相对路径会指向壳自己的资源目录，请求直接失败。
 * - 原生壳没有 dev server，生产包里必须指向真实后端地址。
 *
 * ## 三级解析（优先级从高到低）
 *
 * 1. **运行时注入**：`window.__CHATLY_CONFIG__.apiBase`
 *    —— 原生壳在启动时用 `capacitor.config.ts` 里的配置写进来；
 *    也可以在 `index.html` 里内联，覆盖不同部署环境。
 * 2. **构建期环境变量**：`import.meta.env.VITE_API_BASE`
 *    —— Docker 部署时用构建参数注入同一份后端地址。
 * 3. **默认相对路径**：`/api/v1`
 *    —— 本地开发与「前后端同源部署」场景。
 *
 * ## 注意 WebSocket 地址
 *
 * WS 地址由 `wsUrl()` 单独推导（基于 `location`），不走这里。
 * 原生壳里 `location.host` 是壳自己的地址，所以 `wsUrl()` 也必须
 * 按同一套规则解析，见 `api/client.js` 的 `wsUrl()`。
 */

/**
 * 运行时配置容器。
 *
 * ⚠️ **不能在这里做模块级快照** —— 原生壳是在**应用启动之后**才把配置写进来的
 * （`cap.addListener('appUrlOpen')` 前后都可能），模块加载时快照下来的
 * 永远空值。所以每次读都现取，写也写到同一个对象上。
 *
 * 无 window 的环境（Node 跑自检脚本时）用模块级对象兜底，
 * 这样 `setRuntimeConfig()` 在任何环境都能验证。
 */
const fallbackConfig = {}

function runtimeConfig() {
  if (typeof window === 'undefined') return fallbackConfig
  if (!window.__CHATLY_CONFIG__) window.__CHATLY_CONFIG__ = {}
  return window.__CHATLY_CONFIG__
}

/**
 * 解析 API 基础地址。
 *
 * @returns {string} 不带尾斜杠的 base
 */
export function resolveApiBase() {
  const injected = String(runtimeConfig().apiBase || '').trim()
  if (injected) return stripTrailingSlash(injected)

  const env = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_API_BASE : ''
  if (env) return stripTrailingSlash(String(env))

  return '/api/v1'
}

/**
 * 解析 WebSocket 地址。
 *
 * 原生壳里 `location.host` 不可用（那是壳的地址），
 * 必须从 API base 反推 —— 所以这里**依赖 apiBase 已经解析完成**。
 *
 * @returns {string} 形如 `wss://host/ws?ticket=xxx`
 */
export function resolveWsBase() {
  const apiBase = resolveApiBase()

  /* 相对路径 → 同源 WS */
  if (apiBase.startsWith('/')) {
    const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = typeof location !== 'undefined' ? location.host : '127.0.0.1:5198'
    return `${protocol}//${host}/ws`
  }

  /* 绝对地址 → 按 http/https 换成 ws/wss */
  let url
  try {
    url = new URL(apiBase)
  } catch {
    return 'ws://127.0.0.1:3002/ws'
  }
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${url.host}/ws`
}

/**
 * 去掉尾斜杠。
 *
 * @param {string} value
 * @returns {string}
 */
function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

/**
 * 在原生壳里注入运行时配置。
 *
 * Capacitor 壳可以在 `capacitor.config.ts` 里配 `server.url`，
 * 但那只对「连本地开发服务器」有用。生产环境要指向真实后端，
 * 做法是在壳启动时把地址写进 `window.__CHATLY_CONFIG__`。
 *
 * @param {{ apiBase?: string }} config
 */
export function setRuntimeConfig(config) {
  Object.assign(runtimeConfig(), config || {})
}
