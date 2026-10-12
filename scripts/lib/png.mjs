/**
 * 零依赖 PNG 编解码 —— 自检专用。
 *
 * 为什么要它：验证「屏幕上/文件里那张二维码是真的」最硬的办法是
 * **把它当图片读回来再解一遍**。只断言「canvas 存在」「canvas 有宽高」
 * 属于数元素个数，抓不到画错、被 CSS 缩糊、只画了半张这些情况。
 *
 * 只在 `scripts/` 下用，不进运行时代码（前端零依赖的约束不受影响）。
 * 用的是 Node 内建的 zlib，不引第三方。
 */
import zlib from 'node:zlib'

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/**
 * 把 RGBA 像素编成 PNG。
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Uint8ClampedArray} rgba 长度 width*height*4
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 /* 过滤器 0（None）：编码端越简单越好，体积无所谓 */
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 /* 位深 */
  ihdr[9] = 6 /* 颜色类型 6 = RGBA */
  ihdr[10] = 0 /* 压缩 */
  ihdr[11] = 0 /* 过滤 */
  ihdr[12] = 0 /* 非隔行 */

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 解 PNG 成 RGBA。支持位深 8 的颜色类型 0/2/4/6，不支持隔行与 16 位
 * （Chrome 截图与自家生成的图都是 8 位非隔行，够用；遇到别的直接抛，
 * 不要静默返回半张图 —— 那会让自检给出假阳性）。
 * @returns {{width:number, height:number, data:Uint8ClampedArray}}
 */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG 文件')

  let pos = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let interlace = 0
  const idat = []

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }

  if (depth !== 8) throw new Error(`只支持 8 位深，实际 ${depth}`)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8ClampedArray(width * height * 4)
  const prev = Buffer.alloc(stride)
  const line = Buffer.alloc(stride)

  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    /* 反过滤。逐字节做，前一个像素就是同一行里往前 channels 个字节。 */
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = v & 0xff
    }
    line.copy(prev)

    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 4
      if (colorType === 6) {
        out[d] = line[s]
        out[d + 1] = line[s + 1]
        out[d + 2] = line[s + 2]
        out[d + 3] = line[s + 3]
      } else if (colorType === 2) {
        out[d] = line[s]
        out[d + 1] = line[s + 1]
        out[d + 2] = line[s + 2]
        out[d + 3] = 255
      } else if (colorType === 4) {
        out[d] = out[d + 1] = out[d + 2] = line[s]
        out[d + 3] = line[s + 1]
      } else {
        out[d] = out[d + 1] = out[d + 2] = line[s]
        out[d + 3] = 255
      }
    }
  }

  return { width, height, data: out }
}

/** 把二维码矩阵渲染成 RGBA（供 encodePng / decodePng 的往返测试） */
export function qrModulesToRgba(modules, size, { scale = 8, margin = 4, dark = 0x16, light = 255 } = {}) {
  const side = (size + margin * 2) * scale
  const out = new Uint8ClampedArray(side * side * 4)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const r = ((y / scale) | 0) - margin
      const c = ((x / scale) | 0) - margin
      const inside = r >= 0 && c >= 0 && r < size && c < size
      const v = inside && modules[r * size + c] ? dark : light
      const p = (y * side + x) * 4
      out[p] = out[p + 1] = out[p + 2] = v
      out[p + 3] = 255
    }
  }
  return { width: side, height: side, data: out }
}
