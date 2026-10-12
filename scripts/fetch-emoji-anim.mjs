/**
 * 动画大表情抓取 + 转码 —— Microsoft Fluent Emoji **Animated**（MIT）
 *
 * 和 `fetch-emoji.mjs`（静态 SVG）是两件事，不要混：
 *   - 上游是**另一个仓库** `microsoft/fluentui-emoji-animated`。主仓 `fluentui-emoji`
 *     里一个动画文件都没有（只有 Color/Flat/High Contrast 的 SVG + 3D 的 PNG）。
 *   - 上游格式是 **APNG 不是 GIF**（PNG 序列带 acTL 块，256×256，40+ 帧）。
 *   - **单个 2.85MB**，无损帧序列，全量 447 个 ≈ 1.3GB —— 所以只挑**有大表情动画版**的那批，
 *     并且必须本地转码，不能直接落盘。
 *
 * ⚠️ Git LFS：这个仓库的图片走 LFS。`raw.githubusercontent.com` 只会返回
 *    **132 字节的指针文本文件**（内容是 `version https://git-lfs.github.com/...`），
 *    拿它当 PNG 用会得到一堆坏图。真身要走：
 *      https://media.githubusercontent.com/media/{owner}/{repo}/{branch}/{path}
 *
 * ⚠️⚠️ 输出格式是 **GIF 不是 WebP**。第一版转的是 WebP 动画，上线后在桌面浏览器上
 *   出现「两个完整表情重叠 / 错位」。根因是 ffmpeg 的 libwebp 写出的帧是
 *   **全画布 + blend=blend + dispose=none**（每帧混合到上一帧、且不清除上一帧），
 *   而 Fluent 表情的背景是**透明**的 —— 第 2 帧画上去时透明处透出第 1 帧，
 *   表情又只挪了一点点，看起来就是两个表情叠着。
 *   GIF 没这个问题：ffmpeg 的 gif 封装默认写 **disposal=2（显示后恢复背景）**，
 *   每帧结束把画布擦干净，天然不会累积。而且 GIF 是兼容性最稳的动画格式
 *   （WebP 动画在部分浏览器/解码器上行为不一致）。
 *   脚本末尾会**逐个校验 disposal 必须是 2**，不是就打补丁 —— 别让同类坑再回来。
 *
 * 转码用本机 ffmpeg（winget 装的 8.0）。参数是**量**出来的（详见下面的常量注释）：
 *   原始 APNG 256                 2.85MB
 *   WebP 128 12fps q62             136KB   ← 有帧叠加 bug，已弃用
 *   GIF  112 12fps  96色 bayer3    128KB   ← 第一版，边缘有毛刺
 *   GIF  112 10fps 128色 bayer1    127KB   ← 噪点反而更差（7.71 > 5.78）
 *   GIF  144 10fps 256色 无抖动    153KB   ← 噪点 4.07
 *   **GIF 160 10fps 256色 无抖动  ~175KB** ← 取这个，噪点 3.71
 *   GIF   96  8fps  32色           51KB
 *   **帧数是体积主因**（40+ 帧），抽帧比降色有效得多。
 *   毛刺的主因是**抖动噪点**不是分辨率 —— 详见 SIZE / DITHER 处的注释。
 *
 * 产物：
 *   public/emoji-anim/<码点>.gif    运行时 <img src="/emoji-anim/1f602.gif">
 *   public/emoji-anim/LICENSE.txt   上游 MIT + 来源与转码说明
 *   src/data/emoji-anim.js          码点 → 动画地址（没有动画版的不在里面，前端回退静态 SVG）
 *
 * 用法：
 *   node scripts/fetch-emoji-anim.mjs            # 缺什么下什么（原始 APNG 缓存在 .tmp）
 *   node scripts/fetch-emoji-anim.mjs --force    # 忽略已有产物，全部重转
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EMOJI_BIG, EMOJI_NAMES } from '../src/data/emoji.js'
/* GIF 的解析 / 打补丁 / 自检放在 scripts/lib/gif.mjs —— 转码脚本和 check-emoji.mjs 共用同一份判据，
   否则「转码时觉得没问题」和「自检时觉得没问题」会是两套标准，同类 bug 迟早回来。 */
