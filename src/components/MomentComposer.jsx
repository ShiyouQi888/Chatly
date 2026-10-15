/**
 * 动态发布 / 编辑（整屏层）
 *
 * 为什么是整屏而不是底部弹层：内容有文案、最多 9 张图、话题、定位、可见范围五项，
 * 塞进底部弹层会出现「输入框 + 图片网格 + 键盘」三方抢空间，手机上没法用。
 *
 * 两条铁律：
 *   1. **媒体先上传再发布**，不是「先本地预览、发布时才传」。
 *      图 / 视频就是这条动态的内容本身，发布失败却留下一堆孤儿文件是最难收拾的状态。
 *      代价是取消发布要清掉已传的文件 —— 这个代价小得多（由清理脚本按「无人引用」回收）。
 *   2. **投票 / 活动 / 链接卡片与动态一起落库**，编辑动态时也会同步更新卡片内容。
 *
 * 视频与图片**互斥**（一条动态要么图文、要么 1 个视频）：
 * 朋友圈也是这个规则 —— 视频动态是「一段视频 + 一段话」，
 * 混着发的话九宫格里要起好几个解码器，滚动起来手机发烫，收益却几乎为零。
 */
import React, { useRef, useState } from 'react'
import { api, mediaUrl } from '../api/client.js'
import VideoPlayer, { fmtTime } from './VideoPlayer.jsx'
import LocationPicker from './LocationPicker.jsx'
import {
  IconClose,
  IconPlus,
  IconTrash,
  IconTag,
  IconLocate,
  IconVideo,
  IconCheck,
  IconChevron,
} from './Icon.jsx'
import './moment-composer.css'

const MAX_MEDIA = 9
/** 视频最多 1 个（和服务端 moment.js 的 MAX_VIDEO 一致） */
const MAX_VIDEO = 1
/** 视频体积上限（和服务端 upload.js 的 MOMENT_VIDEO_MAX 一致） */
const VIDEO_MAX_BYTES = 80 * 1024 * 1024
/** 视频时长上限：3 分钟。再长就不是一个「动态」该承载的内容了 */
const VIDEO_MAX_SEC = 180
const CONTENT_MAX = 2000
const TOPIC_MAX = 40

