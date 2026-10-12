/**
 * 地理数学 —— **前后端共用一份**。
 *
 * 为什么单独一个文件而不是各写一份：
 *   坐标换算和距离公式是那种「写错了不会报错、只会悄悄偏半公里」的代码。
 *   前端按 A 算法排「附近」、后端按 B 算法算距离，两个人算出来的顺序能对不上，
 *   而且**各自单测都会过**。放一处，只有一个地方可能错。
 *   （和二维码那次「编解码共用 dataPositions()」是同一个教训。）
 *
 * 这个文件**必须保持纯净**：不碰 DOM、不碰 localStorage、不碰 fetch。
 * 浏览器相关的东西在 `src/lib/geo.js`，服务端只 import 这里。
 *
 * 坐标系：本文件的换算是 **WGS-84 ↔ GCJ-02**。腾讯地图 / 腾讯位置服务用 GCJ-02，
 * 浏览器 `navigator.geolocation` 给 WGS-84。混用内地会偏 265~621 m（实测十城）。
 */

const PI = Math.PI
const A = 6378245.0 /* 克拉索夫斯基椭球长半轴 */
const EE = 0.00669342162296594323 /* 第一偏心率平方 */

/** 中国（含港澳）之外不做偏移 —— 这套算法只在内地成立，出了国门硬套偏得更离谱。 */
export function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0
  return ret
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0
  return ret
}

/** WGS-84 → GCJ-02（GPS 原始坐标 → 腾讯地图能用的坐标） */
export function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return { lat, lng }
  let dLat = transformLat(lng - 105.0, lat - 35.0)
  let dLng = transformLng(lng - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI)
  return { lat: lat + dLat, lng: lng + dLng }
}

/**
 * GCJ-02 → WGS-84。
 * 没有解析解，用**迭代逼近**：直接反着减一次误差还有 1~2 米，迭代两轮基本收敛（实测 < 1 cm）。
 */
export function gcj02ToWgs84(lat, lng) {
  if (outOfChina(lat, lng)) return { lat, lng }
  let wgsLat = lat
  let wgsLng = lng
  for (let i = 0; i < 2; i++) {
    const guess = wgs84ToGcj02(wgsLat, wgsLng)
    wgsLat += lat - guess.lat
    wgsLng += lng - guess.lng
  }
  return { lat: wgsLat, lng: wgsLng }
}

/**
 * 两点间**大圆直线距离**（km）。用 haversine，不是「度数乘常数」——
 * 后者在高纬度会明显偏，而且经纬度每度的米数本来就不一样。
 */
export function haversineKm(a, b) {
  if (!a || !b) return null
  if (![a.lat, a.lng, b.lat, b.lng].every((v) => Number.isFinite(v))) return null
  const R = 6371.0088 /* 平均地球半径 */
  const toRad = (d) => (d * PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

/**
 * 距离文案。
 * ⚠️ 不要在这里写「附近」「不远」这种**无法证伪**的词 —— 那是编数据。
 * 有数字就给数字，精度到站得住的量级（我们没有亚米级数据，别写 toFixed(2)）。
 */
export function formatDistance(km) {
  if (!Number.isFinite(km)) return ''
  if (km < 1) return `${Math.round(km * 1000)} m`
  if (km < 10) return `${km.toFixed(1)} km`
  return `${Math.round(km)} km`
}

/**
 * 把坐标粗化到 `digits` 位小数。默认 2 位 ≈ 1.1 km ——
 * 这是**唯一允许离开本机**的精度（再细就能反推住址了）。
 */
export function roughGeo(geo, digits = 2) {
  if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lng)) return null
  const p = 10 ** digits
  return { lat: Math.round(geo.lat * p) / p, lng: Math.round(geo.lng * p) / p }
}

/* ================= 坐标输入的规范化 ================= */

/** 5 位小数 ≈ 1.1 米的精度 —— 位置分享到「哪栋楼」足够，再精细只是噪声 */
const GEO_DIGITS = 5

/**
 * 把一对「可能是 null / undefined / 空串 / 字符串数字 / 越界值」的坐标规范化。
 *
 * ⚠️ **这个函数存在的唯一理由是 `Number(null) === 0`。**
 *    直接写 `Number.isFinite(Number(lat))` 会把 `null` 判成合法的 0 ——
 *    而 (0, 0) 是几内亚湾，不是「没有位置」。于是「用户手输了一个地点名」
 *    会在库里变成一条带坐标的记录，界面上老老实实画出一张非洲西海岸的地图。
 *    这个 bug 不会报错、不会崩，只会安静地指错地方。
 *
 * 规矩：
 *   · 两个坐标**必须成对**。只有一个的画出来是错的（纬度 39 配经度 0 会落到欧洲），
 *     所以缺一个就整体当作「没有坐标」。
 *   · 越界一律当作「没有坐标」，让调用方去拒或者忽略。
 *   · **返回 null 而不是 0**，调用方直接落库就是 NULL。
 *
 * @returns {{lat:number,lng:number}|null}
 */
export function parseGeoPair(lat, lng) {
  const asNum = (v) => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const la = asNum(lat)
  const ln = asNum(lng)
  if (la === null || ln === null) return null
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return null
  const p = 10 ** GEO_DIGITS
  return { lat: Math.round(la * p) / p, lng: Math.round(ln * p) / p }
}