import { forceDisposeToBg, verifyGif } from './lib/gif.mjs'

const execFileAsync = promisify(execFile)

const REPO = 'microsoft/fluentui-emoji-animated'
const BRANCH = 'main'
const API = `https://api.github.com/repos/${REPO}`
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`
/** LFS 真身端点 —— 见文件头说明，别换成 RAW */
const MEDIA = `https://media.githubusercontent.com/media/${REPO}/${BRANCH}`

const ROOT = 'D:/BS-chat-os'
const TMP = path.join(ROOT, '.tmp/emoji-anim')
const RAW_DIR = path.join(TMP, 'raw')
const OUT_DIR = path.join(ROOT, 'public/emoji-anim')
const DATA_FILE = path.join(ROOT, 'src/data/emoji-anim.js')

/* 参数是量出来的，不是拍的（实测脚本见 git 历史里的 .tmp/tune-gif.mjs）。
   两个结论推翻了直觉：
     1. **边缘毛刺的主因是抖动噪点，不是分辨率** —— 把「降到 96px 后的边界长度/√面积」
        拿来比，112 / 144 / 160 三档都是 4.50，几乎不动；
        但「像素与 3×3 邻域均值的偏差」（抖动噪点）从 5.78 一路降到 3.71。
        bayer 有序抖动的棋盘纹在高分屏放大后就是肉眼看到的毛刺。
     2. **加大抖动强度反而更脏** —— 112/128色/bayer1 的噪点 7.71，比当前的 5.78 还差。
        正确做法是**把色数用满（256）+ 关掉抖动**。 */
const SIZE = 160 // 贴纸显示 96 CSS px；高分屏按 2x 就是 192 设备像素，160 才不至于被放大糊边
const FPS = 10
const COLORS = 256 // GIF 的上限
const DITHER = 'none' // 256 色已经够，再加抖动只会引入棋盘噪点
/** 超过这个体积就按 LADDER 降档重编 —— 复杂表情（打滚笑、便便）帧多，容易顶上去 */
const MAX_BYTES = 190 * 1024
/** 降档阶梯：先降尺寸（保帧率），再降帧率。色数和抖动始终不动 —— 一动就回到毛刺。 */
const LADDER = [
  { size: SIZE, fps: FPS, colors: COLORS, dither: DITHER },
  { size: 144, fps: FPS, colors: COLORS, dither: DITHER },
  { size: 128, fps: 8, colors: 224, dither: DITHER },
]
const CONCURRENCY = 4 // APNG 单个近 3MB，别开太大
const FORCE = process.argv.includes('--force')

fs.mkdirSync(TMP, { recursive: true })
fs.mkdirSync(RAW_DIR, { recursive: true })
fs.mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 统一码点写法 —— 上游 metadata 的 unicode 用**空格**分隔，还带 fe0f */
const norm = (code) =>
  String(code)
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((p) => p && p !== 'fe0f')
    .join('-')

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (r.ok) return await r.json()
      if (r.status === 404) return null
      if (r.status === 429 || r.status >= 500) await sleep(400 * (i + 1))
      else return null
    } catch {
      await sleep(300 * (i + 1))
    }
  }
  return null
}

async function download(url, dest, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) })
      if (!r.ok) {
        if (r.status === 404) return false
        await sleep(500 * (i + 1))
        continue
      }
      const buf = Buffer.from(await r.arrayBuffer())
      // LFS 没生效时会拿到 132 字节的指针文本 —— 当成失败，别写出坏图
      if (buf.length < 1024 || buf.slice(0, 11).toString('ascii') === 'version htt') {
        throw new Error(`拿到的是 LFS 指针（${buf.length}B），不是真图`)
      }
      fs.writeFileSync(dest, buf)
      return true
    } catch {
      await sleep(600 * (i + 1))
    }
  }
  return false
}

