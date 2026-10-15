/**
 * Chatly 图标集 —— 全部为内联 SVG，无外部依赖
 * 统一 24x24 viewBox，stroke 风格，继承 currentColor
 */
import React from 'react'

const base = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

const S = ({ size = 24, sw = 1.8, children, style, ...rest }) => (
  <svg {...base} width={size} height={size} strokeWidth={sw} style={style} {...rest}>
    {children}
  </svg>
)

/* ===== 底部导航 ===== */
export const IconChat = (p) => (
  <S {...p}>
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.3 9.3 0 0 1-3.3-.6L4 21l1.3-3.9A8.2 8.2 0 0 1 3.6 11.5 8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />
  </S>
)

export const IconMoment = (p) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 3.4c2.6 3 2.6 14.2 0 17.2M3.6 12h16.8" />
  </S>
)

export const IconCompass = (p) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.8" />
    <path d="M15.6 8.4 10.8 10.8 8.4 15.6l4.8-2.4 2.4-4.8Z" />
  </S>
)

export const IconUser = (p) => (
  <S {...p}>
    <circle cx="12" cy="8.2" r="3.9" />
    <path d="M4.8 20.4a7.4 7.4 0 0 1 14.4 0" />
  </S>
)

export const IconContacts = (p) => (
  <S {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.8 19.5a5.3 5.3 0 0 1 10.4 0M16 5.4a3 3 0 0 1 0 5.7M17 14.3a4.5 4.5 0 0 1 3.2 4.2" />
  </S>
)

/* ===== 顶栏 ===== */
export const IconSearch = (p) => (
  <S {...p}>
    <circle cx="11" cy="11" r="6.8" />
    <path d="m16.2 16.2 3.6 3.6" />
  </S>
)

export const IconPlus = (p) => (
  <S {...p}>
    <path d="M12 5.4v13.2M5.4 12h13.2" />
  </S>
)

export const IconBack = (p) => (
  <S {...p}>
    <path d="M14.6 5.6 8.2 12l6.4 6.4" />
  </S>
)

export const IconMore = (p) => (
  <S {...p}>
    <circle cx="5.4" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="18.6" cy="12" r="1.5" fill="currentColor" stroke="none" />
  </S>
)

export const IconChevron = (p) => (
  <S {...p}>
    <path d="M9.4 5.8 15.6 12l-6.2 6.2" />
  </S>
)

export const IconClose = (p) => (
  <S {...p}>
    <path d="M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6" />
  </S>
)

/* ===== 会话 / 通话 ===== */
export const IconPhone = (p) => (
  <S {...p}>
    <path d="M20.4 16.9v2.5a1.7 1.7 0 0 1-1.9 1.7 16.6 16.6 0 0 1-7.2-2.6 16.3 16.3 0 0 1-5-5A16.6 16.6 0 0 1 3.7 6.3 1.7 1.7 0 0 1 5.4 4.5h2.5a1.7 1.7 0 0 1 1.7 1.5c.1.8.3 1.6.6 2.4a1.7 1.7 0 0 1-.4 1.8l-1 1a13.4 13.4 0 0 0 5 5l1-1a1.7 1.7 0 0 1 1.8-.4c.8.3 1.6.5 2.4.6a1.7 1.7 0 0 1 1.4 1.5Z" />
  </S>
)

export const IconMail = (p) => (
  <S {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="m4 7 8 6 8-6" />
  </S>
)

export const IconVideo = (p) => (
  <S {...p}>
    <rect x="2.6" y="6.2" width="12.8" height="11.6" rx="3" />
    <path d="m15.4 12 6-3.4v6.8l-6-3.4Z" />
  </S>
)

export const IconSend = (p) => (
  <S {...p} strokeWidth={0}>
    <path
      d="M4.2 11.1 19.1 4.3c.9-.4 1.8.5 1.4 1.4l-6.8 14.9c-.4.9-1.7.8-2-.1l-1.6-5.1a1 1 0 0 0-.7-.7l-5.1-1.6c-.9-.3-1-1.6-.1-2Z"
      fill="currentColor"
      stroke="none"
    />
  </S>
)

export const IconMic = (p) => (
  <S {...p}>
    <rect x="9.2" y="2.8" width="5.6" height="10.4" rx="2.8" />
    <path d="M5.4 11.4a6.6 6.6 0 0 0 13.2 0M12 18v3.2" />
  </S>
)

export const IconEmoji = (p) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.8" />
    <path d="M8.6 14.4a4.4 4.4 0 0 0 6.8 0" />
    <circle cx="9.3" cy="10" r="1.05" fill="currentColor" stroke="none" />
    <circle cx="14.7" cy="10" r="1.05" fill="currentColor" stroke="none" />
  </S>
)

export const IconImage = (p) => (
  <S {...p}>
    <rect x="3.2" y="4.4" width="17.6" height="15.2" rx="3.2" />
    <circle cx="8.6" cy="9.4" r="1.7" />
    <path d="m3.6 16.8 4.6-4.2 4 3.6 3-2.6 5 4.4" />
  </S>
)

export const IconBellOff = (p) => (
  <S {...p}>
    <path d="M13.6 4.2a6 6 0 0 1 3.6 5.5c0 3.3.7 4.8 1.6 6H7.4" />
    <path d="M9 19.2a3 3 0 0 0 6 0" />
    <path d="M3.6 3.6 20.4 20.4" />
  </S>
)

/* ===== 个人主页 ===== */
export const IconStar = (p) => (
  <S {...p}>
    <path d="m12 3.6 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.8Z" />
  </S>
)

export const IconClock = (p) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 7.2V12l3.2 2" />
  </S>
)

