import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../store/AppContext.jsx'
import { useAuth } from '../store/AuthContext.jsx'
import { avatarOf } from '../store/ChatStore.jsx'
import { Avatar } from '../components/ui.jsx'
import { drawQrToCanvas, encodeQr, decodeQrFromSource } from '../lib/qr.js'
import { userPayload } from '../lib/qrPayload.js'
import { IconDownload, IconCopy, IconCheck, IconScan } from '../components/Icon.jsx'
import './my-qr.css'

/* ===== 我的二维码 =====
 *
 * 码里放的是 `chatly://user/<username>`（见 lib/qrPayload.js）。
 *
 * ★ 码中心**不放头像**：我们的自写解码器每块最多纠 3 个错误码字
 *   （见 lib/qr.js 的 rsCorrect），中心挖一块出来很容易超掉纠错能力 ——
 *   表现就是「自己截图再扫自己的码，扫不出来」。头像放在码外面，一样好看。
 *
 * ★ 保存的是**图片文件**而不是 canvas 节点：`<a download>` 直接下 blob，
 *   不走 fetch（同源也不需要），少一层出错的可能。
 */

/** 把图片加载成可绘制对象；失败返回 null（保存卡片时降级为不带头像） */
function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null)
    const img = new Image()
    /* 头像只可能是同源 /uploads 或 data:，都是同源安全的，画进 canvas 不会污染 */
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

