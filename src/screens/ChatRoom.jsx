import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useApp } from '../store/AppContext.jsx'
import { useChat, avatarOf } from '../store/ChatStore.jsx'
import { api, formatDayLabel, mediaUrl } from '../api/client.js'
import { Avatar, ActionMenu, Sheet, Switch } from '../components/ui.jsx'
import EmojiPanel, { isEmojiSticker } from '../components/EmojiPanel.jsx'
import MediaViewer, { VideoBubble, isVideoMessage } from '../components/MediaViewer.jsx'
import { LocationBubble, LocationViewer } from '../components/LocationView.jsx'
import LocationPicker from '../components/LocationPicker.jsx'
import { PollSheet, PollBubble, PollDetailSheet } from '../components/PollBubble.jsx'
import ForwardSheet from '../components/ForwardSheet.jsx'
import { useFavorites } from '../store/FavoriteStore.jsx'
import { useWatchLater } from '../store/WatchLaterStore.jsx'
import { useLongPress } from '../hooks/useLongPress.js'
import {
  IconBack,
  IconVideo,
  IconMore,
  IconPlus,
  IconEmoji,
  IconMic,
  IconSend,
  IconReply,
  IconCopy,
  IconForward,
  IconHeart,
  IconStar,
  IconClock,
  IconTranslate,
  IconInfo,
  IconTrash,
  IconClose,
  IconCheck,
  IconImage,
  IconFolder,
  IconLocate,
  IconChevron,
} from '../components/Icon.jsx'
import UserProfile from './UserProfile.jsx'
import GroupSettings from './GroupSettings.jsx'
import GroupFilesPage from './GroupFilesPage.jsx'
import './chat-room.css'

const REVOKE_WINDOW = 2 * 60 * 1000

/* ===== 顶部 ===== */
function Header({ chat, onBack, onInfo, onProfile, onGroup, typing, connected }) {
  const sub = typing
    ? '正在输入…'
    : chat.type === 'group'
      ? `${chat.memberCount} 位成员`
      : chat.online
        ? '在线'
        : '离线'

  const isGroup = chat.type === 'group'

  return (
    <header className="room-head">
      <button type="button" className="rh-back" onClick={onBack} aria-label="返回">
        <IconBack size={22} />
      </button>

      {/* 头像与名字分成两个按钮：群聊点头像 / 名字进**群设置**（改群名、公告、成员），
          「⋯」才是会话设置（置顶 / 免打扰 / 删会话）；私聊点头像是看对方资料。
          不能把按钮套在按钮里 —— 那是非法 DOM 嵌套，读屏也会错乱。 */}
      <div className="rh-center">
        <button
          type="button"
          className="rh-avatar"
          onClick={isGroup ? onGroup : onProfile}
          aria-label={isGroup ? '群设置' : `查看 ${chat.name} 的资料`}
        >
          <Avatar src={chat.src} name={chat.name} size={34} radius={11} online={chat.online} />
        </button>
        <button type="button" className="rh-name" onClick={isGroup ? onGroup : onInfo}>
          <span className="rh-meta">
            <b>{chat.name}</b>
            <em className={typing ? 'is-typing' : ''}>{sub}</em>
          </span>
        </button>
      </div>

      <div className="rh-act">
        <button type="button" className="rh-btn" aria-label="会话设置" onClick={() => onInfo()}>
          <IconMore size={19} />
        </button>
      </div>

      {!connected && <span className="room-offline">连接中…</span>}
    </header>
  )
}

/* ===== 日期分隔 ===== */
function DayDivider({ text }) {
  return <div className="day-div">{text}</div>
}

/* ===== 已撤回 ===== */
function RevokedLine() {
  return (
    <div className="msg-sys">
      <span>消息已撤回</span>
    </div>
  )
}

/* ===== 图片 / 文件 ===== */
function FileCard({ m, mine }) {
  const { showToast } = useApp()
  const ext = (m.fileName || '').split('.').pop()?.toUpperCase() || 'FILE'
  const kb = m.fileSize ? `${(m.fileSize / 1024).toFixed(1)} KB` : '未知大小'

  const open = () => {
    if (m.uploading) return showToast('文件上传完成后即可打开')
    if (!m.fileUrl || m.fileUrl.startsWith('blob:')) return showToast('文件地址缺失')
    window.open(mediaUrl(m.fileUrl), '_blank', 'noopener')
  }

  return (
    <div className={`file-card ${mine ? 'is-mine' : ''}`}>
      <span className="fc-badge">{ext}</span>
      <span className="fc-body">
        <b className="fc-name">{m.fileName || '未命名文件'}</b>
        <em className="fc-size">{kb}</em>
      </span>
      <span className="fc-act">
        <button type="button" onClick={open}>
          打开
        </button>
      </span>
    </div>
  )
}

function UploadProgress({ message }) {
  if (!message.uploading && !message.uploadFailed) return null
  const progress = Math.max(0, Math.min(100, Number(message.uploadProgress) || 0))
  const label = message.uploadFailed ? '上传失败' : message.uploadStage || '准备上传'
  return (
    <div className={`msg-upload-progress ${message.uploadFailed ? 'is-failed' : ''}`}>
      <div className="msg-upload-label">
        <span>{label}</span>
        {!message.uploadFailed && <span>{progress}%</span>}
      </div>
      <div
        className="msg-upload-track"
        role="progressbar"
        aria-label="附件上传进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${message.uploadFailed ? 100 : progress}%` }} />
      </div>
    </div>
  )
}

function isVoiceMessage(m) {
  return m?.kind === 'file' && /^voice-note-.*\.(webm|m4a|ogg|opus|wav|mp3)$/i.test(m.fileName || '')
}

function VoiceBubble({ m, mine }) {
  return (
    <div className={`voice-bubble ${mine ? 'is-mine' : ''}`}>
      <IconMic size={18} />
      <audio controls preload="metadata" src={mediaUrl(m.fileUrl)} aria-label="语音消息" />
    </div>
  )
}

/* ===== 图片（带加载失败兜底：文件被清理时不显示浏览器的破图标） =====
 *
 * 「自动下载图片」这个开关（我 → 通用设置）**只有在这里读它才有意义**。
 * 以前它谁都不读：用户关掉之后聊天里照样把所有图都下载下来，
 * 而且没有任何迹象表明开关没生效 —— 典型的「存得下、不生效」。
 * 关掉时的占位样式（`.img-bubble.is-locked` / `.img-lock-hint`）早就写好了，
 * 只是没人接上（CSS 里那段注释就是当年留下的）。
 */
const AUTO_DOWNLOAD_KEY = 'chatly-auto-download'

function ImageBubble({ m, onOpen }) {
  const [broken, setBroken] = useState(false)
  /* 每张图**各自**记「这一张已经点了加载」。
     用一个共享状态的话，点一张会把这个会话里所有图一起放出来 ——
     用户点的是「这一张」，不是「全部」。 */
  const [locked, setLocked] = useState(
    () => localStorage.getItem(AUTO_DOWNLOAD_KEY) === 'false'
  )

  if (broken) {
    return (
      <div className="img-broken">
        <IconImage size={20} />
        <span>图片已失效</span>
      </div>
    )
  }

  /* 自动下载关掉时先不请求图片，只显示一个明说「点击加载」的占位 ——
     直接放一张空灰块会让人以为图坏了 */
  if (locked) {
    return (
      <button
        type="button"
        className="img-bubble is-locked"
        onClick={() => setLocked(false)}
        aria-label="加载图片"
        data-testid="img-locked"
      >
        <span className="img-lock-hint">点击加载图片</span>
      </button>
    )
  }

  return (
    <button type="button" className="img-bubble" onClick={() => onOpen(m)}>
      <img src={mediaUrl(m.fileUrl)} alt={m.fileName || '图片'} loading="lazy" onError={() => setBroken(true)} />
    </button>
  )
}

/* ===== 大表情（贴纸）=====
   和普通图片的区别不只是尺寸：它是「表达」而不是「文件」，
   所以不给气泡背景、不给边框、也不点开大图预览（对贴纸没意义）。
   判断依据是 fileUrl 前缀 —— 大表情和头像的 preset:<n> 一样，
   靠地址本身区分形态，数据库里不需要新增 kind（messages.kind 有 CHECK 约束，改起来要重建表）。 */
function Sticker({ m }) {
  const [broken, setBroken] = useState(false)

  if (broken) {
    return (
      <div className="sticker is-broken">
        <IconEmoji size={22} />
        <span>表情已失效</span>
      </div>
    )
  }

  return (
    <img
      className="sticker"
      src={mediaUrl(m.fileUrl)}
      alt={m.fileName || '表情'}
      loading="lazy"
      draggable={false}
      onError={() => setBroken(true)}
    />
  )
}

/* ===== 已读回执（只在我方消息上） =====
   收敛成「小头像簇 + 一行字」：
   - 最多露 3 个头像，读过的排前面，没读的置灰排后面，多出来的收成 +N
   - 点一下弹出详情面板（位置由调用方算，向上或向下）
   尺寸刻意压在 15px 头像 / 10.5px 文字，不抢消息本体的视觉重心。 */
