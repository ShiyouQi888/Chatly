import React, { useEffect, useState } from 'react'
import { api, formatAgo } from '../api/client.js'
import { useApp } from '../store/AppContext.jsx'
import { useAuth } from '../store/AuthContext.jsx'
import { useMoments } from '../store/MomentStore.jsx'
import { useFavorites } from '../store/FavoriteStore.jsx'
import { avatarOf, useChat } from '../store/ChatStore.jsx'
import { THEMES, DEVICES, WATCH_LATER, FILES, IMG } from '../data/mock.js'
import { Avatar, Row, Group, Switch, Chip, Empty, SectionTitle } from '../components/ui.jsx'
import ProfileEditor from '../components/ProfileEditor.jsx'
import MyQrPage from './MyQrPage.jsx'
import { isVideoItem } from '../components/MomentMedia.jsx'
import {
  IconPlay,
  IconStar,
  IconClock,
  IconFolder,
  IconShield,
  IconLock,
  IconGear,
  IconPalette,
  IconBell,
  IconHelp,
  IconInfo,
  IconEdit,
  IconBack,
  IconChevron,
  IconEye,
  IconLogout,
  IconCheck,
  IconImage,
  IconLocate,
  IconUser,
  IconSearch,
  IconQr,
} from '../components/Icon.jsx'
import './me-tab.css'

const GENDER_LABEL = { male: '男', female: '女', other: '其他' }

const VIS_SHORT = { friends: '仅好友', private: '仅自己' }

/* ===== 「我的动态」子页 =====
 * 读的是**真实**动态（和动态 Tab 同一个接口，scope=mine）。
 * 这里以前渲染的是 mock 里的 MY_POSTS —— 动态接后端之后那几条就是
 * 「页面上列着根本不存在的内容」，属于必须清掉的假功能。
 *
 * 编辑 / 删除**不在这里做**：同一套动作开两个入口迟早会走岔
 * （一边补了新字段、另一边没有）。这页只负责看，要改就跳去动态 Tab，
 * 那里有完整的编辑 / 删除 / 可见范围。 */