export default function MyQrPage() {
  const { showToast } = useApp()
  const { user } = useAuth()
  const canvasRef = useRef(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const payload = userPayload(user?.username)
  const avatar = avatarOf(user)

  /* 画码。payload 变了（换了账号）就重画。
     ★ 缩放取**整数**像素/模块（`floor`），并且把 canvas 的 CSS 尺寸钉成它的像素尺寸：
       让浏览器去缩一个非整数倍的话，模块边缘会被重采样成灰边，真机扫起来更容易失败。
       username 长短不同 → 版本可能是 2 或 3 → 每个版本的整数缩放也不一样，所以按版本算。 */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      const info = encodeQr(payload, {})
      const margin = 3
      const box = 252
      const scale = Math.max(4, Math.floor(box / (info.size + margin * 2)))
      drawQrToCanvas(canvas, payload, { scale, margin })
      canvas.style.width = `${canvas.width}px`
      canvas.style.height = `${canvas.height}px`
    } catch (e) {
      showToast(e.message || '二维码生成失败')
    }
  }, [payload, showToast])

  /* 自检钩子：check-qr.mjs 用它证明「屏幕上这张码是真的能扫的」，
     而不是只断言「canvas 存在」（后者数元素个数，抓不到画错的情况）。 */
  useEffect(() => {
    if (typeof window === 'undefined') return
    const canvas = canvasRef.current
    const info = (() => {
      try {
        return encodeQr(payload, {})
      } catch {
        return null
      }
    })()
    const api = {
      payload,
      username: user?.username || null,
      version: info?.version ?? null,
      size: info?.size ?? null,
      mask: info?.mask ?? null,
      canvasWidth: canvas?.width ?? 0,
      canvasHeight: canvas?.height ?? 0,
      /** 把当前 canvas 上的像素直接喂回自己的解码器 */
      decodeSelf: () => (canvas ? decodeQrFromSource(canvas) : null),
    }
    window.__myQr = api
    return () => {
      if (window.__myQr === api) delete window.__myQr
    }
  }, [payload, user])

  /** 画一张「分享卡片」：码 + 头像 + 昵称 + ID。返回 canvas */
  const buildCard = useCallback(async () => {
    const W = 720
    const H = 940
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d')

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, W, H)

    /* 顶部品牌条 */
    const grad = ctx.createLinearGradient(0, 0, W, 0)
    grad.addColorStop(0, '#9b8cfb')
    grad.addColorStop(0.5, '#7b5cf6')
    grad.addColorStop(1, '#5b6ef5')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, 10)

    /* 二维码：单独画在白底方块里，居中 */
    const qrSide = 480
    const qrX = (W - qrSide) / 2
    const qrY = 90
    const small = document.createElement('canvas')
    drawQrToCanvas(small, payload, { scale: 10, margin: 3, dark: '#16161f', light: '#ffffff' })
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(small, qrX, qrY, qrSide, qrSide)
    ctx.imageSmoothingEnabled = true

    /* 头像 + 昵称 + ID */
    const avatarY = qrY + qrSide + 70
    const img = await loadImage(avatar)
    const as = 108
    const ax = (W - as) / 2
    ctx.save()
    ctx.beginPath()
    const ar = 28
    ctx.moveTo(ax + ar, avatarY)
    ctx.arcTo(ax + as, avatarY, ax + as, avatarY + as, ar)
    ctx.arcTo(ax + as, avatarY + as, ax, avatarY + as, ar)
    ctx.arcTo(ax, avatarY + as, ax, avatarY, ar)
    ctx.arcTo(ax, avatarY, ax + as, avatarY, ar)
    ctx.closePath()
    ctx.clip()
    if (img) {
      ctx.drawImage(img, ax, avatarY, as, as)
    } else {
      ctx.fillStyle = '#7b5cf6'
      ctx.fillRect(ax, avatarY, as, as)
    }
    ctx.restore()

    ctx.textAlign = 'center'
    ctx.fillStyle = '#16161f'
    ctx.font = '600 44px "Noto Sans SC", "Source Han Sans SC", system-ui, sans-serif'
    ctx.fillText(user?.nickname || '', W / 2, avatarY + as + 74, W - 120)

    ctx.fillStyle = '#8c8ca0'
    ctx.font = '400 30px "Noto Sans SC", "Source Han Sans SC", system-ui, sans-serif'
    ctx.fillText(`ID: ${user?.username || ''}`, W / 2, avatarY + as + 124)

    ctx.fillStyle = '#b4b4c4'
    ctx.font = '400 26px "Noto Sans SC", "Source Han Sans SC", system-ui, sans-serif'
    ctx.fillText('打开 Chatly 扫一扫，加我为好友', W / 2, H - 46)

    return c
  }, [payload, avatar, user])

  const onSave = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const card = await buildCard()
      const blob = await new Promise((resolve) => card.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('导出图片失败')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `chatly-${user?.username || 'me'}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
      showToast('已保存到下载目录')
    } catch (e) {
      showToast(e.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }, [buildCard, busy, showToast, user])

  const onCopy = useCallback(async () => {
    const id = String(user?.username || '')
    if (!id) return
    try {
      /* 无头 / 非安全上下文里 clipboard 会 reject —— 这时**不能**说「已复制」 */
      await navigator.clipboard.writeText(id)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      showToast(`浏览器不允许自动复制，请长按选中上面的 ID（${id}）`)
    }
  }, [showToast, user])

  return (
    <div className="myqr">
      <div className="myqr-card">
        <div className="myqr-figure">
          <canvas ref={canvasRef} className="myqr-canvas" data-testid="my-qr-canvas" />
          <span className="myqr-corner myqr-corner--tl" />
          <span className="myqr-corner myqr-corner--tr" />
          <span className="myqr-corner myqr-corner--bl" />
          <span className="myqr-corner myqr-corner--br" />
        </div>

        <div className="myqr-user">
          <Avatar src={avatar} name={user?.nickname || ''} size={48} radius={15} ring={0} />
          <div className="myqr-user-txt">
            <b>{user?.nickname}</b>
            <em>ID: {user?.username}</em>
          </div>
        </div>

        <p className="myqr-hint">
          <IconScan size={15} />
          打开「扫一扫」扫这张码，就能加我为好友
        </p>
      </div>

      <div className="myqr-acts">
        <button type="button" className="myqr-btn myqr-btn--primary" onClick={onSave} disabled={busy}>
          <IconDownload size={18} />
          {busy ? '正在生成…' : '保存图片'}
        </button>
        <button type="button" className="myqr-btn" onClick={onCopy}>
          {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
          {copied ? '已复制' : '复制我的 ID'}
        </button>
      </div>

      <p className="sub-note">
        这张码里只有你的用户 ID，不含手机号、位置等任何隐私信息。群二维码会在后续版本加入。
      </p>
    </div>
  )
}
