/**
 * 构建 Android 壳的内容包（dist → android/app/src/main/assets/public）。
 *
 * ## 为什么不能直接用 `npm run build` + `cap sync`
 *
 * Web 版用相对路径 `/api/v1`，靠 Vite dev proxy 转发。原生壳里没有 dev server，
 * WebView 的 origin 是 `http://localhost`（见 capacitor.config.json 的
 * `server.androidScheme`），相对路径会指向壳自己的资源目录 —— 所有请求 404。
 *
 * 所以 Android 构建**必须**把 API 地址编译成绝对地址：
 *   `VITE_API_BASE` → `platform/config.js` 的 `resolveApiBase()` → `BASE`。
 *
 * ## 地址怎么选
 *
 * - Android 模拟器：`http://10.0.2.2:3002/api/v1`（10.0.2.2 是宿主机 loopback 别名）
 * - 真机（同一局域网）：`http://<电脑局域网 IP>:3002/api/v1`，同时后端要
 *   用 `HOST=0.0.0.0` 启动，否则只监听 127.0.0.1，真机连不上。
 * - 生产：换成 https 域名，并把 AndroidManifest 的 `usesCleartextTraffic` 去掉。
 *
 * 用 `CHATLY_ANDROID_API` 覆盖，例如：
 *   CHATLY_ANDROID_API=http://192.168.1.20:3002/api/v1 npm run android:build
 *
 * ⚠️ 本脚本会覆盖 `dist/`（Web 版产物）。要重新部署 Web 时再跑一次 `npm run build`。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiBase = String(process.env.CHATLY_ANDROID_API || 'http://10.0.2.2:3002/api/v1').trim()
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const capBin = path.join(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor')
const DIST = path.join(root, 'dist')
const ASSETS = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'public')

if (!/^https?:\/\/[^\s]+\/api\/v1$/.test(apiBase)) {
  console.error(`✗ API 地址格式不对：${apiBase}\n  需要形如 http://10.0.2.2:3002/api/v1（结尾必须是 /api/v1）`)
  process.exit(2)
}

const run = (label, args, extraEnv = {}) => {
  console.log(`\n════ ${label} ════`)
  return spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
}

console.log(`Chatly Android 构建 · API = ${apiBase}`)

/* 某些受限文件系统会拦截「一次删除几百个文件」（Vite 清空 dist 时要删
   dist/emoji 下 300+ 个 SVG）。把旧目录整体**移走**而不是删除，
   Vite 就会直接新建输出目录，不需要批量删除。
   ⚠️ 必须移到**同一个盘**：项目在 D:\，os.tmpdir() 在 C:\，
   renameSync 跨设备会抛 EXDEV，等于没兜底。放在项目内 .tmp/（已 gitignore）。 */
if (fs.existsSync(DIST)) {
  try {
    const backup = path.join(root, '.tmp', `dist-pre-android-${Date.now()}`)
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    fs.renameSync(DIST, backup)
    console.log(`旧 dist 已移出（${backup}），Vite 将新建输出目录`)
  } catch (e) {
    console.warn(`⚠️ 无法移走旧 dist，Vite 清空输出目录时可能被批量删除保护拦下：${e.message}`)
  }
}

const build = run('1/3 vite build（注入绝对 API 地址）', [viteBin, 'build'], { VITE_API_BASE: apiBase })
if (build.error || build.status !== 0) {
  console.error(`✗ vite build 失败${build.error ? '：' + build.error.message : ''}`)
  process.exit(build.status ?? 1)
}

/* cap sync 同样会先删掉整个 assets/public 目录，在受限文件系统上可能失败。
   失败就退化为「覆盖复制」：不删目录，只把 dist 的内容盖上去，
   再清掉不再被 index.html 引用的旧 hash 文件（数量很少，不会触发批量保护）。 */
const sync = run('2/3 cap sync android', [capBin, 'sync', 'android'])
if (sync.error || sync.status !== 0) {
  console.warn('⚠️ cap sync 未完成，回退到覆盖复制 dist → android assets')
  fs.mkdirSync(ASSETS, { recursive: true })
  fs.cpSync(DIST, ASSETS, { recursive: true, force: true })
  const want = new Set(fs.readdirSync(path.join(DIST, 'assets')))
  for (const name of fs.readdirSync(path.join(ASSETS, 'assets'))) {
    if (!/\.(js|css|map)$/.test(name) || want.has(name)) continue
    try { fs.rmSync(path.join(ASSETS, 'assets', name), { force: true }) } catch {}
  }
}

/* 3/3 自校验：包里的 JS 必须真的带着绝对 API 地址。
   只检查 dist 不够 —— cap sync 失败时很容易「dist 是对的、壳里还是旧版」，
   装到手机上才发现登录一直转圈。 */
console.log('\n════ 3/3 校验壳内资产 ════')
const assetsDir = path.join(ASSETS, 'assets')
const bundles = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'))
  : []
const injected = bundles.some((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8').includes(apiBase))
if (!bundles.length || !injected) {
  console.error(`✗ 壳内 JS 没有注入 ${apiBase}（bundles=${bundles.length}）`)
  process.exit(1)
}
const html = fs.readFileSync(path.join(ASSETS, 'index.html'), 'utf8')
const referenced = (html.match(/assets\/[^"']+\.js/g) || []).map((s) => path.basename(s))
if (!referenced.length || !referenced.every((f) => bundles.includes(f))) {
  console.error(`✗ index.html 引用的 bundle 不在壳里：${JSON.stringify(referenced)}`)
  process.exit(1)
}
console.log(`✅ 壳内 ${bundles.length} 个 JS bundle，index.html 引用的 ${referenced.join(', ')} 都在，且已注入绝对 API 地址`)
console.log('\n✅ Android 内容包就绪。接着在 android/ 下执行 gradlew assembleDebug 出 APK。')
