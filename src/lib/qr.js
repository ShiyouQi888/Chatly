/* ===== 零依赖二维码编解码 =====
 *
 * 为什么自己写：项目硬约束是**零运行时依赖**（不引 qrcode / jsqr / zxing）。
 * 但「扫一扫」必须真的能扫 —— 实测本机浏览器 `typeof BarcodeDetector === 'undefined'`
 * （Shape Detection API 在桌面 Chrome 上没开），**没有任何内置解码器可用**。
 * 所以编码与解码都自己实现：编码给「我的二维码」，解码给「扫一扫」。
 *
 * 支持范围（够用即可，不追全规格）：
 *   · 编码：byte 模式，纠错等级 L / M，版本 1~10（byte 容量 17~271 字节）。
 *   · 解码：灰度 → Otsu 二值化 → 定位图案检测 → **仿射**采样（容旋转 / 倾斜 / 缩放）
 *     → 反掩码 → 去交织 → RS 纠错（每块最多纠 3 个错误码字）→ 解析负载。
 *   · 不支持：透视畸变（要第 4 个角点做单应变换）、一图多码、非 byte 模式。
 *
 * ★ 编解码**共用 `dataPositions()` 一处**定义 Z 字填充顺序。
 *   以前编码器写、解码器读各写一遍，两边差一个模块就会「编出来能看、扫出来是乱码」——
 *   这种错极难定位，所以只留一份。
 *
 * 交叉验证见 `scripts/lib/qr-verify.mjs`：拿 npm 的 `qrcode` + `jsqr` 对拍。
 */

/* ---------- GF(256)，本原多项式 0x11D ---------- */
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(function initGF() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
})()

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]])
const gfDiv = (a, b) => (a === 0 ? 0 : GF_EXP[(GF_LOG[a] - GF_LOG[b] + 255) % 255])
const gfPow = (e) => GF_EXP[((e % 255) + 255) % 255]

/* ---------- 规格表 ---------- */
/* 纠错等级在格式信息里是 2 bit，取值**不是** L/M/Q/H 的顺序，别写错 */
const ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 }

/* [每块纠错码字数, 组1块数, 组1数据码字数, 组2块数, 组2数据码字数]（版本 1~10） */
const RS_BLOCKS = {
  L: [
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
  ],
}

const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]

export const MAX_VERSION = 10

const alignPositions = (version) => ALIGN[version - 1] || []

/**
 * 这个校正图案坐标是否与三角定位图案撞了（撞了就不画）。
 * 定位图案含分隔带占 rows/cols `0..8` 与 `size-8..size-1`，校正图案跨 ±2 模块，
 * 所以用**矩形相交**判断，不能只比一个数。
 */
function alignmentSkipped(cy, cx, size) {
  return (
    (cy - 2 <= 8 && cx - 2 <= 8) ||
    (cy - 2 <= 8 && cx + 2 >= size - 8) ||
    (cy + 2 >= size - 8 && cx - 2 <= 8)
  )
}

function blockInfo(version, ecc) {
  const row = (RS_BLOCKS[ecc] || RS_BLOCKS.M)[version - 1]
  if (!row) throw new Error(`不支持的版本：${version}`)
  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = row
  return {
    ecPerBlock,
    g1Blocks,
    g1Data,
    g2Blocks,
    g2Data,
    totalBlocks: g1Blocks + g2Blocks,
    totalData: g1Blocks * g1Data + g2Blocks * g2Data,
  }
}

const charCountBits = (version) => (version <= 9 ? 8 : 16)

/* ---------- 掩码 ---------- */
const MASK_FN = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

/* ---------- 格式信息 / 版本信息（BCH） ---------- */
export function formatBits(ecc, mask) {
  const data = (((ECC_BITS[ecc] ?? 0) << 3) | mask) & 0x1f
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff
}

export function versionBits(version) {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (version << 12) | rem
}

