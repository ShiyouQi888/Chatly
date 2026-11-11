/**
 * 新消息的系统推送（Web Push）
 *
 * 为什么单独一个文件：`push.js` 是「怎么发」，这里是「该不该发、发给谁、推什么」。
 * 而且它依赖 `ws.js` 的在线判定，而 `ws.js` 又依赖 `push.js`——
 * 把规则塞进 push.js 会形成循环，所以只能另起一层。
 *
 * ## 四条规则（每一条都对应一个真实会踩的坑）
 *
 * 1. **在线不推**。用户已经连着 WS、消息就在眼前，再弹一条系统通知是纯打扰。
 *    代价是：后台标签页仍算在线，可能不推 —— 但比起「前台还在弹通知」，这个取舍是对的。
 * 2. **免打扰会话不推**。`conversation_members.muted` 是用户显式关掉的，必须尊重。
 * 3. **按类型尊重通知设置**：私聊看 `notify_message`，群聊看 `notify_group`。
 *    和站内通知共用同一套开关键，避免「关了通知却还在弹」。
 * 4. **通话记录不推**。它是一次事件的回执，不是等你回的消息；
 *    为它弹通知只会让「刚挂完电话」的人再被打扰一次。
 *
 * ## 已知边界
 *
 * - 群消息不做「只推 @」的收窄：那会让普通的群聊消息在离线时彻底静默，
 *   与 IM 的常识不符。真要收窄应该在产品层给「仅 @ 时提醒」的开关。
 * - 一个用户多台设备时，只要有一台在线就整体不推。按设备精确判定需要把
 *   订阅和 WS 连接绑定，当前两套表没打通。
 */
import { q } from './db.js'
import { isOnlineAnywhere } from './ws.js'
import { pushIsConfigured, sendPushToUser } from './push.js'

/** 推送正文的截断长度：锁屏上看不完，太长反而把关键信息挤掉 */
const SNIPPET_MAX = 80

/**
 * 推送正文。
 *
 * 和站内通知的 `messageSnippet()` 看起来很像，但**不能复用**：
 * 那个函数服务于通知列表（可以带完整文件名），这里要压到一行锁屏文案，
 * 而且必须处理通话记录（站内通知不为它建行）。
 */
export function pushSnippet(message) {
  const cut = (s) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim()
    if (!t) return ''
    return t.length > SNIPPET_MAX ? t.slice(0, SNIPPET_MAX) + '…' : t
  }
  switch (message?.kind) {
    case 'image':
      return '[图片]'
    case 'video':
      return '[视频]'
    case 'file':
      return cut(`[文件] ${message.fileName || ''}`)
    case 'location':
      return cut(`[位置] ${message.geo?.name || ''}`)
    case 'poll':
      return cut(`[投票] ${message.text || ''}`)
    case 'call':
      return message.callMedia === 'video' ? '[视频通话]' : '[语音通话]'
    default:
      return cut(message?.text) || '[消息]'
  }
}

/**
 * 给会话里**离线且未静音**的成员发系统推送。
 *
 * @returns {{ targets:number, sent:number, configured:boolean }} 供自检断言用
 */
export async function notifyMessagePush({ conversationId, senderId, message }) {
  const out = { targets: 0, sent: 0, configured: pushIsConfigured() }
  try {
    if (!message || message.kind === 'call') return out
    if (!out.configured) return out

    const conv = await q.get('SELECT type, title FROM conversations WHERE id = ?', conversationId)
    if (!conv) return out

    const sender = await q.get('SELECT nickname, username FROM users WHERE id = ?', Number(senderId))
    const senderName = sender?.nickname || sender?.username || '有人'

    const members = await q.all(
      `SELECT cm.user_id AS userId, cm.muted AS muted
         FROM conversation_members cm
        WHERE cm.conversation_id = ? AND cm.user_id != ?`,
      conversationId,
      Number(senderId)
    )
    if (!members.length) return out

    /* 通知开关一次性批量取 —— 群里几十个人逐个查设置就是 N+1，
       而这条路径在每条群消息上都会走。 */
    const ids = members.map((m) => Number(m.userId))
    const settingKey = conv.type === 'group' ? 'notify_group' : 'notify_message'
    const prefs = await q.all(
      `SELECT user_id AS userId, value FROM user_settings
        WHERE key = ? AND user_id IN (${ids.map(() => '?').join(',')})`,
      settingKey,
      ...ids
    )
    const disabled = new Set(
      prefs
        .filter((p) => String(p.value).replace(/"/g, '') === 'false')
        .map((p) => Number(p.userId))
    )

    const title = conv.type === 'group' ? conv.title || '群聊' : senderName
    const body = conv.type === 'group' ? `${senderName}: ${pushSnippet(message)}` : pushSnippet(message)

    const candidates = members.filter((m) => !Number(m.muted) && !disabled.has(Number(m.userId)))
    out.targets = candidates.length
    if (!candidates.length) return out

    /* 在线判定和投递并行：判一个推一个，不让「某个人在线查询慢」拖住整批。 */
    await Promise.all(
      candidates.map(async (m) => {
        const userId = Number(m.userId)
        try {
          if (await isOnlineAnywhere(userId)) return
          const r = await sendPushToUser(
            userId,
            {
              type: 'message.new',
              payload: {
                conversationId: Number(conversationId),
                messageId: message.id ?? null,
                title,
                body,
                /* 同一个会话用同一个 tag：多条未读会在系统托盘里替换成最新一条，
                   而不是叠出一串。这是 Web Push 层面唯一能做的「聚合」。 */
                tag: `chatly-msg-${conversationId}`,
                url: `/?conv=${conversationId}`,
              },
            },
            /* 离线消息最多等 24 小时；urgency 用 normal —— 消息不该像来电那样抢焦点。 */
            { ttl: 86400, urgency: 'normal' }
          )
          out.sent += r.sent
        } catch (e) {
          console.warn('[push] 消息推送失败（已忽略）：', e.message)
        }
      })
    )
    return out
  } catch (e) {
    console.warn('[push] 消息推送规则执行失败（已忽略）：', e.message)
    return out
  }
}
