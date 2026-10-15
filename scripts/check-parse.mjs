/**
 * 源码「能不能解析」自检 —— 全项目最便宜的一道闸。
 *
 * 为什么单独有这一支：
 *   乱写一行 JSX（比如在 `return (` 的括号里、元素**之前**放一个 `{/* 注释 *\/}`）
 *   是个**致命**错误 —— Babel 解析失败 → Vite 对该模块返回 500 →
 *   整个应用**白屏**。但它的暴露路径特别绕：
 *     · `node --check` 查不出来（.jsx 不是合法 JS，压根解析不了，会直接报另一个错）；
 *     · `vite build` 能查出来，但要几十秒，而且本项目已经有过
 *       「build 过了、运行时才炸」的先例，所以它也没被当成唯一验证；
 *     · 靠 `check-console` / 各页自检去撞，要等浏览器起来、要等好几秒，
 *       而且症状是「所有选择器全 null」，很容易被误读成「数据没了 / 后端挂了」。
 *   实测踩过一次：MeTab.jsx 里一行注释 → 全站白屏 → 先怀疑数据库、
 *   再怀疑代理、再怀疑端口，绕了一大圈才看到 Vite 的 500。
 *
 * 所以：**改完 jsx 先跑这个**（~1 秒），它只说「哪个文件第几行语法错」。
 *
 * 跑法：node scripts/check-parse.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { transformSync } from 'esbuild'

const ROOT = path.resolve(import.meta.dirname, '..')
/* `scripts` 也扫进来：自检脚本里的语法错**只有跑到那一步才会暴露**，
   而一支自检动辄跑几分钟 —— 与其等它跑到一半炸，不如 1 秒内先报出来。
   （实测代价：给 debris.mjs 批量补 await 时，如果有一处落在非 async 回调里，
     整套自检要跑到那一步才知道。这里 1 秒就能定位。） */
const DIRS = ['src', 'server/src', 'scripts']
const EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])

/** 递归收集候选文件（跳过 node_modules / 构建产物 / 上传目录） */
function walk(dir, out = []) {
  let ents
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'uploads' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (EXT.has(path.extname(e.name))) out.push(p)
  }
  return out
}

/* 相对 import 的路径解析 —— 语法没问题但「import 了一个不存在的文件」
   同样是白屏，而且 esbuild 的 transform 是**单文件**的，查不出这种。
   这里只做「相对路径是否落在真实文件上」，不解析 node_modules（那是包的事）。 */
function checkRelativeImports(file, code, problems) {
  const dir = path.dirname(file)
  const re = /(?:^|[\s;{(])(?:import|export)\s[^'"()]*?from\s*['"](\.[^'"]+)['"]|(?:^|[\s;{(])import\s*\(\s*['"](\.[^'"]+)['"]/gm
  let m
  while ((m = re.exec(code))) {
    const spec = m[1] || m[2]
    const base = path.resolve(dir, spec)
    const cands = [base, base + '.js', base + '.jsx', base + '.mjs', base + '.json', path.join(base, 'index.js'), path.join(base, 'index.jsx')]
    if (!cands.some((c) => fs.existsSync(c) && fs.statSync(c).isFile())) {
      problems.push(`${path.relative(ROOT, file)} → 找不到模块 '${spec}'`)
    }
  }
}

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)))
const syntaxErrors = []
const importProblems = []

for (const f of files) {
  const code = fs.readFileSync(f, 'utf8')
  try {
    transformSync(code, { loader: path.extname(f) === '.ts' || path.extname(f) === '.tsx' ? 'tsx' : 'jsx', jsx: 'automatic', sourcefile: f })
  } catch (e) {
    const loc = e.errors?.[0]?.location
    const where = loc ? `${loc.line}:${loc.column + 1}` : '?'
    const text = e.errors?.[0]?.text || e.message
    syntaxErrors.push(`${path.relative(ROOT, f)}:${where}  ${text}`)
    continue // 解析都不过，就别再往里挑 import 了
  }
  checkRelativeImports(f, code, importProblems)
}

console.log(`扫描 ${files.length} 个源文件（${DIRS.join(' / ')}）`)

if (importProblems.length) {
  console.log(`\n⚠️ ${importProblems.length} 处相对导入指向不存在的文件：`)
  for (const p of importProblems) console.log('   ' + p)
}

if (syntaxErrors.length) {
  console.log(`\n❌ ${syntaxErrors.length} 个文件解析失败（这些文件会让 Vite 返回 500、整个应用白屏）：`)
  for (const s of syntaxErrors) console.log('   ' + s)
  process.exit(1)
}

console.log(syntaxErrors.length === 0 && importProblems.length === 0 ? '\n✅ 全部源文件解析通过，相对导入全部能落到真实文件上' : '\n✅ 全部源文件解析通过（仅上面那些导入告警）')
process.exit(0)