export const IconFolder = (p) => (
  <S {...p}>
    <path d="M3.4 7.6a2.4 2.4 0 0 1 2.4-2.4h3l2 2.4h7.4a2.4 2.4 0 0 1 2.4 2.4v7.6a2.4 2.4 0 0 1-2.4 2.4H5.8a2.4 2.4 0 0 1-2.4-2.4Z" />
  </S>
)

export const IconFile = (p) => (
  <S {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </S>
)

export const IconShield = (p) => (
  <S {...p}>
    <path d="M12 3.2 5 6v5.4c0 4.2 2.9 7.6 7 9.4 4.1-1.8 7-5.2 7-9.4V6Z" />
    <path d="m9.4 11.8 1.8 1.8 3.4-3.4" />
  </S>
)

export const IconLock = (p) => (
  <S {...p}>
    <rect x="4.6" y="10.2" width="14.8" height="10.2" rx="2.8" />
    <path d="M8.2 10.2V7.8a3.8 3.8 0 0 1 7.6 0v2.4" />
  </S>
)

export const IconGear = (p) => (
  <S {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M18.6 14.4a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.6 1.1v.2a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-2.6-1.2l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1.1-2.6h-.2a1.8 1.8 0 1 1 0-3.6h.1a1.5 1.5 0 0 0 1.2-2.6l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 1-1.4v-.2a1.8 1.8 0 1 1 3.6 0v.1a1.5 1.5 0 0 0 2.6 1.1l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0 1.1 2.6h.2a1.8 1.8 0 1 1 0 3.6h-.1a1.5 1.5 0 0 0-1.3 1Z" />
  </S>
)

export const IconPalette = (p) => (
  <S {...p}>
    <path d="M12 3.4a8.6 8.6 0 0 0 0 17.2 2 2 0 0 0 1.4-3.4 2 2 0 0 1 1.4-3.4h2a3.8 3.8 0 0 0 3.8-3.8A8.6 8.6 0 0 0 12 3.4Z" />
    <circle cx="7.8" cy="11.4" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="12" cy="8.2" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="16.2" cy="11.4" r="1.15" fill="currentColor" stroke="none" />
  </S>
)

export const IconBell = (p) => (
  <S {...p}>
    <path d="M17.4 9.8c0-3.1-2.4-5.6-5.4-5.6S6.6 6.7 6.6 9.8c0 5-1.8 6.2-1.8 6.2h14.4s-1.8-1.2-1.8-6.2Z" />
    <path d="M9.6 18.8a2.6 2.6 0 0 0 4.8 0" />
  </S>
)

export const IconHelp = (p) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.4" />
    <circle cx="12" cy="16.6" r=".95" fill="currentColor" stroke="none" />
  </S>
)

export const IconInfo = (p) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 11v5.2" />
    <circle cx="12" cy="7.9" r=".95" fill="currentColor" stroke="none" />
  </S>
)

