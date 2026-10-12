/**
 * GIF89a 最小解析 —— 只关心「会不会叠影」这件事，不解码像素。
 *
 * 由来：动画大表情第一版转的是 WebP，桌面浏览器上出现「两个完整表情重叠 / 错位」。
 * 根因是**帧语义**不是像素 —— ffmpeg 的 libwebp 写出「全画布帧 + blend + dispose=none」，
 * 透明背景的表情逐帧累积，动作幅度大的（🤣💩🚀）就是一眼可见的两个表情叠着。
 * 这类 bug 看文件头、看体积、看帧数全都发现不了，只能把每帧的**处置方式**读出来断言。
 *
 * 所以这里只解析封装层（LSD / GCE / Image Descriptor），**不碰 LZW 数据**。
 * 像素对不对交给 ffmpeg 和浏览器，这里只保证「浏览器会怎么摆放这些帧」是对的。
 *
 * ⚠️ 转码脚本（fetch-emoji-anim.mjs）和自检脚本（check-emoji.mjs）**必须共用这一个模块**。
 *    两边各写一份判据，就会出现「转码时觉得合格、自检时觉得不合格」这种最难查的 bug。
 */
import fs from 'node:fs'

/**
 * @param {Buffer} buf
 * @returns {{w:number, h:number, loop:boolean, frames:Array<{disposal:number, transparent:boolean, delay:number, tIndex:number, gceOff:number, packed:number, x:number, y:number, fw:number, fh:number}>}}
 */
export function parseGif(buf) {
  if (buf.slice(0, 6).toString('ascii') !== 'GIF89a') {
    throw new Error(`不是 GIF89a（实际是 ${buf.slice(0, 6).toString('ascii')}）`)
  }
  const w = buf.readUInt16LE(6)
  const h = buf.readUInt16LE(8)
  const lsdPacked = buf[10]
  const gctSize = lsdPacked & 0x80 ? 3 * (1 << ((lsdPacked & 0x07) + 1)) : 0
  let off = 13 + gctSize
  const frames = []
  let pending = null
  let loop = false

  for (;;) {
    if (off >= buf.length) break
    const b = buf[off]
    if (b === 0x21) {
      // 扩展块
      const label = buf[off + 1]
      off += 2
      if (label === 0xf9) {
        // Graphic Control Extension：packed 的 bit0 = 透明色标志，bit4..2 = 处置方式
        const bs = buf[off]
        const packed = buf[off + 1]
        pending = {
          /* ⚠️ packed 在 off+1，off 是「块长度」字节。
             第一版写成 off，打补丁时会把块长度改掉 —— 文件直接损坏，
             而且因为 ffmpeg 本来就写 disposal=2（补丁从不触发），这个错一直没暴露。 */
          gceOff: off + 1,
          packed,
          disposal: (packed >> 2) & 0x07,
          transparent: !!(packed & 0x01),
          delay: buf.readUInt16LE(off + 2),
          tIndex: buf[off + 4],
        }
        off += 1 + bs
      } else if (label === 0xff) {
        // Application Extension：NETSCAPE2.0 里带循环次数
        const bs = buf[off]
        if (buf.slice(off + 1, off + 12).toString('ascii') === 'NETSCAPE2.0') loop = true
        off += 1 + bs
      }
      for (;;) { const n = buf[off]; off += 1 + n; if (n === 0) break } // 子块链
    } else if (b === 0x2c) {
      // Image Descriptor
      const x = buf.readUInt16LE(off + 1)
      const y = buf.readUInt16LE(off + 3)
      const fw = buf.readUInt16LE(off + 5)
      const fh = buf.readUInt16LE(off + 7)
      off += 10
      const packed = buf[off - 1]
      if (packed & 0x80) off += 3 * (1 << ((packed & 0x07) + 1)) // 局部色表
      off += 1 // LZW 最小码长
      for (;;) { const n = buf[off]; off += 1 + n; if (n === 0) break } // 图像数据
      if (pending) frames.push({ ...pending, x, y, fw, fh })
      pending = null
    } else if (b === 0x3b) {
      break // Trailer
    } else {
      off += 1
    }
  }
  return { w, h, frames, loop }
}

/** 处置方式的中文说明 —— 断言失败时打出来比 0/1/2 好懂 */
export const DISPOSAL_NAME = {
  0: '未指定',
  1: '不处置（会留残影）',
  2: '恢复背景',
  3: '恢复上一帧',
}

/**
 * 把每个 GCE 的处置方式强制写成 2（restore to background）。
 * 不是 2 时上一帧会留在画布上，透明背景的表情就「叠」出好几个。
 * @returns {number} 改了几帧
 */
export function forceDisposeToBg(path) {
  const buf = fs.readFileSync(path)
  let n = 0
  for (const f of parseGif(buf).frames) {
    if (f.disposal !== 2) {
      buf[f.gceOff] = (f.packed & ~0x1c) | (2 << 2) // bit4..2 = 010
      n++
    }
  }
  if (n) fs.writeFileSync(path, buf)
  return n
}

/**
 * 转完立刻自检：帧数够、处置方式正确、能循环。
 * 抛错比返回 false 好 —— 转码脚本里一张坏图就该让整轮失败，
 * 而不是悄悄产出一个「能显示但会叠影」的图。
 * @returns {{frames:number, loop:boolean}}
 */
export function verifyGif(path, { minFrames = 6 } = {}) {
  const g = parseGif(fs.readFileSync(path))
  if (g.frames.length < minFrames) throw new Error(`只有 ${g.frames.length} 帧，不算动画`)
  const bad = g.frames.filter((f) => f.disposal !== 2 && f.disposal !== 3)
  if (bad.length) {
    throw new Error(
      `${bad.length}/${g.frames.length} 帧的处置方式是「${DISPOSAL_NAME[bad[0].disposal]}」，会叠残影`
    )
  }
  if (!g.loop) throw new Error('缺 NETSCAPE 循环扩展（只会播一遍）')
  return { frames: g.frames.length, loop: g.loop }
}

/** 同一个检查在自检脚本里的名字 —— 语义是「断言这条动画能安全播放」。
    它和 verifyGif 必须是同一个函数，只是叫法不同。 */
export const assertSafeAnimGif = verifyGif
