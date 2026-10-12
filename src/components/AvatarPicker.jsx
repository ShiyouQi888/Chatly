/**
 * 头像选择器：从相册上传（可拖动 / 缩放裁剪）或挑一个内置预设
 *
 * 为什么自己写裁剪而不用现成库：
 *   项目前端零运行时依赖（不引图标库 / CSS 框架 / 日期库），裁剪只用
 *   <canvas> + pointer 事件就够了 —— 引入一个裁剪库反而破坏这条约定。
 *
 * 交互约定：
 *   - 选预设 → 立即应用并关闭（值形如 `preset:7`，库里只存编号）
 *   - 上传   → 选图后进入裁剪，确定后把 Blob 交给上层；**上层在「保存」时才真正上传**，
 *              这样用户中途取消也不会在服务器留下孤儿文件
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { PRESET_COUNT, presetAvatar, resolveAvatarValue } from '../api/client.js'
import { IconCheck, IconClose, IconUndo, IconUpload } from './Icon.jsx'
import './avatar-picker.css'

const STAGE = 248 // 裁剪区边长（CSS px）
const OUT_SIZE = 512 // 导出头像边长
const MAX_ZOOM = 3

/** 以「覆盖」方式铺满裁剪区时的基准缩放 */
function baseScale(img, size) {
  return Math.max(size / img.naturalWidth, size / img.naturalHeight)
}

/** 给定 zoom，图片在裁剪区里的显示尺寸 */
function displaySize(img, size, zoom) {
  const s = baseScale(img, size) * zoom
  return { w: img.naturalWidth * s, h: img.naturalHeight * s, s }
}

/** 位移必须夹紧，否则能把图拖出裁剪区、露出底色 */
function clampOffset(o, img, size, zoom) {
  const { w, h } = displaySize(img, size, zoom)
  const maxX = Math.max(0, (w - size) / 2)
  const maxY = Math.max(0, (h - size) / 2)
  return { x: Math.max(-maxX, Math.min(maxX, o.x)), y: Math.max(-maxY, Math.min(maxY, o.y)) }
}