export const IconEdit = (p) => (
  <S {...p}>
    <path d="M4.6 19.4h3.2l8.9-8.9a2.3 2.3 0 0 0-3.2-3.2l-8.9 8.9Z" />
    <path d="m14.4 7.6 2.4 2.4" />
  </S>
)

export const IconPlusCircle = (p) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 8.4v7.2M8.4 12h7.2" />
  </S>
)

/* ===== 消息交互 ===== */
export const IconLocate = (p) => (
  <S {...p}>
    <path d="M20.4 3.6 3.9 10.3c-.8.3-.7 1.4.1 1.6l6.4 1.8 1.8 6.4c.2.8 1.3.9 1.6.1l6.7-16.5Z" />
  </S>
)

export const IconReply = (p) => (
  <S {...p}>
    <path d="M9.6 7.2 4.8 12l4.8 4.8" />
    <path d="M4.8 12h8.4a5.6 5.6 0 0 1 5.6 5.6v1.2" />
  </S>
)

export const IconCopy = (p) => (
  <S {...p}>
    <rect x="8.4" y="8.4" width="11.2" height="11.2" rx="2.6" />
    <path d="M15.6 5.2a2.6 2.6 0 0 0-2.6-2.6H6.8A2.6 2.6 0 0 0 4.2 5.2v6.2a2.6 2.6 0 0 0 2.6 2.6" />
  </S>
)

export const IconForward = (p) => (
  <S {...p}>
    <path d="m14.4 7.2 4.8 4.8-4.8 4.8" />
    <path d="M19.2 12h-8.4A5.6 5.6 0 0 0 5.2 17.6v1.2" />
  </S>
)

export const IconHeart = (p) => (
  <S {...p}>
    <path d="M12 20.2s-7.4-4.4-7.4-9.6A4.4 4.4 0 0 1 12 7.8a4.4 4.4 0 0 1 7.4 2.8c0 5.2-7.4 9.6-7.4 9.6Z" />
  </S>
)

export const IconComment = (p) => (
  <S {...p}>
    <path d="M20.4 11.8a7.8 7.8 0 0 1-8.4 7.8 8.6 8.6 0 0 1-3-.5L4.6 20.4l1.2-3.6a7.6 7.6 0 0 1-1.2-4.1 7.8 7.8 0 0 1 7.8-7.7h.4a7.8 7.8 0 0 1 7.6 6.8Z" />
  </S>
)

export const IconShare = (p) => (
  <S {...p}>
    <path d="M14.6 3.4 21 9.8l-6.4 6.4v-4.2h-1.4c-4.6 0-7.6 1.6-9.2 4.6.6-6.4 4-10.2 9.2-10.2h1.4Z" />
  </S>
)

export const IconTranslate = (p) => (
  <S {...p}>
    <path d="M3.6 6.2h8.2M7.7 4.4v1.8M10.2 6.2c-.6 3.6-3 6.4-6.2 7.8M5.6 9.6c1.4 2.4 3.5 4.1 5.8 4.9" />
    <path d="m12.6 20 3.2-8.6L19 20M13.9 17.2h4" />
  </S>
)