/* ---------- RS 纠错 ---------- */
const genCache = new Map()
/**
 * 生成多项式 g(x) = ∏(x − α^i)，i = 0..ecLen−1。
 * 系数数组**降幂**存放：`g[0]` 是 x^ecLen 的系数（恒为 1），`g[ecLen]` 是常数项。
 *
 * ⚠️ 这一段的两个索引极易写反（写成 `next[j+1] ^= g[j]` / `next[j] ^= α^i·g[j]`），
 * 结果是「g 的前几项全错、但纠错仍然自洽」—— 自己编自己解能过（因为编解码共用它），
 * 只有和标准实现或真实扫码器对拍才会暴露。已由 `qr-verify.mjs` 的逐模块对拍兜住。
 */
export function rsGeneratorPoly(ecLen) {
  if (genCache.has(ecLen)) return genCache.get(ecLen)
  let g = [1]
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(g.length + 1).fill(0)
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j] /* x·g：次数 +1，但降幂下标不变 */
      next[j + 1] ^= gfMul(g[j], gfPow(i)) /* α^i·g：降幂下标 +1 */
    }
    g = next
  }
  genCache.set(ecLen, g)
  return g
}

export function rsEncode(data, ecLen) {
  const g = rsGeneratorPoly(ecLen)
  const rem = new Uint8Array(ecLen)
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0]
    rem.copyWithin(0, 1)
    rem[ecLen - 1] = 0
    if (factor !== 0) for (let j = 0; j < ecLen; j++) rem[j] ^= gfMul(g[j + 1], factor)
  }
  return rem
}

/** 伴随式 S_j = R(α^j)，全 0 表示无错 */
function syndromes(msg, ecLen) {
  const S = new Uint8Array(ecLen)
  for (let j = 0; j < ecLen; j++) {
    const x = gfPow(j)
    let acc = 0
    for (let i = 0; i < msg.length; i++) acc = gfMul(acc, x) ^ msg[i]
    S[j] = acc
  }
  return S
}

/** GF(256) 高斯消元解 A·e = B，无解返回 null */
function solveLinear(A, B) {
  const n = B.length
  const m = A.map((row, i) => [...row, B[i]])
  for (let col = 0; col < n; col++) {
    let pivot = -1
    for (let r = col; r < n; r++) if (m[r][col] !== 0) { pivot = r; break }
    if (pivot < 0) return null
    ;[m[col], m[pivot]] = [m[pivot], m[col]]
    const inv = gfDiv(1, m[col][col])
    for (let c = col; c <= n; c++) m[col][c] = gfMul(m[col][c], inv)
    for (let r = 0; r < n; r++) {
      if (r === col || m[r][col] === 0) continue
      const f = m[r][col]
      for (let c = col; c <= n; c++) m[r][c] ^= gfMul(f, m[col][c])
    }
  }
  return m.map((row) => row[n])
}

/**
 * 纠错：**穷举错误位置 + 解线性方程组**，不用 Berlekamp-Massey + Forney。
 * 后者要处理一堆多项式约定（起始根、Forney 的符号与 α 幂次），写错了极难发现；
 * 这里要纠的错误本来就少（≤3），穷举直白、而且能用单元测试证明。
 * 位置 k 对应 X = α^(n-1-k)，且有 S_j = Σ e_i · X_i^j。
 */
export function rsCorrect(msg, ecLen) {
  if (syndromes(msg, ecLen).every((v) => v === 0)) return msg
  const n = msg.length
  const maxErr = Math.min(3, Math.floor(ecLen / 2))

  const search = (pick) => {
    const v = pick.length
    const X = pick.map((k) => gfPow(n - 1 - k))
    const A = []
    const B = []
    for (let j = 0; j < v; j++) {
      A.push(X.map((x) => gfPow(GF_LOG[x] * j)))
      B.push(syndromes(msg, ecLen)[j])
    }
    const e = solveLinear(A, B)
    if (!e) return null
    const S = syndromes(msg, ecLen)
    for (let j = v; j < ecLen; j++) {
      let acc = 0
      for (let i = 0; i < v; i++) acc ^= gfMul(e[i], gfPow(GF_LOG[X[i]] * j))
      if (acc !== S[j]) return null
    }
    const out = Uint8Array.from(msg)
    pick.forEach((k, i) => {
      out[k] ^= e[i]
    })
    return out
  }

  for (let v = 1; v <= maxErr; v++) {
    const pick = []
    const walk = (start, depth) => {
      if (depth === v) return search([...pick])
      for (let k = start; k < n; k++) {
        pick.push(k)
        const r = walk(k + 1, depth + 1)
        if (r) return r
        pick.pop()
      }
      return null
    }
    const r = walk(0, 0)
    if (r) return r
  }
  return null
}

