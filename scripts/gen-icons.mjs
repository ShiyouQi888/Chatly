/**
 * 生成 PWA 图标（180 / 192 / 512）。
 *
 * 为什么自己画：项目约定「零外链资源、零第三方字体/图片」，图标也不能例外；
 * 而 iOS 只认 PNG 的 apple-touch-icon —— 没有它，「添加到主屏幕」出来的是一个
 * 灰色截图缩略图，Web Push 的门槛就卡在这一步。
 *
 * 画法：品牌紫渐变圆角底 + 白色对话气泡 + 两条短横线（暗示文字消息）。
 * 用 2× 超采样做抗锯齿，避免小尺寸下边缘出现锯齿。
 *
 * 跑法：node scripts/gen-icons.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodePng } from './lib/png.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const BRAND_FROM = [0x7c, 0x6c, 0xf8]
const BRAND_TO = [0x5b, 0x4b, 0xd8]
const INK = [0x6d, 0x5d, 0xf6]

const lerp = (a, b, t) => a + (b - a) * t

/** 点是否在圆角矩形内（坐标与尺寸都是 0..1 的相对值） */
function inRoundRect(x, y, left, top, w, h, r) {
  const x2 = left + w
  const y2 = top + h
  if (x < left || x > x2 || y < top || y > y2) return false
  const cx = Math.min(Math.max(x, left + r), x2 - r)
  const cy = Math.min(Math.max(y, top + r), y2 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/** 气泡左下角的小尾巴（三角形） */
function inTail(x, y) {
  if (x < 0.27 || x > 0.46 || y < 0.58 || y > 0.75) return false
  const t = (y - 0.58) / 0.17
  return x <= 0.46 - t * 0.19
}

function shade(x, y) {
  // 背景：45° 线性渐变
  const t = Math.min(1, Math.max(0, (x * 0.55 + y * 0.45)))
  let rgb = [
    lerp(BRAND_FROM[0], BRAND_TO[0], t),
    lerp(BRAND_FROM[1], BRAND_TO[1], t),
    lerp(BRAND_FROM[2], BRAND_TO[2], t),
  ]
  let alpha = 255

  /* 顺序很重要：两条横线在气泡**内部**，必须先判线再判气泡，
     否则整块白底会把线盖掉（第一版就是这么画出一个纯白方块的）。 */
  const lineA = inRoundRect(x, y, 0.335, 0.348, 0.33, 0.046, 0.023)
  const lineB = inRoundRect(x, y, 0.335, 0.448, 0.23, 0.046, 0.023)
  const bubble = inRoundRect(x, y, 0.245, 0.26, 0.51, 0.33, 0.095) || inTail(x, y)

  if (lineA || lineB) {
    rgb = INK
  } else if (bubble) {
    rgb = [255, 255, 255]
  }
  return { rgb, alpha }
}

function render(size) {
  const SS = 2
  const W = size * SS
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x * SS + sx + 0.5) / W
          const py = (y * SS + sy + 0.5) / W
          if (!inRoundRect(px, py, 0, 0, 1, 1, 0.225)) continue
          const s = shade(px, py)
          r += s.rgb[0]
          g += s.rgb[1]
          b += s.rgb[2]
          a += 255
        }
      }
      const n = SS * SS
      const idx = (y * size + x) * 4
      // 预乘平均：圆角外的采样点是透明的，直接除 n 会造成边缘发黑
      const cover = a / n
      out[idx] = cover ? Math.round(r / (a / 255)) : 0
      out[idx + 1] = cover ? Math.round(g / (a / 255)) : 0
      out[idx + 2] = cover ? Math.round(b / (a / 255)) : 0
      out[idx + 3] = Math.round(cover)
    }
  }
  return encodePng(size, size, out)
}

for (const size of [180, 192, 512]) {
  const file = path.join(root, 'public', `icon-${size}.png`)
  fs.writeFileSync(file, render(size))
  console.log(`已生成 ${path.relative(root, file)}（${size}×${size}）`)
}
