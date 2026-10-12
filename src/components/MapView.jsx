import { useEffect, useRef, useState } from 'react'
import { IconLocate } from './Icon'
import './map-view.css'

/**
 * 腾讯地图（GL JS）渲染组件。
 *
 * ## 这里有三条不能违反的规矩
 *
 * 1. **按需加载，绝不预加载。** 项目的硬约束是「零运行时依赖 + 禁止外链 + 离线可跑」，
 *    地图是**唯一**必须破例的地方 —— 所以破例的范围要压到最小：
 *    只有真的要画地图时才去请求 `map.qq.com`，而且**没配 key 时一次请求都不发**。
 *    预加载看起来更「顺滑」，代价是每次打开 App 都拖一个外链进来，离线时还平白多几个报错。
 *
 * 2. **没 key 就给占位，且必须写明「这不是地图」。** 画一个长得像地图的东西是最糟的选择：
 *    用户会以为定位错了。占位图只给**我们自己画的**坐标网格 + 真实经纬度数字，
 *    并直说「未配置地图密钥」。
 *
 * 3. **容器必须有固定高度。** 地图 SDK 按容器尺寸初始化，高度是 0 时它渲染成空白
 *    （在 flex 布局里尤其容易踩到）。所以高度走 props → 行内样式，不靠 CSS 里「撑开」。
 *
 * ## key 从哪来
 * `VITE_TMAP_KEY`（`.env.local`）。为什么不用「WorkBuddy 的 key 代理」：
 * 那个代理只在 WorkBuddy 预览里有效，`npm run dev` 独立跑或部署出去就不存在了，
 * 属于「在一种环境能跑、换个环境 404」的假成功。
 */

let sdkPromise = null

function loadTMap() {
  if (typeof window !== 'undefined' && window.TMap) return Promise.resolve(window.TMap)
  if (sdkPromise) return sdkPromise

  sdkPromise = new Promise((resolve, reject) => {
    const key = import.meta.env.VITE_TMAP_KEY
    if (!key) {
      reject(new Error('未配置 VITE_TMAP_KEY'))
      return
    }
    const s = document.createElement('script')
    s.src = `https://map.qq.com/api/gljs?v=1.exp&key=${encodeURIComponent(key)}`
    s.async = true
    s.onload = () => (window.TMap ? resolve(window.TMap) : reject(new Error('SDK 已加载但没有挂上 TMap')))
    s.onerror = () => reject(new Error('地图 SDK 下载失败（离线或被网络拦截）'))
    document.head.appendChild(s)
  })

  /* 失败要把单例清掉，否则「重试」永远拿到同一个 rejected promise —— 点了没反应。
     和扫一扫里 `setResult(null)` 触发不了重试是同一类坑。 */
  sdkPromise.catch(() => {
    sdkPromise = null
  })
  return sdkPromise
}