export const IconTrash = (p) => (
  <S {...p}>
    <path d="M4.6 6.8h14.8M9.4 6.8V4.9a1.3 1.3 0 0 1 1.3-1.3h2.6a1.3 1.3 0 0 1 1.3 1.3v1.9M17.4 6.8l-.8 12a1.8 1.8 0 0 1-1.8 1.7H9.2a1.8 1.8 0 0 1-1.8-1.7l-.8-12" />
  </S>
)

export const IconPin = (p) => (
  <S {...p}>
    <path d="M9.2 3.4h5.6l-.9 5 3 3.2v1.6h-9.8V11.6l3-3.2Z" />
    <path d="M12 13.2v7" />
  </S>
)

export const IconMarkRead = (p) => (
  <S {...p}>
    <path d="m3.4 12.6 4 4L16 8" />
    <path d="m12.4 16.6 1.6 1.6L22.6 9" />
  </S>
)

/* ===== 发现 ===== */
export const IconFire = (p) => (
  <S {...p}>
    <path d="M12 3.2s4.8 4 4.8 8.4a4.8 4.8 0 0 1-9.6 0c0-1.5.6-2.7 1.4-3.6 0 1.3.8 2.2 1.8 2.2 1.2 0 2-1 2-2.6 0-1.7-.4-3-.4-4.4Z" />
  </S>
)

export const IconTarget = (p) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.4" />
    <circle cx="12" cy="12" r="4.2" />
    <circle cx="12" cy="12" r=".95" fill="currentColor" stroke="none" />
  </S>
)

export const IconTag = (p) => (
  <S {...p}>
    <path d="M11.4 3.4H20a.6.6 0 0 1 .6.6v8.6a2 2 0 0 1-.6 1.4l-6.6 6.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8l6.6-6.6a2 2 0 0 1 1.4-.6Z" />
    <circle cx="16.4" cy="7.6" r="1.3" />
  </S>
)

export const IconCalendar = (p) => (
  <S {...p}>
    <rect x="3.4" y="5.2" width="17.2" height="15.4" rx="3" />
    <path d="M3.4 10h17.2M8.4 3.4v3.6M15.6 3.4v3.6" />
  </S>
)

export const IconEye = (p) => (
  <S {...p}>
    <path d="M2.6 12S6 5.8 12 5.8 21.4 12 21.4 12 18 18.2 12 18.2 2.6 12 2.6 12Z" />
    <circle cx="12" cy="12" r="3.1" />
  </S>
)

export const IconCheck = (p) => (
  <S {...p}>
    <path d="m5 12.8 4.6 4.6L19 7.4" />
  </S>
)

export const IconLogout = (p) => (
  <S {...p}>
    <path d="M14.4 4.6h2.4a2.4 2.4 0 0 1 2.4 2.4v10a2.4 2.4 0 0 1-2.4 2.4h-2.4" />
    <path d="M10 8.4 6.4 12 10 15.6M6.4 12H15" />
  </S>
)

export const IconPlay = (p) => (
  <S {...p} strokeWidth={0}>
    <path d="M8.4 5.6 18 12l-9.6 6.4Z" fill="currentColor" stroke="none" />
  </S>
)

export const IconPause = (p) => (
  <S {...p} strokeWidth={0}>
    <rect x="7" y="5.4" width="3.6" height="13.2" rx="1.4" fill="currentColor" stroke="none" />
    <rect x="13.4" y="5.4" width="3.6" height="13.2" rx="1.4" fill="currentColor" stroke="none" />
  </S>
)

export const IconMusic = (p) => (
  <S {...p}>
    <path d="M9 18.2V6.4l10-2v11.4" />
    <circle cx="6.4" cy="18.4" r="2.6" />
    <circle cx="16.4" cy="15.8" r="2.6" />
  </S>
)
export const IconCamera = (p) => (
  <S {...p}>
    <path d="M3.4 8.6a2.6 2.6 0 0 1 2.6-2.6h1.5l1.3-2h7.4l1.3 2H18a2.6 2.6 0 0 1 2.6 2.6v7.8a2.6 2.6 0 0 1-2.6 2.6H6a2.6 2.6 0 0 1-2.6-2.6z" />
    <circle cx="12" cy="12.6" r="3.4" />
  </S>
)

