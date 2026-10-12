/**
 * 位置消息的**显示端** —— 列表里的气泡 + 点开后的全屏。
 *
 * 三条规矩：
 *
 * 1. **气泡外壳不能用 `<button>`。** MapView 在「加载失败」状态下会渲染一个「重新加载」按钮，
 *    按钮套按钮是非法嵌套（读屏会错乱，React 也会告警）。所以外壳是带
 *    `role="button"` + 键盘处理的 `<div>`。
 *
 * 2. **没有坐标就老老实实说没有。** 位置消息的坐标是可以缺的（用户手输地点名）。
 *    这时不画地图、也不偷偷拿 0 兜底（0,0 是几内亚湾），只显示地点名 + 一句「只发了地点名」。
 *
 * 3. **地图只在这里按需加载。** 气泡用 `interactive={false}`（盖手势遮罩），
 *    否则在列表里上下滑动会被地图吃掉滚动。
 */
import { useEffect } from 'react'
import MapView from './MapView.jsx'
import { IconClose, IconLocate } from './Icon.jsx'
import './location-view.css'

/** 坐标只有成对才有意义 —— 缺一个就当没有，别拿 0 兜底 */
function coordsOf(geo) {
  const lat = Number(geo?.lat)
  const lng = Number(geo?.lng)
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
}

/** 让一个 div 具备按钮的键盘可达性（外壳不能用真 button，见文件头第 1 条） */
function tapProps(onActivate, label) {
  return {
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    onClick: onActivate,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onActivate()
      }
    },
  }
}

export function LocationBubble({ m, onOpen }) {
  const g = m?.geo || {}
  const c = coordsOf(g)

  return (
    <div
      className={`loc-card ${m?.mine ? 'is-mine' : ''}`}
      data-testid="loc-bubble"
      data-has-coord={c ? '1' : '0'}
      {...tapProps(
        () => onOpen?.(m),
        `位置：${g.name || '未知地点'}${g.address ? `，${g.address}` : ''}，点开看地图`
      )}
    >
      <div className="loc-map">
        {c ? (
          <MapView lat={c.lat} lng={c.lng} height={118} interactive={false} compact title={g.name} />
        ) : (
          /* 没有坐标：不画地图。画一个「像地图」的东西比不画更糟 ——
             用户会以为对方分享了一个精确位置。 */
          <div className="loc-nomap">
            <IconLocate size={19} />
            <em>只发了地点名，没有坐标</em>
          </div>
        )}
      </div>

      <div className="loc-info">
        <span className="loc-text">
          <b>{g.name || '位置'}</b>
          {g.address && <em>{g.address}</em>}
        </span>
        <span className="loc-go" aria-hidden="true">
          <IconLocate size={16} />
        </span>
      </div>
    </div>
  )
}

export function LocationViewer({ m, onClose }) {
  const g = m?.geo || {}
  const c = coordsOf(g)

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="loc-viewer cover-tabbar" data-testid="loc-viewer" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <header className="lv-bar">
        <button type="button" className="lv-btn" onClick={onClose} aria-label="关闭">
          <IconClose size={20} />
        </button>
        <h2>位置</h2>
        <span className="lv-spacer" aria-hidden="true" />
      </header>

      <div className="lv-stage">
        {/* 全屏这里给地图满高，可以拖拽缩放 —— 行内 100% 是有效的：
            .lv-stage 是 flex:1，高度是确定的（MapView 要求容器有确定高度）。 */}
        <MapView lat={c?.lat} lng={c?.lng} height="100%" interactive title={g.name} />
      </div>

      <div className="lv-foot">
        <b>{g.name || '位置'}</b>
        {g.address && <em>{g.address}</em>}
        {/* 坐标直接写出来：这是位置消息里唯一「可核对」的东西，
            免得用户怀疑我们显示的位置和对方发的不是同一个点。 */}
        <span className="lv-coord">
          {c ? `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}` : '这条位置只有地点名，没有坐标'}
        </span>
      </div>
    </div>
  )
}