/* ---------- 矩阵构造 ---------- */
const makeMatrix = (size) => Array.from({ length: size }, () => new Uint8Array(size))

function drawFinder(m, row, col) {
  const size = m.length
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const r = row + dy
      const c = col + dx
      if (r < 0 || c < 0 || r >= size || c >= size) continue
      const d = Math.max(Math.abs(dy - 3), Math.abs(dx - 3))
      m[r][c] = d === 4 ? 0 : d === 2 ? 0 : 1 /* d=4 是分隔带，d=2 是内圈留白 */
    }
  }
}

/** 函数模块掩膜：这些位置不放数据，也不参与掩码 */
function functionMask(size, version) {
  const f = makeMatrix(size)
  const mark = (r, c) => {
    if (r >= 0 && c >= 0 && r < size && c < size) f[r][c] = 1
  }
  /* ⚠️ 三个角块**不是**三个 9×9：左上 9×9（含格式信息第 1 份），
     右上 9×8、左下 8×9 —— 各差一列/一行。多标一列会把本该放数据的模块
     当成功能模块，`dataPositions()` 生成的 Z 字顺序随之整体错位，
     表现是「码画得出来、扫出来是乱码」。这里错一次，下面全错。 */
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) mark(r, c)
  for (let r = 0; r < 9; r++) for (let c = 0; c < 8; c++) mark(r, size - 1 - c)
  for (let r = 0; r < 8; r++) for (let c = 0; c < 9; c++) mark(size - 1 - r, c)
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6) }

  const pos = alignPositions(version)
  for (const cy of pos) {
    for (const cx of pos) {
      if (alignmentSkipped(cy, cx, size)) continue
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(cy + dy, cx + dx)
    }
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(i, size - 11 + j); mark(size - 11 + j, i) }
  }
  return f
}

/**
 * ★ 数据的 Z 字填充顺序 —— 编码器写、解码器读，**共用这一份**。
 * 列从右往左每次两列，跳过定位线所在的第 6 列；方向上下来回。
 * 方向不能自己记一个 toggle：标准是由「这一对里右边那一列的列号」决定的
 * （`((col + 1) & 2) === 0`），蹭巧对上只是因为列号步长恰好是 2，改一处就崩。
 */
function dataPositions(size, version) {
  const fn = functionMask(size, version)
  const pos = []
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5
    const up = ((col + 1) & 2) === 0
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i
      for (const c of [col, col - 1]) if (!fn[row][c]) pos.push(row * size + c)
    }
  }
  return pos
}

function drawAlignment(m, version, size) {
  const pos = alignPositions(version)
  for (const cy of pos) {
    for (const cx of pos) {
      if (alignmentSkipped(cy, cx, size)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) m[cy + dy][cx + dx] = Math.max(Math.abs(dy), Math.abs(dx)) !== 1 ? 1 : 0
      }
    }
  }
}

function drawTiming(m, size) {
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0
    m[i][6] = i % 2 === 0 ? 1 : 0
  }
}

function drawFormat(m, size, ecc, mask) {
  const bits = formatBits(ecc, mask)
  const bit = (i) => (bits >>> i) & 1
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i)
  m[7][8] = bit(6)
  m[8][8] = bit(7)
  m[8][7] = bit(8)
  for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i)
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i)
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i)
  m[size - 8][8] = 1 /* 固定黑模块 */
}

function drawVersion(m, size, version) {
  if (version < 7) return
  const bits = versionBits(version)
  for (let i = 0; i < 18; i++) {
    const b = (bits >>> i) & 1
    const a = size - 11 + (i % 3)
    const r = Math.floor(i / 3)
    m[r][a] = b
    m[a][r] = b
  }
}

