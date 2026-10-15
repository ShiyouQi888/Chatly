/**
 * 「选位置」整屏面板 —— **聊天发位置 / 动态发布定位共用同一个**。
 *
 * ## 为什么要共用一个面板
 * 两处要的东西一模一样：「我在哪（或附近哪个地方）→ 拿到地点名 + 坐标」。
 * 各写一份的话，「无 key 时怎么降级」「坐标缺失怎么显示」这两件最容易被写得不一致的事
 * 会在两个地方各错一遍 —— 而且用户会觉得是同一个功能在不同页面表现不一样。
 *
 * ## 四条不能违反的规矩
 *
 * 1. **拿不到的东西不编。** 没配 key 就没有地址，没有定位就没有坐标。
 *    这里一律如实显示「拿不到」，然后**给出可用的替代路径**（手动输入地点名）。
 *    绝对不能拿一个看起来合理的默认地址填上 —— 用户会真的照它走。
 *
 * 2. **坐标缺一个就当没有。** lat / lng 只有成对才有意义，
 *    只有一个的画到地图上是错的，宁可退化成「纯地点名」。
 *
 * 3. **我的坐标不出本机。** `getMyLocation()` 的结果只写进 `localStorage`（缓存，下次打开先顶上），
 *    **不进任何请求体**。真正离开这台设备的，只有用户**明确点选**的那一个地点。
 *
 * 4. **每一步失败都要说清是哪一步。** 「浏览器不给定位」和「服务端没配 key」是两件事，
 *    报同一句话用户只能反复点（同 `ScanPage` 的 `cameraReason`）。
 */
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client.js'
import MapView from './MapView.jsx'
import { IconCheck, IconClose, IconLocate, IconSearch, IconUndo } from './Icon.jsx'
import { canLocate, formatDistance, geoReason, getMyLocation, readMyGeo, writeMyGeo } from '../lib/geo.js'
import './location-picker.css'

/** 附近地点半径（米）。1000 米 ≈ 步行十来分钟，正好是「我周围」这个粒度。 */
const POI_RADIUS = 1000

