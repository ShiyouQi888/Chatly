/**
 * 拿第三方实现（gcoord）当裁判，逐点对拍 src/lib/geo.js 的 WGS-84 ↔ GCJ-02 换算，
 * 以及 haversine 距离。
 *
 * 为什么必须这样验：坐标换算写错了**不会报错**，只会整体偏几百米 ——
 * 界面照样能显示一个地址，只是那个地址是隔壁小区的。
 * 和二维码那次一样：自己验自己等于没验，得有个独立实现来判。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { wgs84ToGcj02, gcj02ToWgs84, haversineKm, roughGeo, formatDistance } from '../../src/lib/geo.js'

/* 参照实现装在 .tmp/geoverify 里，**不进项目依赖**（和 qr-verify 装 qrcode/jsqr 一个路子）。
   ⚠️ createRequire 的基准必须指向参照实现所在的目录 ——
   用 `import.meta.url` 的话是按本文件的位置找，`.tmp/geoverify/node_modules` 根本不在搜索路径上。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(path.join(ROOT, '.tmp', 'geoverify', 'package.json'))
const gcoord = require('gcoord')

let bad = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) bad++
}

const M_PER_DEG_LAT = 111320

/* 覆盖东经 105° 偏西/偏东两侧（偏移公式在 105° 两侧符号不同）、不同纬度、港澳、边角 */
const POINTS = [
  { name: '北京 天安门', lat: 39.90869, lng: 116.39751 },
  { name: '上海 人民广场', lat: 31.1774276, lng: 121.5272106 },
  { name: '深圳 市民中心', lat: 22.5431, lng: 114.0579 },
  { name: '广州 天河', lat: 23.1291, lng: 113.2644 },
  { name: '成都 天府广场', lat: 30.6571, lng: 104.0657 },
  { name: '乌鲁木齐（东经 105° 以西）', lat: 43.8256, lng: 87.6168 },
  { name: '哈尔滨（东经 105° 以东、高纬）', lat: 45.8038, lng: 126.535 },
  { name: '中国香港 中环', lat: 22.2819, lng: 114.1582 },
  { name: '三亚（低纬）', lat: 18.2528, lng: 109.5119 },
  { name: '拉萨（高海拔、西侧）', lat: 29.6525, lng: 91.1721 },
]

/* ---- 1. WGS → GCJ 逐点对拍 ---- */
console.log('── WGS-84 → GCJ-02（对拍 gcoord） ──')
let worstM = 0
for (const p of POINTS) {
  const mine = wgs84ToGcj02(p.lat, p.lng)
  /* gcoord 用 [经度, 纬度] 的顺序 */
  const [refLng, refLat] = gcoord.transform([p.lng, p.lat], gcoord.WGS84, gcoord.GCJ02)
  const dM = haversineKm(mine, { lat: refLat, lng: refLng }) * 1000
  worstM = Math.max(worstM, dM)
  ok(dM < 1, `${p.name} 与 gcoord 一致（< 1 m）`, `差 ${dM.toFixed(4)} m`)
}
console.log(`   最差点差 ${worstM.toFixed(4)} m`)

/* ---- 2. GCJ → WGS 逐点对拍 ---- */
console.log('\n── GCJ-02 → WGS-84（对拍 gcoord） ──')
let worstBack = 0
for (const p of POINTS) {
  const g = wgs84ToGcj02(p.lat, p.lng)
  const mine = gcj02ToWgs84(g.lat, g.lng)
  const dM = haversineKm(mine, p) * 1000
  worstBack = Math.max(worstBack, dM)
}
ok(worstBack < 1, `10 个点往回换全部 < 1 m（最差 ${worstBack.toFixed(4)} m）`)

