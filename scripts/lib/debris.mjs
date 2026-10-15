/**
 * 自检残留清理 —— 给所有 CDP / 接口自检脚本共用
 *
 * 为什么需要它：自检脚本会建临时会话（「回执演示·部分」「联调群」「自检·长会话」…），
 * 用完以为调 `DELETE /conversations/:id` 就清掉了 —— **其实没有**。
 * 那个接口的语义是「退出成员关系」（leaveConversation），会话行和消息都还在，
 * 其他成员的成员记录也还在。于是每跑一轮自检就多留一批孤儿会话：
 * 演示库一度攒下 57 个会话，其中 13 个同名「回执演示·部分」，对话列表完全没法看了。
 *
 * 这里直接对数据库做真删除。可以这么做是因为：服务端每次查询都现读 DB，没有内存缓存，
 * 删掉就是删掉了（SQLite 开了 WAL，多进程读写没问题，服务端不需要重启）。
 *
 * 只在**自检脚本**里调用。产品代码里没有「彻底删除会话」这个功能，
 * 用户侧的「删除会话」就该是保留历史、只退出自己。
 *
 * ## ⚠️ 全部导出都是 async，调用点必须 `await`
 *
 * 原先是同步的（直接用 SQLite 的 `db` 裸句柄）。那样做的代价是：
 * **任何 import 了本文件的脚本都跑不了 `DB_DRIVER=postgres`** ——
 * 一进 `purgeDebris()` 就抛「db 是 SQLite 专有的同步直连」。
 * 于是「PG 下把浏览器自检也跑一遍」这条**唯一能发现 PG 专有界面问题**的路被堵死了
 * （实测就是这么漏掉一个发现页 500 的）。
 *
 * 改成 `q` / `tx`（门面导出，两种驱动通用）之后，`check-group` / `check-media` /
 * `check-console` 这些纯浏览器脚本也能在 PG 后端下原样跑一遍。
 * **代价只是调用点多写一个 `await`**，而收益是这类脚本不再有「只能在 SQLite 下验」的盲区。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { q, tx } from '../../server/src/db.js'
import { PRIVATE_UPLOAD_DIR } from '../../server/src/upload.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS = path.join(HERE, '..', '..', 'server', 'uploads')
const PRIVATE_UPLOADS = PRIVATE_UPLOAD_DIR
/** 孤儿文件不删，只挪到这儿 —— 万一是谁手滑误判，还能捞回来 */
const ORPHAN_DIR = path.join(HERE, '..', '..', '.tmp', 'orphan-uploads')

/** 自检脚本建的临时会话，标题一律以这些前缀开头。
 *  给临时会话起「自检·」前缀是好习惯：一眼能看出来，也方便这里识别。 */
const DEBRIS_PREFIXES = ['自检·', '回执演示·', '联调群', '收件人小组']

/** `IN (?, ?, …)` 的占位符串 —— 两种驱动都由方言层翻译，写法一致 */
const holes = (n) => Array.from({ length: n }, () => '?').join(', ')

export async function purgeDebris({ quiet = false } = {}) {
  const rows = await q.all('SELECT id, title, type FROM conversations')

  const byTitle = rows.filter((c) =>
    DEBRIS_PREFIXES.some((p) => String(c.title || '').startsWith(p))
  )

  // 没有成员的会话也是孤儿：成员全退出了，谁也看不到、谁也删不掉。
  const orphanIds = (
    await q.all(
      `SELECT c.id FROM conversations c
       LEFT JOIN conversation_members m ON m.conversation_id = c.id
       GROUP BY c.id HAVING COUNT(m.user_id) = 0`
    )
  ).map((r) => r.id)

  const ids = [...new Set([...byTitle.map((c) => c.id), ...orphanIds])]
  if (!ids.length) {
    if (!quiet) console.log('库里没有自检残留')
    return { conversations: 0, messages: 0, members: 0 }
  }

  const ph = holes(ids.length)
  let members = 0
  let messages = 0
  await tx(async () => {
    members = (await q.run(`DELETE FROM conversation_members WHERE conversation_id IN (${ph})`, ...ids)).changes
    messages = (await q.run(`DELETE FROM messages WHERE conversation_id IN (${ph})`, ...ids)).changes
    await q.run(`DELETE FROM conversations WHERE id IN (${ph})`, ...ids)
  })

  if (!quiet) {
    const titled = byTitle.length
    const orphan = ids.length - titled
    console.log(
      `清理自检残留：${ids.length} 个会话（按标题 ${titled}／无成员孤儿 ${orphan}）、` +
        `${messages} 条消息、${members} 条成员记录`
    )
    const names = [...new Set(byTitle.map((c) => c.title))].slice(0, 8)
    if (names.length) console.log(`  涉及：${names.join('、')}${byTitle.length > 8 ? ' …' : ''}`)
  }
  return { conversations: ids.length, messages, members }
}

