import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconPlay,
  IconPause,
  IconVolume,
  IconMute,
  IconExpand,
  IconCollapse,
  IconImage,
} from './Icon.jsx'
import './video-player.css'

/**
 * 自己的视频播放器（**不使用原生 `controls`**）
 *
 * 为什么不用原生控件：
 *   1. 它会带出「画中画 / 下载 / 全屏」等一堆我们**没接**的按钮 —— 点了没反应，
 *      在用户看来就是坏功能；
 *   2. 原生控件不管容器比例，横屏和竖屏视频会被拉成同一个形状；
 *   3. 各浏览器原生控件长得不一样，一个 App 里两套视觉语言。
 *
 * ⚠️ **「不用原生 controls」不等于「看起来不像默认播放器」。**
 *    第一版就是反例：控件确实全是自己写的，但全屏态把容器写成
 *    `height: 100% + max-height: none` —— 容器撑满整个舞台，画面 `object-fit: contain`
 *    居中后上下各留一大片纯黑，控制条被推到屏幕最下沿、离画面几十像素远，
 *    顶上还压着一行原始文件名（`xxx.mp4`）。整块东西和浏览器自带的播放器长得一模一样，
 *    用户看一眼就会问「你这不是用的默认播放器吗」。
 *    所以这一版的硬约束是：**容器必须正好是画面的形状**（和列表卡片同一个套路，
 *    `max-width: 上限高度 × 比例`），控制条贴着画面下沿，不在画面上叠任何文字。
 *
 * 横屏 / 竖屏自适应：
 *   `onLoadedMetadata` 拿到 `videoWidth / videoHeight` 后把真实比例写进 `--ar`，
 *   并打 `is-landscape` / `is-portrait`。CSS 里两种方向的**约束不一样**：
 *     横屏 —— 宽度铺满，高度跟着比例走；
 *     竖屏 —— 高度优先、有上限（否则一条 9:16 的视频能把整张卡片顶到屏幕外）。
 *   画面一律 `object-fit: contain`，比例不一致时留黑边而不是裁画面 ——
 *   裁掉半张脸比多两条黑边难看得多。
 *
 * ⚠️ 不做「检测到竖屏就提示用户旋转手机」这类真机行为：
 *    这是纯 H5 竖屏预览，没有传感器可依赖，提示了也是假的。
 */

/** 比例上下限：太极端（超宽电影、超长竖屏）会把列表撑变形，夹一下 */
const AR = {
  landscape: { min: 1, max: 1.91 }, // 1:1 ~ 1.91:1
  portrait: { min: 0.6, max: 1 }, // 3:5 ~ 1:1
}

/** 播放中多久自动收起控制条（暂停时永不收起） */
const BAR_AUTO_HIDE = 5000

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** 由真实宽高算出容器该用的比例（含夹取）。拿不到就按 16:9 兜底。 */
export function aspectOf(width, height) {
  const w = Number(width)
  const h = Number(height)
  if (!(w > 0) || !(h > 0)) return 16 / 9
  const portrait = h > w
  const lim = portrait ? AR.portrait : AR.landscape
  return Math.min(Math.max(w / h, lim.min), lim.max)
}

/**
 * 未经夹取的真实比例。
 * 夹取（0.6~1.91）是为了**列表卡片**别被极端比例撑爆；查看器里有 `max-height: 100%` 兜底，
 * 再夹一次只会白白多出两条黑边 —— 360×640 的真实比例是 0.563，被夹成 0.6 后
 * 容器比画面宽 6.6%，`object-fit: contain` 就在左右各留 11px 的黑条。
 */
export function rawAspectOf(width, height) {
  const w = Number(width)
  const h = Number(height)
  if (!(w > 0) || !(h > 0)) return 16 / 9
  return w / h
}

