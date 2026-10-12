import { useEffect, useState } from 'react'
import { IconClose, IconDownload, IconPlay, IconImage } from './Icon.jsx'
import VideoPlayer from './VideoPlayer.jsx'
import './media-viewer.css'

/**
 * 图片 / 视频全屏查看器 —— 关闭、保存、视频播放。
 *
 * 为什么单独拆一个组件而不是继续堆在 ChatRoom 里：
 * 「打开一个媒体」这件事有自己的一套状态（加载失败、视频时长、保存中），
 * 和聊天页的状态混在一起会让 ChatRoom 更难读；而且这两条逻辑（播放 / 保存）
 * 都值得单独写测试。
 */

/**
 * 视频扩展名清单。**必须和服务端 `server/src/upload.js` 的 VIDEO_EXT 一致** ——
 * 前端认 mp4 而服务端白名单里没有，用户选完视频会在发送那一步被 400 挡掉，
 * 报的却是「文件地址不合法」，看起来像前端拼错了 URL。
 */
export const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv', 'ogv']

const VIDEO_RE = new RegExp(`\\.(${VIDEO_EXT.join('|')})$`, 'i')

/**
 * 这条消息是视频吗？
 *
 * 两种来源都要认：
 *   1. `kind === 'video'` —— 走「视频」入口发的，类型就是 video；
 *   2. `kind === 'file'` 但扩展名是视频 —— **历史消息**。以前没有视频入口，
 *      视频只能走「文件」发出去，库里存的是 file。
 *      只认第 1 种的话，用户早先发的那些视频点开仍然播不了，
 *      他会认为是这次没改好。
 */
export function isVideoMessage(m) {
  if (!m) return false
  if (m.kind === 'video') return true
  const name = String(m.fileUrl || m.fileName || '')
  return VIDEO_RE.test(name)
}

/**
 * 保存到本地。
 *
 * 用 `<a download>` 而不是 fetch → blob：同源地址下 download 属性即可触发保存，
 * 不必把整个文件读进内存（视频动辄几十 MB）。
 * ⚠️ 只在**同源**下有效 —— 这也是本项目坚持不外链素材的一个附带好处。
 */
export function saveMedia(url, fileName) {
  const a = document.createElement('a')
  a.href = url
  a.download = fileName || 'chatly-media'
  a.rel = 'noopener'
  // 必须挂到 DOM 上：Firefox 上不在文档里的 <a> 派发的 click 不生效
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function fmtSize(n) {
  if (!n) return ''
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtDuration(sec) {
  if (!sec || !Number.isFinite(sec)) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function MediaViewer({ m, onClose }) {
  const [broken, setBroken] = useState(false)
  const [duration, setDuration] = useState(0)

  const video = isVideoMessage(m)

  /* Esc 关闭：桌面预览下这是唯一合手的方式，和表情面板一致 */
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /* 换一条媒体时重置状态，否则上一条的「加载失败」会带到下一条 */
  useEffect(() => {
    setBroken(false)
    setDuration(0)
  }, [m?.id])

  const onSave = () => {
    if (!m?.fileUrl) return
    saveMedia(m.fileUrl, m.fileName)
  }

  const meta = [m?.fileName, fmtSize(m?.fileSize), duration ? fmtDuration(duration) : '']
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="media-viewer cover-tabbar" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mv-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="mv-btn" onClick={onClose} aria-label="关闭">
          <IconClose size={20} />
          <span>关闭</span>
        </button>
        <button type="button" className="mv-btn" onClick={onSave} aria-label="保存到本地">
          <IconDownload size={20} />
          <span>保存</span>
        </button>
      </div>

      <div className="mv-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {broken ? (
          <div className="mv-broken">
            <IconImage size={26} />
            <span>文件已失效</span>
          </div>
        ) : video ? (
          /* 用自己的播放器而不是原生 controls：原生控件会带出「画中画 / 下载」
             这些没接的按钮，点了没反应看着就像坏了 */
          <div className="mv-vp">
            {/* 不给 fileName：播放器上一版会在画面左上角浮一行 `xxx.mp4`，
                那是最像浏览器原生控件的一笔。文件名在下方 mv-meta 里已经有了。 */}
            <VideoPlayer
              key={m.fileUrl}
              src={m.fileUrl}
              mode="full"
              autoPlay
              onLoadedDuration={setDuration}
            />
          </div>
        ) : (
          <img
            key={m.fileUrl}
            className="mv-media"
            src={m.fileUrl}
            alt={m.fileName || '图片'}
            onError={() => setBroken(true)}
          />
        )}
      </div>

      {meta && <p className="mv-meta">{meta}</p>}
    </div>
  )
}

/**
 * 消息列表里的视频气泡。
 *
 * 用 `<video preload="metadata">` 而不是自己做封面图：
 * 服务端没有抽帧能力，硬造封面要么多一次转码、要么显示黑块。
 * 浏览器加载元数据后会把首帧画出来，配一个播放角标就够了。
 */
export function VideoBubble({ m, onOpen }) {
  const [broken, setBroken] = useState(false)
  const [duration, setDuration] = useState(0)

  if (broken) {
    return (
      <div className="video-broken">
        <IconImage size={20} />
        <span>视频已失效</span>
      </div>
    )
  }

  return (
    <button type="button" className="video-bubble" onClick={() => onOpen(m)}>
      <video
        className="vb-media"
        src={m.fileUrl}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onError={() => setBroken(true)}
      />
      <span className="vb-play">
        <IconPlay size={18} />
      </span>
      {duration > 0 && <span className="vb-dur">{fmtDuration(duration)}</span>}
    </button>
  )
}