/**
 * 删掉指定的几条消息 —— 给「往演示会话里发了一条探针消息」的自检脚本收尾用。
 * 演示库里没有「彻底删除消息」这个产品功能（撤回才是产品语义，会留一行「消息已撤回」），
 * 所以自检想做到零痕迹就只能从数据库这一层删。
 */
export async function purgeMessages(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => Number.isFinite(Number(x)))
  if (!list.length) return 0
  return (await q.run(`DELETE FROM messages WHERE id IN (${holes(list.length)})`, ...list)).changes
}

/**
 * 回收「没有任何地方引用」的上传文件 —— 移到 .tmp/orphan-uploads/，不删。
 *
 * 自检脚本传图片、换头像都会在 uploads/ 里留文件；消息一清理、头像一还原，
 * 这些文件就没人指了。留着只会让 uploads/ 越攒越满（还都长得一模一样，看不出是哪个）。
 *
 * ⚠️ **引用方清单必须跟着新功能一起长**。当前有**七处**：
 *   users.avatar · users.profile_cover · messages.file_url · conversations.avatar ·
 *   moment_media.url · favorites.file_url · feedbacks.screenshot_url
 * 每加一个「能存文件地址」的地方就要来这里补一行 —— 漏一处不是「少清理一个文件」，
 * 而是**把还在用的文件当成孤儿挪走**：那条数据从此指向一个不存在的路径，
 * 界面上就是一片破图（而且 .tmp/orphan-uploads/ 里躺着，看着像文件丢了）。
 * 收藏尤其危险：它的 file_url 是**快照**，原消息删掉之后只有它还在指那个文件
 * （见 server/src/favorite.js 的说明）。
 *
 * ⚠️ 必须在清完消息之后再调 —— 反过来的话刚发的图还被消息指着，扫不到。
 */
export async function purgeOrphanUploads({ quiet = false } = {}) {
  if (!fs.existsSync(UPLOADS) && !fs.existsSync(PRIVATE_UPLOADS)) return { moved: 0, files: [] }
  const publicRefs = new Set()
  const privateRefs = new Set()
  const add = (v) => {
    if (typeof v !== 'string') return
    if (v.startsWith('/uploads/')) publicRefs.add(v.slice('/uploads/'.length))
    if (v.startsWith('/api/v1/files/private/')) privateRefs.add(v.slice('/api/v1/files/private/'.length).split('?')[0])
  }
  /* 七个引用方各查一遍。写法统一成 `SELECT <列> FROM <表>`，
     方便一眼看出「清单里有几张表」和实际查了几张表是否一致。 */
  const SOURCES = [
    ['users', 'avatar'],
    /* 个人主页封面：不是头像，但同样存 /uploads 地址，不能被当作孤儿挪走。 */
    ['users', 'profile_cover'],
    ['messages', 'file_url'],
    /* 群头像也是引用方 —— 漏掉它的话，换过群头像的群里那张旧图会被当成孤儿挪走，
       而那条会话还指着它（历史头像不在 messages.file_url 里，扫不到）。 */
    ['conversations', 'avatar'],
    /* 动态的配图。种子动态的照片也在 uploads 里，不算进来的话
       第一次跑清理就会把演示动态的照片全挪走，六条动态集体变破图。 */
    ['moment_media', 'url'],
    /* 收藏的快照文件 —— 原消息可能已经撤回/删除，这时**只有收藏还指着它**。 */
    ['favorites', 'file_url'],
    /* 反馈的截图 —— 同上：这条反馈是那个文件**唯一**的引用者。 */
    ['feedbacks', 'screenshot_url'],
  ]
  for (const [table, col] of SOURCES) {
    for (const r of await q.all(`SELECT ${col} AS v FROM ${table}`)) add(r.v)
  }

  const orphans = [
    ...(fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS)
      .filter((f) => !publicRefs.has(f) && fs.statSync(path.join(UPLOADS, f)).isFile())
      .map((name) => ({ name, dir: UPLOADS, bucket: 'public' })) : []),
    ...(fs.existsSync(PRIVATE_UPLOADS) ? fs.readdirSync(PRIVATE_UPLOADS)
      .filter((f) => !privateRefs.has(f) && fs.statSync(path.join(PRIVATE_UPLOADS, f)).isFile())
      .map((name) => ({ name, dir: PRIVATE_UPLOADS, bucket: 'private' })) : []),
  ]
  if (!orphans.length) return { moved: 0, files: [] }

  fs.mkdirSync(path.join(ORPHAN_DIR, 'public'), { recursive: true })
  fs.mkdirSync(path.join(ORPHAN_DIR, 'private'), { recursive: true })
  const moved = []
  for (const { name, dir, bucket } of orphans) {
    const from = path.join(dir, name)
    const to = path.join(ORPHAN_DIR, bucket, name)
    try {
      fs.renameSync(from, to)
      moved.push(name)
    } catch {
      /* 被服务端或编辑器占着就先跳过，下次再收 */
    }
  }
  if (!quiet && moved.length) console.log(`回收 ${moved.length} 个无引用的上传文件 → .tmp/orphan-uploads/`)
  return { moved: moved.length, files: moved }
}