function MyPosts({ onManage }) {
  const [state, setState] = useState({ loading: true, list: [], error: '' })

  useEffect(() => {
    let alive = true
    api
      .moments({ scope: 'mine', limit: 50 })
      .then((d) => alive && setState({ loading: false, list: d.moments || [], error: '' }))
      .catch((e) => alive && setState({ loading: false, list: [], error: e.message || '加载失败' }))
    return () => {
      alive = false
    }
  }, [])

  if (state.loading) return <p className="sub-note">加载中…</p>
  if (state.error) return <p className="sub-note">{state.error}</p>
  if (!state.list.length) {
    return <Empty icon={<IconImage size={26} />} title="还没有动态" desc="去发布第一条动态吧" />
  }

  return (
    <>
      <div className="sub-list">
        {state.list.map((m) => (
          <div key={m.id} className="mini-post">
            <div className="mp-head">
              <Avatar src={avatarOf(m.author)} name={m.author?.nickname} size={34} radius={11} />
              <b>{m.author?.nickname}</b>
              <em>{formatAgo(m.createdAt)}</em>
            </div>
            {m.content && <p>{m.content}</p>}
            {m.media?.length > 0 && (
              <div className="mp-media">
                {m.media.slice(0, 3).map((it, i) =>
                  isVideoItem(it) ? (
                    /* 视频缩略图：`<video preload="metadata">` 会画出首帧。
                       之前这里一律当图片渲染，视频动态在「我的动态」里是一个黑框。 */
                    <span key={it.url + i} className="mp-cell is-video">
                      <video src={it.url} muted playsInline preload="metadata" />
                      <i>
                        <IconPlay size={12} />
                      </i>
                    </span>
                  ) : (
                    <img key={it.url + i} src={it.url} alt="" loading="lazy" />
                  )
                )}
                {m.media.length > 3 && <i className="mp-more">+{m.media.length - 3}</i>}
              </div>
            )}
            <div className="mp-foot">
              <span>
                <IconStar size={13} /> {m.likeCount}
              </span>
              <span>{m.commentCount} 条评论</span>
              {VIS_SHORT[m.visibility] && <span className="mp-vis">{VIS_SHORT[m.visibility]}</span>}
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="mp-manage" onClick={onManage}>
        去动态页编辑 / 删除
      </button>
    </>
  )
}

/* ===== 快捷四宫格 ===== */
function QuickGrid({ onOpen }) {
  const items = [
    { key: 'posts', label: '我的动态', icon: <IconImage size={21} />, tone: 'linear-gradient(135deg,#a8c8e8,#6a8ad0)' },
    { key: 'fav', label: '收藏', icon: <IconStar size={21} />, tone: 'linear-gradient(135deg,#ffd08a,#f0a840)' },
    { key: 'later', label: '稍后看', icon: <IconClock size={21} />, tone: 'linear-gradient(135deg,#c7b3ff,#8a6ad0)' },
    { key: 'files', label: '最近文件', icon: <IconFolder size={21} />, tone: 'linear-gradient(135deg,#a8dcc0,#4a9c78)' },
  ]
  return (
    <div className="quick-grid">
      {items.map((it) => (
        <button key={it.key} type="button" className="quick-item" onClick={() => onOpen(it.key)}>
          <span className="quick-ic" style={{ background: it.tone }}>
            {it.icon}
          </span>
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  )
}

/* ===== 收藏行 =====
   收藏存的是**快照**，所以这里画的内容全部来自收藏自己那一行，
   不去拉原消息（原消息可能已经被撤回甚至被清理）。

   五种消息形态都要能画：文字 / 图片 / 文件 / 位置 / 投票。
   用 `kind` 分流而不是「有什么画什么」—— 位置消息的正文是空的、
   文件消息的正文是文件名，混在一起会画出一堆空白行。 */
function FavRow({ f, onOpen, onJump, onRemove }) {
  /* 摘要文案：按 kind 分流，和会话列表预览、收藏列表三处口径保持一致 */
  const summary = (() => {
    if (f.kind === 'image') return '[图片]'
    if (f.kind === 'file') return `[文件] ${f.fileName || ''}`.trim()
    if (f.kind === 'video') return `[视频] ${f.fileName || ''}`.trim()
    if (f.kind === 'location') return `[位置] ${f.geo?.name || ''}`.trim()
    if (f.kind === 'poll') return `[投票] ${f.text || ''}`.trim()
    return (f.text || '').replace(/\n/g, ' ')
  })()

  const who = f.sender?.nickname || '已注销用户'
  const when = formatAgo(f.createdAt)

  return (
    <div className="fav-row" data-testid="fav-row" data-fav-id={f.id} data-kind={f.kind}>
      <button type="button" className="fav-main" onClick={onOpen} data-testid="fav-open">
        {/* 图片收藏直接显示缩略图 —— 收藏一张图却只看到「[图片]」两个字没有意义。
            ⚠️ 不走 <img> 兜底占位：文件可能已经不在磁盘上了（那是允许的，
            收藏只是快照），破了就显示一个图标块，不要一个破图。 */}
        {f.kind === 'image' && f.fileUrl ? (
          <span className="fav-thumb">
            <img src={f.fileUrl} alt={f.fileName || '图片'} loading="lazy" />
          </span>
        ) : (
          <span className={`fav-ic is-${f.kind}`}>
            {f.kind === 'location' ? (
              <IconLocate size={20} />
            ) : f.kind === 'poll' ? (
              <IconCheck size={20} />
            ) : f.kind === 'file' || f.kind === 'video' ? (
              <IconFolder size={20} />
            ) : f.kind === 'image' ? (
              <IconImage size={20} />
            ) : (
              <IconStar size={20} />
            )}
          </span>
        )}
        <span className="fav-body">
          <b>{summary || '（空）'}</b>
          <em>
            {who} · {when}
            {f.kind !== 'text' && f.text && f.kind !== 'poll' ? ` · ${f.text}` : ''}
          </em>
        </span>
      </button>

      <div className="fav-acts">
        {/* 「在聊天中查看」只在**跳得过去**时才给：
            原消息被物理删掉（canJump=false）或会话没了的时候，
            摆一个点了没反应的按钮比不给更糟。 */}
        {f.canJump ? (
          <button type="button" className="fav-act" onClick={onJump} data-testid="fav-jump">
            在聊天中查看
          </button>
        ) : (
          <span className="fav-act is-off" title="原消息或会话已经不在了">
            原消息已不在
          </span>
        )}
        <button type="button" className="fav-act is-danger" onClick={onRemove} data-testid="fav-remove">
          移除
        </button>
      </div>
    </div>
  )
}

/* ===== 子页面容器 ===== */
function SubPage({ title, onBack, children, action }) {
  return (
    <div className="subpage cover-tabbar">
      <header className="sub-head">
        <button type="button" className="sub-back" onClick={onBack}>
          <IconBack size={21} />
        </button>
        <h2>{title}</h2>
        {action || <span className="sub-spacer" />}
      </header>
      <div className="sub-scroll no-scrollbar">{children}</div>
    </div>
  )
}

export default function MeTab({ nav }) {
  const { showToast, status, dispatch } = useApp()
  const { user, logout } = useAuth()
  const { conversations } = useChat()
  /* setScope 是全局的（和动态 Tab 共用一个 store）——
     点「去动态页编辑」时顺手把筛选切到「我的」，落地就是自己那几条。 */
  const { setScope } = useMoments()
  const {
    list: favList,
    hasMore: favHasMore,
    total: favTotal,
    loading: favLoading,
    error: favError,
    refresh: refreshFavorites,
    removeFavoriteById,
  } = useFavorites()
  const [page, setPage] = useState(null)
  const [theme, setTheme] = useState('极光')
  const [editing, setEditing] = useState(false)
  /* 「我」页的统计条要给一个真实的动态数量 —— 不能再用 mock 里那个数，
     否则会出现「统计说有 3 条，点进去一条都没有」。 */
  const [myCount, setMyCount] = useState(null)

  /**
   * 进「我的收藏」时重拉一次。
   *
   * 为什么不能只靠 store 里已有那份：收藏可能在**聊天页**刚加过
   * （长按消息 → 收藏），而那条不会主动推进 `list` ——
   * 不重拉的话，用户收藏完切到我页会看到旧列表，以为没收藏上。
   */
  useEffect(() => {
    if (page === 'fav') refreshFavorites().catch(() => {})
  }, [page, refreshFavorites])

  /**
   * 点一条收藏：能跳就跳到聊天里那条消息，跳不了就把快照内容展示出来。
   *
   * 为什么「两者都做」：原消息**可能已经不在**（对方撤回后又被清理、
   * 或会话被删）—— 那时候只给跳转就是一个点了没反应的按钮。
   * 收藏的意义就在于「原消息没了它还在」，所以必须有自成一体的一条路。
   */
  const onOpenFavorite = (f) => {
    if (f.canJump) {
      nav?.jumpToMessage?.(f.conversationId, f.messageId)
      return
    }
    /* 跳不过去：把快照内容念出来（信息都在收藏自己那一行里） */
    const summary =
      f.kind === 'image'
        ? '图片'
        : f.kind === 'file' || f.kind === 'video'
          ? f.fileName || '文件'
          : f.kind === 'location'
            ? f.geo?.name || '位置'
            : f.kind === 'poll'
              ? f.text || '投票'
              : (f.text || '').slice(0, 40)
    showToast(`原消息已不在，收藏内容：${summary}`)
  }

  useEffect(() => {
    if (!user) return
    let alive = true
    api
      .moments({ scope: 'mine', limit: 100 })
      .then((d) => alive && setMyCount((d.moments || []).length))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [user])

  /* ===== 子页面：我的二维码 ===== */
  if (page === 'qr') {
    return (
      <SubPage title="我的二维码" onBack={() => setPage(null)}>
        <MyQrPage />
      </SubPage>
    )
  }

  /* ===== 子页面：我的动态 ===== */
  if (page === 'posts') {
    return (
      <SubPage title="我的动态" onBack={() => setPage(null)}>
        <MyPosts
          onManage={() => {
            setScope('mine')
            dispatch({ type: 'SET_TAB', tab: 'moment' })
          }}
        />
      </SubPage>
    )
  }

  /* ===== 子页面：收藏（真实数据，PRD §9） =====
     这里原来是 mock 里的 FAVORITES 三条假数据（「海边日落摄影局 · 活动」…），
     点了只弹一句 toast。现在读的是真收藏 —— 内容是**快照**，
     所以原消息撤回之后这一条仍然完整（正文/文件都在）。 */
  if (page === 'fav') {
    return (
      <SubPage title="我的收藏" onBack={() => setPage(null)}>
        {favLoading && !favList.length ? (
          <p className="sub-note">正在加载收藏…</p>
        ) : favError ? (
          <p className="sub-note is-warn">{favError}</p>
        ) : !favList.length ? (
          <div data-testid="fav-empty">
            <Empty
              icon={<IconStar size={26} />}
              title="还没有收藏"
              desc="长按聊天里的一条消息，选「收藏」就能存到这里"
            />
          </div>
        ) : (
          <div className="sub-list" data-testid="fav-list">
            {favList.map((f) => (
              <FavRow
                key={f.id}
                f={f}
                onOpen={() => onOpenFavorite(f)}
                onJump={() => nav?.jumpToMessage?.(f.conversationId, f.messageId)}
                onRemove={async () => {
                  try {
                    await removeFavoriteById(f.id)
                    showToast('已移出收藏')
                  } catch (e) {
                    showToast(e.message || '移除失败')
                  }
                }}
              />
            ))}
            {favHasMore && (
              <button
                type="button"
                className="sub-more"
                onClick={() => refreshFavorites({ beforeId: favList[favList.length - 1]?.id })}
              >
                加载更多
              </button>
            )}
          </div>
        )}
      </SubPage>
    )
  }

  /* ===== 子页面：稍后看 ===== */
  if (page === 'later') {
    return (
      <SubPage title="稍后看" onBack={() => setPage(null)}>
        <div className="sub-list">
          {WATCH_LATER.map((f) => (
            <button key={f.id} type="button" className="asset-row" onClick={() => showToast('打开 ' + f.title)}>
              <Avatar src={f.src} name={f.title} size={46} radius={14} />
              <span className="asset-body">
                <b>{f.title}</b>
                <em>
                  {f.type} · {f.time}
                </em>
              </span>
              <IconChevron size={16} className="asset-chev" />
            </button>
          ))}
        </div>
      </SubPage>
    )
  }

  /* ===== 子页面：文件中心 ===== */
  if (page === 'files') {
    return (
      <SubPage title="文件中心" onBack={() => setPage(null)}>
        <div className="file-search">
          <IconSearch size={16} />
          <input placeholder="搜索文件" />
        </div>
        <div className="file-cats">
          {['全部', '文档', '图片', '视频', '压缩包', '其他'].map((c, i) => (
            <Chip key={c} size="sm" active={i === 0} onClick={() => showToast(`筛选：${c}`)}>
              {c}
            </Chip>
          ))}
        </div>
        <div className="sub-list">
          {FILES.map((f) => (
            <div key={f.id} className="file-row">
              <span className="file-ext">{f.type.slice(0, 4)}</span>
              <span className="asset-body">
                <b>{f.title}</b>
                <em>
                  {f.size} · 来自 {f.from}
                </em>
              </span>
              <button type="button" className="file-dl" onClick={() => showToast('下载 ' + f.title)}>
                下载
              </button>
            </div>
          ))}
        </div>
      </SubPage>
    )
  }

  /* ===== 子页面：账号与安全 ===== */
  if (page === 'security') {
    return (
      <SubPage title="账号与安全" onBack={() => setPage(null)}>
        <Group title="登录方式">
          <Row icon={<IconUser size={19} />} label="手机号" value="138****6721" onClick={() => showToast('更换手机号')} />
          <Row icon={<IconShield size={19} />} label="邮箱" value="已绑定" onClick={() => showToast('更换邮箱')} />
          <Row icon={<IconLock size={19} />} label="密码" value="已设置" onClick={() => showToast('修改密码')} last />
        </Group>
        <Group title="安全设置" footer="开启二次验证后，在新设备登录需额外验证。">
          <Row icon={<IconShield size={19} />} label="生物识别" right={<Switch on onChange={() => showToast('已切换生物识别')} />} />
          <Row icon={<IconLock size={19} />} label="二次验证" right={<Switch on={false} onChange={() => showToast('已开启二次验证')} />} last />
        </Group>
        <Group title="登录设备">
          {DEVICES.map((d, i) => (
            <Row
              key={d.id}
              icon={<IconInfo size={19} />}
              label={d.name}
              sub={d.meta}
              right={d.now ? <span className="tag-now">当前</span> : null}
              chevron={!d.now}
              onClick={d.now ? undefined : () => showToast('远程退出 ' + d.name)}
              last={i === DEVICES.length - 1}
            />
          ))}
        </Group>
        <Group>
          <Row icon={<IconLogout size={19} />} label="退出登录" danger onClick={() => showToast('已退出登录 · 原型演示')} last />
        </Group>
      </SubPage>
    )
  }

  /* ===== 子页面：隐私 ===== */
  if (page === 'privacy') {
    return (
      <SubPage title="隐私设置" onBack={() => setPage(null)}>
        <Group title="谁可以找到我">
          <Row label="谁可以加我" value="好友的好友" onClick={() => showToast('设置：谁可以加我')} />
          <Row label="谁可以给我发消息" value="所有人" onClick={() => showToast('设置：谁可以发消息')} />
          <Row label="陌生人可查看主页" right={<Switch on={false} onChange={() => showToast('已切换')} />} last />
        </Group>
        <Group title="谁可以看到我">
          <Row label="我的状态" value="仅好友" onClick={() => showToast('设置：状态可见范围')} />
          <Row label="我的动态" value="公开" onClick={() => showToast('设置：动态可见范围')} />
          <Row label="显示在线状态" right={<Switch on onChange={() => showToast('已切换')} />} />
          <Row label="显示已读回执" right={<Switch on onChange={() => showToast('已切换')} />} last />
        </Group>
        <Group title="聊天隐私" footer="消息自动消失开启后，新会话的消息会在设定时间后清除。">
          <Row icon={<IconLock size={19} />} label="消息加密" value="已开启" onClick={() => showToast('端到端加密已开启')} />
          <Row icon={<IconShield size={19} />} label="消息自动消失" value="关闭" onClick={() => showToast('设置消息自动消失')} />
          <Row icon={<IconEye size={19} />} label="阅后即焚" right={<Switch on={false} onChange={() => showToast('已切换')} />} />
          <Row icon={<IconBell size={19} />} label="截屏提醒" right={<Switch on onChange={() => showToast('已切换')} />} last />
        </Group>
      </SubPage>
    )
  }

  /* ===== 子页面：通知 ===== */
  if (page === 'notify') {
    return (
      <SubPage title="消息通知" onBack={() => setPage(null)}>
        <Group title="通知类型">
          <Row label="新消息" right={<Switch on onChange={() => showToast('已切换')} />} />
          <Row label="@ 我" right={<Switch on onChange={() => showToast('已切换')} />} />
          <Row label="点赞" right={<Switch on onChange={() => showToast('已切换')} />} />
          <Row label="评论" right={<Switch on onChange={() => showToast('已切换')} />} />
          <Row label="新关注" right={<Switch on onChange={() => showToast('已切换')} />} last />
        </Group>
        <Group title="群与系统">
          <Row label="群通知" right={<Switch on onChange={() => showToast('已切换')} />} />
          <Row label="系统通知" right={<Switch on onChange={() => showToast('已切换')} />} last />
        </Group>
        <Group title="提醒方式">
          <Row label="声音" right={<Switch on onChange={() => showToast('已切换')} />} />
          <Row label="震动" right={<Switch on onChange={() => showToast('已切换')} />} />
          <Row label="免打扰时段" value="23:00 - 08:00" onClick={() => showToast('设置免打扰时段')} last />
        </Group>
        <p className="sub-note">支持按联系人单独设置通知级别。</p>
      </SubPage>
    )
  }

  /* ===== 子页面：外观主题 ===== */
  if (page === 'theme') {
    return (
      <SubPage title="外观主题" onBack={() => setPage(null)}>
        <SectionTitle action="使用中" onAction={() => showToast('当前主题：' + theme)}>
          <span>默认主题</span>
        </SectionTitle>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`theme-card ${theme === t.name ? 'is-on' : ''}`}
              onClick={() => {
                setTheme(t.name)
                showToast('已应用主题 · ' + t.name)
              }}
            >
              <span
                className="theme-swatch"
                style={{ background: `linear-gradient(135deg, ${t.colors[0]}, ${t.colors[1]})` }}
              >
                {theme === t.name && (
                  <i className="theme-check">
                    <IconCheck size={16} sw={2.6} />
                  </i>
                )}
              </span>
              <span className="theme-name">{t.name}</span>
            </button>
          ))}
        </div>

        <SectionTitle>自定义</SectionTitle>
        <Group>
          <Row icon={<IconImage size={19} />} label="聊天背景" value="默认" onClick={() => showToast('选择聊天背景')} />
          <Row icon={<IconPalette size={19} />} label="气泡颜色" value="紫蓝渐变" onClick={() => showToast('选择气泡颜色')} />
          <Row icon={<IconEye size={19} />} label="强调色" value="荧光蓝" onClick={() => showToast('选择强调色')} />
          <Row
            icon={<IconInfo size={19} />}
            label="字体大小"
            value="标准"
            onClick={() => showToast('调整字体大小')}
          />
          <Row label="动效开关" right={<Switch on onChange={() => showToast('已切换动效')} />} last />
        </Group>
        <p className="sub-note">可以为不同联系人设置独立的聊天主题。</p>
      </SubPage>
    )
  }

  /* ===== 主页面 ===== */
  return (
    <div className="tabpane">
      <div className="me-scroll no-scrollbar">
        {/* 个人空间头部 */}
        <div className="me-hero">
          <div className="me-cover" style={{ backgroundImage: `linear-gradient(160deg,#2b2b45,#141428)` }}>
            <svg className="me-cover-svg" viewBox="0 0 390 220" preserveAspectRatio="none">
              <defs>
                <linearGradient id="skyG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#8ea6d8" />
                  <stop offset="0.55" stopColor="#b8b0e0" />
                  <stop offset="1" stopColor="#e0c8d8" />
                </linearGradient>
              </defs>
              <rect width="390" height="220" fill="url(#skyG)" />
              <circle cx="308" cy="52" r="30" fill="rgba(255,255,255,.5)" />
              <circle cx="322" cy="44" r="27" fill="#b8b0e0" opacity=".55" />
              <path d="M0 168l86-84 62 52 46-34 90 74 106-58v102H0z" fill="rgba(255,255,255,.5)" />
              <path d="M0 190l112-70 74 56 60-40 144 66v18H0z" fill="rgba(255,255,255,.72)" />
            </svg>
            <button type="button" className="me-cover-set" onClick={() => showToast('更换主页背景')}>
              <IconImage size={15} />
            </button>
          </div>

          <div className="me-idcard">
            <Avatar src={avatarOf(user)} name={user?.nickname || ''} size={76} radius={24} ring={0} />
            <div className="me-info">
              <div className="me-name">
                <h2>{user?.nickname}</h2>
                <button type="button" className="me-editbtn" onClick={() => setEditing(true)}>
                  <IconEdit size={15} />
                </button>
                {/* 「我的二维码」入口：挂在昵称行**流内**最右侧（不是绝对定位）——
                    绝对定位的话昵称一长就会钻到按钮底下。 */}
                <button
                  type="button"
                  className="me-qrbtn"
                  onClick={() => setPage('qr')}
                  aria-label="我的二维码"
                >
                  <IconQr size={17} sw={1.9} />
                </button>
              </div>
              <p className="me-bio">{user?.bio || '还没有个性签名'}</p>
              <span className="me-uid">ID: {user?.username}</span>
              {(user?.region || user?.gender) && (
                <p className="me-meta">
                  {user.gender && <span>{GENDER_LABEL[user.gender] || user.gender}</span>}
                  {user.region && <span>{user.region}</span>}
                </p>
              )}
            </div>
          </div>

          {!!user?.tags?.length && (
            <div className="me-tags">
              {user.tags.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
          )}

          <div className="me-stats">
            <button type="button" onClick={() => dispatch({ type: 'SET_TAB', tab: 'chat' })}>
              <b>{conversations.length}</b>
              <em>会话</em>
            </button>
            <span className="me-stat-div" />
            <button type="button" onClick={() => setPage('posts')}>
              <b>{myCount === null ? '—' : myCount > 99 ? '99+' : myCount}</b>
              <em>动态</em>
            </button>
            <span className="me-stat-div" />
            <button type="button" onClick={() => setPage('fav')}>
              {/* 真数，不再是 mock 数组的长度（那个永远是 3） */}
              <b>{favTotal > 99 ? '99+' : favTotal}</b>
              <em>收藏</em>
            </button>
          </div>
        </div>

        {/* 当前状态 */}
        <button
          type="button"
          className="me-status"
          onClick={() => {
            dispatch({ type: 'SET_STATUS', status: { emoji: '🎧', text: '正在听歌', expire: '还有 24 小时' } })
            showToast('已切换状态')
          }}
        >
          <span className="me-status-emoji">{status.emoji}</span>
          <span className="me-status-body">
            <b>{status.text}</b>
            <em>{status.expire} · 点击切换</em>
          </span>
          <IconChevron size={16} />
        </button>

        {/* 快捷四宫格 */}
        <QuickGrid onOpen={(k) => setPage(k)} />

        {/* 个性签名卡：点进真实的资料编辑 */}
        <button type="button" className="me-quote" onClick={() => setEditing(true)}>
          <span className="me-quote-mark">“</span>
          <p>
            {user?.bio || '还没有个性签名'}
            <br />
            <em>—— 点这里编辑资料</em>
          </p>
          <IconChevron size={16} />
        </button>

        {/* 设置列表 */}
        <Group>
          <Row
            icon={<IconShield size={19} />}
            label="账号与安全"
            onClick={() => setPage('security')}
          />
          <Row icon={<IconLock size={19} />} label="隐私设置" onClick={() => setPage('privacy')} />
          <Row icon={<IconGear size={19} />} label="通用设置" onClick={() => showToast('通用设置')} />
          <Row icon={<IconPalette size={19} />} label="主题外观" value={theme} onClick={() => setPage('theme')} />
          <Row icon={<IconBell size={19} />} label="消息通知" onClick={() => setPage('notify')} />
          <Row icon={<IconHelp size={19} />} label="帮助与反馈" onClick={() => showToast('帮助与反馈')} />
          <Row icon={<IconInfo size={19} />} label="关于我们" value="v1.0.0" onClick={() => showToast('Chatly v1.0.0')} last />
        </Group>

        <button type="button" className="me-logout" onClick={logout}>
          <IconLogout size={18} /> 退出登录
        </button>

        <p className="me-foot">Chatly · 连接更有趣的人</p>
      </div>

      {/* 编辑资料：真实读写后端（昵称/签名/性别/生日/地区/标签 + 头像上传·预设·裁剪） */}
      <ProfileEditor
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={() => setEditing(false)}
        showToast={showToast}
      />
    </div>
  )
}
