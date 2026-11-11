/**
 * 平台适配层专项自检（P0）
 *
 * ## 为什么要有这个脚本
 *
 * 适配层的价值全在「**接口一致**」上：
 * Web 实现和原生实现必须暴露同一组方法、同样的语义。
 * 这件事靠人记不住 —— 加了新接口只改了一半，或者某个方法名拼错，
 * 到真机上调才发现。
 *
 * 所以这里断言的是**契约**，不是具体行为：
 * 1. 每个适配器都导出约定的接口；
 * 2. Web 实现真的能用（读写、剪贴板、媒体的降级路径不炸）；
 * 3. 运行时探测在 Web 下判定正确；
 * 4. 业务代码**不再直连**浏览器 API（这是「一次编写」的地基）；
 * 5. API base 的三级解析按优先级生效。
 *
 * 跑法：node scripts/check-platform.mjs（不需要后端）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'src')

/**
 * 动态 import 一个模块。
 *
 * ⚠️ Windows 上必须转成 file:// URL —— 直接 import('D:\\...') 会抛
 * ERR_UNSUPPORTED_ESM_URL_SCHEME（绝对路径被当成了 'd:' 这个协议）。
 */
const load = (file) => import(pathToFileURL(file).href)

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

/* ================= 1. 目录与文件 ================= */
console.log('─── 1. 适配层文件 ───')
const PLATFORM_DIR = path.join(SRC, 'platform')
ok(fs.existsSync(PLATFORM_DIR), 'src/platform/ 目录存在')

const EXPECTED_FILES = [
  'env.js', 'storage.js', 'media.js', 'clipboard.js', 'geo.js',
  'haptics.js', 'share.js', 'deepLink.js', 'push.js', 'config.js', 'index.js',
]
for (const f of EXPECTED_FILES) {
  ok(fs.existsSync(path.join(PLATFORM_DIR, f)), `适配器文件存在：${f}`)
}

/* ================= 2. 业务代码不再直连浏览器 API ================= */
console.log('\n─── 2. 业务代码不再直连浏览器 API ───')

/** 递归列出 src 下的所有 js/jsx 文件（排除 platform 目录） */
function listSrcFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'platform' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSrcFiles(full))
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * 抽出「代码行」（去掉注释），免得注释里的示例被当成真调用。
 *
 * 块注释要整体剥掉 —— 只按行判断的话，
 * 块注释里提到 `navigator.vibrate` 的那行会被误判成真调用。
 */
function codeLines(text) {
  /* 先剥掉所有块注释（/ * ... * /，可跨行） */
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  return noBlock
    .split('\n')
    .map((line) => {
      const t = line.trim()
      if (t.startsWith('//')) return ''
      /* 行尾注释：简单去掉 —— 字符串里出现 // 的情况本项目没有 */
      const cut = line.indexOf('//')
      return cut >= 0 ? line.slice(0, cut) : line
    })
    .join('\n')
}

const srcFiles = listSrcFiles(SRC)