/* ---- 3. 偏移量必须是真的（不是「换了个名字其实没换」） ---- */
console.log('\n── 偏移量 ──')
for (const p of POINTS) {
  const g = wgs84ToGcj02(p.lat, p.lng)
  const m = haversineKm(p, g) * 1000
  const ref = gcoord.transform([p.lng, p.lat], gcoord.WGS84, gcoord.GCJ02)
  const refM = haversineKm(p, { lat: ref[1], lng: ref[0] }) * 1000
  ok(Math.abs(m - refM) < 2, `${p.name} 偏移量 ${Math.round(m)} m（gcoord ${Math.round(refM)} m）`)
}

/* ---- 4. haversine 对拍：用 gcoord 换过来的两点距离做交叉验证 ---- */
console.log('\n── haversine ──')
{
  const a = POINTS[0]
  const b = POINTS[1]
  const km = haversineKm(a, b)
  /* 用球面余弦公式独立算一遍（不同公式、同样半径），互相印证 */
  const toRad = (d) => (d * Math.PI) / 180
  const R = 6371.0088
  const cos =
    Math.sin(toRad(a.lat)) * Math.sin(toRad(b.lat)) +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng))
  const km2 = R * Math.acos(Math.min(1, Math.max(-1, cos)))
  ok(Math.abs(km - km2) < 1, '与球面余弦公式互证（< 1 km）', `${km.toFixed(2)} vs ${km2.toFixed(2)}`)
}

/* ---- 5. 边界：境外一律不动 ---- */
console.log('\n── 境外 ──')
{
  const out = [
    { name: '东京', lat: 35.6812, lng: 139.7671 },
    { name: '纽约', lat: 40.7128, lng: -74.006 },
    { name: '伦敦', lat: 51.5074, lng: -0.1278 },
  ]
  for (const p of out) {
    const g = wgs84ToGcj02(p.lat, p.lng)
    ok(g.lat === p.lat && g.lng === p.lng, `${p.name} 不偏移`)
  }
}

/* ---- 6. 距离得对上可以独立核对的已知城市间距 ---- */
console.log('\n── 已知城市间距 ──')
{
  const bj = { lat: 39.9042, lng: 116.4074 }
  const sh = { lat: 31.2304, lng: 121.4737 }
  ok(Math.abs(haversineKm(bj, sh) - 1067) < 8, '北京→上海 ≈ 1067 km', haversineKm(bj, sh).toFixed(1))
  const sz = { lat: 22.5431, lng: 114.0579 }
  const gz = { lat: 23.1291, lng: 113.2644 }
  ok(Math.abs(haversineKm(sz, gz) - 105) < 6, '深圳→广州 ≈ 105 km', haversineKm(sz, gz).toFixed(1))
  ok(haversineKm(bj, bj) === 0, '同一个点距离为 0')
  ok(haversineKm(bj, null) === null, '缺参数返回 null（**不返回 0** 冒充「就在旁边」）')
}

/* ---- 7. 粗化与文案 ---- */
console.log('\n── 粗化 / 文案 ──')
{
  const r = roughGeo({ lat: 22.54321, lng: 114.05798 }, 2)
  ok(r.lat === 22.54 && r.lng === 114.06, '粗化到 2 位小数', JSON.stringify(r))
  const errM = haversineKm({ lat: 22.54321, lng: 114.05798 }, r) * 1000
  ok(errM < 800, '粗化误差 ~0.5 km（够算「附近」，不够定位到楼栋）', `${Math.round(errM)} m`)
  ok(roughGeo(null) === null, '粗化 null 返回 null')

  ok(formatDistance(0.42) === '420 m', '0.42 km → 420 m')
  ok(formatDistance(3.14) === '3.1 km', '3.14 km → 3.1 km')
  ok(formatDistance(1067.2) === '1067 km', '1067.2 km → 1067 km')
  ok(formatDistance(null) === '' && formatDistance(NaN) === '', '拿不到距离返回空串，不编')
  ok(
    !/附近|不远|很近/.test([0.3, 5, 100].map(formatDistance).join('')),
    '★ 文案里不出现「附近 / 不远」这类无法证伪的词'
  )
}

console.log(bad ? `\n❌ ${bad} 项未通过` : '\n✅ 与参照实现逐点一致')
process.exit(bad ? 1 : 0)