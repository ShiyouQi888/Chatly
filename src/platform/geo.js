/**
 * 地理位置 —— 定位与坐标缓存。
 *
 * ## 跨端差异
 *
 * Web 端：`navigator.geolocation.getCurrentPosition()`，只在安全上下文可用。
 * 原生壳：WebView 里也有 geolocation，但**精度与耗电都不可控**，
 * 且 Android 需要 ACCESS_COARSE/FINE_LOCATION 权限。
 * 原生端优先用 Capacitor 的 Geolocation 插件（走系统定位服务，更准更省电）。
 *
 * 坐标系问题（**项目既有铁律，不要改**）：
 * 浏览器 `navigator.geolocation` 给的是 **WGS-84**，
 * 腾讯地图（GCJ-02）要用 **GCJ-02**，两者差 50–500 米。
 * 转换在 `lib/geo.js` 的 `wgs84ToGcj02` 里，适配层不碰坐标，只管取数。
 */

import { isNative, capPlugin } from './env.js'

/**
 * 定位能力是否可用。
 *
 * @returns {boolean}
 */
export function isSupported() {
  if (isNative) return !!capPlugin('Geolocation')
  if (typeof navigator === 'undefined') return false
  return !!navigator.geolocation
}

/**
 * 取一次当前定位。
 *
 * 错误文案统一在这里翻译，原生端与 Web 端的差异（系统定位关闭、
 * 权限被拒）都收敛成同一套话术。
 *
 * @param {{ enableHighAccuracy?: boolean, timeout?: number }} [options]
 * @returns {Promise<{ latitude: number, longitude: number, accuracy: number }>}
 */
export function getCurrentPosition(options = {}) {
  const { enableHighAccuracy = true, timeout = 10_000 } = options

  if (isNative) {
    const geo = capPlugin('Geolocation')
    if (geo) {
      return new Promise((resolve, reject) => {
        geo.getCurrentPosition(
          (pos) => {
            resolve({
              latitude: Number(pos?.coords?.latitude),
              longitude: Number(pos?.coords?.longitude),
              accuracy: Number(pos?.coords?.accuracy ?? 0),
            })
          },
          (error) => reject(geoError(error)),
          { enableHighAccuracy, timeout }
        )
      })
    }
  }

  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(Object.assign(new Error('当前环境不支持定位'), { name: 'NotSupportedError' }))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          latitude: Number(pos.coords.latitude),
          longitude: Number(pos.coords.longitude),
          accuracy: Number(pos.coords.accuracy ?? 0),
        })
      },
      (error) => reject(geoError(error)),
      { enableHighAccuracy, timeout }
    )
  })
}

/**
 * 定位失败的可读文案。
 *
 * @param {any} error
 * @returns {Error}
 */
function geoError(error) {
  const code = Number(error?.code)
  let message = '定位失败，请稍后重试。'
  if (code === 1) message = '没有获得定位权限，请在系统设置里允许 Chatly 使用位置信息。'
  else if (code === 2) message = '暂时拿不到位置信息，请检查定位服务是否开启。'
  else if (code === 3) message = '定位超时，请到开阔一点的地方再试。'
  else if (error?.message) message = String(error.message)
  return Object.assign(new Error(message), { name: error?.name || 'GeolocationError', code })
}
