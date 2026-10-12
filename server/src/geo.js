/**
 * 腾讯位置服务（WebService API）客户端 —— **只在服务端跑**。
 *
 * 为什么放在服务端而不是前端直连：
 *   1. 前端明文 key 会被抓包抄走（腾讯官方也建议商业用途走后端代理）；
 *   2. 项目要求前端「零运行时依赖 + 离线可跑」，前端只要拿到**已经整理好的 JSON**，
 *      不需要认识腾讯这套接口；
 *   3. key 换了只改一个环境变量，前端一行都不用动。
 *
 * 环境变量：`TENCENT_MAP_KEY`（不是 VITE_ 前缀 —— 带 VITE_ 会被打进前端产物）。
 *
 * ⚠️ **没配 key 不是错误**。这时所有函数返回 `{ configured: false }`，
 *    路由据此回一个**明确的降级响应**，前端降级成「只出坐标、不出地址」。
 *    绝不能返回假地址，也不能抛 500 —— 没配 key 是正常状态，不是故障。
 *
 * ⚠️ 坐标系是 **GCJ-02**（内地 / 港澳）。浏览器 `navigator.geolocation` 给的是 WGS-84，
 *    必须先在前端换成 GCJ-02 再传过来，否则地址会偏几百米到一两公里。
 *    台湾省是 WGS-84 —— 这一层不做区分，超出内地场景直接不承诺精度。
 */

const KEY = String(process.env.TENCENT_MAP_KEY || '').trim()
const BASE = 'https://apis.map.qq.com/ws'
const TIMEOUT_MS = 6000

export const isGeoConfigured = () => !!KEY

/** 只判断「是不是一个像样的经纬度」，不做行政区划校验 —— 越界坐标让腾讯那边去拒。 */
function validLatLng(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  )
}

/** 去掉行政区划后缀，让「广东省 / 深圳市」变成界面上的「广东 / 深圳」。 */
function stripSuffix(name) {
  return String(name || '')
    .replace(/(省|自治区|特别行政区|维吾尔|回族|壮族|市)$/u, '')
    .trim()
}

/**
 * 拼成资料页那个「广东·深圳」的格式。
 * 直辖市（北京市 / 北京市）省和市会同名 → 只留一个，不显示「北京·北京」。
 */
function regionLabel(province, city) {
  const p = stripSuffix(province)
  const c = stripSuffix(city)
  if (!p) return c
  if (!c || p === c) return p
  return `${p}·${c}`
}

async function call(path, params) {
  const url = new URL(`${BASE}${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  url.searchParams.set('key', KEY)

  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    /* 超时 / DNS / 无网都落到这里。无网时前端本来就该降级，所以给一个可判别的 code。 */
    const err = new Error(
      e?.name === 'TimeoutError' ? '位置服务超时（网络不通？）' : '位置服务连不上（网络不通？）'
    )
    err.code = 'UNREACHABLE'
    throw err
  }

  let body
  try {
    body = await res.json()
  } catch {
    const err = new Error(`位置服务返回了非 JSON（HTTP ${res.status}）`)
    err.code = 'BAD_RESPONSE'
    throw err
  }

  /* 腾讯的约定：HTTP 200 + body.status === 0 才算成功。
     ⚠️ 只看 res.ok 会把「key 校验失败」当成成功，然后拿 undefined 去拼地址。 */
  if (body.status !== 0) {
    const err = new Error(body.message || `位置服务返回 status=${body.status}`)
    err.code = 'UPSTREAM'
    err.status = body.status
    throw err
  }
  return body
}

/**
 * 逆地址解析：坐标 → 文字地址（+ 可选周边 POI 列表）。
 *
 * 一个接口干两件事是有意的 —— 腾讯的 `get_poi=1` 就是为「位置共享 / 签到」这类场景设计的，
 * `policy=5` 官方描述是「用户经常用于发送位置、位置分享等场景的热门地点优先排序」，
 * 正好是动态选位置要的东西。这样「我页一键定位」和「动态选附近地点」共用一份调用，
 * 不用再去接另一个地点搜索接口。
 *
 * @param {number} lat GCJ-02 纬度
 * @param {number} lng GCJ-02 经度
 * @param {{ pois?: boolean, radius?: number }} opts radius 单位米，1~5000
 */
export async function reverseGeocode(lat, lng, opts = {}) {
  if (!isGeoConfigured()) return { configured: false }
  const la = Number(lat)
  const ln = Number(lng)
  if (!validLatLng(la, ln)) {
    const err = new Error('经纬度不合法')
    err.code = 'BAD_INPUT'
    throw err
  }

  const wantPois = opts.pois !== false
  const radius = Math.min(Math.max(Number(opts.radius) || 1000, 1), 5000)

  const body = await call('/geocoder/v1/', {
    location: `${la},${ln}`,
    get_poi: wantPois ? 1 : 0,
    /* address_format=short 少一截省市区前缀；orderby=_distance 按离我多远排 */
    poi_options: wantPois
      ? `address_format=short;radius=${radius};policy=5;orderby=_distance`
      : undefined,
  })

  const r = body.result || {}
  const c = r.address_component || {}
  const ad = r.ad_info || {}
  const adLoc = ad.location || {}

  return {
    configured: true,
    /* 用户真正站在哪 —— 只用于这次请求的展示，**不落库** */
    address: {
      formatted: r.address || '',
      recommend: r.formatted_addresses?.recommend || '',
      province: c.province || ad.province || '',
      city: c.city || ad.city || '',
      district: c.district || ad.district || '',
      street: c.street || '',
      streetNumber: c.street_number || '',
    },
    /* 行政区划的**中心点** —— 这是公开地理事实，不是个人位置。
       要存就存这个（配合 city_public 开关），存它既不侵犯隐私又够「附近」用。 */
    city: {
      name: ad.name || '',
      adcode: ad.adcode ? String(ad.adcode) : '',
      lat: Number.isFinite(adLoc.lat) ? adLoc.lat : null,
      lng: Number.isFinite(adLoc.lng) ? adLoc.lng : null,
      region: regionLabel(c.province || ad.province, c.city || ad.city),
    },
    pois: wantPois
      ? (r.pois || []).map((p) => ({
          id: String(p.id || ''),
          name: p.title || '',
          address: p.address || '',
          category: p.category || '',
          lat: Number.isFinite(p.location?.lat) ? p.location.lat : null,
          lng: Number.isFinite(p.location?.lng) ? p.location.lng : null,
          /* 腾讯给的距离是「到入参坐标的直线距离（米）」。
             可能是 0（人在 AOI 里）；也可能压根不给 —— 那就留 null，**不编**。 */
          distance: Number.isFinite(p._distance) ? p._distance : null,
          direction: p._dir_desc || '',
        }))
      : [],
  }
}
