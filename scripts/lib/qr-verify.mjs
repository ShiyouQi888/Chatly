/**
 * 二维码编解码器交叉验证 —— 拿 npm 上的参考实现对拍自家 `src/lib/qr.js`。
 *
 * 为什么必须做这一步：编解码是**纯数学**，写错了不会报错，只会「编出来看着像码、
 * 扫出来是乱码」。自己验自己等于没验（两遍错得一样就互相印证了）。
 * 所以引三方参考实现当裁判：
 *   · `qrcode` —— 老牌编码器，逐模块对拍**矩阵**（版本 / 掩码 / 填充 / 纠错全在里面）。
 *   · `jsqr`   —— 成熟解码器，把我编的码喂给它，它得解回原文（证明我编码是对的）。
 *
 * 三条判据：
 *   A. 矩阵一致：固定掩码 0~7 逐个对拍 + 自动选掩码对拍。
 *   B. `jsqr` 能解我编的码（含旋转 / 缩放 / 噪声）。
 *   C. 我自己的解码器能解我编的码（含旋转 / 缩放）。
 *
 * 用法：`node scripts/lib/qr-verify.mjs`
 * 依赖在 `.tmp/qrverify/`（不进项目依赖，见该目录 README）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const refDir = path.join(root, '.tmp/qrverify')

if (!fs.existsSync(path.join(refDir, 'node_modules'))) {
  console.error(`✗ 参考实现没装好，先跑：\n  cd .tmp/qrverify && npm install qrcode jsqr --registry=https://registry.npmmirror.com`)
  process.exit(1)
}
const require = createRequire(path.join(refDir, 'package.json'))
const QRCode = require('qrcode')
const ByteData = require('qrcode/lib/core/byte-data')
const jsQR = require('jsqr').default || require('jsqr')

/**
 * ⚠️ `QRCode.create(text, { mode: 'byte' })` **不生效**：qrcode 1.5.4 会自动挑最优模式，
 * 纯大写文本仍会被编成 Alphanumeric。要强制 byte，只能自己 `new ByteData(text)` 当段传进去。
 * （踩过：不加这一句，"HELLO" 这类纯大写样例会一直对不上，看起来像编码器有 bug。）
 */
const refCreate = (text, opts = {}) => QRCode.create([new ByteData(text)], opts)

/* 把 ESM 的 qr.js 抄一份成 .mjs 再 import —— 源码里是 `document` 相关的浏览器 API，
   但只要不调用 `decodeQrFromSource` / `drawQrToCanvas`，顶层不会有副作用。 */
const src = fs.readFileSync(path.join(root, 'src/lib/qr.js'), 'utf8')
const tmpModule = path.join(refDir, 'qr.mjs')
fs.writeFileSync(tmpModule, src)
const qr = await import(pathToFileURL(tmpModule).href)

/* ---------- 断言工具 ---------- */
let pass = 0
const fails = []
const ok = (name) => { pass++; console.log(`  ✓ ${name}`) }
const bad = (name, detail) => { fails.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail))
const section = (t) => console.log(`\n${t}`)

/* ---------- 渲染工具 ---------- */
/** 把矩阵渲染成 RGBA 像素（黑=0x16，白=255），quiet zone 可调 */
function renderRgba(modules, size, { scale = 8, margin = 4, dark = 0x16, light = 255, rotate = 0, noise = 0 } = {}) {
  const side = (size + margin * 2) * scale
  const buf = new Uint8ClampedArray(side * side * 4)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const rr = ((y / scale | 0) - margin)
      const cc = ((x / scale | 0) - margin)
      const inside = rr >= 0 && cc >= 0 && rr < size && cc < size
      let v = inside && modules[rr * size + cc] ? dark : light
      if (noise) {
        const n = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1
        v = Math.max(0, Math.min(255, v + n * noise))
      }
      const p = (y * side + x) * 4
      buf[p] = buf[p + 1] = buf[p + 2] = v
      buf[p + 3] = 255
    }
  }
  if (rotate) return rotateRgba(buf, side, side, rotate)
  return { data: buf, width: side, height: side }
}

