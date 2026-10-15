/**
 * 允许的消息类型 —— **只在这里写一份**。
 *
 * 抽成独立文件的理由：SQLite 驱动与 PostgreSQL 驱动都要用它，
 * 而两个驱动不可能互相 import（会成环）。放在这里，两边都往下依赖。
 *
 * 另外三处必须和它对上：
 *   · `routes/messages.js` 的白名单
 *   · 前端 `isVideoMessage()` / 位置气泡的判断
 *   · PG 的 `messages_kind_check` 约束
 *
 * SQLite 改 CHECK 只能整表重建、PG 是删了约束再加 —— 两边路径完全不同，
 * 但**判据（全量比对 MESSAGE_KINDS）必须是同一个**，否则会出现
 * 「本地库升到位了、线上库少一个 kind」这种只在一边炸的问题。
 */
export const MESSAGE_KINDS = ['text', 'image', 'file', 'video', 'location', 'poll']

/**
 * 允许的通知类型 —— 和 MESSAGE_KINDS 同一个理由抽在这里只写一份。
 *
 * notifications.kind 上有 CHECK 约束，而 `src/notification.js` 的 NOTIFY_KEY
 * 是「事件 → user_settings 开关键」的映射。两处必须对齐：
 * 漏一个（当初就漏了 'group'）的症状是「群公告通知永远写不进去」，
 * 而且是**静默**的 —— pushNotification 吞掉约束错误以免连带让主操作失败，
 * 于是从接口上看像「没这个事件」，从库里看像「没这条行」，两头都不报错。
 *
 * 所以：DDL 的 CHECK 和 notification.js 的判据都从这里取，别再手写第二份清单。
 */
export const NOTIFICATION_KINDS = ['message', 'mention', 'like', 'comment', 'follow', 'group', 'system']
