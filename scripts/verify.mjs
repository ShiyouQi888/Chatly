import { spawn } from 'node:child_process'
import path from 'node:path'
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
    'check-me', 'check-profile', 'check-discover', 'check-video', 'check-moment', 'check-geo',
    'check-qr', 'check-readreceipt', 'check-emoji', 'check-scroll', 'check-align',
    'check-narrow', 'check-console', 'audit-ui',
  ]
  steps.push(...suites.map((name) => [name, process.execPath, [path.join(root, `scripts/${name}.mjs`)]]))
}

async function checkService(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) })
    return response.ok
  } catch {
    return false
  }
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

console.log(`Chatly ${quick ? '快速' : '完整'}回归：${steps.length} 个阶段\n`)
const results = []
for (const [name, command, args] of steps) {
  if (!(await checkService('http://127.0.0.1:3002/health'))) {
    console.error(`\n后端在「${name}」后未通过健康检查；为避免级联误报，停止后续阶段。`)
    results.push({ name: 'Backend health between stages', code: 1 })
    break
  }
  console.log(`\n════ ${name} ════`)
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
