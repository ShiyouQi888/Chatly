/* ===== 通知提醒：声音 / 震动 / 免打扰 =====
 *
 * 这三项管的是「通知到了之后怎么吵你」，不是「有没有这条通知」
 * （后者是服务端在写入时按 notify_* 开关判的，见 server/src/notification.js）。
 * 所以它们只能在**客户端**判：
 *   · 免打扰时段用的是用户设备的本地时间 —— 服务端判会对时区不对的人成立（错的）；
 *   · 声音 / 震动本来就是浏览器能力，服务端碰不到。
 *
 * 偏好从 /notifications/prefs 读回来（sound / vibrate / dnd_enabled / dnd_start / dnd_end），
 * 存成模块级变量：useAlert 与 Phone 的 WS 回调不在同一棵组件子树里，
 * 用一个共享的 setter 比到处传 props 干净。 */
import { useCallback } from 'react'

let prefs = { sound: true, vibrate: true, dnd_enabled: false, dnd_start: '23:00', dnd_end: '08:00' }

export function setNotifyPrefs(p) {
  if (!p) {
    prefs = { sound: true, vibrate: true, dnd_enabled: false, dnd_start: '23:00', dnd_end: '08:00' }
    return
  }
  prefs = { ...prefs, ...p }
}
export function getNotifyPrefs() {
  return prefs
}

/** "HH:MM" → 当天分钟数。解析不出来返回 null（不当成 0，那是午夜） */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''))
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/**
 * 此刻是否落在免打扰时段内。
 *
 * ⚠️ 跨午夜的时段（默认 23:00–08:00 就是）要单独判：start > end 表示区间**跨过 0 点**，
 * 命中的是「>= start 或 <= end」，而不是普通的「start <= now <= end」。
 * 按普通区间算的话，默认这个夜间时段永远判不出「在免打扰里」—— 那正是最该生效的时段。
 * start === end 当成「全天免打扰」还是「不免打扰」？取更保守的**不**（0 长度区间不吵人也不该静掉一切）。
 */
export function inDnd(now = new Date()) {
  if (!prefs.dnd_enabled) return false
  const start = toMinutes(prefs.dnd_start)
  const end = toMinutes(prefs.dnd_end)
  if (start === null || end === null) return false
  if (start === end) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  if (start < end) return cur >= start && cur < end
  return cur >= start || cur < end
}

/* ---- 声音：一段极短的提示音，Web Audio 现场合成，不带任何音频文件 ----
 * 为什么合成而不是放 mp3：项目零运行期依赖，也不想为一个「叮」塞个二进制进来。
 * 两个正弦 + 一个快速包络，够短、够轻，不会吵。 */
let audioCtx = null
function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return false
    /* 浏览器策略：没有用户手势之前 AudioContext 是 suspended —— 这时 play() 不会响。
       真机上用户早就点过屏幕了；headless 自检里它响不响不影响断言（断言看的是「有没有调用」）。 */
    if (!audioCtx) audioCtx = new Ctx()
    if (audioCtx.state === 'suspended') audioCtx.resume?.()
    const t = audioCtx.currentTime
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, t)
    osc.frequency.exponentialRampToValueAtTime(660, t + 0.12)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.08, t + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
    osc.connect(gain).connect(audioCtx.destination)
    osc.start(t)
    osc.stop(t + 0.22)
    return true
  } catch {
    return false
  }
}

function buzz() {
  try {
    /* Headless browser suites and first-load sessions have no activation; calling
       vibrate in that state is blocked with a console error by Chromium. Once the
       user has interacted with the app, realtime notification vibration is allowed. */
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return false
    return navigator.vibrate?.(30) !== false && !!navigator.vibrate
  } catch {
    return false
  }
}

/**
 * 一条通知到了，要不要吵、怎么吵。
 * @param {{ silent?: boolean }} opts silent=true 时只更新红点不发出任何声光
 *        （用户正开着对应的那一屏时用它，别一边看着一边响）。
 * @returns {{sounded:boolean,vibrated:boolean,muted:boolean}} 实际做了什么 —— 界面不撒谎
 */
export function alertForNotification({ silent = false } = {}) {
  if (silent || inDnd()) return { sounded: false, vibrated: false, muted: true }
  const sounded = prefs.sound ? beep() : false
  const vibrated = prefs.vibrate ? buzz() : false
  return { sounded, vibrated, muted: false }
}

/**
 * 给组件用的薄封装：拿到当前是否免打扰，以及一个「响一下」的动作。
 * 提醒方式（sound/vibrate）读的是**最近一次 setNotifyPrefs 的值**，
 * 所以 NotificationSettings 里拨动开关之后要立刻调 setNotifyPrefs，
 * 不然新设置要等下次拉取才生效（那是「点了没反应」）。
 */
export function useNotifyAlert() {
  return useCallback((opts) => alertForNotification(opts), [])
}
