import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))

/**
 * 表情素材的缓存头。
 *
 * 386 个静态 SVG + 30 个动画 GIF 都是**不变的本地素材**（只有重跑抓取脚本才会变），
 * 每次打开表情面板都重新请求一遍纯属浪费 —— 用户看过一次之后就应该走本地副本。
 *
 * - dev 用 1 小时：够覆盖一整次会话，又不至于让「重新生成素材后刷新看不到新图」变成玄学。
 * - preview / 生产用 1 年 + immutable：文件名是 Unicode 码点，内容跟着代码一起发布。
 *
 * ⚠️ 两个前缀都要判：`'/emoji-anim/1f602.gif'.startsWith('/emoji/')` 是 **false**
 *    （`-anim` 打断了匹配），只写一个会让动画素材完全没缓存。
 */
function emojiCacheHeaders() {
  const mw = (value) => (req, res, next) => {
    const u = req.url || ''
    if (u.startsWith('/emoji/') || u.startsWith('/emoji-anim/')) {
      res.setHeader('Cache-Control', value)
    }
    next()
  }
  return {
    name: 'chatly-emoji-cache',
    configureServer(server) {
      server.middlewares.use(mw('public, max-age=3600'))
    },
    configurePreviewServer(server) {
      server.middlewares.use(mw('public, max-age=31536000, immutable'))
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), emojiCacheHeaders()],
  resolve: { alias: { '@': path.resolve(projectRoot, 'src') } },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    port: 5198,
    proxy: {
      // REST / 上传 / WebSocket 全部转发到独立后端
      '/api': { target: 'http://127.0.0.1:3002', changeOrigin: true },
      '/uploads': { target: 'http://127.0.0.1:3002', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:3002', ws: true },
    },
  },
})