/* 扫一扫：四个取景角 + 一条扫描线。比 IconCamera 更像「扫描」而不是「拍照」。 */
export const IconScan = (p) => (
  <S {...p}>
    <path d="M3.4 8.4V5.8a2.4 2.4 0 0 1 2.4-2.4h2.6" />
    <path d="M15.6 3.4h2.6a2.4 2.4 0 0 1 2.4 2.4v2.6" />
    <path d="M20.6 15.6v2.6a2.4 2.4 0 0 1-2.4 2.4h-2.6" />
    <path d="M8.4 20.6H5.8a2.4 2.4 0 0 1-2.4-2.4v-2.6" />
    <path d="M3.6 12h16.8" />
  </S>
)

/* 我的二维码：三个定位角 + 几粒数据模块，一眼能认出是二维码 */
export const IconQr = (p) => (
  <S {...p}>
    <path d="M4 4h5.4v5.4H4z" />
    <path d="M14.6 4H20v5.4h-5.4z" />
    <path d="M4 14.6h5.4V20H4z" />
    <path d="M14.6 14.6h2.2v2.2h-2.2z" />
    <path d="M18.4 18.4H20V20h-1.6z" />
    <path d="M14.6 18.4h1.6" />
    <path d="M18.4 14.6H20" />
  </S>
)

export const IconUpload = (p) => (
  <S {...p}>
    <path d="M12 16V4.4" />
    <path d="m7.4 8.8 4.6-4.4 4.6 4.4" />
    <path d="M4.6 15.4v3a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-3" />
  </S>
)

/* 下载 / 保存到本地。方向和 IconUpload 相反：箭头朝下、落到托盘里。 */
export const IconDownload = (p) => (
  <S {...p}>
    <path d="M12 4.4V16" />
    <path d="m7.4 11.4 4.6 4.4 4.6-4.4" />
    <path d="M4.6 15.4v3a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-3" />
  </S>
)

export const IconUndo = (p) => (
  <S {...p}>
    <path d="M4.2 9.4h9.6a5.6 5.6 0 0 1 0 11.2H8.4" />
    <path d="m8.2 5 -4 4.4 4 4.4" />
  </S>
)

/* ===== 视频播放器 ===== */

/** 喇叭（有声音） */
export const IconVolume = (p) => (
  <S {...p}>
    <path d="M11 5.6 6.6 9H3.8v6h2.8L11 18.4Z" />
    <path d="M14.6 9.2a4 4 0 0 1 0 5.6" />
    <path d="M17.2 6.6a7.6 7.6 0 0 1 0 10.8" />
  </S>
)

/** 静音（喇叭 + 叉） */
export const IconMute = (p) => (
  <S {...p}>
    <path d="M11 5.6 6.6 9H3.8v6h2.8L11 18.4Z" />
    <path d="m15 10 4.4 4" />
    <path d="m19.4 10 -4.4 4" />
  </S>
)

/** 全屏（四角向外） */
export const IconExpand = (p) => (
  <S {...p}>
    <path d="M9 4.4H4.4V9" />
    <path d="M15 4.4h4.6V9" />
    <path d="M15 19.6h4.6V15" />
    <path d="M9 19.6H4.4V15" />
  </S>
)

/** 退出全屏（四角向内） */
export const IconCollapse = (p) => (
  <S {...p}>
    <path d="M4.4 9H9V4.4" />
    <path d="M19.6 9H15V4.4" />
    <path d="M19.6 15H15v4.6" />
    <path d="M4.4 15H9v4.6" />
  </S>
)