/* ---------- 数据位流 ---------- */
function buildCodewords(bytes, version, ecc) {
  const info = blockInfo(version, ecc)
  const bits = []
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, charCountBits(version))
  for (const b of bytes) push(b, 8)

  const capacity = info.totalData * 8
  if (bits.length > capacity) throw new Error('内容过长')
  push(0, Math.min(4, capacity - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  const pads = [0xec, 0x11]
  let p = 0
  while (bits.length < capacity) push(pads[p++ % 2], 8)

  const data = new Uint8Array(info.totalData)
  for (let i = 0; i < data.length; i++) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]
    data[i] = v
  }

  const blocks = []
  let off = 0
  for (let b = 0; b < info.g1Blocks; b++) {
    const d = data.subarray(off, off + info.g1Data)
    off += info.g1Data
    blocks.push({ data: d, ec: rsEncode(d, info.ecPerBlock) })
  }
  for (let b = 0; b < info.g2Blocks; b++) {
    const d = data.subarray(off, off + info.g2Data)
    off += info.g2Data
    blocks.push({ data: d, ec: rsEncode(d, info.ecPerBlock) })
  }

  const out = new Uint8Array(info.totalData + info.ecPerBlock * info.totalBlocks)
  let k = 0
  const maxData = Math.max(info.g1Data, info.g2Data)
  for (let i = 0; i < maxData; i++) for (const bl of blocks) if (i < bl.data.length) out[k++] = bl.data[i]
  for (let i = 0; i < info.ecPerBlock; i++) for (const bl of blocks) out[k++] = bl.ec[i]
  return out
}

function applyMask(m, fn, size, mask) {
  const f = MASK_FN[mask]
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c] && f(r, c)) m[r][c] ^= 1
}

/** 掩码惩罚（4 条规则），分越低越好 */
export function penaltyScore(m, size) {
  let score = 0
  let dark = 0
  const line = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1
      let prev = get(a, 0)
      for (let b = 1; b < size; b++) {
        const v = get(a, b)
        if (v === prev) run++
        else {
          if (run >= 5) score += 3 + (run - 5)
          prev = v
          run = 1
        }
      }
      if (run >= 5) score += 3 + (run - 5)
    }
  }
  line((a, b) => m[a][b])
  line((a, b) => m[b][a])

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c]
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3
    }
  }

  const pat = [1, 0, 1, 1, 1, 0, 1]
  const scan = (get) => {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b + 10 < size; b++) {
        let hit = true
        for (let i = 0; i < 7 && hit; i++) if (get(a, b + i) !== pat[i]) hit = false
        if (!hit) continue
        let quiet = true
        for (let i = 7; i < 11 && quiet; i++) if (get(a, b + i) !== 0) quiet = false
        if (quiet) score += 40
      }
      for (let b = 4; b + 6 < size; b++) {
        let hit = true
        for (let i = 0; i < 7 && hit; i++) if (get(a, b + i) !== pat[i]) hit = false
        if (!hit) continue
        let quiet = true
        for (let i = 1; i <= 4 && quiet; i++) if (get(a, b - i) !== 0) quiet = false
        if (quiet) score += 40
      }
    }
  }
  scan((a, b) => m[a][b])
  scan((a, b) => m[b][a])

  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c]
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10
  return score
}

/**
 * 生成二维码矩阵。
 * @param {string} text 内容（UTF-8）
 * @param {{ecc?: 'L'|'M', mask?: number, version?: number}} opts
 * @returns {{size:number, version:number, mask:number, modules:Uint8Array}}
 */
