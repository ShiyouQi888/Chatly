import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { useApp } from '../store/AppContext.jsx'
import { avatarOf, useChat } from '../store/ChatStore.jsx'
import { Avatar } from '../components/ui.jsx'
import { decodeQrImageData, decodeQrFromSource } from '../lib/qr.js'
import { parseQrPayload, looksLikeUserId, normalizeUsernameInput } from '../lib/qrPayload.js'
import {
  IconBack,
  IconImage,
  IconEdit,
  IconScan,
  IconCopy,
  IconCheck,
  IconChat,
  IconInfo,
} from '../components/Icon.jsx'
import './scan.css'

/* ===== 扫一扫 =====
 *
 * 三条**都真的能跑**的路径，能力不足时明确说原因，不假装：
 *   1. 摄像头 —— getUserMedia + lib/qr.js 的**自写**解码器
 *      （桌面 Chrome 没有 BarcodeDetector，见 lib/qr.js 顶部说明）
 *   2. 相册   —— 选一张图，同一个解码器。这条也是自检能覆盖的路径：
 *      无头浏览器没有摄像头，但可以往 file input 里塞一张真实 PNG
 *   3. 手动   —— 直接输 ID（界面上的「ID: xxxx」），走后端按 username 查
 *
 * 识别的结果**只有三类是真实动作**：加好友（写 follows 表）、发消息（建/开私聊）、复制文本。
 * 群码 / 动态码只做到「认出来 + 明确说暂未支持」—— 后端还没有对应的入群校验，
 * 做成按钮就是个点了没反应的假东西。
 */

/** 摄像头失败的**具体**原因。一律写成「摄像头不可用」等于没写，用户没法自助。 */
function cameraReason(e) {
  const name = e?.name || ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '摄像头权限被拒绝。可在浏览器地址栏的权限设置里重新允许后重试'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return '这台设备上没有检测到可用的摄像头'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '摄像头被其它程序占用，关掉占用它的应用后重试'
  }
  return `摄像头打不开：${name || e?.message || '未知原因'}`
}

function loadImageFromUrl(src) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