function ReadReceipt({ m, peersWithState, open, onOpen }) {
  if (!peersWithState.length) return null

  const total = peersWithState.length
  const readers = peersWithState.filter((p) => p.readCursor >= m.id)
  const unreaders = peersWithState.filter((p) => p.readCursor < m.id)
  const allRead = readers.length === total

  const MAX = 3
  const shown = [...readers, ...unreaders].slice(0, MAX)
  const rest = total - shown.length

  const label = allRead ? '全部已读' : readers.length === 0 ? '未读' : `${readers.length}/${total} 已读`

  return (
    <button
      type="button"
      className={`read-tag ${allRead ? 'is-all' : readers.length === 0 ? 'is-none' : 'is-part'} ${
        open ? 'is-open' : ''
      }`}
      onClick={(e) => onOpen(m.id, e.currentTarget, m.mine)}
      aria-label={`${label}，点击查看谁读了`}
      aria-expanded={open}
    >
      <span className="rt-avs">
        {shown.map((p) => (
          <span key={p.user.id} className={`rt-av ${p.readCursor >= m.id ? '' : 'is-unread'}`}>
            <Avatar src={avatarOf(p.user)} name={p.user.nickname} size={15} radius={5} />
          </span>
        ))}
        {rest > 0 && <span className="rt-more">+{rest}</span>}
      </span>
      <span className="rt-label">{label}</span>
    </button>
  )
}

