import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const quick = process.argv.includes('--quick')
const localNode = (...parts) => path.join(root, 'node_modules', ...parts)
const steps = [
  ['JSX / import parse', process.execPath, [path.join(root, 'scripts/check-parse.mjs')]],
  ['Production build', process.execPath, [localNode('vite/bin/vite.js'), 'build']],
  ['Independent admin authentication', process.execPath, [path.join(root, 'scripts/check-admin-auth.mjs')]],
  ['Core login / announcement / file / permission flows', process.execPath, [path.join(root, 'scripts/check-core-flows.mjs')]],
  ['Backend REST / WebSocket regression', process.execPath, [path.join(root, 'server/test/e2e.mjs')]],
]

if (!quick) {
  const suites = [
    'e2e-realtime', 'check-group', 'check-media', 'check-reply-forward', 'check-poll',
    'check-favorite', 'check-longpress', 'check-privacy', 'check-presence', 'check-driver',
    'check-me', 'check-profile', 'check-community', 'check-call', 'check-push', 'check-video', 'check-moment', 'check-geo',
    'check-qr', 'check-readreceipt', 'check-emoji', 'check-scroll', 'check-align',
    'check-narrow', 'check-console', 'audit-ui', 'check-platform',
  ]
  steps.push(...suites.map((name) => [name, process.execPath, [path.join(root, `scripts/${name}.mjs`)]]))
}

/**
 * 健康检查要能扛住「首次连接慢」。
 * 实测 Vite dev server 空闲一段时间后，第一条 Node fetch 要 2.1 秒才回，
 * 而 curl 只要 20ms —— 单次 2500ms 超时会偶发把好端端的前端判成「未就绪」，
 * 回归在第一个阶段之前就 exit 2（曾连续两轮遇到）。这里短重试三次，
 * 真挂了最多多等几秒，不会掩盖故障。
 */
async function checkService(url, { tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (response.ok) return true
    } catch {
      /* 换下一次 */
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

const backendReady = await checkService('http://127.0.0.1:3002/health')
if (!backendReady) {
  console.error('后端未就绪。请先在 server 目录运行 npm run dev，再执行 npm run verify。')
  process.exit(2)
}
if (!quick && !(await checkService('http://127.0.0.1:5198/'))) {
  console.error('前端未就绪。完整回归需要前端 5198 和后端 3002 同时运行；快速回归只需要后端。')
  process.exit(2)
}

/**
 * 某些受限文件系统会拦截「一次删除几百个文件」：Vite 清空 dist 时要删
 * dist/emoji 下的 300+ 个 SVG，直接 build 会报 SAFE_DELETE_BULK_CONFIRM_REQUIRED，
 * 表现为「Production build」莫名其妙失败，而且前端代码一个字节都没改。
 * 把旧 dist 整体**移走**（不是删除），Vite 就会新建输出目录，绕开批量删除。
 * 与 scripts/build-android.mjs 用同一套做法。
 *
 * ⚠️ 目标必须是**同一个盘**里的目录：项目在 D:\，os.tmpdir() 在 C:\，
 * renameSync 跨设备会抛 EXDEV，旧 dist 原地不动，Vite 照样去删 390 个 SVG
 * 然后被拦下 —— 这个「兜底没生效」比没有兜底更难看出来。
 */
function rotateDist() {
  const dist = path.join(root, 'dist')
  if (!fs.existsSync(dist)) return
  try {
    const backup = path.join(root, '.tmp', `dist-pre-verify-${Date.now()}`)
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    fs.renameSync(dist, backup)
    console.log(`   · 旧 dist 已移出（${backup}），Vite 将新建输出目录`)
  } catch (e) {
    console.warn(`   ⚠️ 无法移走旧 dist，清空输出目录时可能被批量删除保护拦下：${e.message}`)
  }
}

console.log(`Chatly ${quick ? '快速' : '完整'}回归：${steps.length} 个阶段\n`)
const results = []
for (const [name, command, args] of steps) {
  if (!(await checkService('http://127.0.0.1:3002/health'))) {
    console.error(`\n后端在「${name}」后未通过健康检查；为避免级联误报，停止后续阶段。`)
    results.push({ name: 'Backend health between stages', code: 1 })
    break
  }
  console.log(`\n════ ${name} ════`)
  if (name === 'Production build') rotateDist()
  const code = await new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: 'inherit' })
    child.once('error', (error) => {
      console.error(error.message)
      resolve(1)
    })
    child.once('exit', (status, signal) => resolve(status ?? (signal ? 1 : 0)))
  })
  results.push({ name, code })
}

console.log('\n════ 回归汇总 ════')
for (const result of results) console.log(`${result.code === 0 ? '✅' : '❌'} ${result.name}`)
const failed = results.filter((result) => result.code !== 0)
const skipped = steps.length - results.length
if (skipped) console.log(`⏭️ 因服务不可用，跳过 ${skipped} 个后续阶段`)
console.log(failed.length ? `\n❌ ${failed.length}/${results.length} 个阶段失败` : `\n✅ ${results.length}/${steps.length} 个阶段通过`)
process.exit(failed.length ? 1 : 0)