function localDateTimeValue(date) {
  const offset = date.getTimezoneOffset() * 60000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function fmtBytes(n) {
  const b = Number(n) || 0
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(b / 1024))} KB`
}

const SCOPES = [
  { v: 'public', label: '公开', desc: '所有人可见' },
  { v: 'friends', label: '仅好友', desc: '互相关注的人可见' },
  { v: 'private', label: '仅自己', desc: '只有我能看' },
]

export default function MomentComposer({ open, editing, defaultVisibility = 'public', onClose, onSubmit }) {
  const [content, setContent] = useState('')
  const [topic, setTopic] = useState('')
  const [location, setLocation] = useState('')
  /* 定位的坐标**和地点名分开存**：手输的地点名没有坐标，老动态也可能只有名字。
     坐标缺一个就当作没有（不是补 0）—— (0,0) 是几内亚湾。 */
  const [locGeo, setLocGeo] = useState(null) // { lat, lng } | null
  const [locOpen, setLocOpen] = useState(false)
  const [visibility, setVisibility] = useState('public')
  const [media, setMedia] = useState([]) // { url, fileName, fileSize, kind, width, height, duration }
  const [card, setCard] = useState(null) // { kind, data }
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef(null)
  /* 图片和视频用两个 input：input 的 `multiple` 是写在标签上的，没法「选图时多选、选视频时单选」。
     合成一个 input 的话，用户在桌面端一次框选 3 个视频，只能靠事后报错 —— 不如一开始就只让选一个。 */
  const videoRef = useRef(null)

  /* 打开 / 编辑对象变化时预填。
     放在渲染期同步 setState 是刻意的：写成 useEffect 会先渲染一帧空表单再填，
     编辑时能看到内容「跳」一下。这里没有副作用，只是把初始值算出来。

     ⚠️ 判据**不能**写 `loaded !== editing`。新建时 `editing` 是 null，
     而 `loaded` 初值也是 null → 条件恒为 false，于是：
       ① 新建**从来不预填**（这时问题不大，靠 useState 初值兜住了）；
       ② 但编辑过一次之后 `loaded` 会变成那条动态，关掉面板只把 `loaded` 清回 null，
          **表单 state 还留着上一条的正文** —— 再点「+」新建，
          输入框里赫然是刚才编辑的那条内容，一不小心就重复发一条。
     所以用「本次打开的唯一标识」来判断：新建 = 'new'，编辑 = `e<id>`。
     关掉时清成 null，下次打开必定重新预填一遍。 */
  const [loaded, setLoaded] = useState(null)
  const sessionKey = open ? (editing ? `e${editing.id}` : 'new') : null
  if (sessionKey && loaded !== sessionKey) {
    setLoaded(sessionKey)
    setContent(editing?.content || '')
    setTopic(editing?.topic || '')
    setLocation(editing?.location || '')
    setLocGeo(
      Number.isFinite(editing?.locationLat) && Number.isFinite(editing?.locationLng)
        ? { lat: editing.locationLat, lng: editing.locationLng }
        : null
    )
    setLocOpen(false)
    /* 编辑保留原可见范围；新建用「我 → 隐私设置」里的默认范围 */
    setVisibility(editing ? editing.visibility || 'public' : defaultVisibility)
    setMedia((editing?.media || []).map((m) => ({ ...m, kind: m.kind || 'image' })))
    setCard(editing?.card ? {
      kind: editing.card.kind,
      data: {
        ...editing.card.data,
        ...(editing.card.kind === 'activity' ? { startsAt: localDateTimeValue(new Date(editing.card.data.startsAt)) } : {}),
      },
    } : null)
    setErr('')
    setBusy(false)
  }
  if (!sessionKey && loaded !== null) setLoaded(null)

  if (!open) return null

  const hasVideo = media.some((m) => m.kind === 'video')

  /** 格式：体积是死的（服务端还有一道），时长得读元数据才知道 */
  const addImages = async (fileList) => {
    const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type))
    if (!files.length) return
    if (hasVideo) {
      setErr('视频和图片不能混发 —— 换视频就先删掉它，或者换一条图文动态')
      return
    }
    if (media.length + files.length > MAX_MEDIA) {
      setErr(`最多 ${MAX_MEDIA} 张图，多了 ${media.length + files.length - MAX_MEDIA} 张`)
      return
    }
    setBusy(true)
    setErr('')
    const okItems = []
    for (const f of files) {
      try {
        /* 走动态自己的上传接口（图片 12MB）：消息那个接口上限 20MB 且不校验 MIME */
        const up = await api.uploadMomentMedia(f, 'image')
        okItems.push({ url: up.url, fileName: up.fileName || f.name, fileSize: up.fileSize || f.size, kind: 'image' })
      } catch (e) {
        setErr(e.message || '有图片上传失败')
        break
      }
    }
    setMedia((m) => [...m, ...okItems])
    setBusy(false)
  }

  const addVideo = async (fileList) => {
    const f = Array.from(fileList || []).find((x) => /^video\//.test(x.type))
    if (!f) {
      setErr('这不是一个视频文件')
      return
    }
    if (media.length) {
      setErr('视频和图片不能混发 —— 先把下面的媒体删掉')
      return
    }
    if (f.size > VIDEO_MAX_BYTES) {
      setErr(`视频太大了（${fmtBytes(f.size)}），上限 ${fmtBytes(VIDEO_MAX_BYTES)}`)
      return
    }
    setBusy(true)
    setErr('')
    try {
      /* 先读元数据再上传：时长超限就不用白传 80MB 上去。
         宽高也在这里读 —— 落库后列表能**在加载视频之前**按真实比例占位。 */
      const meta = await api.probeMedia(f, 'video')
      if (meta?.duration && meta.duration > VIDEO_MAX_SEC) {
        setErr(`视频最长 ${VIDEO_MAX_SEC / 60} 分钟，这段有 ${Math.ceil(meta.duration)} 秒`)
        setBusy(false)
        return
      }
      const up = await api.uploadMomentMedia(f, 'video')
      setMedia([
        {
          url: up.url,
          fileName: up.fileName || f.name,
          fileSize: up.fileSize || f.size,
          kind: 'video',
          width: meta?.width || null,
          height: meta?.height || null,
          duration: meta?.duration || null,
        },
      ])
    } catch (e) {
      setErr(e.message || '视频上传失败')
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = (content.trim() || media.length > 0 || card) && !busy

  const chooseCard = (kind) => {
    if (card?.kind === kind) {
      setCard(null)
      return
    }
    const data = kind === 'poll'
      ? { question: '', options: ['', ''], multi: false }
      : kind === 'activity'
        ? { title: '', startsAt: localDateTimeValue(new Date(Date.now() + 60 * 60 * 1000)), location: '', description: '' }
        : { url: '', title: '', description: '' }
    setCard({ kind, data })
    setErr('')
  }

  const updateCard = (key, value) => setCard((current) => current ? { ...current, data: { ...current.data, [key]: value } } : current)

  const submit = async () => {
    if (!canSubmit) return
    if (card?.kind === 'poll') {
      const options = [...new Set(card.data.options.map((value) => value.trim()).filter(Boolean))]
      if (!card.data.question.trim()) return setErr('请填写投票问题')
      if (options.length < 2) return setErr('投票至少需要两个不同的有效选项')
    }
    if (card?.kind === 'activity') {
      if (!card.data.title.trim()) return setErr('请填写活动名称')
      if (!Number.isFinite(new Date(card.data.startsAt).getTime()) || new Date(card.data.startsAt).getTime() <= Date.now()) {
        return setErr('活动时间必须晚于现在')
      }
    }
    if (card?.kind === 'link') {
      if (!card.data.title.trim()) return setErr('请填写链接标题')
      try {
        if (!['http:', 'https:'].includes(new URL(card.data.url).protocol)) throw new Error()
      } catch {
        return setErr('请输入以 http:// 或 https:// 开头的有效链接')
      }
    }
    setBusy(true)
    setErr('')
    try {
      await onSubmit({
        content: content.trim(),
        topic: topic.trim(),
        location: location.trim(),
        /* 坐标和名字一起提交（服务端按「成对」校验，半个坐标会被丢掉）。
           注意这里传的是 null 而不是 undefined —— undefined 在 JSON 里会被整个省略，
           编辑时想「清掉原来的坐标」就永远清不掉。 */
        locationLat: locGeo?.lat ?? null,
        locationLng: locGeo?.lng ?? null,
        visibility,
        /* 宽高时长一起提交：列表拿不到这些就只能先按 16:9 渲染，
           等视频加载完再跳一下 —— 一屏里好几条时那一跳很明显。 */
        media: media.map((m) => ({
          url: m.url,
          fileName: m.fileName,
          fileSize: m.fileSize,
          kind: m.kind,
          width: m.width || null,
          height: m.height || null,
          duration: m.duration || null,
        })),
        card: card ? {
          kind: card.kind,
          data: {
            ...card.data,
            ...(card.kind === 'activity' ? { startsAt: new Date(card.data.startsAt).getTime() } : {}),
          },
        } : null,
      })
      onClose()
    } catch (e) {
      setErr(e.message || '发布失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mc-root cover-tabbar">
      <header className="mc-bar">
        <button type="button" className="mc-cancel" onClick={onClose} aria-label="取消">
          <IconClose size={20} />
        </button>
        <h2>{editing ? '编辑动态' : '发布动态'}</h2>
        <button type="button" className="mc-send" disabled={!canSubmit} onClick={submit}>
          {busy ? '处理中…' : editing ? '保存' : '发布'}
        </button>
      </header>

      <div className="mc-body no-scrollbar">
        <textarea
          className="mc-textarea"
          rows={5}
          value={content}
          maxLength={CONTENT_MAX}
          placeholder="分享此刻的想法…"
          onChange={(e) => setContent(e.target.value)}
        />

        {/* 媒体：真实上传的结果，不是本地预览 —— 发布失败不会留下孤儿文件 */}
        {hasVideo ? (
          <div className="mc-video">
            {media.map((m, i) => (
              <div key={m.url + i} className="mc-video-box">
                {/* 发布前能直接试播：不给 onOpen，VideoPlayer 就原地播 */}
                <VideoPlayer src={mediaUrl(m.url)} width={m.width} height={m.height} duration={m.duration} />
                <button type="button" className="mc-cell-del" aria-label="移除视频" onClick={() => setMedia([])}>
                  <IconTrash size={13} />
                </button>
              </div>
            ))}
            <p className="mc-video-meta">
              {media[0]?.duration ? `${fmtTime(media[0].duration)} · ` : ''}
              {fmtBytes(media[0]?.fileSize)}
              {media[0]?.width && media[0]?.height ? ` · ${media[0].width}×${media[0].height}` : ''}
            </p>
          </div>
        ) : (
          <div className="mc-grid">
            {media.map((m, i) => (
              <div key={m.url + i} className="mc-cell">
                <img src={mediaUrl(m.url)} alt={m.fileName || '配图'} />
                <button
                  type="button"
                  className="mc-cell-del"
                  aria-label={`删除第 ${i + 1} 张`}
                  onClick={() => setMedia((list) => list.filter((_, j) => j !== i))}
                >
                  <IconTrash size={13} />
                </button>
              </div>
            ))}
            {media.length < MAX_MEDIA && (
              <button
                type="button"
                className="mc-cell is-add"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                aria-label="添加图片"
              >
                <IconPlus size={22} sw={2.2} />
                <em>
                  {media.length}/{MAX_MEDIA}
                </em>
              </button>
            )}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            addImages(e.target.files)
            e.target.value = '' // 允许连续选同一批文件
          }}
        />
        {/* 视频单独一个 input：不带 multiple，一次只能选一个（服务端也只收 1 个） */}
        <input
          ref={videoRef}
          type="file"
          accept="video/mp4,video/webm,video/quicktime,video/x-m4v,video/x-msvideo,video/x-matroska,video/ogg"
          hidden
          onChange={(e) => {
            addVideo(e.target.files)
            e.target.value = ''
          }}
        />

        <div className="mc-vrow">
          <button
            type="button"
            className="mc-vpick"
            onClick={() => videoRef.current?.click()}
            disabled={busy || media.length > 0}
            aria-label="选择视频"
          >
            <IconVideo size={16} />
            {hasVideo ? '已选 1 个视频' : '选一个视频'}
          </button>
          <em>
            {media.length > 0 && !hasVideo
              ? '已选图片，视频与图片不能混发'
              : `最多 ${MAX_VIDEO} 个 · ${fmtBytes(VIDEO_MAX_BYTES)} 内 · ${VIDEO_MAX_SEC / 60} 分钟内`}
          </em>
        </div>

        <div className="mc-field">
          <span className="mc-field-ic">
            <IconTag size={16} />
          </span>
          <input
            value={topic}
            maxLength={TOPIC_MAX}
            placeholder="话题，例如：周末出逃"
            onChange={(e) => setTopic(e.target.value)}
          />
        </div>

        {/* 位置：走**共用**的「选位置」面板（和聊天发位置同一套），
            这样「附近有哪些地方」「没配 key 怎么降级」在两处一定是一致的。
            面板里也支持手动输入地点名 —— 手输的没有坐标，卡片上会写明。 */}
        <div className="mc-loc">
          <button
            type="button"
            className={`mc-field is-tap ${location ? 'is-set' : ''}`}
            onClick={() => setLocOpen(true)}
            data-testid="mc-loc-pick"
          >
            <span className="mc-field-ic">
              <IconLocate size={16} />
            </span>
            <span className="mc-loc-body">
              {location ? <b>{location}</b> : <em>定位（可留空）</em>}
              {location && <em>{locGeo ? '带坐标，可在地图上看' : '只有地点名，不带坐标'}</em>}
            </span>
            <IconChevron size={15} />
          </button>
          {location && (
            <button
              type="button"
              className="mc-loc-clear"
              aria-label="清除位置"
              onClick={() => {
                setLocation('')
                setLocGeo(null)
              }}
            >
              <IconClose size={15} />
            </button>
          )}
        </div>

        <div className="mc-sec">
          <h4>可见范围</h4>
          <div className="mc-scopes">
            {SCOPES.map((s) => (
              <button
                key={s.v}
                type="button"
                className={`mc-scope ${visibility === s.v ? 'is-on' : ''}`}
                onClick={() => setVisibility(s.v)}
                aria-pressed={visibility === s.v}
              >
                <b>{s.label}</b>
                <em>{s.desc}</em>
                {visibility === s.v && (
                  <i>
                    <IconCheck size={12} sw={3} />
                  </i>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="mc-sec">
          <h4>添加卡片（选填）</h4>
          <div className="mc-card-types">
            <button type="button" className={`mc-card-type ${card?.kind === 'poll' ? 'is-on' : ''}`} onClick={() => chooseCard('poll')} aria-pressed={card?.kind === 'poll'}>
              投票
            </button>
            <button type="button" className={`mc-card-type ${card?.kind === 'activity' ? 'is-on' : ''}`} onClick={() => chooseCard('activity')} aria-pressed={card?.kind === 'activity'}>
              活动
            </button>
            <button type="button" className={`mc-card-type ${card?.kind === 'link' ? 'is-on' : ''}`} onClick={() => chooseCard('link')} aria-pressed={card?.kind === 'link'}>
              链接卡片
            </button>
          </div>
          {card?.kind === 'poll' && (
            <div className="mc-card-editor">
              <label className="mc-card-label">投票问题<input value={card.data.question} maxLength={120} placeholder="你更喜欢哪种？" onChange={(e) => updateCard('question', e.target.value)} /></label>
              <div className="mc-card-options">
                {card.data.options.map((option, index) => (
                  <div className="mc-card-option" key={index}>
                    <input aria-label={`选项 ${index + 1}`} value={option} maxLength={60} placeholder={`选项 ${index + 1}`} onChange={(e) => updateCard('options', card.data.options.map((x, i) => i === index ? e.target.value : x))} />
                    {card.data.options.length > 2 && <button type="button" onClick={() => updateCard('options', card.data.options.filter((_, i) => i !== index))} aria-label={`删除选项 ${index + 1}`}>移除</button>}
                  </div>
                ))}
              </div>
              {card.data.options.length < 6 && <button type="button" className="mc-card-add" onClick={() => updateCard('options', [...card.data.options, ''])}>＋ 添加选项</button>}
              <label className="mc-card-check"><input type="checkbox" checked={card.data.multi} onChange={(e) => updateCard('multi', e.target.checked)} /> 允许多选</label>
            </div>
          )}
          {card?.kind === 'activity' && (
            <div className="mc-card-editor">
              <label className="mc-card-label">活动名称<input value={card.data.title} maxLength={100} placeholder="周末一起去徒步" onChange={(e) => updateCard('title', e.target.value)} /></label>
              <label className="mc-card-label">开始时间<input type="datetime-local" value={card.data.startsAt} onChange={(e) => updateCard('startsAt', e.target.value)} /></label>
              <label className="mc-card-label">活动地点<input value={card.data.location} maxLength={120} placeholder="填写集合地点（选填）" onChange={(e) => updateCard('location', e.target.value)} /></label>
              <label className="mc-card-label">活动说明<textarea value={card.data.description} maxLength={500} placeholder="补充活动安排（选填）" onChange={(e) => updateCard('description', e.target.value)} /></label>
            </div>
          )}
          {card?.kind === 'link' && (
            <div className="mc-card-editor">
              <label className="mc-card-label">链接地址<input type="url" value={card.data.url} maxLength={2048} placeholder="https://example.com" onChange={(e) => updateCard('url', e.target.value)} /></label>
              <label className="mc-card-label">卡片标题<input value={card.data.title} maxLength={120} placeholder="给链接起个标题" onChange={(e) => updateCard('title', e.target.value)} /></label>
              <label className="mc-card-label">链接简介<textarea value={card.data.description} maxLength={300} placeholder="简单介绍这个链接（选填）" onChange={(e) => updateCard('description', e.target.value)} /></label>
            </div>
          )}
        </div>

        {err && <p className="mc-err">{err}</p>}
        {/* 说清楚取消的代价：图是选中时就传上去了，取消不会去删服务器上的文件。
            与其含糊带过，不如写出来 —— 这些文件由 cleanup 脚本按「无人引用」回收。 */}
        <p className="mc-hint">
          {[...content].length}/{CONTENT_MAX} · 图片 / 视频选中即上传，取消后由清理脚本回收
        </p>
      </div>

      {/* 选位置：层级高于发布面板（z-index 160 > 150），所以能正常盖在上面 */}
      <LocationPicker
        open={locOpen}
        onClose={() => setLocOpen(false)}
        title="选择位置"
        submitLabel="确定"
        onPick={(p) => {
          setLocation(p.name || '')
          setLocGeo(
            Number.isFinite(p.lat) && Number.isFinite(p.lng) ? { lat: p.lat, lng: p.lng } : null
          )
        }}
      />
    </div>
  )
}
