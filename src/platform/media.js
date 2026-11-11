/**
 * 媒体采集 —— 摄像头 / 麦克风 / 录音。
 *
 * ## 跨端差异
 *
 * Web 端：`navigator.mediaDevices.getUserMedia()`。
 * 原生壳：WebView 里 **也有** `navigator.mediaDevices`（Capacitor 的 WebView
 * 是完整的 Chromium/WKWebView），但有两处差异：
 *
 * 1. **权限**：WebView 首次访问摄像头时，弹出的权限框是**系统级**的
 *    （iOS 的「相机」权限、Android 的 CAMERA 权限），不是网页级的。
 *    必须在原生工程的 Info.plist / AndroidManifest 里声明，
 *    否则 `getUserMedia` 直接抛 `NotAllowedError`。
 * 2. **安全上下文**：`getUserMedia` 只在 https 或 localhost 可用。
 *    原生壳用 `https://localhost` 或 `capacitor://localhost` 协议，
 *    Capacitor 默认就是安全上下文 —— 但如果配了 `server.url` 指向 http，
 *    就会失效。
 *
 * 所以这里主要做两件事：**统一入口** + **把权限错误翻译成人话**。
 */

import { isNative, capPlugin } from './env.js'

/**
 * 权限错误的可读文案。
 *
 * 原生端的报错信息比浏览器更晦涩（`NotAllowedError` 之下还分
 * 「用户拒绝」和「系统没授权」），但用户看到的是同一句话。
 *
 * @param {any} error
 * @returns {string}
 */
export function mediaErrorText(error) {
  const name = error?.name || ''
  const message = String(error?.message || '')
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || /permission/i.test(message)) {
    return isNative
      ? '没有获得相机或麦克风权限。请在系统设置里允许 Chatly 使用这些权限。'
      : '没有获得相机或麦克风权限。请在浏览器地址栏左侧的权限设置里允许。'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没有找到可用的摄像头或麦克风。'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '设备被其它程序占用了，请关闭后重试。'
  }
  if (/secure context|https/i.test(message)) {
    return '当前环境不安全，摄像头与麦克风需要 https 或 localhost。'
  }
  return '无法打开摄像头或麦克风。'
}

/**
 * 当前设备是否支持媒体采集。
 *
 * @returns {boolean}
 */
export function isSupported() {
  if (typeof navigator === 'undefined') return false
  return !!navigator.mediaDevices?.getUserMedia
}

/**
 * 申请一路媒体流。
 *
 * @param {MediaStreamConstraints} constraints
 * @returns {Promise<MediaStream>}
 */
export async function getUserMedia(constraints) {
  if (!isSupported()) {
    throw Object.assign(new Error('当前环境不支持摄像头或麦克风'), { name: 'NotSupportedError' })
  }
  return navigator.mediaDevices.getUserMedia(constraints)
}

/**
 * 录音器构造器。
 *
 * 原生壳的 WebView 里 `MediaRecorder` 可用，但**容器格式支持不一致**：
 * Android WebView 早期版本不支持 `audio/webm`，只有 `audio/mp4`。
 * 这里探测一下可用格式，避免传了不支持的类型直接抛错。
 *
 * @returns {typeof MediaRecorder|null}
 */
export function getRecorderClass() {
  if (typeof MediaRecorder === 'undefined') return null
  return MediaRecorder
}

/**
 * 挑一个当前环境支持的录音 MIME。
 *
 * @returns {string} 支持的 MIME；都不支持时返回空串（调用方不传即可）
 */
export function pickAudioMime() {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported?.(mime)) return mime
    } catch {
      /* 老浏览器没有 isTypeSupported —— 继续试下一个 */
    }
  }
  return ''
}

/**
 * 停止所有轨道并释放设备。
 *
 * 通话切换摄像头、结束录音、页面卸载时都必须调用，
 * 否则摄像头的指示灯会一直亮着（用户会以为被监控）。
 *
 * @param {MediaStream|null} stream
 */
export function stopStream(stream) {
  if (!stream) return
  try {
    stream.getTracks().forEach((track) => track.stop())
  } catch {
    /* noop */
  }
}

/**
 * 是否有可用的相机（用于扫码页）。
 *
 * @returns {Promise<boolean>}
 */
export async function hasCamera() {
  if (!isSupported()) return false
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.some((d) => d.kind === 'videoinput')
  } catch {
    /* 权限未授予时 enumerateDevices 返回空列表 —— 视为无相机 */
    return false
  }
}

/**
 * 请求相机权限（原生端走 Camera 插件预检，Web 端直接问浏览器）。
 *
 * @returns {Promise<boolean>}
 */
export async function requestCameraPermission() {
  if (!isNative) {
    try {
      const stream = await getUserMedia({ video: true })
      stopStream(stream)
      return true
    } catch {
      return false
    }
  }
  const camera = capPlugin('Camera')
  if (!camera) return false
  try {
    const status = await camera.checkPermissions?.({ permissions: ['camera'] })
    if (status?.camera === 'granted') return true
    if (status?.camera === 'prompt') {
      const asked = await camera.requestPermissions?.({ permissions: ['camera'] })
      return asked?.camera === 'granted'
    }
    return false
  } catch {
    return false
  }
}