/** 当前最大的消息 id —— 自检脚本开跑前记一条基线，收尾好知道该删到哪儿 */
export async function maxMessageId() {
  const r = await q.get('SELECT COALESCE(MAX(id), 0) AS n FROM messages')
  return Number(r?.n) || 0
}

/**
 * 删掉基线 id 之后产生的所有消息 —— 收尾时一次性清掉本轮产物。
 *
 * 为什么不用「逐个收集本轮消息 id」：漏一条就留痕迹，而且**撤回测试最容易漏** ——
 * 撤回不是删除，消息行还在（`revoked_at` 有值），界面上是一条「消息已撤回」。
 * 演示会话里攒下这种空行，看的人只会以为产品出了 bug。
 */
export async function purgeMessagesAfter(baselineId) {
  return (await q.run('DELETE FROM messages WHERE id > ?', Number(baselineId) || 0)).changes
}

/**
 * 真删动态 —— 和会话同理：产品侧的「删除动态」对作者来说是删了，
 * 但自检脚本还要处理「其它账号的点赞 / 评论也一并消失了」这种连带状态，
 * 而且临时动态往往带图，图得跟着回收。这里一次性把相关行清掉。
 *
 * @param {number[]} [ids] 动态 id 列表；不传则按「正文含自检标记」自动找
 */
export async function purgeMoments(ids) {
  const list = Array.isArray(ids)
    ? ids.filter((x) => Number.isFinite(Number(x)))
    : (
        await q.all(
          `SELECT id FROM moments
           WHERE content LIKE '%自检·%' OR topic LIKE '%自检·%' OR location LIKE '%自检·%'`
        )
      ).map((r) => r.id)
  if (!list.length) return { moments: 0, media: 0, likes: 0, comments: 0 }
  const ph = holes(list.length)
  let out
  await tx(async () => {
    out = {
      likes: (await q.run(`DELETE FROM moment_likes WHERE moment_id IN (${ph})`, ...list)).changes,
      comments: (await q.run(`DELETE FROM moment_comments WHERE moment_id IN (${ph})`, ...list)).changes,
      media: (await q.run(`DELETE FROM moment_media WHERE moment_id IN (${ph})`, ...list)).changes,
      moments: (await q.run(`DELETE FROM moments WHERE id IN (${ph})`, ...list)).changes,
    }
  })
  return out
}

/** 库里所有会话的概览，自检脚本用来核对「跑完之后有没有变干净」 */
export async function conversationOverview() {
  return q.all(
    `SELECT c.id, c.type, c.title,
            (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) AS members,
            (SELECT COUNT(*) FROM messages x WHERE x.conversation_id = c.id) AS messages
     FROM conversations c ORDER BY c.id`
  )
}