async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor++
        if (i >= items.length) return
        out[i] = await fn(items[i], i)
      }
    })
  )
  return out
}

/** 从 PNG 里找关键块 —— 用来确认下载到的真的是 APNG 而不是静态首帧 */
function pngChunks(buf) {
  const types = []
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.slice(off + 4, off + 8).toString('ascii')
    types.push(type)
    if (type === 'IEND') break
    off += 12 + len
  }
  return types
}

/* ---------- GIF 转码 ---------- */

/**
 * 两遍编码：先 palettegen 生成调色板，再 paletteuse 套用。
 * 直接 `-c:v gif` 会让 ffmpeg 用默认调色板，渐变处全是色带。
 */
async function encodeGif(src, dest, { size, fps, colors, dither }) {
  const pal = dest.replace(/\.gif$/, '.pal.png')
  const vf = `fps=${fps},scale=${size}:${size}:flags=lanczos`
  await execFileAsync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', src,
    '-vf', `${vf},palettegen=max_colors=${colors}:stats_mode=diff`,
    pal,
  ])
  await execFileAsync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', src, '-i', pal,
    '-lavfi', `${vf} [x]; [x][1:v] paletteuse=dither=${dither}`,
    '-loop', '0',
    dest,
  ])
  try { fs.rmSync(pal, { force: true }) } catch { /* 临时调色板，删不掉无所谓 */ }
}

/** 按 LADDER 降档重编，直到体积达标 */
async function toGif(src, dest) {
  let last
  for (const step of LADDER) {
    await encodeGif(src, dest, step)
    const bytes = fs.statSync(dest).size
    last = { ...step, bytes }
    if (bytes <= MAX_BYTES) break
  }
  return last
}