function rotateRgba(data, w, h, deg) {
  const times = ((deg % 360) + 360) % 360 / 90
  let cur = { data, width: w, height: h }
  for (let t = 0; t < times; t++) {
    const { data: d, width: cw, height: ch } = cur
    const out = new Uint8ClampedArray(cw * ch * 4)
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const nx = ch - 1 - y
        const ny = x
        const srcP = (y * cw + x) * 4
        const dstP = (ny * ch + nx) * 4
        out[dstP] = d[srcP]
        out[dstP + 1] = d[srcP + 1]
        out[dstP + 2] = d[srcP + 2]
        out[dstP + 3] = 255
      }
    }
    cur = { data: out, width: ch, height: cw }
  }
  return cur
}

/** 最近邻缩放（模拟相机远近） */
function scaleRgba(img, factor) {
  const nw = Math.max(1, Math.round(img.width * factor))
  const nh = Math.max(1, Math.round(img.height * factor))
  const out = new Uint8ClampedArray(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(img.width - 1, Math.round((x + 0.5) / factor - 0.5))
      const sy = Math.min(img.height - 1, Math.round((y + 0.5) / factor - 0.5))
      const sp = (sy * img.width + sx) * 4
      const dp = (y * nw + x) * 4
      out[dp] = img.data[sp]; out[dp + 1] = img.data[sp + 1]; out[dp + 2] = img.data[sp + 2]; out[dp + 3] = 255
    }
  }
  return { data: out, width: nw, height: nh }
}

const toImageData = (img) => ({ data: img.data, width: img.width, height: img.height })

/* ---------- 样例 ---------- */
const CASES = [
  { text: 'HELLO', ecc: 'M' },
  { text: 'chatly://user/chenmo', ecc: 'M' },
  { text: 'chatly://user/linxiaoxia', ecc: 'M' },
  { text: 'https://example.com/a/b?c=1&d=2', ecc: 'M' },
  { text: '中文内容也要能编能解', ecc: 'M' },
  { text: 'x'.repeat(60), ecc: 'M' },
  { text: 'y'.repeat(120), ecc: 'M' },
  { text: 'z'.repeat(200), ecc: 'M' },
  { text: 'LOW-ECC-CASE', ecc: 'L' },
  { text: 'chatly://user/chenyu?t=' + 'a'.repeat(40), ecc: 'L' },
]

/* ================= A. 矩阵一致 ================= */
section('A. 与 qrcode 逐模块对拍')

let maskMismatch = 0
for (const { text, ecc } of CASES) {
  // 版本要一致
  const refAuto = refCreate(text, { errorCorrectionLevel: ecc })
  const mine = qr.encodeQr(text, { ecc })
  const refVersion = (refAuto.modules.size - 17) / 4
  check(
    mine.version === refVersion,
    `版本一致 [${ecc}] ${JSON.stringify(text.slice(0, 24))}`,
    mine.version === refVersion ? '' : `我=${mine.version} 参考=${refVersion}`,
  )
  check(mine.size === refAuto.modules.size, `尺寸一致 size=${mine.size}`)

  // 逐掩码对拍：把「掩码惩罚打分」摘出去，单独验证数据/纠错/填充/格式位
  let allMaskOk = true
  let firstDiff = null
  for (let mk = 0; mk <= 7; mk++) {
    const ref = refCreate(text, { errorCorrectionLevel: ecc, maskPattern: mk })
    const got = qr.encodeQr(text, { ecc, mask: mk })
    for (let i = 0; i < got.size * got.size; i++) {
      if (got.modules[i] !== ref.modules.data[i]) {
        allMaskOk = false
        if (!firstDiff) {
          firstDiff = `mask=${mk} 第 ${(i / got.size) | 0} 行第 ${i % got.size} 列：我=${got.modules[i]} 参考=${ref.modules.data[i]}`
        }
        break
      }
    }
  }
  check(allMaskOk, `掩码 0~7 全对拍 [${ecc}] ${JSON.stringify(text.slice(0, 24))}`, firstDiff || '')

  // 自动选掩码（含惩罚打分）是否与参考一致
  const refBest = refCreate(text, { errorCorrectionLevel: ecc })
  if (mine.mask !== refBest.maskPattern) maskMismatch++
}
check(maskMismatch === 0, '自动选掩码与参考一致', maskMismatch ? `${maskMismatch}/${CASES.length} 例不同（惩罚打分有差异，若解码仍通过则不影响）` : '')

/* ================= B. jsqr 解我编的码 ================= */
section('B. jsqr 能解出我编的码')