export function encodeQr(text, opts = {}) {
  const ecc = opts.ecc === 'L' ? 'L' : 'M'
  const bytes = new TextEncoder().encode(String(text))

  let version = opts.version || 0
  if (!version) {
    for (let v = 1; v <= MAX_VERSION; v++) {
      if (bytes.length * 8 + 4 + charCountBits(v) <= blockInfo(v, ecc).totalData * 8) {
        version = v
        break
      }
    }
  }
  if (!version) throw new Error(`内容过长（${bytes.length} 字节），当前支持到版本 ${MAX_VERSION}`)

  const size = version * 4 + 17
  const codewords = buildCodewords(bytes, version, ecc)
  const fn = functionMask(size, version)
  const positions = dataPositions(size, version)

  const build = (mask) => {
    const m = makeMatrix(size)
    drawFinder(m, 0, 0)
    drawFinder(m, 0, size - 7)
    drawFinder(m, size - 7, 0)
    drawAlignment(m, version, size)
    drawTiming(m, size)
    drawVersion(m, size, version)
    for (let k = 0; k < positions.length; k++) {
      const idx = positions[k]
      const r = (idx / size) | 0
      const c = idx % size
      const bitIdx = k
      m[r][c] = bitIdx < codewords.length * 8 ? (codewords[bitIdx >> 3] >>> (7 - (bitIdx & 7))) & 1 : 0
    }
    applyMask(m, fn, size, mask)
    drawFormat(m, size, ecc, mask)
    return m
  }

  let best = null
  const masks = typeof opts.mask === 'number' ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7]
  for (const mk of masks) {
    const m = build(mk)
    const p = penaltyScore(m, size)
    if (!best || p < best.p) best = { p, mask: mk, m }
  }

  const flat = new Uint8Array(size * size)
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) flat[r * size + c] = best.m[r][c]
  return { size, version, mask: best.mask, modules: flat }
}

/** 把矩阵画到 canvas（不引绘制库），返回 canvas */
export function drawQrToCanvas(canvas, text, { scale = 8, margin = 4, dark = '#16161f', light = '#ffffff', ecc = 'M' } = {}) {
  const { size, modules } = encodeQr(text, { ecc })
  const px = (size + margin * 2) * scale
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = light
  ctx.fillRect(0, 0, px, px)
  ctx.fillStyle = dark
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r * size + c]) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale)
    }
  }
  return canvas
}

/* ================= 解码 ================= */

function toGray(imageData) {
  const { width, height, data } = imageData
  const g = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8
  return g
}

/** Otsu 全局阈值 */
function otsu(gray) {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  const total = gray.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = -1
  let threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      threshold = t
    }
  }
  return threshold
}

function binarize(gray) {
  const t = otsu(gray)
  const b = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) b[i] = gray[i] <= t ? 1 : 0 /* 1 = 深色 */
  return b
}

/** 在一行/一列里找 1:1:3:1:1 的定位图案，返回中心位置与模块像素尺寸 */
function scanLineForFinders(get, len, out) {
  const runs = []
  let i = 0
  while (i < len) {
    const color = get(i)
    let j = i
    while (j < len && get(j) === color) j++
    runs.push({ color, start: i, len: j - i })
    i = j
  }
  for (let k = 0; k + 4 < runs.length; k++) {
    const w = runs.slice(k, k + 5)
    if (w[0].color !== 1) continue
    const total = w[0].len + w[1].len + w[2].len + w[3].len + w[4].len
    if (total < 7) continue
    const s = total / 7
    const v = s / 2
    if (
      Math.abs(w[0].len - s) > v ||
      Math.abs(w[1].len - s) > v ||
      Math.abs(w[2].len - 3 * s) > 3 * v ||
      Math.abs(w[3].len - s) > v ||
      Math.abs(w[4].len - s) > v
    ) {
      continue
    }
    out.push({ center: w[2].start + w[2].len / 2, size: s })
  }
}