async function main() {
  console.log('══════ 动画大表情抓取（Fluent Emoji Animated · MIT）══════\n')

  /* ---- 1. 文件树：拿到「哪些表情有动画版」 ---- */
  const treeFile = path.join(TMP, 'tree.json')
  let tree = fs.existsSync(treeFile) ? JSON.parse(fs.readFileSync(treeFile, 'utf8')) : null
  if (!tree) {
    console.log('拉取文件树…')
    tree = await getJson(`${API}/git/trees/${BRANCH}?recursive=1`)
    if (!tree?.tree) throw new Error('文件树拉取失败')
    fs.writeFileSync(treeFile, JSON.stringify(tree))
  }
  const pngs = tree.tree.filter(
    (x) => x.type === 'blob' && /\/animated\/[^/]+_animated\.png$/i.test(x.path)
  )
  const dirs = [...new Set(pngs.map((x) => x.path.split('/')[1]))]
  /* 目录 → 真实文件路径。
     ⚠️ 千万别自己把目录名拼成文件名：上游文件名**保留连字符和感叹号**
     （`smiling_face_with_heart-eyes_animated.png`、`on!_animated.png`），
     按「非字母数字都换成下划线」的规则拼会拼出不存在的文件 —— 第一版就漏了 😍。
     和静态素材脚本一个教训：路径只能从文件树里取。 */
  const animPath = new Map()
  for (const x of pngs) animPath.set(x.path.split('/')[1], x.path)
  console.log(`上游动画表情：${dirs.length} 个\n`)

  /* ---- 2. 码点 → 目录名：只能从每个 metadata.json 读 ---- */
  const mapFile = path.join(TMP, 'map.json')
  let map = fs.existsSync(mapFile) ? new Map(JSON.parse(fs.readFileSync(mapFile, 'utf8'))) : null
  if (!map) {
    console.log(`读取 ${dirs.length} 个 metadata.json 建码点索引…`)
    const entries = []
    await pool(dirs, 24, async (dir) => {
      const j = await getJson(`${RAW}/assets/${encodeURIComponent(dir)}/metadata.json`)
      if (j?.unicode) entries.push([norm(j.unicode), dir])
    })
    map = new Map(entries)
    fs.writeFileSync(mapFile, JSON.stringify(entries))
    console.log(`  索引到 ${map.size} 个码点\n`)
  }

  /* ---- 3. 挑出大表情里有动画版的 ---- */
  const targets = []
  const missing = []
  for (const code of EMOJI_BIG) {
    const dir = map.get(code)
    if (dir) targets.push({ code, dir })
    else missing.push(code)
  }
  console.log(`大表情 ${EMOJI_BIG.length} 个 → 有动画 ${targets.length} 个，回退静态 ${missing.length} 个`)
  if (missing.length) {
    console.log(`  回退静态：${missing.map((c) => EMOJI_NAMES[c] || c).join(' ')}\n`)
  }

  /* ---- 4. 清掉上一版的残留产物 ----
     .webp：有帧叠加 bug 的那批，留着就变成 public 里同时存在两套动画，
     浏览器随便挑一个都不对。换格式必须连旧文件一起清。
     .pal.png：palettegen 的中间产物，编码完会删；但如果上一轮被中断
     （或像我一样手滑并发跑了两个实例，互相把对方的调色板删了），
     就会留在 public 里被打进 dist。开跑前统一扫掉。 */
  const stale = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.webp') || f.endsWith('.pal.png'))
  for (const f of stale) fs.rmSync(path.join(OUT_DIR, f), { force: true })
  if (stale.length) console.log(`清理上一版残留产物 ${stale.length} 个\n`)

  /* ---- 5. 下载 APNG + 转码 ---- */
  console.log('下载并转码（每个原始约 2.8MB，需要点时间）…')
  let done = 0
  const results = await pool(targets, CONCURRENCY, async ({ code, dir }) => {
    const rel = animPath.get(dir)
    if (!rel) return { code, error: '文件树里没有这个动画文件' }
    const rawPath = path.join(RAW_DIR, `${code}.png`)
    const outPath = path.join(OUT_DIR, `${code}.gif`)

    if (!FORCE && fs.existsSync(outPath)) {
      done++
      try {
        return { code, bytes: fs.statSync(outPath).size, cached: true, ...verifyGif(outPath) }
      } catch (e) {
        return { code, error: `已有产物不合格：${e.message}` }
      }
    }
    if (!fs.existsSync(rawPath)) {
      // 逐段编码再拼回去：路径里有空格和感叹号，整段 encodeURIComponent 会把 / 也吃掉
      const url = `${MEDIA}/${rel.split('/').map(encodeURIComponent).join('/')}`
      const ok = await download(url, rawPath)
      if (!ok) return { code, error: '下载失败' }
    }
    // 确认是 APNG（有 acTL 块）—— 拿到静态首帧的话转出来不会动，得早发现
    const chunks = pngChunks(fs.readFileSync(rawPath))
    if (!chunks.includes('acTL')) return { code, error: '不是 APNG（缺 acTL），可能下错了文件' }

    await toGif(rawPath, outPath)
    // 兜底：ffmpeg 万一某天改了默认处置方式，这里强制写成「恢复背景」再自检
    const patched = forceDisposeToBg(outPath)
    let v
    try {
      v = verifyGif(outPath)
    } catch (e) {
      return { code, error: `转码产物不合格：${e.message}` }
    }
    done++
    process.stdout.write(`    … ${done}/${targets.length}\r`)
    return {
      code,
      bytes: fs.statSync(outPath).size,
      frames: v.frames,
      srcFrames: chunks.filter((c) => c === 'fcTL').length,
      patched,
    }
  })

  const ok = results.filter((r) => r.bytes)
  const bad = results.filter((r) => r.error)
  const total = ok.reduce((a, b) => a + b.bytes, 0)
  console.log(
    `\n转码完成 ${ok.length}/${targets.length}，共 ${(total / 1048576).toFixed(2)}MB，` +
      `平均 ${(total / Math.max(ok.length, 1) / 1024).toFixed(0)}KB\n`
  )
  const patchedCount = ok.filter((r) => r.patched).length
  if (patchedCount) console.log(`其中 ${patchedCount} 个的 disposal 被强制改成 2\n`)
  if (bad.length) console.log(`❌ 失败：${bad.map((b) => `${b.code} ${b.error}`).join('；')}\n`)

  /* ---- 5. 写清单 ---- */
  const lines = []
  lines.push('/**')
  lines.push(' * 动画大表情地址表 —— 由 scripts/fetch-emoji-anim.mjs 生成，不要手改。')
  lines.push(' *')
  lines.push(' * 只收录「有动画版」的大表情。没收录的不代表没有这个表情，')
  lines.push(' * 而是上游没有给它做动画（多是手势类：👍👏🙏💪🤝…），前端要回退到静态 SVG。')
  lines.push(' * 所以取动画地址**必须走 animUrl() 判空**，不能假设一定有。')
  lines.push(' *')
  lines.push(' * 格式是 **GIF**（不是 WebP）：ffmpeg 的 libwebp 会写出 blend+dispose=none 的帧，')
  lines.push(' * 透明背景的表情会叠出残影；GIF 的 disposal=2 天然每帧清屏。详见脚本头。')
  lines.push(' */')
  lines.push('')
  lines.push("export const EMOJI_ANIM_DIR = '/emoji-anim'")
  lines.push('')
  lines.push('export const EMOJI_ANIM = {')
  for (const { code } of ok.sort((a, b) => a.code.localeCompare(b.code))) {
    lines.push(`  '${code}': '/emoji-anim/${code}.gif',`)
  }
  lines.push('}')
  lines.push('')
  lines.push('/** 取动画地址；没有动画版返回 null（调用方负责回退静态 SVG） */')
  lines.push('export function animUrl(code) {')
  lines.push('  return EMOJI_ANIM[code] || null')
  lines.push('}')
  lines.push('')
  fs.writeFileSync(DATA_FILE, lines.join('\n'))
  console.log(`清单已写入 ${path.relative(ROOT, DATA_FILE)}（${ok.length} 条）`)

  /* ---- 6. 许可证 ---- */
  const license = `Emoji artwork: Microsoft Fluent Emoji (Animated)
License: MIT
Source:  https://github.com/${REPO}/blob/${BRANCH}/LICENSE

说明：
  原始素材为 APNG（256x256，约 40+ 帧，单个约 2.8MB），体积不适合移动端直接使用。
  本项目用 ffmpeg 转码为 GIF 动画：${SIZE}x${SIZE}px / ${FPS}fps / ${COLORS} 色 / 无抖动，
  每帧 disposal=2（显示后恢复背景），体积超 ${Math.round(MAX_BYTES / 1024)}KB 时自动降档重编。

  为何不是 WebP：ffmpeg 的 libwebp 写出的帧是「全画布 + blend + dispose=none」，
  透明背景的表情会把上一帧透出来，浏览器里看到的是两个表情叠在一起。GIF 无此问题。

  除尺寸、帧率、调色板与编码格式外未做其它修改。
`
  fs.writeFileSync(path.join(OUT_DIR, 'LICENSE.txt'), license)
  console.log('许可证已写入 public/emoji-anim/LICENSE.txt')

  /* ---- 7. 收尾再扫一遍中间产物 ----
     编码过程是并发的，中途失败/被中断都可能留下 .pal.png。
     这里兜底清掉，保证 public 里只有 .gif 和 LICENSE.txt。 */
  const leftover = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f !== 'LICENSE.txt' && !f.endsWith('.gif'))
  for (const f of leftover) fs.rmSync(path.join(OUT_DIR, f), { force: true })
  if (leftover.length) console.log(`收尾清理非 GIF 残留 ${leftover.length} 个：${leftover.join(' ')}`)
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