export default function VideoPlayer({
  src,
  poster,
  width,
  height,
  duration: durationHint,
  /** inline：信息流里「封面 + 播放按钮」，点了原地播；full：查看器里，进来就播 */
  mode = 'inline',
  autoPlay = false,
  /** 圆角：inline 跟着卡片走，full 由查看器决定 */
  rounded = true,
  onOpen,
  /** 外层想知道真实时长（查看器的信息行要用），不是必须 */
  onLoadedDuration,
}) {
  /* ⚠️ 两个 ref 不能合并：根 div 要拿去做全屏（控件得跟着进全屏），
     <video> 要拿来 play/pause/currentTime。早期版本共用一个 ref 挂在根 div 上，
     toggle() 里 `ref.current.play()` 拿到的是 div —— 直接抛 TypeError，点了没反应。 */
  const ref = useRef(null)
  const videoRef = useRef(null)
  /* 每个播放器一个 id：多个实例同时在列表里时，进度条不能互相串 */
  const uid = useRef(`v${Math.random().toString(36).slice(2, 9)}`).current
  const [playing, setPlaying] = useState(false)
  const [started, setStarted] = useState(autoPlay)
  const [broken, setBroken] = useState(false)
  const [muted, setMuted] = useState(autoPlay) // 自动播放必须静音，否则移动端拦
  const [duration, setDuration] = useState(Number(durationHint) || 0)
  const [now, setNow] = useState(0)
  const [controls, setControls] = useState(true)
  const [flash, setFlash] = useState(null)
  const [ratio, setRatio] = useState(() => aspectOf(width, height))
  /* 真实比例（不夹取），只给查看器用 —— 见 `rawAspectOf` 的注释 */
  const [rawRatio, setRawRatio] = useState(() => rawAspectOf(width, height))
  const [full, setFull] = useState(false)
  const dragging = useRef(false)
  const hideTimer = useRef(null)
  const flashTimer = useRef(null)
  const flashSeq = useRef(0)

  /* 换源就重置，否则上一条的状态（播放中 / 进度）会带到下一条 */
  useEffect(() => {
    setPlaying(false)
    setStarted(autoPlay)
    setBroken(false)
    setNow(0)
    setDuration(Number(durationHint) || 0)
    setRatio(aspectOf(width, height))
    setRawRatio(rawAspectOf(width, height))
  }, [src, autoPlay, durationHint, width, height])

  useEffect(
    () => () => {
      clearTimeout(hideTimer.current)
      clearTimeout(flashTimer.current)
    },
    []
  )

  /* autoPlay（查看器里进来就播）：只声明 `started` 不会真的播，得显式 play()。
     浏览器只允许**静音**自动播放，所以 `muted` 初值跟着 autoPlay 一起为 true。 */
  useEffect(() => {
    if (!autoPlay) return
    const v = videoRef.current
    if (!v) return
    v.play().then(
      () => {
        setStarted(true)
        setPlaying(true)
      },
      () => setStarted(false) // 被拦就退回「封面 + 播放按钮」，不自欺
    )
  }, [autoPlay, src])

  /* 全屏状态跟随浏览器（用户按 Esc 退出也要同步回图标） */
  useEffect(() => {
    const onFs = () => setFull(document.fullscreenElement === ref.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  /* 播放中过一会儿把控制条收起来 —— 真机视频 App 的常态。
     不收的话，一条半透明的条永远压在画面下沿，既挡视线，
     又正好是**浏览器自带播放器**的样子（它也是这么一条常驻的）。 */
  const keepBar = useCallback(() => {
    clearTimeout(hideTimer.current)
    setControls(true)
    hideTimer.current = setTimeout(() => {
      if (!videoRef.current?.paused) setControls(false)
    }, BAR_AUTO_HIDE)
  }, [])

  /** 中央播放 / 暂停反馈：点一下要有个回音，否则「我点哪儿了」说不清 */
  const flashIcon = useCallback((type) => {
    clearTimeout(flashTimer.current)
    setFlash({ type, id: ++flashSeq.current })
    flashTimer.current = setTimeout(() => setFlash(null), 520)
  }, [])

  const toggle = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      keepBar()
      v.play().then(
        () => {
          setStarted(true)
          setPlaying(true)
          flashIcon('play')
        },
        () => setPlaying(false) // 被浏览器策略拦掉就如实回到暂停态，不假装播了
      )
    } else {
      v.pause()
      setPlaying(false)
      flashIcon('pause')
      /* 暂停后控制条必须留着 —— 不然用户找不到「继续」在哪儿 */
      clearTimeout(hideTimer.current)
      setControls(true)
    }
  }, [flashIcon, keepBar])

  /** 进度条拖拽：pointer 系列，不用 click（真机触摸拿不到 click 之前的移动） */
  const seekAt = (clientX) => {
    const v = videoRef.current
    if (!v || !duration) return
    const bar = document.getElementById(`vp-bar-${uid}`)
    if (!bar) return
    const r = bar.getBoundingClientRect()
    const p = Math.min(Math.max((clientX - r.left) / r.width, 0), 1)
    v.currentTime = p * duration
    setNow(v.currentTime)
  }

  if (broken) {
    return (
      <div className="vp-root vp-broken" style={{ '--ar': ratio }}>
        <IconImage size={22} />
        <span>视频已失效</span>
      </div>
    )
  }

  const portrait = ratio <= 1

  /* 「大屏」= 查看器里（`mode="full"`）**或**浏览器全屏。两种场景共用同一套布局：
     按 `--ar` 贴合画面形状 + 铺满可用宽度 + 居中。
     ⚠️ 这里以前只写了 `full`（= `document.fullscreenElement` 的那个状态），
     于是 `mode="full"` 的查看器**根本拿不到 `is-full`** —— `.vp-root.is-full` 那整段 CSS 是死代码。
     横屏看着正常纯属巧合（基础规则 `width:100%` 恰好铺满了查看器宽度），
     竖屏就露馅了：套上的是**列表卡片**的夹取（`max-width: 380×0.6 = 228px`）
     加上基础规则的 `margin-right: auto` → 228×380 的一张卡贴在左边缘，**没有居中**。
     （用户就是看截图问「这是竖屏对吗」才发现左边空了一大块。） */
  const bigScreen = mode === 'full' || full

  return (
    <div
      ref={ref}
      className={[
        'vp-root',
        rounded ? 'is-rounded' : '',
        portrait ? 'is-portrait' : 'is-landscape',
        started ? 'is-started' : '',
        bigScreen ? 'is-full' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--ar': ratio, '--ar-true': rawRatio }}
      /* 指针一进来就把控制条叫回来（收起状态下点不到条上的按钮，
         得先让它回来 —— 这是 auto-hide 播放器的常规做法） */
      onPointerMove={started ? keepBar : undefined}
    >
      <video
        ref={videoRef}
        className="vp-video"
        src={src}
        poster={poster || undefined}
        playsInline
        webkit-playsinline="true"
        preload="metadata"
        muted={muted}
        /* 不在这里加 controls —— 播放器 UI 全是我们自己的 */
        onClick={() => {
          /* 还没开始播的时候，点画面有两条路：
             给了 onOpen 就走「打开全屏查看器」（信息流里的主流行为）；
             没给就原地播。⚠️ 别写成 `onOpen?.() || toggle()` ——
             onOpen 返回 undefined 时会把 toggle 也跑一遍，等于点一次播了又暂停。 */
          if (mode === 'inline' && !started) {
            if (onOpen) onOpen()
            else toggle()
            return
          }
          toggle()
        }}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          if (v.videoWidth > 0) {
            setRatio(aspectOf(v.videoWidth, v.videoHeight))
            setRawRatio(rawAspectOf(v.videoWidth, v.videoHeight))
          }
          if (Number.isFinite(v.duration)) {
            setDuration(v.duration)
            onLoadedDuration?.(v.duration)
          }
        }}
        onTimeUpdate={(e) => !dragging.current && setNow(e.currentTarget.currentTime)}
        onPlay={() => {
          setStarted(true)
          setPlaying(true)
          keepBar()
        }}
        onPause={() => {
          setPlaying(false)
          clearTimeout(hideTimer.current)
          setControls(true)
        }}
        onEnded={() => {
          setPlaying(false)
          clearTimeout(hideTimer.current)
          setControls(true)
        }}
        onError={() => setBroken(true)}
      />

      {/* 未开始：中央大播放按钮 + 时长角标（朋友圈的形态） */}
      {!started && (
        <button
          type="button"
          className="vp-big"
          onClick={mode === 'inline' ? onOpen || toggle : toggle}
          aria-label="播放"
        >
          <span className="vp-big-ic">
            <IconPlay size={22} />
          </span>
        </button>
      )}

      {!started && duration > 0 && <span className="vp-dur">{fmtTime(duration)}</span>}

      {/* 播放 / 暂停的中央闪动反馈（纯视觉，不拦截点击） */}
      {started && flash && (
        <span key={flash.id} className="vp-flash" aria-hidden="true">
          {flash.type === 'play' ? <IconPlay size={26} /> : <IconPause size={26} />}
        </span>
      )}

      {/* 播放中：底部悬浮控制条（自己的 UI，贴画面下沿的玻璃胶囊） */}
      {started && (
        <div className={`vp-bar ${controls || !playing ? 'is-on' : ''}`}>
          <button
            type="button"
            className="vp-ic vp-ic--main"
            onClick={toggle}
            aria-label={playing ? '暂停' : '播放'}
          >
            {playing ? <IconPause size={15} /> : <IconPlay size={15} />}
          </button>

          <span className="vp-time">{fmtTime(now)}</span>

          <div
            id={`vp-bar-${uid}`}
            className="vp-track"
            onPointerDown={(e) => {
              dragging.current = true
              keepBar()
              /* 合成事件 / 自动化测试派发的 pointer 事件没有真实指针，
                 setPointerCapture 会抛 NotFoundError —— 捕获指针只是为了让手指
                 滑出进度条也还能拖，拿不到就退化成「只在条上跟手」，不要整块崩掉。 */
              try {
                e.currentTarget.setPointerCapture?.(e.pointerId)
              } catch {
                /* 忽略 */
              }
              seekAt(e.clientX)
            }}
            onPointerMove={(e) => dragging.current && seekAt(e.clientX)}
            onPointerUp={() => {
              dragging.current = false
            }}
            onPointerCancel={() => {
              dragging.current = false
            }}
          >
            <i className="vp-fill" style={{ width: `${duration ? (now / duration) * 100 : 0}%` }} />
            <i className="vp-knob" style={{ left: `${duration ? (now / duration) * 100 : 0}%` }} />
          </div>

          <span className="vp-time vp-time--end">{fmtTime(duration)}</span>

          <button
            type="button"
            className="vp-ic"
            onClick={() => setMuted((m) => !m)}
            aria-label={muted ? '取消静音' : '静音'}
          >
            {muted ? <IconMute size={15} /> : <IconVolume size={15} />}
          </button>

          <button
            type="button"
            className="vp-ic"
            onClick={() => {
              const el = ref.current
              if (!el) return
              if (document.fullscreenElement) document.exitFullscreen?.()
              else el.requestFullscreen?.().catch(() => setControls(true))
            }}
            aria-label={full ? '退出全屏' : '全屏'}
          >
            {full ? <IconCollapse size={14} /> : <IconExpand size={14} />}
          </button>
        </div>
      )}
    </div>
  )
}