/** 找三个定位图案；返回直角顶点 tl 与另外两点 */
function locateFinders(bin, w, h) {
  const raw = []
  for (let y = 0; y < h; y++) {
    const cands = []
    scanLineForFinders((i) => bin[y * w + i], w, cands)
    for (const c of cands) {
      const cx = Math.round(c.center)
      if (cx < 0 || cx >= w) continue
      const col = []
      scanLineForFinders((i) => bin[i * w + cx], h, col)
      const hit = col.find((cc) => Math.abs(cc.center - y) <= Math.max(2, c.size))
      if (hit) raw.push({ x: cx, y: hit.center, size: (c.size + hit.size) / 2 })
    }
  }
  if (raw.length < 3) return null

  /* 聚类：同一个定位图案会在很多行上命中 */
  const cl = []
  for (const p of raw) {
    const near = cl.find((c) => Math.hypot(c.x - p.x, c.y - p.y) < Math.max(5, c.size * 2.5))
    if (near) {
      near.x = (near.x * near.n + p.x) / (near.n + 1)
      near.y = (near.y * near.n + p.y) / (near.n + 1)
      near.size = (near.size * near.n + p.size) / (near.n + 1)
      near.n++
    } else cl.push({ ...p, n: 1 })
  }
  cl.sort((a, b) => b.n - a.n)
  const top = cl.slice(0, 10)
  if (top.length < 3) return null

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  let best = null
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      for (let k = j + 1; k < top.length; k++) {
        const p = [top[i], top[j], top[k]]
        const dd = [dist(p[0], p[1]), dist(p[1], p[2]), dist(p[0], p[2])]
        const corner = p[dd.indexOf(Math.max(...dd)) === 0 ? 2 : dd.indexOf(Math.max(...dd)) === 1 ? 0 : 1]
        const others = p.filter((q) => q !== corner)
        const s1 = dist(corner, others[0])
        const s2 = dist(corner, others[1])
        if (s1 < 8 || s2 < 8) continue
        const err = Math.abs(s1 - s2) / Math.max(s1, s2) + Math.abs(dist(others[0], others[1]) / Math.max(s1, s2) - Math.SQRT2)
        if (!best || err < best.err) best = { err, tl: corner, others }
      }
    }
  }
  if (!best || best.err > 0.35) return null
  return best
}

function sampleMatrix(bin, w, h, dim, tl, tr, bl) {
  const sx = { x: (tr.x - tl.x) / (dim - 7), y: (tr.y - tl.y) / (dim - 7) }
  const sy = { x: (bl.x - tl.x) / (dim - 7), y: (bl.y - tl.y) / (dim - 7) }
  const m = makeMatrix(dim)
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      const ax = c + 0.5 - 3.5
      const ay = r + 0.5 - 3.5
      const cx = tl.x + ax * sx.x + ay * sy.x
      const cy = tl.y + ax * sx.y + ay * sy.y
      let votes = 0
      let total = 0
      for (const [ox, oy] of [
        [0, 0],
        [-0.28, 0],
        [0.28, 0],
        [0, -0.28],
        [0, 0.28],
      ]) {
        const px = Math.round(cx + ox * sx.x + oy * sy.x)
        const py = Math.round(cy + ox * sx.y + oy * sy.y)
        if (px < 0 || py < 0 || px >= w || py >= h) continue
        votes += bin[py * w + px]
        total++
      }
      m[r][c] = total === 0 || votes * 2 < total ? 0 : 1
    }
  }
  return m
}

function looksLikeQr(m, dim) {
  const check = (r0, c0) => {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const d = Math.max(Math.abs(dy - 3), Math.abs(dx - 3))
        if (m[r0 + dy][c0 + dx] !== (d === 2 ? 0 : 1)) return false
      }
    }
    return true
  }
  if (!check(0, 0) || !check(0, dim - 7) || !check(dim - 7, 0)) return false
  for (let i = 8; i < dim - 8; i++) {
    const want = i % 2 === 0 ? 1 : 0
    if (m[6][i] !== want || m[i][6] !== want) return false
  }
  return true
}

function readFormat(m) {
  const bitAt = (i) => (i <= 5 ? m[i][8] : i === 6 ? m[7][8] : i === 7 ? m[8][8] : i === 8 ? m[8][7] : m[8][14 - i])
  let bits = 0
  for (let i = 0; i < 15; i++) bits |= bitAt(i) << i
  const data = (bits ^ 0x5412) >>> 10
  const ecc = Object.keys(ECC_BITS).find((k) => ECC_BITS[k] === ((data >>> 3) & 3))
  const mask = data & 7
  if (!ecc || !RS_BLOCKS[ecc]) return null
  return { ecc, mask }
}