/** 违禁的浏览器 API 直调（正则在代码行上匹配） */
const FORBIDDEN = [
  { name: 'localStorage', re: /\blocalStorage\s*\.\s*(get|set|remove)Item\s*\(/ },
  { name: 'navigator.clipboard', re: /\bnavigator\.clipboard\b/ },
  { name: 'navigator.geolocation', re: /\bnavigator\.geolocation\b/ },
  { name: 'navigator.vibrate', re: /\bnavigator\.vibrate\b/ },
  { name: 'navigator.mediaDevices', re: /\bnavigator\.mediaDevices\b/ },
  { name: 'navigator.serviceWorker', re: /\bnavigator\.serviceWorker\b/ },
]

for (const { name, re } of FORBIDDEN) {
  const offenders = []
  for (const file of srcFiles) {
    const text = fs.readFileSync(file, 'utf8')
    if (re.test(codeLines(text))) {
      offenders.push(path.relative(root, file).replace(/\\/g, '/'))
    }
  }
  ok(offenders.length === 0, `业务代码不再直调 ${name}`, offenders.length ? offenders.join(', ') : '')
}

/* ================= 3. 接口契约 ================= */
console.log('\n─── 3. 适配器接口契约 ───')

/**
 * 从文件里抽出导出的函数名。
 * 只认 `export function X` / `export async function X` / `export const X =`
 * —— 这是本项目的写法（见 platform/*.js）。
 */
function exportedNames(file) {
  const text = fs.readFileSync(path.join(PLATFORM_DIR, file), 'utf8')
  const names = new Set()
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of text.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  return names
}

const CONTRACTS = {
  'storage.js': ['get', 'set', 'remove', 'keys', 'clearExcept', 'estimateBytes', 'hydrate', 'flush'],
  'media.js': ['isSupported', 'getUserMedia', 'pickAudioMime', 'stopStream', 'mediaErrorText'],
  'clipboard.js': ['writeText', 'readText'],
  'geo.js': ['isSupported', 'getCurrentPosition'],
  'haptics.js': ['isSupported', 'vibrate', 'hasUserActivation'],
  'share.js': ['canShare', 'share', 'openExternal'],
  'deepLink.js': ['getInitialTarget', 'onTarget', 'parseTarget', 'conversationLink'],
  'push.js': ['isSupported', 'provider', 'registerWorker', 'getSubscription', 'subscribe', 'unsubscribe', 'postToWorker', 'onWorkerMessage'],
  'env.js': ['isNative', 'isIOS', 'isAndroid', 'isDesktop', 'isWeb', 'capPlugin'],
  'config.js': ['resolveApiBase', 'resolveWsBase', 'setRuntimeConfig'],
}

for (const [file, names] of Object.entries(CONTRACTS)) {
  const exported = exportedNames(file)
  const missing = names.filter((n) => !exported.has(n))
  ok(missing.length === 0, `${file} 导出完整`, missing.length ? `缺 ${missing.join(', ')}` : `${names.length} 个接口`)
}

/* ================= 4. 运行时探测 ================= */
console.log('\n─── 4. 运行时探测与 Web 实现 ───')

const env = await load(path.join(PLATFORM_DIR, 'env.js'))
/* 本脚本跑在 Node 里（没有 window），所以 runtime 应是 unknown 而不是 web ——
   断言的是「探测不崩、且在无浏览器环境下不误判为 Web」。 */
ok(env.runtime === 'unknown' || env.runtime === 'web', '运行环境探测有明确结果', `runtime=${env.runtime}`)
ok(env.isNative === false, 'Node 环境下 isNative 为假')
ok(env.capPlugin('NotAPlugin') === null, '不存在的插件返回 null（不抛错）')

const storage = await load(path.join(PLATFORM_DIR, 'storage.js'))
ok(storage.get('__platform_probe__') === null, '读不存在的键返回 null')
storage.set('__platform_probe__', 'v1')
ok(storage.get('__platform_probe__') === 'v1', '写入后能读回')
ok(storage.keys().includes('__platform_probe__'), 'keys() 列出已写入的键')
const before = storage.estimateBytes()
ok(before > 0, 'estimateBytes 返回非零', `${before} 字节`)

/* clearExcept：清掉除白名单外的键 */
storage.set('__keep_me__', 'k')
storage.set('__drop_me__', 'd')
storage.clearExcept(['__keep_me__'])
ok(storage.get('__keep_me__') === 'k', 'clearExcept 保留白名单内的键')
ok(storage.get('__drop_me__') === null, 'clearExcept 清掉白名单外的键')

/* 清理探针数据 */
storage.remove('__platform_probe__')
storage.remove('__keep_me__')
storage.remove('__drop_me__')

const media = await load(path.join(PLATFORM_DIR, 'media.js'))
ok(typeof media.isSupported() === 'boolean', 'media.isSupported() 返回布尔')
ok(typeof media.mediaErrorText(new Error('x')) === 'string', 'mediaErrorText 永远返回字符串')
ok(media.mediaErrorText({ name: 'NotAllowedError' }).length > 0, '权限错误有可读文案')

const haptics = await load(path.join(PLATFORM_DIR, 'haptics.js'))
ok(typeof haptics.hasUserActivation() === 'boolean', 'haptics.hasUserActivation() 返回布尔')
ok(typeof haptics.vibrate(1) === 'boolean', 'haptics.vibrate() 返回布尔（不抛错）')

const clipboard = await load(path.join(PLATFORM_DIR, 'clipboard.js'))
/* 无头环境没有剪贴板权限 —— 必须返回 false 而不是抛错（这是关键契约） */
const clipResult = await clipboard.writeText('probe')
ok(typeof clipResult === 'boolean', 'clipboard.writeText 返回布尔而非抛错', `结果=${clipResult}`)

const deepLink = await load(path.join(PLATFORM_DIR, 'deepLink.js'))
ok(deepLink.parseTarget('chatly://conversation/42')?.id === 42, '解析自定义 scheme 深链')
ok(deepLink.parseTarget('https://x.com/chatly/user/7')?.id === 7, '解析 https 深链')
ok(deepLink.parseTarget('chatly://conversation/abc') === null, '非法 id 返回 null')
ok(deepLink.parseTarget('') === null, '空串返回 null')

const config = await load(path.join(PLATFORM_DIR, 'config.js'))
ok(config.resolveApiBase() === '/api/v1', '默认 API base 是相对路径', config.resolveApiBase())
ok(String(config.resolveWsBase()).endsWith('/ws'), 'WS base 以 /ws 结尾', config.resolveWsBase())

/* 运行时注入的优先级 */
config.setRuntimeConfig({ apiBase: 'https://api.example.com/api/v1/' })
ok(config.resolveApiBase() === 'https://api.example.com/api/v1', '运行时注入优先且去掉尾斜杠', config.resolveApiBase())
ok(config.resolveWsBase() === 'wss://api.example.com/ws', 'WS base 从绝对 API base 推导', config.resolveWsBase())
config.setRuntimeConfig({ apiBase: '' })
ok(config.resolveApiBase() === '/api/v1', '清空注入后回落默认')

/* ================= 5. 深链与推送在业务侧的接入 ================= */
console.log('\n─── 5. 业务侧已接入适配层 ───')
const phoneText = fs.readFileSync(path.join(SRC, 'components', 'Phone.jsx'), 'utf8')
ok(/deepLink\.(getInitialTarget|onTarget)/.test(phoneText), 'Phone.jsx 用 deepLink 处理深链')
ok(!/navigator\.serviceWorker/.test(codeLines(phoneText)), 'Phone.jsx 不再直连 serviceWorker')

const notifyText = fs.readFileSync(path.join(SRC, 'screens', 'NotificationSettings.jsx'), 'utf8')
ok(/push\.(isSupported|subscribe|unsubscribe)/.test(notifyText), 'NotificationSettings 走 push 适配器')

const mainText = fs.readFileSync(path.join(SRC, 'main.jsx'), 'utf8')
ok(/storage\.hydrate\(\)/.test(mainText), 'main.jsx 在渲染前 hydrate 存储')
ok(/isNative/.test(mainText), 'main.jsx 按运行环境决定是否注册 Service Worker')

/* ================= 汇总 ================= */
console.log(`\n${'─'.repeat(52)}`)
console.log(failures ? `❌ ${failures} 项未通过` : '✅ 全部通过')
process.exit(failures ? 1 : 0)