export default function ScanPage({ onBack, nav }) {
  const { showToast } = useApp()
  const { createPrivateChat } = useChat()

  const videoRef = useRef(null)
  const grabRef = useRef(null)
  const fileRef = useRef(null)

  const [mode, setMode] = useState('camera') // camera | manual
  const [cam, setCam] = useState({ status: 'idle', msg: '' })
  /* 「重试」不能靠 setResult(null) 触发重开：结果本来就是 null 时 setState 值没变，
     effect 的依赖数组没变化 → 根本不会重跑，按钮点了像没反应。用一个自增计数器。 */
  const [camNonce, setCamNonce] = useState(0)
  const [result, setResult] = useState(null)
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  /* 已经识别到就不再重复触发（同一帧会连着命中好几次） */
  const lockedRef = useRef(false)
  /* 自检读取用：ref 而不是 state —— 摄像头每 260ms 就要摸一次，走 state 会疯狂重渲染 */
  const debugRef = useRef({ cam: 'idle', camMsg: '', frames: 0, lastText: null, resultType: null, error: '' })

  useEffect(() => {
    window.__scan = debugRef.current
    return () => {
      delete window.__scan
    }
  }, [])

  /** 通用：拿到一段文本后决定怎么落地 */
  const handleRecognized = useCallback(async (text) => {
    const payload = parseQrPayload(text)
    debugRef.current.lastText = String(text)
    debugRef.current.resultType = payload.type
    debugRef.current.error = ''

    if (payload.type === 'user') {
      try {
        const d = await api.findUserByUsername(payload.username)
        setResult({ payload, profile: d })
      } catch (e) {
        debugRef.current.error = e.message || '查询失败'
        setResult({ payload, lookupError: e.message || '查询失败' })
      }
      return
    }
    setResult({ payload })
  }, [])

  /* ---------- 摄像头 ---------- */
  useEffect(() => {
    if (result || mode !== 'camera') return
    let stream = null
    let timer = null
    let cancelled = false

    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
      if (stream) {
        stream.getTracks().forEach((t) => t.stop())
        stream = null
      }
      const v = videoRef.current
      if (v) v.srcObject = null
    }

    const tick = () => {
      const v = videoRef.current
      const canvas = grabRef.current
      if (!v || !canvas || lockedRef.current) return
      if (v.readyState < 2 || !v.videoWidth) return
      /* 缩到最长边 480 再解：解码耗时几乎只跟像素数走，1280×720 全尺寸解不动（每 260ms 一次会卡） */
      const k = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight))
      const w = Math.max(1, Math.round(v.videoWidth * k))
      const h = Math.max(1, Math.round(v.videoHeight * k))
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(v, 0, 0, w, h)
      debugRef.current.frames += 1
      let text = null
      try {
        text = decodeQrImageData(ctx.getImageData(0, 0, w, h))
      } catch {
        /* 某一帧解出异常不该把整个扫描循环打断 */
        text = null
      }
      if (text) {
        lockedRef.current = true
        stop()
        handleRecognized(text)
      }
    }

    ;(async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        const msg = '当前环境不支持摄像头（需要用 https 或 localhost 打开）'
        setCam({ status: 'error', msg })
        debugRef.current.cam = 'error'
        debugRef.current.camMsg = msg
        return
      }
      setCam({ status: 'starting', msg: '' })
      debugRef.current.cam = 'starting'
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
      } catch (e) {
        if (cancelled) return
        const msg = cameraReason(e)
        setCam({ status: 'error', msg })
        debugRef.current.cam = 'error'
        debugRef.current.camMsg = msg
        return
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const v = videoRef.current
      if (!v) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      v.srcObject = stream
      try {
        await v.play()
      } catch {
        /* 自动播放被挡不致命：readyState 够了 tick 照样出帧 */
      }
      if (cancelled) return
      setCam({ status: 'live', msg: '' })
      debugRef.current.cam = 'live'
      timer = setInterval(tick, 260)
    })()

    return () => {
      cancelled = true
      stop()
    }
  }, [result, mode, camNonce, handleRecognized])

  /* ---------- 相册选图 ---------- */
  const onPickFile = useCallback(
    async (e) => {
      const file = e.target.files?.[0]
      e.target.value = '' /* 清掉，否则同一张图选第二次不触发 change */
      if (!file) return
      if (!/^image\//.test(file.type)) {
        showToast('请选择图片文件')
        return
      }
      setBusy(true)
      const url = URL.createObjectURL(file)
      try {
        const img = await loadImageFromUrl(url)
        if (!img) {
          showToast('这张图读不出来')
          return
        }
        /* 解码是同步的，先解再 revoke —— 提前 revoke 会让 canvas 抽到空白 */
        const text = decodeQrFromSource(img)
        if (!text) {
          debugRef.current.error = 'no-qr-in-image'
          showToast('这张图里没有识别到二维码')
          return
        }
        lockedRef.current = true
        await handleRecognized(text)
      } finally {
        URL.revokeObjectURL(url)
        setBusy(false)
      }
    },
    [handleRecognized, showToast]
  )

  /* ---------- 手动输入 ---------- */
  const onLookup = useCallback(async () => {
    const username = normalizeUsernameInput(manual)
    if (!username) {
      showToast('请先填写用户 ID')
      return
    }
    setBusy(true)
    try {
      const d = await api.findUserByUsername(username)
      setResult({ payload: { type: 'user', raw: username, username }, profile: d })
    } catch (e) {
      setResult({ payload: { type: 'user', raw: username, username }, lookupError: e.message || '查询失败' })
    } finally {
      setBusy(false)
    }
  }, [manual, showToast])

  /* ---------- 加好友（写 follows 表） ---------- */
  const onFollow = useCallback(async () => {
    const id = result?.profile?.userId
    if (!id) return
    setBusy(true)
    try {
      await api.followUser(id)
      setResult((r) => (r ? { ...r, profile: { ...r.profile, following: true } } : r))
      showToast('已加为好友')
    } catch (e) {
      showToast(e.message || '操作失败')
    } finally {
      setBusy(false)
    }
  }, [result, showToast])

  const onSay = useCallback(async () => {
    const id = result?.profile?.userId
    if (!id) return
    setBusy(true)
    try {
      const convId = await createPrivateChat(id)
      onBack() /* 先关掉覆盖层，再开私聊，否则两个整屏层会叠在一起 */
      nav.openChat({ id: convId })
    } catch (e) {
      showToast(e.message || '打开私聊失败')
      setBusy(false)
    }
  }, [createPrivateChat, nav, onBack, result, showToast])

  const onCopy = useCallback(async () => {
    const raw = result?.payload?.raw
    if (!raw) return
    try {
      await navigator.clipboard.writeText(raw)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* 复制不了就别说复制好了 */
      showToast('浏览器不允许自动复制，请长按选中下面的内容')
    }
  }, [result, showToast])

  const rescan = useCallback(() => {
    lockedRef.current = false
    debugRef.current.resultType = null
    debugRef.current.error = ''
    setResult(null)
    setCopied(false)
    setManual('')
  }, [])

  const p = result?.payload
  const prof = result?.profile?.user
  const camLive = cam.status === 'live'

  return (
    <div className="scan">
      <header className="scan-head">
        <button type="button" className="sub-back scan-back" onClick={onBack} aria-label="返回">
          <IconBack size={21} />
        </button>
        <h2>扫一扫</h2>
        <span className="scan-head-spacer" />
      </header>

      <div className="scan-scroll no-scrollbar">
        {!result && (
          <>
            <div className="scan-frame" data-cam={cam.status}>
              <video
                ref={videoRef}
                className="scan-video"
                playsInline
                muted
                autoPlay
                data-live={camLive ? '1' : '0'}
              />
              <div className="scan-mask" />
              <span className="scan-corner scan-corner--tl" />
              <span className="scan-corner scan-corner--tr" />
              <span className="scan-corner scan-corner--bl" />
              <span className="scan-corner scan-corner--br" />
              {camLive && <span className="scan-line" />}

              {cam.status !== 'live' && (
                <div className="scan-over" data-state={cam.status}>
                  {cam.status === 'error' ? (
                    <>
                      <IconInfo size={26} />
                      <p data-testid="cam-error">{cam.msg}</p>
                      <button
                        type="button"
                        className="scan-retry"
                        onClick={() => {
                          lockedRef.current = false
                          setCam({ status: 'starting', msg: '' })
                          setCamNonce((n) => n + 1)
                        }}
                      >
                        重试
                      </button>
                    </>
                  ) : (
                    <p>{cam.status === 'starting' ? '正在打开摄像头…' : '准备中…'}</p>
                  )}
                </div>
              )}
            </div>

            <p className="scan-tip">
              {camLive ? '把二维码放进取景框，识别到会自动停' : '没有摄像头也能用下面的方式'}
            </p>

            {mode === 'manual' ? (
              <div className="scan-manual">
                <div className="scan-field">
                  <input
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && onLookup()}
                    placeholder="输入对方的 ID，例如 chenmo"
                    autoComplete="off"
                    aria-label="用户 ID"
                  />
                </div>
                <button type="button" className="scan-btn scan-btn--primary" onClick={onLookup} disabled={busy}>
                  {busy ? '查找中…' : '查找'}
                </button>
                <button type="button" className="scan-btn" onClick={() => setMode('camera')}>
                  用摄像头
                </button>
              </div>
            ) : (
              <div className="scan-acts">
                <button type="button" className="scan-act" onClick={() => fileRef.current?.click()} disabled={busy}>
                  <IconImage size={21} />
                  {busy ? '识别中…' : '从相册选图'}
                </button>
                <button type="button" className="scan-act" onClick={() => setMode('manual')}>
                  <IconEdit size={21} />
                  手动输 ID
                </button>
              </div>
            )}

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={onPickFile}
              className="scan-file"
              data-testid="scan-file"
            />
          </>
        )}

        {result && (
          <div className="scan-result" data-type={p?.type || 'unknown'}>
            {/* ---- 扫到人：资料卡 + 真实动作 ---- */}
            {p?.type === 'user' && prof && (
              <>
                <div className="scan-person">
                  <Avatar src={avatarOf(prof)} name={prof.nickname} size={64} radius={21} online={result.profile.online} />
                  <div className="scan-person-txt">
                    <b>{prof.nickname}</b>
                    <em>@{prof.username}</em>
                    {result.profile.isSelf && <span className="scan-chip">这是你自己的码</span>}
                    {!result.profile.isSelf && result.profile.following && <span className="scan-chip">已加为好友</span>}
                  </div>
                </div>
                <p className="scan-bio">{prof.bio || '这个人很神秘，什么都没写'}</p>

                {!!prof.tags?.length && (
                  <div className="scan-tags">
                    {prof.tags.map((t) => (
                      <span key={t}>{t}</span>
                    ))}
                  </div>
                )}

                {!result.profile.isSelf ? (
                  <div className="scan-person-acts">
                    {result.profile.following ? (
                      <button type="button" className="scan-btn scan-btn--done" disabled>
                        <IconCheck size={18} /> 已加为好友
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="scan-btn scan-btn--primary"
                        onClick={onFollow}
                        disabled={busy}
                        data-testid="scan-follow"
                      >
                        {busy ? '处理中…' : '加好友'}
                      </button>
                    )}
                    <button type="button" className="scan-btn" onClick={onSay} disabled={busy}>
                      <IconChat size={18} /> 发消息
                    </button>
                  </div>
                ) : (
                  <div className="scan-person-acts">
                    <button type="button" className="scan-btn" onClick={onCopy}>
                      {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                      {copied ? '已复制' : '复制我的 ID'}
                    </button>
                  </div>
                )}

                <p className="scan-note">
                  加上好友后，动态页会开始出现 Ta 的内容；双方互加之后，彼此的「仅好友」动态才可见。
                </p>
              </>
            )}

            {/* ---- 扫到人但查不到 ---- */}
            {p?.type === 'user' && !prof && (
              <div className="scan-plain">
                <IconInfo size={26} />
                <b>没能查到这个人</b>
                <p>
                  {result.lookupError || '查询失败'}
                  <br />
                  ID：{p.username}
                </p>
              </div>
            )}

            {/* ---- 群 / 动态：认得出，但明确说没接入 ---- */}
            {(p?.type === 'group' || p?.type === 'moment') && (
              <div className="scan-plain">
                <IconInfo size={26} />
                <b>{p.type === 'group' ? '这是群二维码' : '这是动态二维码'}</b>
                <p data-testid="scan-unsupported">
                  {p.type === 'group' ? `群 #${p.groupId}` : `动态 #${p.momentId}`}
                  ，Chatly 目前还不支持直接加入，群二维码的生成与识别会在后续版本加入。
                </p>
              </div>
            )}

            {/* ---- 普通文本 / 网址 ---- */}
            {(p?.type === 'text' || p?.type === 'url') && (
              <div className="scan-plain">
                <IconInfo size={26} />
                <b>{p.type === 'url' ? '这是一个网址' : '扫到一段文本'}</b>
                <code className="scan-code" data-testid="scan-code">
                  {p.raw}
                </code>
                {p.type === 'url' && (
                  <p className="scan-note">出于安全考虑不会自动打开，需要的话复制后自行访问。</p>
                )}
                {looksLikeUserId(p.text) && (
                  <button
                    type="button"
                    className="scan-btn"
                    onClick={async () => {
                      await handleRecognized(p.text)
                    }}
                  >
                    <IconScan size={18} /> 按用户 ID「{p.text}」查一下
                  </button>
                )}
              </div>
            )}

            {p?.type === 'unknown' && (
              <div className="scan-plain">
                <IconInfo size={26} />
                <b>认不出这段内容</b>
                <code className="scan-code">{p.raw}</code>
              </div>
            )}

            <div className="scan-result-acts">
              {(p?.type === 'text' || p?.type === 'url' || p?.type === 'unknown' ||
                (p?.type === 'group') ||
                (p?.type === 'moment')) && (
                <button type="button" className="scan-btn" onClick={onCopy}>
                  {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                  {copied ? '已复制' : '复制内容'}
                </button>
              )}
              <button type="button" className="scan-btn scan-btn--primary" onClick={rescan} data-testid="scan-again">
                <IconScan size={18} /> 再扫一次
              </button>
            </div>
          </div>
        )}
      </div>

      <canvas ref={grabRef} className="scan-grab" />
    </div>
  )
}