export default function AvatarPicker({ open, name = '', current, previewSrc, onApply, onClose }) {
  const [mode, setMode] = useState('pick') // pick | crop
  const [img, setImg] = useState(null) // 正在裁剪的原图（已加载完的 Image）
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const fileRef = useRef(null)
  const objUrlRef = useRef(null)
  const dragRef = useRef(null)

  /* 关闭时清掉 object URL，否则每开一次就漏一个 blob */
  const reset = useCallback(() => {
    if (objUrlRef.current) {
      URL.revokeObjectURL(objUrlRef.current)
      objUrlRef.current = null
    }
    setMode('pick')
    setImg(null)
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setErr('')
    setBusy(false)
  }, [])

  useEffect(() => {
    if (!open) reset()
  }, [open, reset])

  useEffect(() => () => reset(), [reset])

  /* ---------- 选图 → 进裁剪 ---------- */
  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许连续选同一个文件
    if (!file) return

    if (!/^image\//.test(file.type)) {
      setErr('请选择图片文件')
      return
    }
    if (file.size > 12 * 1024 * 1024) {
      setErr('图片过大（建议 12MB 以内）')
      return
    }

    const url = URL.createObjectURL(file)
    objUrlRef.current = url
    const im = new Image()
    im.onload = () => {
      setErr('')
      setImg(im)
      setZoom(1)
      setOffset({ x: 0, y: 0 })
      setMode('crop')
    }
    im.onerror = () => {
      setErr('这张图片读不出来，换一张试试')
      URL.revokeObjectURL(url)
      objUrlRef.current = null
    }
    im.src = url
  }

  /* ---------- 拖动 ---------- */
  const onDown = (e) => {
    if (!img) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
  }
  const onMove = (e) => {
    const d = dragRef.current
    if (!d || !img) return
    setOffset(clampOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) }, img, STAGE, zoom))
  }
  const onUp = () => {
    dragRef.current = null
  }

  const onZoom = (v) => {
    setZoom(v)
    if (img) setOffset((o) => clampOffset(o, img, STAGE, v))
  }

  /* ---------- 确定裁剪 → 交给上层 ---------- */
  const confirmCrop = () => {
    if (!img) return
    setBusy(true)
    const { s } = displaySize(img, STAGE, zoom)
    const w = img.naturalWidth * s
    const h = img.naturalHeight * s
    const left = (STAGE - w) / 2 + offset.x
    const top = (STAGE - h) / 2 + offset.y

    const srcX = -left / s
    const srcY = -top / s
    const srcSize = STAGE / s

    const canvas = document.createElement('canvas')
    canvas.width = OUT_SIZE
    canvas.height = OUT_SIZE
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff' // 透明图走 JPEG 会变黑，先垫白底
    ctx.fillRect(0, 0, OUT_SIZE, OUT_SIZE)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, OUT_SIZE, OUT_SIZE)

    canvas.toBlob(
      (blob) => {
        setBusy(false)
        if (!blob) {
          setErr('裁剪失败，换一张试试')
          return
        }
        // 只交 File 出去，预览用的 object URL 由上层创建 —— 上层才知道这个值活多久，
        // 在这里创建的话，上层丢弃草稿时没人负责 revoke。
        const file = new File([blob], `avatar-${Date.now()}.jpg`, { type: 'image/jpeg' })
        onApply({ kind: 'file', file })
      },
      'image/jpeg',
      0.92
    )
  }

  if (!open) return null

  // previewSrc 用来预览还没保存的裁剪结果；current 只负责给预设打勾
  const shown = previewSrc || resolveAvatarValue(current)

  return (
    <div className="avp-root">
      <div className="avp-mask" onClick={onClose} />
      <div className="avp-panel anim-sheet">
        <header className="avp-head">
          <button type="button" className="avp-close" onClick={onClose}>
            <IconClose size={20} />
          </button>
          <h3>{mode === 'crop' ? '调整头像' : '更换头像'}</h3>
          <span className="avp-spacer" />
        </header>

        {mode === 'pick' ? (
          <div className="avp-body no-scrollbar">
            <div className="avp-preview">
              {shown ? (
                <img src={shown} alt={name} />
              ) : (
                <span className="avp-preview-fallback">{(name || '?').slice(-2)}</span>
              )}
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="avp-file"
              onChange={onFile}
            />
            <button type="button" className="avp-upload" onClick={() => fileRef.current?.click()}>
              <IconUpload size={18} />
              从相册上传
            </button>
            <p className="avp-hint">支持 PNG / JPG / GIF / WebP，上传后可以拖动、缩放调整</p>

            <div className="avp-sec">
              <h4>或者选一个内置头像</h4>
              <div className="avp-grid">
                {Array.from({ length: PRESET_COUNT }, (_, i) => {
                  const n = i + 1
                  const on = current === `preset:${n}`
                  return (
                    <button
                      key={n}
                      type="button"
                      className={`avp-item ${on ? 'is-on' : ''}`}
                      onClick={() => onApply({ kind: 'preset', n })}
                      aria-label={`内置头像 ${n}`}
                      aria-pressed={on}
                    >
                      <img src={presetAvatar(n)} alt={`预设头像 ${n}`} />
                      {on && (
                        <i className="avp-item-check">
                          <IconCheck size={13} sw={3} />
                        </i>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            {err && <p className="avp-err">{err}</p>}
          </div>
        ) : (
          <div className="avp-body is-crop">
            <div
              className="avp-stage"
              style={{ width: STAGE, height: STAGE }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            >
              {img && (
                <img
                  src={img.src}
                  alt="待裁剪"
                  draggable={false}
                  style={(() => {
                    const { w, h } = displaySize(img, STAGE, zoom)
                    return {
                      width: w,
                      height: h,
                      left: (STAGE - w) / 2 + offset.x,
                      top: (STAGE - h) / 2 + offset.y,
                    }
                  })()}
                />
              )}
              <span className="avp-stage-ring" />
            </div>
            <p className="avp-hint">拖动调整位置，滑块缩放</p>

            <div className="avp-zoom">
              <span>−</span>
              <input
                type="range"
                min="1"
                max={MAX_ZOOM}
                step="0.01"
                value={zoom}
                onChange={(e) => onZoom(Number(e.target.value))}
                aria-label="缩放"
              />
              <span>＋</span>
            </div>

            {err && <p className="avp-err">{err}</p>}

            <div className="avp-acts">
              <button
                type="button"
                className="avp-btn is-ghost"
                onClick={() => {
                  setZoom(1)
                  setOffset({ x: 0, y: 0 })
                }}
              >
                <IconUndo size={16} /> 复位
              </button>
              <button type="button" className="avp-btn is-ghost" onClick={reset}>
                重选图片
              </button>
              <button type="button" className="avp-btn is-primary" onClick={confirmCrop} disabled={busy}>
                {busy ? '处理中…' : '确定'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