for (const { text, ecc } of CASES) {
  const { size, modules } = qr.encodeQr(text, { ecc })
  const img = renderRgba(modules, size)
  const r = jsQR(img.data, img.width, img.height)
  check(r && r.data === text, `jsqr 解码 [${ecc}] ${JSON.stringify(text.slice(0, 24))}`, r ? (r.data === text ? '' : `得到 ${JSON.stringify(r.data)}`) : '未识别')
}

// 旋转 / 缩放 / 噪声
const rt = qr.encodeQr('chatly://user/ajie', { ecc: 'M' })
for (const deg of [0, 90, 180, 270]) {
  const img = renderRgba(rt.modules, rt.size, { rotate: deg })
  const r = jsQR(img.data, img.width, img.height)
  check(r && r.data === 'chatly://user/ajie', `jsqr 旋转 ${deg}°`)
}
for (const f of [0.5, 1, 2, 3]) {
  const img = scaleRgba(renderRgba(rt.modules, rt.size, { scale: 4 }), f)
  const r = jsQR(img.data, img.width, img.height)
  check(r && r.data === 'chatly://user/ajie', `jsqr 缩放 ×${f}`)
}
{
  const img = renderRgba(rt.modules, rt.size, { noise: 60 })
  const r = jsQR(img.data, img.width, img.height)
  check(r && r.data === 'chatly://user/ajie', 'jsqr 噪声（±60 灰阶）')
}

/* ================= C. 我自己的解码器 ================= */
section('C. 自有解码器（扫一扫用）')

for (const { text, ecc } of CASES) {
  const { size, modules } = qr.encodeQr(text, { ecc })
  const img = renderRgba(modules, size)
  let got = null
  try { got = qr.decodeQrImageData(toImageData(img)) } catch (e) { got = `抛异常: ${e.message}` }
  check(got === text, `自解码 [${ecc}] ${JSON.stringify(text.slice(0, 24))}`, got === text ? '' : `得到 ${JSON.stringify(got)}`)
}

for (const deg of [0, 90, 180, 270]) {
  const img = renderRgba(rt.modules, rt.size, { rotate: deg })
  let got = null
  try { got = qr.decodeQrImageData(toImageData(img)) } catch (e) { got = `抛异常: ${e.message}` }
  check(got === 'chatly://user/ajie', `自解码 旋转 ${deg}°`, got === 'chatly://user/ajie' ? '' : `得到 ${JSON.stringify(got)}`)
}

// 缩放：模拟相机拍到的远近。太小的图（1 像素/模块）确实解不动，是已知边界。
for (const [scale, f, mustPass] of [[4, 0.5, true], [4, 1, true], [4, 2, true], [8, 0.5, true], [3, 0.4, false]]) {
  const img = scaleRgba(renderRgba(rt.modules, rt.size, { scale }), f)
  let got = null
  try { got = qr.decodeQrImageData(toImageData(img)) } catch (e) { got = `抛异常: ${e.message}` }
  const good = got === 'chatly://user/ajie'
  const px = (scale * f).toFixed(1)
  if (mustPass) check(good, `自解码 scale=${scale}×${f}（${px}px/模块）`, good ? '' : `得到 ${JSON.stringify(got)}`)
  else console.log(`  · 边界 scale=${scale}×${f}（${px}px/模块）→ ${good ? '仍可解' : '解不动（可接受）'}`)
}

{
  const img = renderRgba(rt.modules, rt.size, { noise: 40 })
  let got = null
  try { got = qr.decodeQrImageData(toImageData(img)) } catch (e) { got = `抛异常: ${e.message}` }
  check(got === 'chatly://user/ajie', '自解码 噪声（±40 灰阶）', got === 'chatly://user/ajie' ? '' : `得到 ${JSON.stringify(got)}`)
}

// 打印一张我编的码（方便人眼核对定位图案）
{
  const { size, modules, version, mask } = qr.encodeQr('chatly://user/chenmo', { ecc: 'M' })
  console.log(`\n  样例 chatly://user/chenmo → version ${version}, mask ${mask}, ${size}×${size}`)
  for (let r = 0; r < size; r++) {
    let line = '  '
    for (let c = 0; c < size; c++) line += modules[r * size + c] ? '██' : '  '
    console.log(line)
  }
}

/* ---------- 汇总 ---------- */
console.log(`\n${'─'.repeat(52)}`)
if (fails.length) {
  console.log(`✗ ${pass} 项通过，${fails.length} 项失败`)
  for (const f of fails) console.log(`   · ${f}`)
  process.exit(1)
}
console.log(`✅ 全部通过：${pass} 项`)
