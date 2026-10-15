/**
 * 动态里的媒体：图片走九宫格，视频走自己的播放器
 *
 * 列表卡片和详情页**共用这一个组件**（只换 CSS 前缀）：
 * 之前两边各写一份 ImageGrid，规则一模一样却各改各的 ——
 * 加视频这种「两种媒体两种渲染」的分支，复制一份就等于埋一份会走偏的副本。
 *
 * 视频**不进网格**：
 *   网格格子是 1:1 的（为了把不同比例的图裁整齐），视频塞进去就只剩一个方的，
 *   「横屏宽幅 / 竖屏高幅」的自适应根本无从谈起。视频单独占一块，比例由
 *   `VideoPlayer` 按真实宽高算。
 */
import VideoPlayer from './VideoPlayer.jsx'
import { mediaUrl } from '../api/client.js'
import './moment-media.css'

/** 和服务端 `upload.js` 的 VIDEO_EXT 同一份清单（老数据的 kind 可能是 image） */
export const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|avi|mkv|ogv)$/i

/** 是不是视频。`kind` 优先，认不出来再按扩展名补判一次 */
export function isVideoItem(it) {
  if (!it) return false
  if (it.kind === 'video') return true
  if (it.kind === 'image') return false
  return VIDEO_EXT_RE.test(it.url || it.fileUrl || '')
}

export default function MomentMedia({ media, prefix = 'mgrid', onOpen }) {
  const items = (media || []).slice(0, 9)
  if (!items.length) return null

  /* 'mgrid' → 'mcell'，'mdgrid' → 'mdcell'：两套 CSS 的命名只差这两个字母 */
  const cell = prefix.replace('grid', 'cell')

  if (items.some(isVideoItem)) {
    return (
      <div className="mm-video">
        {items.filter(isVideoItem).map((it, i) => (
          <VideoPlayer
            key={(it.url || '') + i}
            src={mediaUrl(it.url)}
            /* 宽高时长是发布时读出来落库的：列表**在加载视频之前**就能按真实比例占位，
               不会先按 16:9 渲染再跳一下。没有的话组件自己兜 16:9。 */
            width={it.width}
            height={it.height}
            duration={it.duration}
            mode="inline"
            /* 点了不原地播，走全屏查看器 —— 朋友圈视频的主流行为 */
            onOpen={() => onOpen?.(it)}
          />
        ))}
      </div>
    )
  }

  const n = Math.min(items.length, 9)
  return (
    <div className={`${prefix} ${prefix}-${n}`}>
      {items.map((it, i) => (
        <button
          key={(it.url || '') + i}
          type="button"
          className={cell}
          onClick={() => onOpen?.(it)}
          aria-label={`查看第 ${i + 1} 张`}
        >
          <img src={mediaUrl(it.url)} alt={it.fileName || '配图'} loading="lazy" />
        </button>
      ))}
    </div>
  )
}