function deinterleave(words, info) {
  const blocks = []
  for (let b = 0; b < info.totalBlocks; b++) {
    const len = b < info.g1Blocks ? info.g1Data : info.g2Data
    blocks.push({ data: new Uint8Array(len + info.ecPerBlock), dLen: len })
  }
  let k = 0
  const maxData = Math.max(info.g1Data, info.g2Data)
  for (let i = 0; i < maxData; i++) for (const bl of blocks) if (i < bl.dLen && k < words.length) bl.data[i] = words[k++]
  for (let i = 0; i < info.ecPerBlock; i++) for (const bl of blocks) if (k < words.length) bl.data[bl.dLen + i] = words[k++]
  return blocks
}

function parsePayload(data, version) {
  const bits = []
  for (const b of data) for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1)
  let p = 0
  const take = (n) => {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | (bits[p++] || 0)
    return v
  }
  if (take(4) !== 0b0100) return null /* 只认 byte 模式 */
  const len = take(charCountBits(version))
  if (len * 8 > bits.length - p) return null
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = take(8)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function tryDecodeMatrix(m, dim) {
  if ((dim - 17) % 4 !== 0) return null
  const version = (dim - 17) / 4
  if (version < 1 || version > MAX_VERSION) return null
  if (!looksLikeQr(m, dim)) return null
  const fmt = readFormat(m)
  if (!fmt) return null
  if (!(RS_BLOCKS[fmt.ecc] || [])[version - 1]) return null

  const info = blockInfo(version, fmt.ecc)
  const fn = functionMask(dim, version)
  const positions = dataPositions(dim, version)
  const maskFn = MASK_FN[fmt.mask]

  const totalBits = (info.totalData + info.ecPerBlock * info.totalBlocks) * 8
  const words = new Uint8Array(Math.ceil(totalBits / 8))
  for (let k = 0; k < positions.length && k < totalBits; k++) {
    const idx = positions[k]
    const r = (idx / dim) | 0
    const c = idx % dim
    let bit = m[r][c]
    if (!fn[r][c] && maskFn(r, c)) bit ^= 1 /* 反掩码 */
    if (bit) words[k >> 3] |= 1 << (7 - (k & 7))
  }

  const out = []
  for (const bl of deinterleave(words, info)) {
    const fixed = rsCorrect(bl.data, info.ecPerBlock)
    if (!fixed) return null
    for (let i = 0; i < bl.dLen; i++) out.push(fixed[i])
  }
  return parsePayload(Uint8Array.from(out), version)
}

/**
 * 从 ImageData 解出二维码内容，失败返回 null。
 * @param {ImageData} imageData
 * @returns {string|null}
 */
export function decodeQrImageData(imageData) {
  const { width: w, height: h } = imageData
  if (!w || !h) return null
  const bin = binarize(toGray(imageData))
  const found = locateFinders(bin, w, h)
  if (!found) return null

  const size = (found.tl.size + found.others[0].size + found.others[1].size) / 3
  const diag = Math.hypot(found.others[0].x - found.others[1].x, found.others[0].y - found.others[1].y)
  const span = Math.round(diag / Math.SQRT2 / Math.max(size, 0.5))
  let version = Math.round((span + 7 - 17) / 4)
  version = Math.min(Math.max(version || 1, 1), MAX_VERSION)
  const dim = version * 4 + 17

  /* 两个「另一个角」谁是右上谁是左下不确定（取决于朝向 / 是否镜像），两种都试 */
  for (const [tr, bl] of [
    [found.others[0], found.others[1]],
    [found.others[1], found.others[0]],
  ]) {
    const text = tryDecodeMatrix(sampleMatrix(bin, w, h, dim, found.tl, tr, bl), dim)
    if (text != null) return text
  }
  return null
}

/** 从 canvas / img / video 等可绘制对象解码 */
export function decodeQrFromSource(source, { maxSide = 1000 } = {}) {
  const sw = source.naturalWidth || source.videoWidth || source.width
  const sh = source.naturalHeight || source.videoHeight || source.height
  if (!sw || !sh) return null
  const ratio = Math.min(1, maxSide / Math.max(sw, sh))
  const w = Math.max(1, Math.round(sw * ratio))
  const h = Math.max(1, Math.round(sh * ratio))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)
  return decodeQrImageData(ctx.getImageData(0, 0, w, h))
}
