/**
 * Android 产物静态自检 —— 不需要模拟器 / 真机。
 *
 * 真机调试之前能查的都在这里查完，避免「装上去一直转圈」才知道
 * API 地址没打进包里：
 *   1. 原生配置：WebView scheme / mixed content / 明文流量 / INTERNET 权限；
 *   2. 后端：CORS 中间件确实被接入了；
 *   3. APK：存在、体积正常、签名有效；
 *   4. **包内** Web 资产：index.html 引用的 bundle 都在，且 bundle 里带着
 *      绝对 API 地址（只查 dist 不够 —— cap sync 可能失败而 dist 是对的）。
 *
 * 依赖 `unzip`（Git Bash / Linux / macOS 自带）。apksigner 存在时顺便验签，
 * 没有就跳过这一条，不影响其它断言。
 *
 * 跑法：node scripts/check-android.mjs
 *      CHATLY_ANDROID_API=http://192.168.1.20:3002/api/v1 node scripts/check-android.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apk = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
const apiBase = String(process.env.CHATLY_ANDROID_API || 'http://10.0.2.2:3002/api/v1').trim()

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const unzip = (args) => spawnSync('unzip', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

console.log(`Chatly Android 产物自检 · 期望 API = ${apiBase}\n`)

/* ---------- 1. 原生配置 ---------- */
console.log('─── 1. 原生配置 ───')
const capConfigPath = path.join(root, 'capacitor.config.json')
ok(fs.existsSync(capConfigPath), 'capacitor.config.json 存在')
let cap = {}
try { cap = JSON.parse(read(capConfigPath)) } catch { /* 下面会逐项报错 */ }
ok(cap.webDir === 'dist', 'webDir 指向 Vite 的 dist', String(cap.webDir))
ok(cap.server?.androidScheme === 'http', 'WebView 用 http scheme（本地 http 后端不算 mixed content）', String(cap.server?.androidScheme))
ok(cap.android?.allowMixedContent === true, '已开启 allowMixedContent')

const manifest = read(path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'))
ok(/android:usesCleartextTraffic="true"/.test(manifest), 'AndroidManifest 允许明文 HTTP（本地后端）')
ok(/android\.permission\.INTERNET/.test(manifest), 'AndroidManifest 声明了 INTERNET 权限')
ok(
  /import \{ nativeCors \}/.test(read(path.join(root, 'server', 'src', 'index.js'))) &&
    /app\.use\(nativeCors\)/.test(read(path.join(root, 'server', 'src', 'index.js'))),
  '后端已接入原生壳 CORS 中间件'
)

/* ---------- 2. APK ---------- */
console.log('\n─── 2. APK 产物 ───')
ok(fs.existsSync(apk), 'debug APK 已生成', apk)
const size = fs.existsSync(apk) ? fs.statSync(apk).size : 0
ok(size > 1024 * 1024, 'APK 体积正常（> 1MB）', `${(size / 1024 / 1024).toFixed(1)} MB`)
if (!fs.existsSync(apk)) {
  console.log('\n❌ APK 不存在，后续包内断言跳过。先跑 npm run android:build && cd android && gradlew assembleDebug')
  process.exit(1)
}

const listing = unzip(['-Z1', apk])
ok(listing.status === 0, 'APK 是可读的 zip', listing.status !== 0 ? (listing.stderr || '').slice(0, 120) : '')
const entries = String(listing.stdout || '').split(/\r?\n/)
const htmlEntry = 'assets/public/index.html'
ok(entries.includes(htmlEntry), '包内有 index.html')

const html = String(unzip(['-p', apk, htmlEntry]).stdout || '')
const refs = [...html.matchAll(/assets\/([^"']+\.js)/g)].map((m) => m[1])
ok(refs.length > 0, 'index.html 引用了 JS bundle', refs.join(', '))

const bundles = entries.filter((e) => /^assets\/public\/assets\/.*\.js$/.test(e))
let injected = false
for (const ref of refs) {
  const entry = `assets/public/assets/${ref}`
  if (!entries.includes(entry)) continue
  const body = String(unzip(['-p', apk, entry]).stdout || '')
  if (body.includes(apiBase)) injected = true
}
ok(
  refs.every((r) => entries.includes(`assets/public/assets/${r}`)),
  'index.html 引用的 bundle 都真的打进了 APK'
)
ok(injected, '★ 包内 JS 带着绝对 API 地址（不是相对 /api/v1）', apiBase)

/* ---------- 3. 签名（可选） ---------- */
console.log('\n─── 3. 签名 ───')
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
/* ⚠️ 用 `java -jar apksigner.jar`，别直接 spawn apksigner.bat ——
   Windows 上 Node 执行 .bat 需要额外 shell，会静默失败（看起来像验签没过）。 */
let signerJar = ''
if (sdk) {
  const bt = path.join(sdk, 'build-tools')
  for (const v of fs.existsSync(bt) ? fs.readdirSync(bt) : []) {
    const p = path.join(bt, v, 'lib', 'apksigner.jar')
    if (fs.existsSync(p)) signerJar = p
  }
}
if (signerJar) {
  const r = spawnSync('java', ['-jar', signerJar, 'verify', apk], { encoding: 'utf8' })
  ok(r.status === 0, 'apksigner 验签通过', (r.stdout || r.stderr || '').trim().slice(0, 120))
} else {
  console.log('⏭️  未找到 apksigner（可选），跳过验签')
}

console.log(failures ? `\n❌ Android 产物自检有 ${failures} 项失败` : '\n✅ Android 产物自检全部通过')
process.exit(failures ? 1 : 0)