/* ===== 已读详情弹层 ===== */
function ReadPopover({ msgId, style, peersWithState, onClose }) {
  const readers = peersWithState.filter((p) => p.readCursor >= msgId)
  const unreaders = peersWithState.filter((p) => p.readCursor < msgId)

  return (
    <>
      <div className="read-pop-mask" onClick={onClose} />
      <div className="read-pop anim-pop" style={style} role="dialog" aria-label="已读详情">
        <div className="rp-head">
          <b>
            已读 {readers.length}
            <em> / {peersWithState.length}</em>
          </b>
          {unreaders.length > 0 && <span className="rp-unread">{unreaders.length} 人未读</span>}
        </div>

        <div className="rp-body no-scrollbar">
          {peersWithState.length === 0 && <p className="rp-empty">会话里还没有其他成员</p>}

          {readers.map((p) => (
            <div key={p.user.id} className="rp-row">
              <Avatar src={avatarOf(p.user)} name={p.user.nickname} size={24} radius={8} />
              <span className="rp-name">{p.user.nickname}</span>
              <span className="rp-tag is-read">
                <IconCheck size={11} sw={3} /> 已读
              </span>
            </div>
          ))}

          {unreaders.map((p) => (
            <div key={p.user.id} className="rp-row is-pending">
              <Avatar src={avatarOf(p.user)} name={p.user.nickname} size={24} radius={8} />
              <span className="rp-name">{p.user.nickname}</span>
              <span className="rp-tag">未读</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

/* ===== 单条消息 ===== */
function Message({ m, chat, me, peersWithState, readPopMsgId, onLongPress, onOpenImage, onOpenLoc, onOpenRead, polls, onVotePoll, onClosePoll, onOpenPollDetail, onJumpToMessage, flash, favorited, multi, onMultiToggle }) {
  /* ⚠️ mine / canRevoke 必须在 useLongPress **之前**算出来：
     长按回调闭包会引用 canRevoke，而 `const` 声明在 hook 之后的话，
     第一次渲染求值回调时就落在 TDZ 里（`Cannot access 'canRevoke' before initialization`）
     —— 项目已经因为这类顺序问题白屏过一次了（见 LESSONS 的 React 白屏一节）。 */
  const mine = m.mine
  const canRevoke = mine && !m.pending && !m.failed && Date.now() - m.createdAt <= REVOKE_WINDOW

  /* 长按 / 右键 → 消息操作菜单（回复 / 复制 / 收藏 / 多选 / 撤回）。
     ⚠️ 挂在**整行**上，不是只挂文字气泡 —— 原来只有 `kind === 'text'` 的气泡
     绑了 onContextMenu，于是图片 / 视频 / 文件 / 位置 / 投票消息**长按毫无反应**，
     而且那还是右键（手机上根本没有）。现在整行都能长按，五种消息形态一致。 */
  const longPress = useLongPress(() => onLongPress?.(m, canRevoke), {
    /* 多选模式下不需要菜单：那时点整行是「选中/取消」 */
    disabled: !!multi?.on || m.revoked,
  })

  if (m.revoked) return <RevokedLine />

  /* 多选模式下：点整行 = 选中/取消（不再触发引用回复），且长按菜单不弹 */
  const selected = !!multi?.on && multi.ids.has(m.id)

  return (
    /* data-id / data-kind 给自检脚本和调试用：按序号定位消息行会因为
       随手插入的消息而错位，按 id 找才稳。
       `data-mid` 是**数字消息 id**，从群设置跳过来时靠它定位这一行
       （乐观消息的 data-id 会是 tmp-xxx，不能用来定位）。 */
    <div
      className={`msg ${mine ? 'is-mine' : ''} ${flash ? 'is-flash' : ''} ${selected ? 'is-selected' : ''} ${multi?.on ? 'is-multiable' : ''}`}
      data-id={m.id}
      data-mid={typeof m.id === 'number' ? m.id : ''}
      data-kind={m.kind}
      data-selected={selected ? '1' : '0'}
      data-testid={m.kind === 'poll' ? 'poll-msg' : undefined}
      /* 长按 / 右键（两者共用一个回调，见 useLongPress）
         + 捕获阶段吞掉长按尾巴上的 click，否则会连带触发「引用回复」或打开查看器 */
      {...longPress.handlers}
      onClick={multi?.on ? () => onMultiToggle?.(m) : undefined}
    >
      {/* 多选态左侧的勾选圈（非多选模式下不渲染） */}
      {multi?.on && (
        <span className={`msg-pick ${selected ? 'is-on' : ''}`} aria-hidden="true">
          {selected && <IconCheck size={13} sw={3} />}
        </span>
      )}
      {/* 头像统一放在 msg-col 之前，位置由 flex 方向决定：
          对方行不镜像 → 头像在左；我方行 row-reverse → 头像被排到最右。
          （若把头像写在 msg-col 之后，row-reverse 会把它翻到左边，两边头像会都挤在左侧。） */}
      <Avatar src={m.av} name={mine ? me?.nickname : m.sender || chat.name} size={32} radius={10} />

      <div className="msg-col">
        {/* 昵称只在群聊显示：单聊能看出是谁，无需重复 */}
        {!mine && chat.type === 'group' && m.sender && <span className="msg-sender">{m.sender}</span>}

        {m.quote && (
          /* 引用块可点击 → 跳到被引用的那条消息（复用收藏/投票那套跳转：翻页 + 滚动 + 高亮）。
             ⚠️ 只有知道 replyToId 才给点击：quote 只是 text 摘要（被撤回时是空的），
             没有 id 的引用块点了一定跳不过去 —— 摆个可点的样子就是假按钮。 */
          m.replyToId ? (
            <button
              type="button"
              className="quote quote--jump"
              data-testid="quote-jump"
              data-reply-to={m.replyToId}
              onClick={(e) => {
                e.stopPropagation()
                onJumpToMessage?.(m.replyToId, '被引用的那条消息已经不在当前记录里了')
              }}
              title="跳到被引用的消息"
            >
              <span className="quote-bar" />
              <span className="quote-t">{m.quote}</span>
            </button>
          ) : (
            <div className="quote">
              <span className="quote-bar" />
              <span className="quote-t">{m.quote}</span>
            </div>
          )
        )}

        {m.kind === 'text' && (
          /* ⚠️ 这里**不能**挂 onClick={() => onReply(m)} ——
             原来点一下文字气泡就挂上引用，真机上想复制/选中文字时一点就进引用态，
             只能去输入区按 ✕ 取消。这是误触，不是功能。
             引用只从长按菜单的「回复」进（微信也是这个口径）。
             点气泡=什么都不做（选中文字走系统行为——CSS 侧 user-select 保持可选中）。 */
          <div className="bubble">
            {m.text.split('\n').map((line, i) => (
              <React.Fragment key={i}>
                {i > 0 && <br />}
                {line}
              </React.Fragment>
            ))}
          </div>
        )}

        {m.kind === 'image' &&
          (isEmojiSticker(m.fileUrl) ? (
            <Sticker m={m} />
          ) : (
            <ImageBubble m={m} onOpen={onOpenImage} />
          ))}

        {/* 视频有两种来源：`kind === 'video'` 是走「视频」入口发的；
            早先没有视频入口时只能走「文件」，库里存的是 file，
            所以按扩展名补判一次 —— 否则用户以前发的视频点开还是播不了。 */}
        {(m.kind === 'video' || (isVideoMessage(m) && !isVoiceMessage(m))) && (
          <VideoBubble m={m} onOpen={onOpenImage} />
        )}

        {isVoiceMessage(m) && <VoiceBubble m={m} mine={mine} />}
        {m.kind === 'file' && !isVideoMessage(m) && !isVoiceMessage(m) && <FileCard m={m} mine={mine} />}

        {/* 位置消息：地图缩略 + 地点名 + 地址。坐标可能缺（用户手输的地点名），
            缺的时候气泡里会写清「只发了地点名」，不画地图。 */}
        {m.kind === 'location' && <LocationBubble m={m} onOpen={onOpenLoc} />}

        <UploadProgress message={m} />

        {/* 投票消息：详情不在消息体里（服务端只给 pollId），由 store 按 id 批量补拉。
            还没拉到就先画骨架 —— **不能画「0 票」**，那是在撒谎。 */}
        {m.kind === 'poll' && !m.revoked && (
          <PollBubble
            poll={m.pollId ? polls?.[m.pollId] : null}
            loading={!!m.pollId && polls && !polls[m.pollId]}
            me={me}
            onVote={(optionIds) => onVotePoll?.(m.pollId, optionIds)}
            onClose={() => onClosePoll?.(m.pollId)}
            onOpenDetail={() => onOpenPollDetail?.(m.pollId)}
          />
        )}

        {m.failed && (
          <div className="msg-send-error" role="status">
            <span className="msg-send-error-mark" aria-hidden="true">!</span>
            <small>{m.failureMessage || '消息发送失败'}</small>
          </div>
        )}

        <span className="msg-foot">
          {m.failed && <em className="msg-failed" aria-label="发送失败">!</em>}
          {m.pending && <em>发送中</em>}
          {!m.pending && !m.failed && <em>{m.time}</em>}
          {mine && !m.pending && !m.failed && (
            <ReadReceipt
              m={m}
              peersWithState={peersWithState}
              open={readPopMsgId === m.id}
              onOpen={onOpenRead}
            />
          )}
        </span>
      </div>
    </div>
  )
}

/* ===== 会话设置面板 ===== */
function InfoSheet({ open, onClose, chat, me, onDelete, onProfile, onGroup, onEditAnnouncement, onFiles }) {
  const { showToast } = useApp()
  const { togglePin, toggleMute, mergeGroupMeta } = useChat()
  const [pushBusy, setPushBusy] = useState(false)

  if (!open) return null

  const others = (chat.members || []).filter((m) => m.user.id !== me?.id)
  const peer = others[0]?.user
  const isGroup = chat.type === 'group'

  const pushAnnouncement = async () => {
    if (!chat.announcement || !['owner', 'admin'].includes(chat.myRole) || pushBusy) return
    setPushBusy(true)
    try {
      const { meta } = await api.pushGroupAnnouncement(chat.id)
      mergeGroupMeta(chat.id, meta)
      showToast('群公告已置顶并通知全体成员')
    } catch (e) {
      showToast(e.message || '公告推送失败')
    } finally {
      setPushBusy(false)
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="会话设置">
      <div className="info-head">
        {/* 私聊时头像可点开对方资料页；群聊没有「个人资料」可看，保持静态 */}
        {isGroup ? (
          <Avatar src={chat.src} name={chat.name} size={64} radius={20} />
        ) : (
          <button
            type="button"
            className="info-head-av"
            onClick={() => peer && onProfile(peer.id)}
            disabled={!peer}
            aria-label="查看对方资料"
          >
            <Avatar src={chat.src} name={chat.name} size={64} radius={20} />
          </button>
        )}
        <b>{chat.name}</b>
        <em>{isGroup ? `${chat.memberCount} 位成员 · 群聊` : peer ? `@${peer.username}` : '好友'}</em>
      </div>

      {isGroup && (
        /* 群文件和公告直接放在会话信息外层；群设置保留成员与资料管理。 */
        <div className="info-block">
          <h5>群内容</h5>
          <div className="inline-rows">
            <button type="button" className="inline-row" onClick={onFiles}>
              <span>群文件</span>
              <span className="inline-right">分类浏览<IconChevron size={15} /></span>
            </button>
          </div>
          <div className="info-announcement">
            <div className="info-announcement-head"><b>群公告</b><span>{chat.announcementAt ? formatDayLabel(Number(chat.announcementAt) || new Date(chat.announcementAt).getTime()) : ''}</span></div>
            <p>{chat.announcement || '还没有群公告'}</p>
            <div className="info-announcement-actions">
              <button type="button" className="info-ann-action" onClick={chat.myRole === 'owner' || chat.myRole === 'admin' ? onEditAnnouncement : onGroup}>{chat.myRole === 'owner' || chat.myRole === 'admin' ? (chat.announcement ? '编辑公告' : '发布公告') : '群管理'}</button>
              {chat.announcement && ['owner', 'admin'].includes(chat.myRole) && (
                <button type="button" className="info-ann-action is-muted" disabled={pushBusy} onClick={pushAnnouncement}>{pushBusy ? '推送中…' : '置顶并推送'}</button>
              )}
            </div>
          </div>
          <div className="inline-rows">
            <button type="button" className="inline-row" onClick={onGroup}>
              <span>群设置与成员管理</span><span className="inline-right"><IconChevron size={15} /></span>
            </button>
          </div>
        </div>
      )}

      {isGroup ? (
        <div className="info-block">
          <h5>群成员</h5>
          <div className="info-grid">
            {(chat.members || []).map((mb) => (
              <div key={mb.user.id} className="info-member">
                {/* 必须走 avatarOf：直接用 user.avatar 的话，没传头像的人是空白初始字，
                    别处却是彩色块，同一个人在两处长得不一样 */}
                <Avatar src={avatarOf(mb.user)} name={mb.user.nickname} size={46} radius={15} />
                <span>{mb.user.nickname}</span>
                {mb.role !== 'member' && <i className="mb-role">{mb.role === 'owner' ? '群主' : '管理员'}</i>}
              </div>
            ))}
          </div>
        </div>
      ) : (
        peer && (
          <div className="info-block">
            <h5>对方资料</h5>
            <button type="button" className="info-profile-row" onClick={() => onProfile(peer.id)}>
              <Avatar src={avatarOf(peer)} name={peer.nickname} size={44} radius={15} />
              <span className="info-profile-body">
                <b>{peer.nickname}</b>
                <em>{peer.bio || `@${peer.username}`}</em>
              </span>
              <IconChevron size={16} />
            </button>
          </div>
        )
      )}

      <div className="info-block">
        <h5>聊天</h5>
        {/* 用 div 而不是 button：Switch 自身就是 button，
            把 button 套在 button 里是非法 DOM 嵌套（React 会告警，读屏也会错乱） */}
        <div className="inline-rows">
          <div className="inline-row is-static">
            <span>置顶聊天</span>
            <span className="inline-right">
              <Switch on={!!chat.pinned} onChange={() => togglePin(chat.id)} />
            </span>
          </div>
          <div className="inline-row is-static">
            <span>消息免打扰</span>
            <span className="inline-right">
              <Switch on={!!chat.muted} onChange={() => toggleMute(chat.id)} />
            </span>
          </div>
        </div>
      </div>

      <button
        type="button"
        className="info-danger"
        onClick={() => {
          onDelete()
          onClose()
        }}
      >
        <IconTrash size={18} /> 删除会话
      </button>
    </Sheet>
  )
}

/* ===== 输入区 =====
   对外暴露 insert()：表情面板要「插到光标处」，而光标位置只有 <textarea> 自己知道。
   用 useImperativeHandle 而不是把 text 状态提到 ChatRoom ——
   那样输入框每敲一个字都要重渲染整个消息列表，长会话下会明显卡。 */
const Composer = forwardRef(function Composer(
  { onSend, onPlus, onTyping, onVoiceRecord, recording, disabled, emojiOpen, onToggleEmoji, onCloseEmoji, quote, onCancelQuote },
  ref
) {
  const [text, setText] = useState('')
  const [focus, setFocus] = useState(false)
  const { showToast } = useApp()
  const taRef = useRef(null)

  const submit = () => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }

  /**
   * 点输入框 → 收起表情面板，并把光标留在输入框里。
   *
   * 幂等：同一个手势里 pointerdown 和 click 可能各来一次，重复调用结果一样。
   * ⚠️ 判据只认 emojiOpen，**不能用 focus 事件代替** ——
   * `insert()` 挑完表情会 `el.focus()` 把光标放回输入框，
   * 而手机上点表情按钮会先让 textarea 失焦，那次程序性 focus 就会真的触发 focus 事件
   * → 面板刚挑一个表情就被关掉，根本没法连续挑。click / pointerdown 只有用户自己点才会来。
   */
  const dismissEmoji = () => {
    if (!emojiOpen) return
    onCloseEmoji()
    taRef.current?.focus()
  }

  /**
   * 在光标处插入文本。
   * 必须在 setText 之后手动把光标挪到插入内容之后 ——
   * setState 是异步的，所以放在 rAF 里等 DOM 更新完再 setSelectionRange。
   * 否则连点两次表情会倒着插（第二次插在第一次前面）。
   */
  useImperativeHandle(ref, () => ({
    insert(str) {
      const el = taRef.current
      setText((cur) => {
        if (!el) return cur + str
        const start = el.selectionStart ?? cur.length
        const end = el.selectionEnd ?? cur.length
        requestAnimationFrame(() => {
          el.focus()
          const pos = start + str.length
          el.setSelectionRange(pos, pos)
        })
        return cur.slice(0, start) + str + cur.slice(end)
      })
    },
  }))

  return (
    <div className={`composer ${focus ? 'is-focus' : ''}`}>
      {/* 待发送的引用条。
          ⚠️ 这一段以前**根本不存在** —— `quote` 状态被 setQuote 设上了，
          但界面上没有任何地方显示它，用户点了「回复」/ 短按消息之后
          看不到任何反馈（只能等消息发出去、看到气泡上方多了引用块才知道生效了）。
          现在在输入区上方显示「正在回复谁 + 原文摘要」，并给一个 ✕ 可取消。 */}
      {quote && (
        <div className="cp-quote" data-testid="composer-quote">
          <span className="cp-quote-bar" />
          <span className="cp-quote-body">
            <b>{quote.mine ? '回复自己' : `回复 ${quote.sender || ''}`.trim()}</b>
            <em>{(quote.text || '').replace(/\n/g, ' ').slice(0, 60)}</em>
          </span>
          <button
            type="button"
            className="cp-quote-x"
            aria-label="取消引用"
            data-testid="cancel-quote"
            onClick={onCancelQuote}
          >
            <IconClose size={16} />
          </button>
        </div>
      )}
      <div className="cp-row">
      <button
        type="button"
        className={`cp-btn ${recording ? 'is-recording' : ''}`}
        onClick={onVoiceRecord}
        disabled={disabled}
        aria-label={recording ? '结束并发送语音' : '录制语音消息'}
        title={recording ? '点击结束并发送' : '录制语音消息'}
      >
        <IconMic size={21} />
      </button>
      {/* 点输入框就收起表情面板。挂在外层 .cp-field 而不是 textarea 上：
          这个圆角框有 9/15px 内边距，点在 padding 上原生不会聚焦，
          挂在 textarea 上会漏掉这些位置；padding 区点击额外补一次 focus。

          为什么 onClick 和 onPointerDown 都挂（处理函数是幂等的，同一个手势来两次也无害）：
          - pointerdown：真机触摸时立刻响应。若等到 click，手机上软键盘弹出会把布局顶上去，
            mouseup 可能落在别的元素上，click 就不一定送得到这个框。
          - click：自检脚本走的是 `el.click()`，只会派发 click，不会派发 pointerdown。
            只挂 pointerdown 会让这条交互没法被脚本验证。

          ⚠️ 判据只认 emojiOpen，**不要改成挂在 onFocus 上**：
          程序性 focus（insert() 挑完表情会把光标放回输入框）也会触发 focus 事件，
          那样挑一个表情面板就被自己关掉。详见 dismissEmoji 的注释。 */}
      <div
        className="cp-field"
        onPointerDown={dismissEmoji}
        onClick={dismissEmoji}
      >
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder={disabled ? '连接中…' : '输入消息…'}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value)
            onTyping()
          }}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onKeyDown={(e) => {
            // 读取设置：回车是发送还是换行
            const enterToSend = localStorage.getItem('chatly-enter-to-send') !== 'false'
            if (e.key === 'Enter' && !e.shiftKey && enterToSend) {
              e.preventDefault()
              submit()
            }
          }}
        />
      </div>

      {/* 表情按钮**始终**存在：以前「有输入就换成发送」的写法会让人正在打字时
          点不到表情，这是真没法用的缺陷。现在是 发送 / 加号 二选一，表情常驻。
          切勿在同一按钮内既挂 onClick 又给里面的图标挂 onClick —— 会触发两次。 */}
      <button
        type="button"
        className={`cp-btn ${emojiOpen ? 'is-on' : ''}`}
        onClick={onToggleEmoji}
        aria-label={emojiOpen ? '收起表情面板' : '打开表情面板'}
        aria-expanded={emojiOpen}
      >
        <IconEmoji size={21} />
      </button>

      {text.trim() ? (
        <button type="button" className="cp-send" onClick={submit} aria-label="发送">
          <IconSend size={19} />
        </button>
      ) : (
        <button type="button" className="cp-btn" onClick={onPlus} aria-label="更多">
          <IconPlus size={21} />
        </button>
      )}
      </div>
    </div>
  )
})

/* ===== 加号面板 =====
   「位置」是真的能用的（选地点 → 发一条 kind='location' 的消息）。

   「投票」**只在群聊里出现**（PRD §14 是群投票）。私聊里不是「禁用」，而是
   **根本没有这一项** —— 投票在两个人之间没有语义，摆一个永远点不动的灰按钮
   只会让人以为功能坏了。第一版把它画成「投票 · 仅群聊」，那是错的口径：
   界面上不该出现一个用户永远用不到的东西。
   群里若被「全员禁言 / 仅管理员发言」挡住，才回到 disabled + 写明原因 ——
   那种情况下功能是**存在**的，只是当前这个人暂时不能用。 */
function PlusSheet({ open, onClose, onImage, onVideo, onFile, onLocate, onPoll, isGroup, canPoll, pollReason, canMedia = true, mediaReason = '' }) {
  if (!open) return null
  /* 禁言时媒体入口整排锁定。注意和投票的区别：
     投票是「不适用（私聊）→ 整个不渲染」；媒体是「适用但暂时不能用 → 留着但 disabled」——
     用户要能看到「这里本来有四个入口，只是现在被禁言锁了」，
     全藏掉会让他以为功能消失了。 */
  const mediaLock = canMedia ? {} : { disabled: true, suffix: mediaReason }
  const items = [
    { label: '图片', icon: <IconImage size={21} />, tone: '#8fd3f4', onClick: onImage, ...mediaLock },
    { label: '视频', icon: <IconVideo size={21} />, tone: '#ffb0b0', onClick: onVideo, ...mediaLock },
    { label: '位置', icon: <IconLocate size={21} />, tone: '#a8e6cf', onClick: onLocate, ...mediaLock },
    { label: '文件', icon: <IconFolder size={21} />, tone: '#b3c7ff', onClick: onFile, ...mediaLock },
    /* 只有群聊才把「投票」拼进来（私聊里这一格直接不存在） */
    ...(isGroup
      ? [
          {
            label: '投票',
            icon: <IconCheck size={21} />,
            tone: '#ffd08a',
            onClick: onPoll,
            disabled: !canPoll,
            /* 群里的禁用要写清是**为什么** —— 只画一个灰按钮，用户只会以为坏了 */
            suffix: canPoll ? '' : pollReason,
          },
        ]
      : []),
    /* ⚠️ 这里**没有**「收藏」。
       第一版把它画成「收藏 · 未接入」的灰按钮；收藏做完之后它也仍然不该在这儿 ——
       加号面板是「发一条新消息」的地方，而收藏的作用对象是**已有的一条消息**
       （长按消息 → 收藏）。放在这里语义上说不通，用户点开也只会困惑。
       所以直接拿掉，而不是改成某个别的动作。 */
  ]
  return (
    <div className="plus-root">
      <div className="plus-mask" onClick={onClose} />
      <div className="plus-panel anim-sheet">
        <span className="sheet-grab" />
        <div className="plus-grid">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              className="plus-item"
              disabled={it.disabled}
              data-testid={`plus-${it.label}`}
              onClick={() => {
                if (it.disabled) return
                onClose()
                it.onClick?.()
              }}
            >
              <span className="plus-ic" style={{ background: it.disabled ? '#e6e6ee' : it.tone }}>
                {it.icon}
              </span>
              <span>{it.disabled ? `${it.label} · ${it.suffix || '未接入'}` : it.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ===== 主组件 ===== */
export default function ChatRoom({ chat, onBack, jumpTo, onJumped }) {
  const { showToast } = useApp()
  const {
    me,
    connected,
    loadMessages,
    openConversation,
    closeConversation,
    sendMessage,
    sendAttachment,
    revokeMessage,
    notifyTyping,
    messagesOf,
    hasMoreOf,
    typing,
    readCursors,
    deleteConversation,
    polls,
    sendPollMessage,
    votePoll,
    closePoll,
    conversations,
  } = useChat()
  const { isFaved, addFavorite, removeFavorite, addFavorites, removeFavorites, rememberFavorited } = useFavorites()

  const [menuState, setMenuState] = useState(null) // { m, canRevoke }
  const [multi, setMulti] = useState({ on: false, ids: new Set() }) // 多选模式（PRD §9）
  /* 转发目标选择器：{ open, ids } —— ids 可能是 1 条（长按菜单进）或 N 条（多选进）。
     和多选共用「选了哪些」的语义，但**不复用 multi 状态**：转发选完目标就关，
     而多选栏在转发面板打开期间要保持（回来还能继续选）。 */
  const [forward, setForward] = useState({ open: false, ids: [] })
  const [info, setInfo] = useState(false)
  const [plus, setPlus] = useState(false)
  const [quote, setQuote] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [viewer, setViewer] = useState(null)
  const [locPick, setLocPick] = useState(false) // 「选位置」整屏面板
  const [locView, setLocView] = useState(null) // 正在全屏看的位置消息
  const [pollNew, setPollNew] = useState(false) // 「发起投票」整屏面板
  const [pollView, setPollView] = useState(null) // 正在看详情的投票 id
  const [flashId, setFlashId] = useState(null) // 从群设置跳过来时高亮的那条消息
  const [readPop, setReadPop] = useState(null) // { msgId, style }
  const [profileId, setProfileId] = useState(null) // 正在查看的对方 user id
  const [emoji, setEmoji] = useState(false) // 表情面板
  const [gset, setGset] = useState(false) // 群设置页（只有群聊会开）
  const [editAnnouncementOnOpen, setEditAnnouncementOnOpen] = useState(false)
  const [groupFilesOpen, setGroupFilesOpen] = useState(false)
  const [annOpen, setAnnOpen] = useState(false) // 群公告是否已展开

  const composerRef = useRef(null)
  const endRef = useRef(null)
  const scrollRef = useRef(null)
  const roomRef = useRef(null)
  const fileRef = useRef(null)
  const fileKindRef = useRef('file')
  const voiceRecorderRef = useRef(null)
  const voiceStreamRef = useRef(null)
  const voiceChunksRef = useRef([])
  const voiceTimeoutRef = useRef(null)
  const [recording, setRecording] = useState(false)
  const lastIdRef = useRef(null)
  const flashTimer = useRef(null)

  const list = messagesOf(chat.id)
  const hasMore = hasMoreOf(chat.id)
  const typingUser = typing[chat.id]

  /* 除我以外的成员 + 各自已读位置。实时事件推进游标后这里会自动重算，
     打开中的弹层也跟着变，不需要额外同步。 */
  const peersWithState = useMemo(
    () =>
      (chat.members || [])
        .filter((mb) => mb.user.id !== me?.id)
        .map((mb) => ({
          user: mb.user,
          // ?? 与 || 混用必须加括号，否则是语法错误
          readCursor: (readCursors[chat.id]?.[mb.user.id] ?? Number(mb.lastReadMessageId)) || 0,
        })),
    [chat.members, chat.id, me, readCursors]
  )

  /* 点击已读：把弹层锚到那行回执上，空间不够就朝下弹 */
  const openReadPop = useCallback((msgId, el, mine) => {
    const room = roomRef.current
    const scroller = scrollRef.current
    if (!room || !el) return
    const rr = room.getBoundingClientRect()
    const fr = el.getBoundingClientRect()
    // 以「消息可视区」为上下边界 —— 用 .room 的话会把顶栏和输入区也算进可用空间，
    // 结果矮屏下向下弹会直接压住输入框。
    const sr = scroller ? scroller.getBoundingClientRect() : rr

    const W = Math.min(232, rr.width - 20)
    let left = mine ? fr.right - rr.left - W : fr.left - rr.left
    left = Math.max(10, Math.min(left, rr.width - W - 10))

    // 弹层高度随人数变，用 top / bottom 定位避开测高；同时把缩放原点翻到贴边那一侧，
    // 弹出的动画才是「从头像簇里长出来」，而不是凭空缩放。
    const GAP = 6
    const POP_MAX = 212 // 与 .read-pop 的 max-height 对齐
    const spaceUp = fr.top - sr.top
    const spaceDown = sr.bottom - fr.bottom
    const style = { left, width: W }

    if (spaceUp >= spaceDown) {
      // 上方更宽裕 → 向上弹，并把高度压在可用空间内（超出由 .rp-body 内部滚动）
      style.bottom = rr.bottom - fr.top + GAP
      style.maxHeight = Math.max(72, Math.min(POP_MAX, spaceUp - GAP))
      style.transformOrigin = 'bottom center'
    } else {
      style.top = fr.bottom - rr.top + GAP
      style.maxHeight = Math.max(72, Math.min(POP_MAX, spaceDown - GAP))
      style.transformOrigin = 'top center'
    }

    setReadPop({ msgId, style })
  }, [])

  const closeReadPop = useCallback(() => setReadPop(null), [])

  /* 打开「对方资料」整屏页。
     两个入口调用姿势不同：顶部头像 onProfile() 不带参、会话设置里的行 onProfile(id) 带参，
     所以这里既能接 id 也能自己从 members 里找对端。 */
  const openPeerProfile = useCallback(
    (id) => {
      const pid =
        typeof id === 'number' ? id : (chat.members || []).find((m) => m.user.id !== me?.id)?.user?.id
      if (!pid) return
      setInfo(false) // 资料页是覆盖层，先收起设置面板，避免两层叠加
      setProfileId(pid)
    },
    [chat.members, me]
  )

  /* 切换会话 / 离开时收起弹层、资料页与表情面板 */
  useEffect(() => {
    setReadPop(null)
    setProfileId(null)
    setEmoji(false)
    setLocPick(false)
    setLocView(null)
    setPollNew(false)
    setPollView(null)
    /* 多选也要退出：切了会话之后「已选」的那几条属于上一个房间，
       留着会让底部的「已选 N 条」和眼前的列表对不上。 */
    setMulti({ on: false, ids: new Set() })
  }, [chat.id])

  /**
   * 把这一页消息的收藏状态记进 FavoriteStore。
   *
   * 服务端在消息出参里给了 `favorited`（一次 IN 查询算完），
   * 灌进 Set 之后长按菜单才能正确显示「收藏」还是「取消收藏」——
   * 尤其是翻到很久以前的消息时，那条**不在收藏列表的第一页**，
   * 从列表里反查是查不到的（见 FavoriteStore 文件头的说明）。
   */
  useEffect(() => {
    if (list?.length) rememberFavorited(list)
  }, [list, rememberFavorited])

  /* Esc 收起表情面板：桌面预览下这是唯一合手的关闭方式 */
  useEffect(() => {
    if (!emoji) return
    const onKey = (e) => e.key === 'Escape' && setEmoji(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [emoji])

  /* 打开会话：拉历史 + 标记已读；离开时清掉「当前激活会话」 */
  useEffect(() => {
    openConversation(chat.id)
    loadMessages(chat.id).catch((e) => showToast(e.message || '加载消息失败'))
    return () => closeConversation()
  }, [chat.id, openConversation, closeConversation, loadMessages, showToast])

  /* 新消息到达时贴底；加载更早的消息不触发（最后一条 id 未变） */
  useEffect(() => {
    const items = list || []
    const last = items[items.length - 1]
    if (!last) return
    if (last.id !== lastIdRef.current) {
      const first = lastIdRef.current == null
      lastIdRef.current = last.id
      if (first || last.mine || chat.id) {
        requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end' }))
      }
    }
  }, [list, chat.id])

  /**
   * 跳到某条消息（群设置的投票、我页收藏的「在聊天中查看」都用它）。
   *
   * ⚠️ 那条消息**可能还没加载出来**（投票/收藏是上周的，当前这页历史里没有）。
   * 只做 `scrollIntoView` 的话会静默失败 —— 用户看到上一层关了、
   * 聊天页停在原地，像是「点了没反应」。
   * 所以：先翻页把它翻出来，翻不到就如实说一句，再滚过去并高亮一下。
   *
   * @param {number} messageId
   * @param {string} [missingText] 找不到时的提示文案（投票与收藏的说法不一样）
   */
  const jumpToMessage = async (messageId, missingText = '这条消息已经不在当前记录里了') => {
    const id = Number(messageId)
    if (!id) return false
    let items = list || []
    if (!items.some((m) => m.id === id)) {
      let tries = 0
      while (tries < 10 && hasMore) {
        tries++
        try {
          await loadMessages(chat.id, { beforeId: items[0]?.id })
        } catch {
          break
        }
        items = messagesOf(chat.id) || []
        if (items.some((m) => m.id === id)) break
      }
    }
    const el = roomRef.current?.querySelector(`[data-mid="${id}"]`)
    if (!el) {
      showToast(missingText)
      return false
    }
    el.scrollIntoView({ block: 'center' })
    setFlashId(id)
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlashId(null), 1600)
    return true
  }

  /**
   * 外来跳转请求（我页收藏 → 「在聊天中查看」）。
   *
   * ⚠️ 依赖 `nonce` 而不是 `messageId`：连点两次同一条时 messageId 没变，
   * effect 不会重跑 → 看着像「点了没反应」（扫一扫「重试」踩过同一个坑）。
   * 另外要等消息列表**至少加载过一次**再跳，否则 `list` 还是 undefined，
   * 会误报「不在这页记录里」。
   */
  useEffect(() => {
    if (!jumpTo?.messageId || !list) return
    let alive = true
    jumpToMessage(jumpTo.messageId, '这条收藏的消息已经不在聊天记录里了').finally(() => {
      /* 跳完就告诉 Phone 把请求清掉，避免返回再进房间时又跳一次 */
      if (alive) onJumped?.()
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo?.nonce, list])

  /* 滚到顶部 → 加载更早的消息 */
  const onScroll = async () => {
    // 回执弹层锚在具体那一行上，滚动后位置就失效了，直接收起
    if (readPop) setReadPop(null)

    const el = scrollRef.current
    if (!el || el.scrollTop > 24 || loadingMore || !hasMore || !list?.length) return
    setLoadingMore(true)
    const prevH = el.scrollHeight
    try {
      await loadMessages(chat.id, { beforeId: list[0].id })
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight - prevH
      })
    } catch (e) {
      showToast(e.message || '加载更早消息失败')
    } finally {
      setLoadingMore(false)
    }
  }

  /* ---------- 发送 ---------- */
  const send = async (text) => {
    try {
      await sendMessage({
        conversationId: chat.id,
        kind: 'text',
        text,
        quoteText: quote?.text?.replace(/\n/g, ' ').slice(0, 22) || undefined,
        replyToId: quote?.id,
      })
      setQuote(null)
    } catch (e) {
      showToast(e.message || '发送失败')
    }
  }

  const pickFile = (kind) => {
    fileKindRef.current = kind
    if (fileRef.current) {
      /* accept 只是给系统选择器一个默认筛选，不是安全边界 ——
         真正的类型校验在服务端（upload 白名单 + kind 白名单）。 */
      fileRef.current.accept = { image: 'image/*', video: 'video/*', file: '' }[kind] ?? ''
      fileRef.current.value = ''
      fileRef.current.click()
    }
  }

  /* ---------- 大表情：点一下直接发 ---------- */
  const sendSticker = async ({ fileUrl, fileName }) => {
    try {
      await sendMessage({ conversationId: chat.id, kind: 'image', fileUrl, fileName })
    } catch (e) {
      showToast(e.message || '发送失败')
    }
  }

  /* ---------- 发位置 ----------
     `place.lat/lng` 可能是 null（用户手输的地点名）—— 照原样传，**不要补 0**。
     服务端对「坐标缺一个」的处理是整体当作没有坐标，前端这边保持一致。 */
  const sendLocation = async (place) => {
    if (!place?.name) return
    try {
      await sendMessage({
        conversationId: chat.id,
        kind: 'location',
        geo: { name: place.name, address: place.address || '', lat: place.lat, lng: place.lng },
      })
    } catch (e) {
      showToast(e.message || '发送位置失败')
    }
  }

  /* ---------- 发言门控（禁言） ----------
     ⚠️ 这是**唯一**的前端发言门：投票入口、输入框禁言条、加号面板共用它。
     服务端有同名的 canSpeak()（chat.js）做真正的拦截，这里的作用只是
     「提前告诉用户发不出去」，不是防线 —— 两处判据必须一致（muteAll/adminOnly + 角色），
     各写一份的话迟早走岔（比如投票发不出去、文字发得出去）。

     另外「能不能发起」和「要不要显示这个入口」是**两件事**：
       · **私聊**：投票入口整个不渲染（见 PlusSheet 的 `isGroup`）；
       · **群聊**：入口在，但被禁言挡成 disabled —— 投票在聊天里表现为一条消息，
         发言被禁却能发起投票就等于绕过了群治理。
     被挡时要写明原因，不是只把按钮画灰。 */
  const speakGate = useMemo(() => {
    if (chat.type !== 'group') return { ok: true, reason: '' }
    const myRole = chat.myRole || (chat.ownerId === me?.id ? 'owner' : 'member')
    const privileged = myRole === 'owner' || myRole === 'admin'
    if (chat.muteAll && !privileged) return { ok: false, reason: '全员禁言中' }
    if (chat.adminOnly && !privileged) return { ok: false, reason: '仅管理员可发言' }
    return { ok: true, reason: '' }
  }, [chat.type, chat.myRole, chat.ownerId, chat.muteAll, chat.adminOnly, me?.id])
  /* 投票门就是发言门（发起投票同时会发一条 kind='poll' 的消息）。
     别名而不是复制 —— 两个名字指向同一份判定，改一处两处一起变。 */
  const pollGate = speakGate

  const createPoll = async (payload) => {
    /* PollSheet 打开后禁言状态也可能通过 WS 更新；提交时再次读取同一个 gate，
       避免弹层仍开着时沿用旧权限。服务端 canSpeak() 仍是最终防线。 */
    if (!speakGate.ok) throw new Error(`${speakGate.reason}，暂不能发起投票`)
    const { poll } = await sendPollMessage({ conversationId: chat.id, ...payload })
    /* 发起后把详情层直接打开？**不开** —— 投票已经在聊天记录里了，
       再叠一个整屏层会挡住「我刚发出去的那条」。只把它滚进视野。 */
    setPollView(null)
    return poll
  }

  const onVotePoll = async (pollId, optionIds) => {
    try {
      await votePoll(pollId, optionIds)
    } catch (e) {
      showToast(e.message || '投票失败')
      throw e
    }
  }

  const onClosePoll = async (pollId) => {
    try {
      await closePoll(pollId)
      showToast('投票已结束')
    } catch (e) {
      showToast(e.message || '结束投票失败')
      throw e
    }
  }

  /* ---------- 收藏（PRD §9） ----------
     收藏是**快照**，服务端会把正文和文件地址抄一份 —— 所以原消息撤回后
     收藏里那条仍然完整（这是「收藏」这个词的题中之义）。
     失败原因由服务端给（「这条消息已撤回，不能收藏」），如实透出。 */
  const toggleFavorite = async (m) => {
    setMenuState(null)
    try {
      if (isFaved(m.id)) {
        await removeFavorite(m.id)
        showToast('已取消收藏')
      } else {
        const out = await addFavorite(m.id)
        showToast(out?.created === false ? '已经在收藏里了' : '已收藏')
      }
    } catch (e) {
      showToast(e.message || '收藏失败')
    }
  }

  /* ---------- 稍后看 ----------
     稍后看是**引用**（不是快照），原消息撤回后稍后看条目会消失。
     和收藏的区别：收藏适合「重要内容存档」，稍后看适合「待办事项」。 */
  const { addToWatchLater, removeFromWatchLater } = useWatchLater()
  const toggleWatchLater = async (m) => {
    setMenuState(null)
    try {
      if (m.inWatchLater) {
        await removeFromWatchLater(m.id)
        showToast('已从稍后看移除')
      } else {
        await addToWatchLater(m.id, chat.id)
        showToast('已加入稍后看')
      }
    } catch (e) {
      showToast(e.message || '操作失败')
    }
  }

  /* ---------- 多选模式（PRD §9「消息多选批量：转发 / 收藏 / 删除」） ----------
     这里只做**收藏**那一项是真的；转发与删除仍标「未接入」并 disabled ——
     按项目一贯的口径，不做点了弹 toast 假装成功的假按钮。 */
  const multiExit = () => setMulti({ on: false, ids: new Set() })

  const multiToggle = (m) => {
    if (!multi.on || m.revoked) return
    setMulti((prev) => {
      const ids = new Set(prev.ids)
      if (ids.has(m.id)) ids.delete(m.id)
      else ids.add(m.id)
      return { ...prev, ids }
    })
  }

  const multiFav = async () => {
    const ids = [...multi.ids]
    if (!ids.length) return
    try {
      /* 已收藏的那部分应该走「取消」还是「收藏」？
         多选里两种混着的时候，交给服务端逐个处理最省心：
         这里统一调批量收藏（幂等），已经收藏的会返回 created=false，不重复插入。 */
      const out = await addFavorites(ids)
      const added = out?.added?.length || 0
      const skipped = out?.skipped?.length || 0
      /* ⚠️ 如实报数：跳过的那些（已撤回）要讲出来，
         只说「已收藏」会让用户以为 10 条全收进去了。 */
      showToast(
        skipped
          ? `收藏 ${added} 条，跳过 ${skipped} 条（已撤回）`
          : `已收藏 ${added || ids.length} 条`
      )
      multiExit()
    } catch (e) {
      showToast(e.message || '批量收藏失败')
    }
  }

  const multiUnfav = async () => {
    const ids = [...multi.ids]
    if (!ids.length) return
    try {
      const out = await removeFavorites(ids)
      showToast(`已取消收藏 ${out?.removed ?? ids.length} 条`)
      multiExit()
    } catch (e) {
      showToast(e.message || '批量取消失败')
    }
  }

  /* 多选里「有多少条已经被收藏」—— 决定工具栏上给「收藏」还是「取消收藏」 */
  const multiFavedCount = multi.on ? [...multi.ids].filter((id) => isFaved(id)).length : 0
  const multiAllFaved = multi.on && multi.ids.size > 0 && multiFavedCount === multi.ids.size

  /* ---------- 转发 ----------
     两条入口都只做一件事：把「要转哪些消息 id」装进 forward state，
     打开目标选择器。真正的落库在选完目标之后（doForward）。
     ⚠️ 长按菜单进来的那条**可能已被撤回** —— 菜单是在消息还活着时打开的，
     但用户可能开着菜单放了半天才点「转发」。所以 doForward 之前不预判，
     交给服务端逐条判定（skipped 里会写「已被撤回」）。 */
  const openForward = (ids) => {
    const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean)
    if (!list.length) return
    setForward({ open: true, ids: list })
  }

  const doForward = async (target) => {
    const ids = forward.ids
    if (!target?.id || !ids.length) return
    /* 转发给**当前会话**也是允许的（备忘/再发一遍），不拦 —— 见路由注释 */
    const out = await api.forwardMessages(target.id, ids)
    const n = out?.forwarded?.length || 0
    const skipped = out?.skipped?.length || 0
    /* ⚠️ 如实报数，和批量收藏同一个口径：跳过的那些（撤回/投票/无权看）要讲出来，
       只说「已转发」会让用户以为 N 条全过去了。 */
    showToast(
      skipped ? `已转发 ${n} 条，跳过 ${skipped} 条` : `已转发 ${n} 条`
    )
    setForward({ open: false, ids: [] })
    /* 多选进来的：转完退出多选（和收藏做完 multiExit() 一个道理）。
       长按菜单进来的：菜单早关了，这里不用管。 */
    if (multi.on) multiExit()
    /* 转到当前会话：列表会自动贴底（UPSERT_MESSAGE + lastId 变化），不用手动滚 */
  }

  const onFileChosen = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const kind = fileKindRef.current
    try {
      await sendAttachment({
        conversationId: chat.id,
        kind,
        file,
      })
    } catch (err) {
      showToast(err.message || '发送失败')
    } finally {
      if (e.target) e.target.value = ''
    }
  }

  const stopVoiceStream = () => {
    clearTimeout(voiceTimeoutRef.current)
    voiceTimeoutRef.current = null
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop())
    voiceStreamRef.current = null
    voiceRecorderRef.current = null
    setRecording(false)
  }

  const recordVoice = async () => {
    if (recording) {
      voiceRecorderRef.current?.stop()
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showToast('当前浏览器不支持语音录制')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus']
      const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported?.(type))
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      voiceStreamRef.current = stream
      voiceRecorderRef.current = recorder
      voiceChunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data?.size) voiceChunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        showToast('录音失败，请检查麦克风权限')
        stopVoiceStream()
      }
      recorder.onstop = async () => {
        const blob = new Blob(voiceChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'
        stopVoiceStream()
        if (!blob.size) {
          showToast('没有录到声音')
          return
        }
        if (blob.size > 20 * 1024 * 1024) {
          showToast('语音消息超过 20MB，请缩短后重试')
          return
        }
        const file = new File([blob], `voice-note-${Date.now()}.${extension}`, { type: blob.type })
        try {
          await sendAttachment({
            conversationId: chat.id,
            kind: 'file',
            file,
          })
        } catch (error) {
          showToast(error.message || '语音发送失败')
        }
      }
      recorder.start(250)
      setRecording(true)
      voiceTimeoutRef.current = setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop()
        showToast('语音录制达到 2 分钟上限，正在发送')
      }, 120_000)
    } catch (error) {
      stopVoiceStream()
      showToast(error.name === 'NotAllowedError' ? '请允许麦克风权限后重试' : '无法访问麦克风')
    }
  }

  useEffect(() => () => {
    clearTimeout(voiceTimeoutRef.current)
    const recorder = voiceRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.stop()
    }
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  /* ---------- 撤回 ---------- */
  const doRevoke = async (m) => {
    try {
      await revokeMessage(m.id, chat.id)
      showToast('你撤回了一条消息')
    } catch (e) {
      showToast(e.message || '撤回失败')
    }
  }

  /* ---------- 渲染列表（插入日期分隔） ---------- */
  const rendered = useMemo(() => {
    const out = []
    let lastDay = ''
    for (const m of list || []) {
      const day = new Date(m.createdAt).toDateString()
      if (day !== lastDay) {
        lastDay = day
        out.push({ t: 'day', key: `d-${m.id}`, ts: m.createdAt })
      }
      out.push({ t: 'msg', key: m.id, m })
    }
    return out
  }, [list])

  const menuItems = menuState
    ? [
        {
          label: '回复',
          icon: <IconReply size={20} />,
          onClick: () => {
            setQuote(menuState.m)
            showToast('已引用该消息')
          },
        },
        {
          label: '复制',
          icon: <IconCopy size={20} />,
          onClick: () => {
            navigator.clipboard?.writeText(menuState.m.text || '').then(
              () => showToast('已复制到剪贴板'),
              () => showToast('复制失败')
            )
          },
        },
        /* PRD §9 长按菜单要有「收藏」。已收藏时反过来显示「取消收藏」——
           两个入口都摆上会让用户猜哪个才是当前状态。
           ⚠️ 判据用 FavoriteStore 的 Set（`isFaved`）而不是消息自带的 `m.favorited`：
           那条消息可能是刚被 WS 推来的（出参里没有这个字段），
           而 Set 是「拉历史时灌进来 + 收藏时就地增删」的权威集合。 */
        {
          label: isFaved(menuState.m.id) ? '取消收藏' : '收藏',
          icon: <IconStar size={20} />,
          onClick: () => toggleFavorite(menuState.m),
        },
        {
          label: menuState.m.inWatchLater ? '移除稍后看' : '稍后看',
          icon: <IconClock size={20} />,
          onClick: () => toggleWatchLater(menuState.m),
        },
        {
          label: '转发',
          icon: <IconForward size={20} />,
          onClick: () => {
            const mid = menuState.m.id
            setMenuState(null)
            openForward([mid])
          },
        },
        {
          label: '翻译',
          icon: <IconTranslate size={20} />,
          onClick: () => showToast('翻译 · 尚未接入'),
        },
        /* PRD §9「支持消息多选批量」—— 从这里进多选模式 */
        {
          label: '多选',
          icon: <IconCheck size={20} />,
          onClick: () => {
            const mid = menuState.m.id
            setMulti({ on: true, ids: new Set([mid]) })
            setMenuState(null)
          },
        },
        ...(menuState.canRevoke
          ? [
              {
                label: '撤回',
                icon: <IconTrash size={20} />,
                danger: true,
                onClick: () => doRevoke(menuState.m),
              },
            ]
          : []),
      ]
    : []

  return (
    <div className="room" ref={roomRef}>
      <Header
        chat={chat}
        typing={!!typingUser && typingUser !== me?.id}
        connected={connected}
        onBack={onBack}
        onInfo={() => setInfo(true)}
        onProfile={openPeerProfile}
        onGroup={() => setGset(true)}
      />

      {/* 群公告：默认压成一行，点一下展开全文。
          不做「自动弹出遮挡消息」那种 —— 公告是要能随时看到的固定信息，
          但也不能一进来就占掉半屏。 */}
      {chat.type === 'group' && chat.announcement && (
        <button
          type="button"
          className={`room-ann ${annOpen ? 'is-open' : ''}`}
          onClick={() => setAnnOpen((v) => !v)}
          aria-expanded={annOpen}
        >
          <span className="ra-ic">
            <IconInfo size={14} />
          </span>
          <span className="ra-text">{chat.announcement}</span>
          <span className="ra-more">{annOpen ? '收起' : '展开'}</span>
        </button>
      )}

      <div
        className="room-scroll no-scrollbar"
        ref={scrollRef}
        onScroll={onScroll}
        onClick={() => emoji && setEmoji(false)}
      >
        {hasMore && (
          <p className="room-more">{loadingMore ? '正在加载…' : '下拉加载更早的消息'}</p>
        )}

        {!list && <p className="room-more">正在加载消息…</p>}
        {list && list.length === 0 && <p className="room-more">还没有消息，说点什么吧</p>}

        {rendered.map((it) =>
          it.t === 'day' ? (
            <DayDivider key={it.key} text={formatDayLabel(it.ts)} />
          ) : (
            <Message
              key={it.key}
              m={it.m}
              chat={chat}
              me={me}
              peersWithState={peersWithState}
              readPopMsgId={readPop?.msgId}
              onLongPress={(m, canRevoke) => setMenuState({ m, canRevoke })}
              onOpenImage={(m) => setViewer(m)}
              onOpenLoc={(m) => setLocView(m)}
              onOpenRead={openReadPop}
              polls={polls}
              onVotePoll={onVotePoll}
              onClosePoll={onClosePoll}
              onOpenPollDetail={(pollId) => setPollView(pollId)}
              onJumpToMessage={jumpToMessage}
              /* 用 Number 比较：消息 id 是数字，但从 URL / dataset 拿到的可能是字符串，
                 严格相等一旦不成立，高亮就会**静默**不生效（本轮自检就是这么红的）。 */
              flash={Number(flashId) === Number(it.m.id)}
              /* 收藏状态以 FavoriteStore 的 Set 为准（消息自带的 favorited 可能是未知） */
              favorited={isFaved(it.m.id)}
              multi={multi}
              onMultiToggle={multiToggle}
            />
          )
        )}

        {typingUser && typingUser !== me?.id && (
          <div className="typing-line">
            <i />
            <i />
            <i />
          </div>
        )}

        <div ref={endRef} className="room-end" />
      </div>

      {emoji && (
        <EmojiPanel
          onPick={(ch) => composerRef.current?.insert(ch)}
          onSendBig={sendSticker}
        />
      )}

      {/* 多选模式：**换掉**输入区而不是浮在它上面。
          浮一层会让用户在「想打字」和「在选消息」之间分不清当前处在哪个模式；
          换掉输入区，模式感一眼可见（微信也是这么做的）。
          PRD §9 要求「转发 / 收藏 / 删除」三项，这里只有收藏是真的接通的，
          另外两项如实标「未接入」并 disabled —— 不做点了弹 toast 的假按钮。 */}
      {multi.on ? (
        <div className="msel-bar" data-testid="msel-bar">
          <button type="button" className="msel-cancel" onClick={multiExit}>
            取消
          </button>
          <span className="msel-count">已选 {multi.ids.size} 条</span>
          <div className="msel-acts">
            <button
              type="button"
              className="msel-act"
              disabled={!multi.ids.size}
              onClick={multiAllFaved ? multiUnfav : multiFav}
              data-testid="msel-fav"
            >
              <IconStar size={17} />
              {multiAllFaved ? '取消收藏' : '收藏'}
            </button>
            {/* ⚠️ 这里**不能**用当前会话的 speakGate 来 disabled 转发按钮。
                转发是发到**目标会话**，不是当前会话 —— 从禁言群里把消息转发到
                别的群是完全合法的（禁的是「在该群发言」，不是「不能碰该群的消息」）。
                目标会话禁不禁言，在 ForwardSheet 选目标时才知道，
                那里由服务端 403 兜底（面板不关、如实报错，见 ForwardSheet 的 confirm）。
                我第一版写成了 `disabled={!multi.ids.size || !speakGate.ok}`，
                那会把合法的「从禁言群转出」也挡掉 —— 已回退。 */}
            <button
              type="button"
              className="msel-act"
              disabled={!multi.ids.size}
              onClick={() => openForward([...multi.ids])}
              data-testid="msel-forward"
              title="选择目标会话并转发"
            >
              <IconForward size={17} />
              转发
            </button>
            <button type="button" className="msel-act" disabled title="删除 · 尚未接入">
              <IconTrash size={17} />
              删除
            </button>
          </div>
        </div>
      ) : !speakGate.ok ? (
        /* 禁言提示条：**替换**输入区，而不是在输入区上加 disabled ——
           用户打完 200 字才被 403 挡回去是最差的体验。
           文案直接用 gate 的 reason（全员禁言中 / 仅管理员可发言），两处同一份判定。 */
        <div className="muted-bar" data-testid="muted-bar">
          <span className="muted-text">{speakGate.reason}，暂不能发言</span>
        </div>
      ) : (
        <Composer
          ref={composerRef}
          onSend={send}
          onTyping={() => notifyTyping(chat.id)}
          onPlus={() => {
            setEmoji(false)
            setPlus(true)
          }}
          disabled={!connected}
          onVoiceRecord={recordVoice}
          recording={recording}
          emojiOpen={emoji}
          onToggleEmoji={() => setEmoji((v) => !v)}
          onCloseEmoji={() => setEmoji(false)}
          quote={quote}
          onCancelQuote={() => setQuote(null)}
        />
      )}

      <input ref={fileRef} type="file" hidden onChange={onFileChosen} />

      {/* 消息菜单由**长按**弹出来（onLongPress），所以要开那道「补发 click」防御 */}
      <ActionMenu open={!!menuState} onClose={() => setMenuState(null)} items={menuItems} longPress />

      {/* 转发目标选择器：整屏层。forward.ids 可能是 1 条（长按菜单）或 N 条（多选）。
          ⚠️ 和投票面板（PollSheet）/ 选位置（LocationPicker）是**互斥**的整屏层，
          但这里不做互斥判断 —— 它们各自的 open 状态由各自的入口控制，
          转发面板打开时多选栏还在底下（回来能继续选，见 forward state 的注释）。 */}
      {forward.open && (
        <ForwardSheet
          open={forward.open}
          conversations={conversations}
          currentId={chat.id}
          count={forward.ids.length}
          onClose={() => setForward({ open: false, ids: [] })}
          onPick={doForward}
        />
      )}
      <InfoSheet
        open={info}
        onClose={() => setInfo(false)}
        chat={chat}
        me={me}
        onProfile={openPeerProfile}
        onDelete={async () => {
          await deleteConversation(chat.id)
          showToast('会话已删除')
          onBack()
        }}
        onGroup={() => {
          setInfo(false)
          setGset(true)
        }}
        onEditAnnouncement={() => {
          setInfo(false)
          setEditAnnouncementOnOpen(true)
          setGset(true)
        }}
        onFiles={() => {
          setInfo(false)
          setGroupFilesOpen(true)
        }}
      />
      {groupFilesOpen && <GroupFilesPage chat={chat} sendMessage={sendMessage} onBack={() => setGroupFilesOpen(false)} />}
      <PlusSheet
        open={plus}
        onClose={() => setPlus(false)}
        onImage={() => pickFile('image')}
        onVideo={() => pickFile('video')}
        onFile={() => pickFile('file')}
        onLocate={() => setLocPick(true)}
        onPoll={() => setPollNew(true)}
        /* 私聊里「投票」这一格整个不渲染（投票不适用于单聊） */
        isGroup={chat.type === 'group'}
        canPoll={pollGate.ok}
        pollReason={pollGate.reason}
        /* 禁言时四个媒体入口也要锁 ——
           正常情况下加号面板根本打不开（输入区被 muted-bar 替换了，+ 按钮不存在），
           这里是纵深防御：万一哪个状态没清干净把面板打开了，也不该能发出东西。
           真正的拦截永远在服务端 canSpeak()。 */
        canMedia={speakGate.ok}
        mediaReason={speakGate.reason}
      />

      {/* 选位置：整屏面板，选完直接把那条位置发出去 */}
      <LocationPicker open={locPick} onClose={() => setLocPick(false)} onPick={sendLocation} />

      {/* 发起投票：整屏面板。只有群聊会打开它（私聊连入口都没有），
          这里再挂一道 `chat.type === 'group'` 是为了防「状态没清干净时误开」——
          和扫描页那边「nav.openChat 之前先关掉自己」是同一类保险。 */}
      {chat.type === 'group' && (
        <PollSheet open={pollNew} onClose={() => setPollNew(false)} onSubmit={createPoll} />
      )}

      {pollView && polls[pollView] && (
        <PollDetailSheet
          poll={polls[pollView]}
          me={me}
          onClose={() => setPollView(null)}
          onVote={(ids) => onVotePoll(pollView, ids)}
          onClosePoll={() => onClosePoll(pollView)}
        />
      )}

      {readPop && (
        <ReadPopover
          msgId={readPop.msgId}
          style={readPop.style}
          peersWithState={peersWithState}
          onClose={closeReadPop}
        />
      )}

      {viewer && <MediaViewer m={viewer} onClose={() => setViewer(null)} />}

      {/* 位置全屏：和图片查看器同级 —— 都是「点开某个消息内容看完整版」 */}
      {locView && <LocationViewer m={locView} onClose={() => setLocView(null)} />}

      {/* 对方资料页：整屏覆盖层。
          资料页只从私聊进入，所以「发消息」就是回到当前房间，别无跳转目标。 */}
      {profileId && (
        <UserProfile
          userId={profileId}
          onBack={() => setProfileId(null)}
          onMessage={() => setProfileId(null)}
        />
      )}

      {/* 群设置页：整屏覆盖层（层级在资料页之下，所以从里面点「查看资料」能正常盖上来）。
          退出群聊后会话已经没了，直接回列表。 */}
      {gset && (
        <GroupSettings
          chat={chat}
          openAnnouncementEditor={editAnnouncementOnOpen}
          onAnnouncementEditorOpened={() => setEditAnnouncementOnOpen(false)}
          onBack={() => setGset(false)}
          onOpenProfile={(id) => setProfileId(id)}
          onLeft={() => {
            setGset(false)
            onBack()
          }}
          /* 点群设置里的投票 → 关掉设置页，滚到聊天里那条消息并高亮。
             不在这里直接开详情层：用户点的是「哪条投票」，
             要看到的是它**在聊天里的上下文**（前后都说了什么）。 */
          onOpenPoll={(messageId) => {
            setGset(false)
            jumpToMessage(messageId, '这条投票的消息已经不在当前记录里了')
          }}
        />
      )}
    </div>
  )
}
