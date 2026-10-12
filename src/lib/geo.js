/**
 * 地理工具 —— 坐标换算 / 距离 / 定位。
 *
 * 三件必须记住的事：
 *
 * 1. **坐标系有两套，混了就偏。** 浏览器 `navigator.geolocation` 给的是 **WGS-84**，
 *    而腾讯地图 / 腾讯位置服务用的是 **GCJ-02**（火星坐标）。直接拿 WGS-84 的坐标去查地址，
 *    内地会偏 300~1500 米。所以：**进这个模块的原始坐标一律先 `wgs84ToGcj02`**，
 *    之后全程只谈 GCJ-02。`AppleMap` / `GoogleMap` 也各是一套，这里不掺和。
 *
 * 2. **我的坐标只留在本机。** `localStorage` 里那份是给自己用的（算「我离他多远」），
 *    绝不上传 —— 真要用也是 `roughGeo()` 粗化到 2 位小数（≈1.1 km）之后再传，
 *    而且服务端算完距离就丢，不落库。库里的 `users.city_lat/lng` 存的是
 *    **行政区划中心点**（公开地理事实），不是任何人的位置。
 *
 * 3. **拿不到定位要能说清是为什么。** 和扫一扫的 `cameraReason` 一个道理：
 *    「权限被拒」「没开定位服务」「超时」「非安全上下文」对用户是四件不同的事，
 *    统一报「定位失败」等于什么都没说。
 */

/* ---------- 坐标系 / 距离 ----------
   ⚠️ 这几个函数**不是**在这里实现的 —— 真正的实现在仓库根目录的 `shared/geo-math.mjs`，
   前后端共用一份。这边只是转出去，让前端仍然 `import { haversineKm } from '../lib/geo'`。

   为什么非要共用：距离和坐标换算是「写错了不报错、只会悄悄偏几百米」的那类代码。
   前端按一份算法排「附近」、后端按另一份算距离，两边能算出不同的顺序，
   而且**各自单独测都会过**。放一处，只有一个地方可能错。

   ⚠️⚠️ **必须写成「先 import 再 export」，不能只写 `export { … } from '…'`。**
       `export … from` 只是转发，**不会在本模块里产生绑定** ——
       `getMyLocation()` 里调用 `wgs84ToGcj02()` 会直接 `ReferenceError: wgs84ToGcj02 is not defined`。
       而且它抛在 `getCurrentPosition` 的**成功回调**里，那个位置不在 Promise 执行器栈上，
       所以既不会让 Promise reject、也不会走到外层 catch：
       表现是**定位按钮点下去永远转圈**，控制台里才有一条孤零零的异常。
       （`vite build` 也抓不到这类问题，和漏 import 图标那次一模一样。） */

import {
  outOfChina,
  wgs84ToGcj02,
  gcj02ToWgs84,
  haversineKm,
  formatDistance,
  roughGeo,
  parseGeoPair,
} from '../../shared/geo-math.mjs'

export { outOfChina, wgs84ToGcj02, gcj02ToWgs84, haversineKm, formatDistance, roughGeo, parseGeoPair }

/* ---------- 浏览器定位 ---------- */

const KEY = 'chatly:mygeo'

/** 本机缓存的我方坐标（GCJ-02）。**只读不传**，别把它塞进任何请求体。 */
export function readMyGeo() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const o = JSON.parse(raw)
    if (!Number.isFinite(o?.lat) || !Number.isFinite(o?.lng)) return null
    return o
  } catch {
    return null
  }
}

export function writeMyGeo(geo) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...geo, at: Date.now() }))
  } catch {
    /* 隐私模式下 localStorage 会抛 —— 定位本身还能用，没必要因此失败 */
  }
}

export function clearMyGeo() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 同上 */
  }
}

/**
 * 定位失败时说人话。
 * 和 `ScanPage` 的 `cameraReason` 同一套思路：`error.code` / `name` 各不相同，
 * 统一成「定位失败」的话用户完全不知道下一步该干什么（去开权限？去开 GPS？换个浏览器？）。
 */
export function geoReason(err) {
  const code = err?.code
  if (code === 1 || err?.name === 'PermissionDeniedError')
    return '定位权限被拒绝了。到浏览器地址栏左侧的站点设置里把「位置」改成允许，再试一次'
  if (code === 2 || err?.name === 'PositionUnavailableError')
    return '拿不到位置信息：可能是系统定位服务没开，或设备没有定位能力'
  if (code === 3 || err?.name === 'TimeoutError') return '定位超时了，换个地方或连上网络再试一次'
  if (err?.name === 'NotSupportedError' || typeof navigator?.geolocation === 'undefined')
    return '这个浏览器不支持定位'
  return err?.message || '定位失败'
}

/** `navigator.geolocation` 只在安全上下文（https / localhost）可用 —— 这条要提前拦，不然报错很难懂。 */
export const canLocate = () =>
  typeof navigator !== 'undefined' && !!navigator.geolocation && (window.isSecureContext ?? true)

/**
 * 取当前位置，**返回 GCJ-02**。
 * @returns {Promise<{lat:number,lng:number,accuracy:number,gcj:true}>}
 */
export function getMyLocation({ timeout = 10000, maximumAge = 60000, highAccuracy = false } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      const e = new Error('这个浏览器不支持定位')
      e.name = 'NotSupportedError'
      return reject(e)
    }
    /* ⚠️ 非 https 的局域网地址上，Chrome 会让 geolocation 直接不存在或被静默拒绝。
       先说清楚，比让用户对着一个转圈的按钮等 10 秒强。 */
    if (window.isSecureContext === false) {
      const e = new Error('当前页面不是安全上下文（需要 https 或 localhost）')
      e.name = 'NotSupportedError'
      return reject(e)
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        /* ⚠️ 回调里**必须**包 try/catch。
           这里的异常不在 Promise 执行器栈上 —— 抛出去既不会 reject 这个 Promise，
           也不会被下层的 catch 接住，表现就是「一直转圈 + 控制台一条孤零零的异常」。
           （`wgs84ToGcj02` 曾经因为 re-export 不产生本地绑定而在这里抛过。） */
        try {
          const c = pos.coords
          const g = wgs84ToGcj02(c.latitude, c.longitude)
          resolve({ lat: g.lat, lng: g.lng, accuracy: c.accuracy })
        } catch (e) {
          reject(e)
        }
      },
      (err) => reject(err),
      { enableHighAccuracy: highAccuracy, timeout, maximumAge }
    )
  })
}