/** 自画的定位图钉（内联 data URI）。**不引用腾讯 demo 里的图片** —— 那些路径是官方演示专用的。 */
const PIN_SVG =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 1C7.4 1 2 6.4 2 13c0 8.6 12 22 12 22s12-13.4 12-22c0-6.6-5.4-12-12-12z"
            fill="#7b5cf6" stroke="#fff" stroke-width="2"/>
      <circle cx="14" cy="13" r="4.4" fill="#fff"/>
    </svg>`
  )

const hasKey = () => !!import.meta.env.VITE_TMAP_KEY

/**
 * 无 key 时占位的坐标网格。**只画格子，不画街道轮廓** ——
 * 自己描一份「像地图」的轮廓既是编数据，也会碰到版图合规问题。
 * 抽出来是因为整块占位（选位置面板）和缩略占位（消息气泡）都要用同一张网格。
 */
function MapGrid() {
  return (
    <svg className="mv-ph-grid" viewBox="0 0 240 140" preserveAspectRatio="none" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <line key={`v${i}`} x1={i * 34} y1="0" x2={i * 34} y2="140" />
      ))}
      {[0, 1, 2, 3, 4].map((i) => (
        <line key={`h${i}`} x1="0" y1={i * 35} x2="240" y2={i * 35} />
      ))}
      <circle cx="120" cy="66" r="5" className="mv-ph-dot" />
    </svg>
  )
}

/**
 * @param {number} lat GCJ-02 纬度
 * @param {number} lng GCJ-02 经度
 * @param {number} height 容器高度（px）—— 必填，见上面第 3 条
 * @param {boolean} interactive 缩略图传 false：盖一层透明遮罩挡住手势，避免滚动页面时地图跟着动
 * @param {boolean} compact 小尺寸容器（消息气泡那种 130px 左右）用：无 key 时不再铺一大块说明文字，
 *        只留网格 + 一行「坐标占位 · 非地图」。气泡自己已经写了地点名和地址，
 *        再在小格子里塞三行说明会把地图挤成一个条。
 */
export default function MapView({
  lat,
  lng,
  title = '',
  height = 180,
  interactive = true,
  compact = false,
  zoom = 16,
}) {
  const boxRef = useRef(null)
  const mapRef = useRef(null)
  const [state, setState] = useState(hasKey() ? 'loading' : 'nokey')
  const [err, setErr] = useState('')
  const [nonce, setNonce] = useState(0)

  const ok = Number.isFinite(lat) && Number.isFinite(lng)

  useEffect(() => {
    if (!ok || state === 'nokey') return
    let cancelled = false
    let map = null

    setState('loading')
    setErr('')

    loadTMap()
      .then((TMap) => {
        if (cancelled || !boxRef.current) return
        map = mapRef.current
        if (map) {
          map.destroy?.()
          mapRef.current = null
        }
        map = new TMap.Map(boxRef.current, {
          center: new TMap.LatLng(lat, lng),
          zoom,
          /* ⚠️ 不传 mapStyleId —— 自定义样式要在控制台单独开通，默认 key 用不了，
             传了底图会变成一片空白灰，而且看起来像「地图坏了」。 */
        })
        mapRef.current = map
        new TMap.MultiMarker({
          map,
          styles: { default: new TMap.MarkerStyle({ width: 28, height: 36, anchor: { x: 14, y: 36 }, src: PIN_SVG }) },
          geometries: [{ id: 'pin', styleId: 'default', position: new TMap.LatLng(lat, lng) }],
        })
        if (!cancelled) setState('ready')
      })
      .catch((e) => {
        if (cancelled) return
        setErr(e?.message || '地图加载失败')
        setState('error')
      })

    return () => {
      cancelled = true
      try {
        mapRef.current?.destroy?.()
      } catch {
        /* destroy 在 SDK 没初始化完时可能抛，卸载路径上不要因此炸掉整棵 React 树 */
      }
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng, zoom, ok, nonce])

  /* ---- 没配 key：自画的占位，说清「这不是地图」 ---- */
  if (!ok) {
    return (
      <div className="mv-empty" style={{ height }} data-testid="map-invalid">
        <IconLocate size={20} />
        <p>这条记录没有坐标，显示不了位置</p>
      </div>
    )
  }

  if (state === 'nokey') {
    /* 缩略模式：只画网格 + 一行小字。**照样要表态「这不是地图」** ——
       哪怕字很小，也不能让人误以为这是真实底图。 */
    if (compact) {
      return (
        <div
          className="mv-ph is-compact"
          style={{ height }}
          data-testid="map-nokey"
          data-lat={lat}
          data-lng={lng}
        >
          <MapGrid />
          <span className="mv-ph-mini">坐标占位 · 非地图</span>
        </div>
      )
    }
    return (
      <div className="mv-ph" style={{ height }} data-testid="map-nokey" data-lat={lat} data-lng={lng}>
        <MapGrid />
        <div className="mv-ph-body">
          <b>{title || '位置'}</b>
          <span className="mv-ph-coord">
            {lat.toFixed(4)}, {lng.toFixed(4)}
          </span>
          <em>未配置地图密钥（VITE_TMAP_KEY），这里只是坐标占位，不是地图</em>
        </div>
      </div>
    )
  }

  /* ---- 加载失败：如实报错 + 可以重试 ---- */
  if (state === 'error') {
    return (
      <div className="mv-empty" style={{ height }} data-testid="map-error">
        <IconLocate size={20} />
        <p>{err}</p>
        <button type="button" className="mv-retry" onClick={() => setNonce((n) => n + 1)}>
          重新加载
        </button>
      </div>
    )
  }

  return (
    <div className="mv-wrap" style={{ height }} data-testid="map-view" data-map-state={state}>
      <div ref={boxRef} className="mv-canvas" />
      {state === 'loading' && <div className="mv-mask">地图加载中…</div>}
      {/* 缩略图模式：手势遮罩。不去赌 SDK 的 draggable/scrollable 选项名，
          盖一层自己的遮罩更稳，也顺便避开「在列表里滑动却被地图吃掉滚动」。 */}
      {!interactive && state === 'ready' && <div className="mv-shield" aria-hidden="true" />}
    </div>
  )
}
