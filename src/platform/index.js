/**
 * 平台适配层 · 统一出口。
 *
 * 业务代码只从这里 import，不要直接引用具体的适配器文件
 * （`./platform/storage.js` 这种路径引用会让将来换实现时到处改）。
 *
 * 用法：
 * ```js
 * import { storage, clipboard } from '../platform/index.js'
 * const token = storage.get('chatly.token')
 * ```
 *
 * ## 现在有哪些
 *
 * | 模块 | 能力 | Web | 原生 |
 * |---|---|---|---|
 * | env | 运行环境探测 | ✅ | ✅ |
 * | storage | 键值存储 | ✅ | ✅ |
 * | media | 摄像头/麦克风/录音 | ✅ | ✅ |
 * | clipboard | 剪贴板 | ✅ | ✅ |
 * | geo | 定位 | ✅ | ✅ |
 * | haptics | 触感 | ✅ | ✅ |
 * | share | 系统分享 / 外部打开 | ✅ | ✅ |
 * | deepLink | 深链 | ✅ | ✅ |
 * | push | 推送订阅 | ✅ | ⏸ 本阶段不做原生通道 |
 */

export { runtime, isNative, isIOS, isAndroid, isDesktop, isWeb, capPlugin, tauriInvoke, RUNTIME } from './env.js'

export * as storage from './storage.js'
export * as media from './media.js'
export * as clipboard from './clipboard.js'
export * as geo from './geo.js'
export * as haptics from './haptics.js'
export * as share from './share.js'
export * as deepLink from './deepLink.js'
export * as push from './push.js'