export default function LocationPicker({ open, onClose, onPick, title = '发送位置', submitLabel = '发送' }) {
  const [phase, setPhase] = useState('idle') // idle | locating | ready
  const [me, setMe] = useState(null) // 我方坐标（GCJ-02），只在本机用
  const [res, setRes] = useState(null) // /geo/locate 的结果
  const [notice, setNotice] = useState('')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(null)
  const [nonce, setNonce] = useState(0)

  /* 打开时定位一次；关掉就把状态清干净（下次打开不该看见上次的选中项）。
     `alive` 是必须的：定位要几秒，这期间用户可能已经关掉了面板 ——
     迟到的响应要是还往里 setState，会在他下次打开时冒出一个不是他选的地点。 */
  useEffect(() => {
    if (!open) {
      setSel(null)
      setQ('')
      setNotice('')
      setRes(null)
      setMe(null)
      setPhase('idle')
      return
    }

    let alive = true
    setSel(null)
    setQ('')
    setNotice('')
    setRes(null)

    /* 缓存先顶上：地图能立刻画出来，不用等定位 —— 否则面板会先空一下再出图。 */
    const cached = readMyGeo()
    if (cached) setMe({ lat: cached.lat, lng: cached.lng })

    if (!canLocate()) {
      setPhase('ready')
      setNotice('这个环境用不了定位（需要 https / localhost，且浏览器允许定位）。可以手动输入地点名。')
      return
    }

    setPhase('locating')
    ;(async () => {
      try {
        const pos = await getMyLocation()
        if (!alive) return
        setMe({ lat: pos.lat, lng: pos.lng })
        writeMyGeo(pos)

        const r = await api.locate(pos.lat, pos.lng, { pois: true, radius: POI_RADIUS })
        if (!alive) return
        setRes(r)
        setPhase('ready')
        if (!r?.configured) {
          setNotice('服务端还没配置位置服务（TENCENT_MAP_KEY），拉不到地址和附近地点 —— 可以手动输入地点名。')
        }
      } catch (e) {
        if (!alive) return
        /* getMyLocation 抛的是 GeolocationPositionError，locate 抛的是接口错误 */
        const isGeoErr = typeof e?.code === 'number' || e?.name === 'NotSupportedError'
        setNotice(isGeoErr ? geoReason(e) : `位置服务出错：${e.message}`)
        setPhase('ready')
      }
    })()

    return () => {
      alive = false
    }
  }, [open, nonce])

  /** 候选地点：第一条是「我当前所在」，后面是附近 POI（已由服务端按距离排好）。 */
  const places = useMemo(() => {
    const list = []
    if (me) {
      const a = res?.address || {}
      /* 逆地址解析给的两条：recommend 是「含周边参照物」的说法（更接近人怎么描述自己在哪），
         formatted 是标准行政区划串。都拿不到时用行政区名兜底 —— 仍然是一个**真名字**，
         不是编出来的，最后才退到「当前位置」这个中性说法。 */
      const name = a.recommend || a.formatted || res?.city?.region || '当前位置'
      list.push({
        key: 'cur',
        name,
        address: a.formatted && a.formatted !== name ? a.formatted : '',
        lat: me.lat,
        lng: me.lng,
        distance: 0,
        current: true,
      })
    }
    for (const [i, p] of (res?.pois || []).entries()) {
      if (!p.name) continue
      list.push({
        key: `p${i}-${p.id || p.name}`,
        name: p.name,
        address: p.address || '',
        lat: p.lat,
        lng: p.lng,
        distance: p.distance,
      })
    }
    return list
  }, [me, res])

  if (!open) return null

  const keyword = q.trim()

  const confirm = () => {
    if (!sel) return
    onPick?.({ name: sel.name, address: sel.address || '', lat: sel.lat ?? null, lng: sel.lng ?? null })
    onClose?.()
  }

  /* 地图上的点：**选中了什么就画什么**。
     ⚠️ 不能用 `sel?.lat ?? me?.lat` —— 手输的地点名 `lat` 是 null，
     那个 `??` 会退回我的坐标，于是「一个没有坐标的地点」在地图上显示成我站的地方，
     看起来像是给它定位成功了。选中但没有坐标时，就该什么都不画。 */
  const mapTarget = sel ? { lat: sel.lat, lng: sel.lng } : me
  const mapLat = mapTarget?.lat
  const mapLng = mapTarget?.lng

  return (
    <div className="lp-root cover-tabbar" data-phase={phase}>
      <header className="lp-bar">
        <button type="button" className="lp-cancel" onClick={onClose} aria-label="取消">
          <IconClose size={20} />
        </button>
        <h2>{title}</h2>
        <button type="button" className="lp-send" disabled={!sel} onClick={confirm} data-testid="lp-send">
          {submitLabel}
        </button>
      </header>

      <div className="lp-body no-scrollbar">
        <div className="lp-map" data-testid="lp-map">
          <MapView lat={mapLat} lng={mapLng} height={188} title={sel?.name || ''} />
          {phase === 'locating' && <span className="lp-locating">正在定位…</span>}
        </div>

        <div className="lp-search">
          <IconSearch size={16} />
          <input
            value={q}
            maxLength={60}
            placeholder="搜不到？直接输入地点名"
            onChange={(e) => setQ(e.target.value)}
            data-testid="lp-search"
          />
          {(q || notice) && phase === 'ready' && (
            <button
              type="button"
              className="lp-redo"
              onClick={() => {
                setQ('')
                setNonce((n) => n + 1)
              }}
              aria-label="重新定位"
            >
              <IconUndo size={15} />
            </button>
          )}
        </div>

        {notice && <p className="lp-notice">{notice}</p>}

        {keyword ? (
          /* 手动输入：**没有坐标**，对方看到的就是一个地点名。
             这里必须写出来，否则用户会以为「他自己也能看到地图上的位置」。 */
          <ul className="lp-list">
            <li>
              <button
                type="button"
                className={`lp-row ${sel?.key === 'manual' ? 'is-sel' : ''}`}
                onClick={() =>
                  setSel({ key: 'manual', name: keyword, address: '', lat: null, lng: null })
                }
              >
                <span className="lp-ic is-manual">
                  <IconLocate size={17} />
                </span>
                <span className="lp-main">
                  <b>{keyword}</b>
                  <em>手动输入 · 只发地点名，不带坐标</em>
                </span>
                {sel?.key === 'manual' && (
                  <span className="lp-tick">
                    <IconCheck size={13} sw={3} />
                  </span>
                )}
              </button>
            </li>
          </ul>
        ) : (
          <ul className="lp-list">
            {places.map((p) => (
              <li key={p.key}>
                <button
                  type="button"
                  className={`lp-row ${sel?.key === p.key ? 'is-sel' : ''}`}
                  onClick={() => setSel(p)}
                  data-testid={`lp-row-${p.key === 'cur' ? 'current' : 'poi'}`}
                >
                  <span className={`lp-ic ${p.current ? 'is-cur' : ''}`}>
                    <IconLocate size={17} />
                  </span>
                  <span className="lp-main">
                    <b>{p.name}</b>
                    {p.address && <em>{p.address}</em>}
                  </span>
                  <span className="lp-tail">
                    {p.current ? (
                      <span className="lp-cur-tag">当前位置</span>
                    ) : (
                      Number.isFinite(p.distance) && <span className="lp-dist">{formatDistance(p.distance / 1000)}</span>
                    )}
                    {sel?.key === p.key && (
                      <span className="lp-tick">
                        <IconCheck size={13} sw={3} />
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}

            {!places.length && phase === 'ready' && (
              <li className="lp-empty">
                {me ? '没有取到附近地点，可以在上面直接输入地点名' : '还没拿到定位，可以重试或在上面直接输入地点名'}
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  )
}
