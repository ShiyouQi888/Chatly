/**
 * 演示数据：预置用户 + 会话 + 消息
 *   node src/seed.js          幂等：表空才写入
 *   node src/seed.js --reset  清空重建
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, q, insert } from './db.js'
import { hashPassword, parseTags } from './auth.js'
import { ensurePrivate, createGroup, createMessage, updateGroup } from './chat.js'
import { createMoment, addComment, toggleLike } from './moment.js'
import { createPoll, votePoll } from './poll.js'
import { addFavorite } from './favorite.js'

const RESET = process.argv.includes('--reset')

if (RESET) {
  db.exec('DELETE FROM moment_comments')
  db.exec('DELETE FROM moment_likes')
  db.exec('DELETE FROM moment_media')
  db.exec('DELETE FROM moments')
  db.exec('DELETE FROM follows')
  db.exec('DELETE FROM messages')
  db.exec('DELETE FROM conversation_members')
  db.exec('DELETE FROM conversations')
  db.exec('DELETE FROM users')
  db.exec(
    "DELETE FROM sqlite_sequence WHERE name IN ('users','conversations','messages','moments','moment_media','moment_comments')"
  )
  console.log('已清空数据')
}

const DEMO_PASSWORD = 'chatly123'

/* 演示资料：全部为虚构数据。头像留空 → 前端按 id 生成色块兜底 */
const users = [
  {
    username: 'chenmo',
    nickname: '陈墨',
    bio: '热爱生活，也热爱远方 ✨',
    gender: 'male',
    birthday: '1996-03-18',
    region: '广东 · 深圳',
    tags: ['电影', '摄影', '旅行'],
  },
  {
    username: 'linxiaoxia',
    nickname: '林小夏',
    bio: '喜欢在雨天看电影',
    gender: 'female',
    birthday: '1998-07-02',
    region: '广东 · 广州',
    tags: ['电影', '音乐', '咖啡'],
  },
  {
    username: 'ajie',
    nickname: '阿杰',
    bio: '摸鱼爱好者',
    gender: 'male',
    birthday: '1995-11-25',
    region: '浙江 · 杭州',
    tags: ['游戏', '幽默'],
  },
  {
    username: 'xiaolu',
    nickname: '小鹿',
    bio: '家里有 40 盆多肉',
    gender: 'female',
    birthday: '1999-04-09',
    region: '四川 · 成都',
    tags: ['植物', '阅读', '手作'],
  },
  {
    username: 'chenyu',
    nickname: '陈宇',
    bio: '每周三次夜跑',
    gender: 'male',
    birthday: '1994-09-30',
    region: '上海',
    tags: ['跑步', '科技'],
  },
  {
    username: 'xiatian',
    nickname: '夏天',
    bio: '在路上的时候最自在',
    gender: 'other',
    birthday: '2000-01-15',
    region: '云南 · 大理',
    tags: ['旅行', '美食', '摄影'],
  },
  /* ===== 发现页用的“陌生人” =====
     发现页要推荐的是**不认识的人**。只有原来那 6 个的话：他们两两互关、
     同在两个演示群里，推荐列表里全是熟人 —— 排序理由清一色「和你在 N 个群里」，
     看不出「共同兴趣 / 同城」这两条推荐路径到底有没有在工作。
     这 6 个是新加的虚构演示用户（其中两个与陈墨同城），他们**不加入**已有的演示群。 */
  {
    username: 'shenxu',
    nickname: '沈叙',
    bio: '拍城市，也拍城市里的人',
    gender: 'male',
    birthday: '1997-05-11',
    region: '广东 · 深圳',
    tags: ['摄影', '设计', '城市漫步'],
  },
  {
    username: 'wenyan',
    nickname: '温言',
    bio: '周末通常在电影院',
    gender: 'female',
    birthday: '1999-02-28',
    region: '广东 · 深圳',
    tags: ['电影', '阅读'],
  },
  {
    username: 'jiangye',
    nickname: '江野',
    bio: '正在攒一趟长途旅行',
    gender: 'male',
    birthday: '1993-08-07',
    region: '广东 · 广州',
    tags: ['旅行', '摄影', '美食'],
  },
  {
    username: 'suye',
    nickname: '苏叶',
    bio: '手作和植物是我的充电方式',
    gender: 'female',
    birthday: '1998-11-03',
    region: '浙江 · 杭州',
    tags: ['手作', '植物', '咖啡'],
  },
  {
    username: 'hesheng',
    nickname: '何声',
    bio: '做音乐也写代码',
    gender: 'male',
    birthday: '1995-06-19',
    region: '北京',
    tags: ['音乐', '科技'],
  },
  {
    username: 'bailu',
    nickname: '白露',
    bio: '探店笔记写了三年',
    gender: 'female',
    birthday: '2001-03-24',
    region: '四川 · 成都',
    tags: ['美食', '阅读', '电影'],
  },
]

/**
 * 发现页的「兴趣群」：公开可加入（`discoverable = 1`）。
 *
 * 为什么单独建而不是把「设计部」标成公开：
 *   那两个是**工作群 / 私人群**，公开挂牌等于把别人的群摆到广场上；
 *   而且陈墨本来就在里面，发现页会按「我不在里面的群」过滤掉，演示里一条都看不到。
 * 建群时把陈墨排除在成员之外，这样他（以及大多数演示账号）才有「可加入」的东西。
 */
const interestGroups = [
  { title: '周末摄影局', owner: 'xiatian', members: ['xiaolu', 'chenyu'] },
  { title: '深夜读书会', owner: 'linxiaoxia', members: ['ajie'] },
]

/**
 * 老库补资料：只填空字段，绝不覆盖用户自己改过的值。
 * 这样加资料字段时不用 reset —— reset 会把已有会话和消息一起清掉。
 */
function backfillProfiles() {
  let n = 0
  for (const u of users) {
    const row = q.get('SELECT id, gender, birthday, region, tags FROM users WHERE username = ?', u.username)
    if (!row) continue
    const sets = []
    const args = []
    if (!row.gender && u.gender) {
      sets.push('gender = ?')
      args.push(u.gender)
    }
    if (!row.birthday && u.birthday) {
      sets.push('birthday = ?')
      args.push(u.birthday)
    }
    if (!row.region && u.region) {
      sets.push('region = ?')
      args.push(u.region)
    }
    if (!parseTags(row.tags).length && u.tags?.length) {
      sets.push('tags = ?')
      args.push(JSON.stringify(u.tags))
    }
    if (!sets.length) continue
    q.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...args, row.id)
    n++
  }
  return n
}

/**
 * 已有库补建**缺失的**演示用户 —— `INSERT OR IGNORE` 不行就用 `username` 先判存在。
 *
 * ⚠️ 不能为了加用户就让人跑 `npm run reset`：那会把已有会话和消息一起清掉，
 *    而用户在预览里手测过的内容也在里面。只补「库里没有的」，已有的一个字都不动。
 */
function backfillUsers() {
  let n = 0
  for (const u of users) {
    if (q.get('SELECT 1 FROM users WHERE username = ?', u.username)) continue
    insert(
      'INSERT INTO users (username, password_hash, nickname, avatar, bio, gender, birthday, region, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      u.username,
      hashPassword(DEMO_PASSWORD),
      u.nickname,
      null,
      u.bio,
      u.gender,
      u.birthday,
      u.region,
      JSON.stringify(u.tags)
    )
    n++
  }
  return n
}

/**
 * 兴趣群（发现页「可加入的群」）。按 **title 判重** ——
 * 重复建一次就是两个同名群并排刷在发现页里，看的人只会以为是 bug。
 */
function seedInterestGroups(idMap) {
  let n = 0
  for (const g of interestGroups) {
    if (q.get('SELECT 1 FROM conversations WHERE title = ? AND type = ?', g.title, 'group')) continue
    const ownerId = idMap[g.owner]
    if (!ownerId) continue
    const memberIds = g.members.map((m) => idMap[m]).filter(Boolean)
    const cid = createGroup(g.title, memberIds, ownerId)
    q.run('UPDATE conversations SET discoverable = 1 WHERE id = ?', cid)
    n++
  }
  return n
}

const has = q.get('SELECT COUNT(*) AS n FROM users').n
if (has > 0 && !RESET) {
  const filled = backfillProfiles()
  const added = backfillUsers()
  console.log(
    `已有 ${has} 个用户，跳过重建；补齐了 ${filled} 条演示资料（只填空字段）` +
      (added ? `，补建了 ${added} 个演示用户` : '')
  )

  /* idMap 要在补建用户**之后**再算 —— 否则新用户不在表里，兴趣群的成员会少人 */
  const idMap = Object.fromEntries(
    q.all('SELECT id, username FROM users').map((r) => [r.username, r.id])
  )
  const groupsAdded = seedInterestGroups(idMap)

  /* 老库补齐动态：只有一条都没有的时候才写。
     宁可少补也不要重复 —— 重复一次就是六条一模一样的动态刷在列表顶部。 */
  if (q.get('SELECT COUNT(*) AS n FROM moments').n === 0) {
    seedMoments(idMap)
    console.log('已为现有演示库补齐动态与关注关系')
  }
  if (groupsAdded) console.log(`已补建 ${groupsAdded} 个公开兴趣群（发现页可加入）`)

  /* 老库补一条演示投票：投票是「界面上没有内容就不知道长什么样」的功能。
     判据是「这个群还没有任何投票」，所以重复跑 seed 不会多出第二条。 */
  const pollsAdded = seedPolls(idMap)
  if (pollsAdded) console.log(`已为演示群补齐 ${pollsAdded} 条群投票`)

  /* 老库补几条演示收藏 —— 同理：收藏列表空着就不知道它能长什么样 */
  const favsAdded = seedFavorites(idMap)
  if (favsAdded) console.log(`已为演示账号补齐 ${favsAdded} 条收藏`)

  console.log('如需彻底重建：npm run reset')
  process.exit(0)
}

const ids = {}
for (const u of users) {
  ids[u.username] = insert(
    'INSERT INTO users (username, password_hash, nickname, avatar, bio, gender, birthday, region, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    u.username,
    hashPassword(DEMO_PASSWORD),
    u.nickname,
    null,
    u.bio,
    u.gender,
    u.birthday,
    u.region,
    JSON.stringify(u.tags)
  )
}
console.log(`已创建 ${users.length} 个用户（密码统一为 ${DEMO_PASSWORD}）`)

/* ---------- 私聊 ---------- */
const p1 = ensurePrivate(ids.chenmo, ids.linxiaoxia)
const scripts = [
  ['linxiaoxia', '在忙吗？'],
  ['chenmo', '刚忙完～'],
  ['linxiaoxia', '晚上一起去看电影吧～\n新上映的那部，听说很好看！😄'],
  ['chenmo', '不忙呀！我也想这部电影，几点去？'],
  ['linxiaoxia', '我们 7 点在万象城见面怎么样？'],
  ['chenmo', '好呀！我到时发你定位 👍'],
  ['linxiaoxia', '期待～😊'],
]
for (const [who, text] of scripts) {
  createMessage({ conversationId: p1, senderId: ids[who], kind: 'text', content: text })
}
console.log(`私聊 #${p1}：${scripts.length} 条消息`)

const p2 = ensurePrivate(ids.chenmo, ids.chenyu)
createMessage({ conversationId: p2, senderId: ids.chenyu, kind: 'text', content: '晚上打游戏吗？' })
createMessage({ conversationId: p2, senderId: ids.chenmo, kind: 'text', content: '看情况，先把手上的活干完' })
console.log(`私聊 #${p2}：2 条消息`)

/* ---------- 群聊 ---------- */
const g1 = createGroup('设计部', [ids.linxiaoxia, ids.ajie, ids.xiaolu], ids.chenmo)
const groupScripts = [
  ['ajie', '新方案我已经发到群里了，大家看下'],
  ['xiaolu', '@全体成员 下午 4 点开个短会，10 分钟就够'],
  ['chenmo', '收到，我提前把配色稿整理好'],
]
for (const [who, text] of groupScripts) {
  createMessage({ conversationId: g1, senderId: ids[who], kind: 'text', content: text })
}
/* 给演示群各写一条公告：不然「群公告」这条能力在演示里永远只显示
   「还没有群公告」，界面上看不出它长什么样。 */
updateGroup(g1, { announcement: '本周五 18:00 前提交配色稿；评审顺延到下周一上午。' })
console.log(`群聊 #${g1}：${groupScripts.length} 条消息`)

const g2 = createGroup('摸鱼小分队', [ids.ajie, ids.xiaolu, ids.chenyu], ids.chenmo)
createMessage({ conversationId: g2, senderId: ids.ajie, kind: 'text', content: '哈哈哈哈太真实了' })
createMessage({ conversationId: g2, senderId: ids.xiaolu, kind: 'text', content: '老板刚走过去，我马上切回工作了' })
updateGroup(g2, { announcement: '群里只摸鱼，不谈工作 🐟\n周五下午茶 AA，想来的接龙。' })
console.log(`群聊 #${g2}：2 条消息`)

/* 发现页的「可加入的兴趣群」陈墨不在里面（不然发现页会把他已在的群过滤掉，演示里一条都看不到） */
const ig = seedInterestGroups(ids)
if (ig) console.log(`公开兴趣群 ${ig} 个（发现页可加入）`)

/* ---------- 消息收藏（PRD §9） ----------
   和投票同理：收藏列表空着，界面上就看不出这个功能长什么样。
   这里给演示账号（陈墨）收几条**不同形态**的消息，好把
   「文字 / 图片 / 位置 / 投票」四种收藏卡片都摆在眼前。

   幂等判据是「这个人有没有收藏」。收藏走 favorite.js 的 addFavorite，
   而不是手写 INSERT —— 快照的字段抄写规则只有一处，种子跟着它走才不会漂。 */
function seedFavorites(ids) {
  const uid = ids.chenmo
  if (!uid) return 0
  if (q.get('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?', uid).n > 0) return 0

  /* 挑几条真实的演示消息来收藏：按类型各找一条，找不到就跳过那一种。
     不硬写 message id —— 那些 id 随库的重建而变。

     ⚠️ 每条都要传 `uid`：SQL 里有 `cm.user_id = ?` 占位符，
     漏传参数时 node:sqlite **不会报错**，而是按「参数不足」处理，
     查询静默返回 undefined —— 于是 picks 全空、函数返回 0、
     界面上一条演示收藏都没有，而 seed 的输出看起来完全正常
     （这一步本轮就踩了：`picks = []` 而没有任何报错）。 */
  const pickOne = (kindWhere, extraWhere = '') =>
    q.get(
      `SELECT m.id FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
       WHERE m.kind = ? AND m.revoked_at IS NULL ${extraWhere}
       ORDER BY m.id LIMIT 1`,
      uid,
      kindWhere
    )

  const picks = [
    /* 文字：私聊里林小夏那句「晚上一起去看电影吧～」 */
    pickOne('text', "AND m.content LIKE '%看电影%'"),
    /* 图片 / 位置 / 投票：各来一条，好把四种收藏卡片都摆在眼前 */
    pickOne('image'),
    pickOne('location'),
    pickOne('poll'),
  ].filter(Boolean)

  let made = 0
  for (const row of picks) {
    try {
      const out = addFavorite(uid, row.id)
      if (out.created) made++
    } catch (e) {
      /* 某一种形态找不到（老库的演示数据被改过）—— 跳过它，不中断整个 seed */
      console.warn(`[seed] 跳过一条演示收藏：${e.message}`)
    }
  }
  return made
}

/* ---------- 群投票（PRD §14） ----------
   为什么种子必须有这一条：投票是那种「列表里一条都没有，就完全看不出它能干什么」的功能。
   第一次进演示群看到的应该是一条真的投票气泡（有人投过、票数不是 0），
   而不是一个空荡荡的群 + 一个没人点过的入口。

   幂等判据是「这个群里已经有投票了没有」—— 投票**不能按标题查重**：
   用户完全可以自己发一条同名投票，那就分不清哪条是种子的了。
   投票本身走 poll.js 的 createPoll + votePoll，而不是手写 INSERT ——
   种子手写 SQL 的话，业务逻辑改了（比如取消投票要清名册）种子不会跟着改，
   于是「新装库」和「点了按钮建的」两种数据形状就不一样了。 */
function seedPolls(ids) {
  const targets = q
    .all(`SELECT id FROM conversations WHERE type = 'group' ORDER BY id LIMIT 2`)
    .map((r) => r.id)
  let made = 0
  for (const cid of targets) {
    /* ⚠️ 判据是「有没有**被消息引用的**投票」，不是「有没有 polls 行」——
       只看 polls 表的话，一条没有任何消息指向它的投票（自检清消息时只按 id 基线清了消息）
       就会让这里以为演示已就位，于是**聊天里一条投票都看不到，而库里躺着几条死投票**。
       这正是这个功能第一次做完时踩到的：8 条 polls、0 条 poll 消息。
       投票在界面上永远是「挂在某条消息上」的，所以「有没有消息引用」才是它的存在判据。 */
    const has = q.get(
      `SELECT COUNT(*) AS n FROM polls p
       JOIN messages m ON m.poll_id = p.id AND m.revoked_at IS NULL
       WHERE p.conversation_id = ?`,
      cid
    ).n
    if (has > 0) continue

    const first = made === 0
    const poll = createPoll({
      conversationId: cid,
      creatorId: ids.chenmo,
      question: first ? '周六去哪？' : '下次团建想去哪？',
      options: first ? ['海边', '看电影', '爬山', '吃火锅'] : ['露营', '密室逃脱', 'KTV'],
      multi: !first,
      /* 第二条做成匿名，好让「匿名投票」在演示里也有个样子可看 */
      anonymous: !first,
    }).poll

    /* ⚠️ 光建 polls 行是**看不见的** —— 投票在界面上永远挂在一条消息上。
       真实入口（POST /polls）也是「建投票 + 建 kind='poll' 的消息」两步，
       种子少写这一步的后果很隐蔽：库里躺着两条投票、聊天里一条都看不到
       （第一版就是这么错的，而且 seed 自己还报了「补齐 2 条群投票」）。
       content 放题目是路由那边同样的约定：会话列表预览要用。 */
    createMessage({
      conversationId: cid,
      senderId: ids.chenmo,
      kind: 'poll',
      content: poll.question,
      pollId: poll.id,
    })

    /* 造几条真实投票：不然演示里的票数全是 0，看不出「多选 / 匿名」的区别 */
    const voters = first
      ? [
          [ids.linxiaoxia, [0]],
          [ids.ajie, [1]],
        ]
      : [
          [ids.xiaolu, [0, 1]],
          [ids.ajie, [0]],
        ]
    for (const [uid, picks] of voters) {
      const optionIds = picks.map((i) => poll.options[i]?.id).filter(Boolean)
      if (!optionIds.length) continue
      try {
        votePoll(poll.id, uid, optionIds)
      } catch (e) {
        /* 某人不在群里（老库的群成员可能被用户改过）—— 跳过这条投票，不要因此中止整个 seed */
        console.warn(`[seed] 跳过一票：${e.message}`)
      }
    }
    made++
  }
  return made
}

/* ================= 动态 + 关注关系 =================
   抽成函数是为了让**已有的演示库**也能补上这一块：
   库里已经有用户时（跑过一段时间、还有用户手测的数据），
   `node src/seed.js` 会走 backfill 分支，在这里把动态补进去，
   而不是让人去跑 `npm run reset` —— 那会把会话和消息一起清掉。 */
function seedMoments(ids) {
/* ---------- 关注关系 ----------
   动态的「仅好友可见」是按**互相关注**判的，没有这张表那它就是个假开关。
   所以种子里必须真的把关系建出来，而且要有单向关注 ——
   全是互关的话，「仅好友」和「公开」在演示里看不出区别。 */
const mutualPairs = [
  ['chenmo', 'linxiaoxia'],
  ['chenmo', 'ajie'],
  ['chenmo', 'xiaolu'],
  ['linxiaoxia', 'ajie'],
  ['xiaolu', 'chenyu'],
]
const oneWay = [
  ['chenyu', 'chenmo'], // 陈宇关注陈墨，陈墨没回关 → 陈墨的「仅好友」动态陈宇看不到
  ['chenmo', 'xiatian'], // 反过来：陈墨关注夏天，夏天没回关
]
for (const [a, b] of mutualPairs) {
  q.run('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)', ids[a], ids[b])
  q.run('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)', ids[b], ids[a])
}
for (const [a, b] of oneWay) {
  q.run('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)', ids[a], ids[b])
}
console.log(
  `关注关系：${mutualPairs.length} 对互关 + ${oneWay.length} 条单向`
)

/* ---------- 动态 ---------- */
/**
 * 演示用的「照片」：直接生成 SVG 落到 uploads 里。
 *
 * 为什么不是外链、也不是前端现画的假图：
 * 动态的图片是**真文件**才能走通同一条链路（上传 → 落盘 → 列表渲染 → 点开查看 → 保存），
 * 否则「九宫格」和「点开大图」仍然是画出来的，用户一上传自己的照片就会发现两边不是一回事。
 */
const UPLOAD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')

function scene(kind) {
  const wrap = (inner) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 900 900">${inner}</svg>`
  if (kind === 'beach') {
    return wrap(
      `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffe1b0"/><stop offset=".5" stop-color="#ff9f7a"/><stop offset="1" stop-color="#e8668f"/></linearGradient>
       <linearGradient id="w" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3a7fa8"/><stop offset="1" stop-color="#123a5c"/></linearGradient></defs>
       <rect width="900" height="560" fill="url(#s)"/>
       <circle cx="640" cy="330" r="72" fill="#fff8e6" opacity=".9"/>
       <rect y="560" width="900" height="340" fill="url(#w)"/>
       <path d="M0 640 Q225 600 450 640 T900 640 V900 H0Z" fill="#0d2c48" opacity=".55"/>
       <path d="M0 740 Q225 700 450 740 T900 740 V900 H0Z" fill="#0a2440" opacity=".7"/>
       <path d="M60 560 l40 -70 40 70z" fill="#2c5c47"/><path d="M120 560 l55 -95 55 95z" fill="#22493a"/>`
    )
  }
  if (kind === 'city') {
    return wrap(
      `<defs><linearGradient id="c" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#2b3a67"/><stop offset="1" stop-color="#6b4a8a"/></linearGradient></defs>
       <rect width="900" height="900" fill="url(#c)"/>
       <g fill="#141d38">
         <rect x="60" y="420" width="120" height="480"/><rect x="200" y="300" width="140" height="600"/>
         <rect x="360" y="480" width="110" height="420"/><rect x="490" y="240" width="150" height="660"/>
         <rect x="660" y="380" width="120" height="520"/><rect x="790" y="500" width="110" height="400"/>
       </g>
       <g fill="#ffd98a" opacity=".85">
         <rect x="90" y="470" width="18" height="26"/><rect x="130" y="540" width="18" height="26"/>
         <rect x="240" y="360" width="18" height="26"/><rect x="290" y="430" width="18" height="26"/>
         <rect x="530" y="300" width="18" height="26"/><rect x="580" y="380" width="18" height="26"/>
         <rect x="700" y="430" width="18" height="26"/>
       </g>
       <circle cx="700" cy="180" r="58" fill="#fff2cf" opacity=".9"/>`
    )
  }
  if (kind === 'plant') {
    return wrap(
      `<defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#dff0c8"/><stop offset="1" stop-color="#8fbf6a"/></linearGradient></defs>
       <rect width="900" height="900" fill="url(#p)"/>
       <g fill="#4f7f3c" opacity=".9">
         <ellipse cx="300" cy="420" rx="120" ry="58" transform="rotate(-24 300 420)"/>
         <ellipse cx="560" cy="360" rx="130" ry="62" transform="rotate(18 560 360)"/>
         <ellipse cx="430" cy="620" rx="150" ry="70" transform="rotate(-8 430 620)"/>
       </g>
       <rect x="410" y="620" width="80" height="280" rx="14" fill="#c98b5e"/>
       <rect x="330" y="700" width="240" height="200" rx="24" fill="#b5744d"/>`
    )
  }
  return wrap(
    `<defs><linearGradient id="d" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f2e6d8"/><stop offset="1" stop-color="#cbb39a"/></linearGradient></defs>
     <rect width="900" height="900" fill="url(#d)"/>
     <rect x="150" y="520" width="600" height="300" rx="26" fill="#8a6a52"/>
     <rect x="250" y="330" width="180" height="220" rx="20" fill="#fffaf2"/>
     <rect x="470" y="300" width="200" height="250" rx="14" fill="#6b4a3a"/>
     <circle cx="640" cy="250" r="70" fill="#f8f0e4"/>`
  )
}

/** 写一张演示照片到 uploads，返回可引用的 /uploads/... 地址 */
function writePhoto(name, kind) {
  const file = `seed-${name}.svg`
  fs.writeFileSync(path.join(UPLOAD_DIR, file), scene(kind), 'utf8')
  return `/uploads/${file}`
}

/* ===== 演示视频 =====
   视频不能像照片那样现造（需要编码器），所以两个 mp4 是**提前生成好放在仓库里**的
   （`server/assets/seed/`，ffmpeg 造的渐变动画，横屏 640×360 / 竖屏 360×640）。
   seed 只负责把它们复制进 uploads —— 这样 `npm run reset` 不依赖机器上有没有 ffmpeg。
   文件不在就跳过视频动态（不报错，其余种子照常写）。 */
const SEED_VIDEO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'seed')

function writeVideo(name) {
  const src = path.join(SEED_VIDEO_DIR, name)
  if (!fs.existsSync(src)) return null
  const file = `seed-${name}`
  fs.copyFileSync(src, path.join(UPLOAD_DIR, file))
  return `/uploads/${file}`
}

const momentScripts = [
  {
    who: 'linxiaoxia',
    at: -12 * 60 * 1000,
    content: '海边的风真的会让人忘记一切烦恼 🌊\n下次想在这里看日落。',
    topic: '#周末出逃',
    location: '深圳 · 大鹏湾',
    visibility: 'public',
    photos: ['beach', 'beach', 'beach'],
    likes: ['chenmo', 'ajie', 'xiaolu', 'chenyu'],
    comments: [
      ['chenmo', '这个光绝了，等日落吧'],
      ['xiaolu', '求定位！下次带上我'],
    ],
  },
  {
    who: 'chenmo',
    at: -60 * 60 * 1000,
    content: '今天的光线很好，随手拍了几张。\n摄影这件事，果然还是要等。',
    topic: '#摄影日常',
    location: '杭州 · 良渚',
    visibility: 'public',
    photos: ['city', 'city'],
    likes: ['linxiaoxia', 'xiaolu'],
    comments: [['ajie', '构图太顶了']],
  },
  {
    /* 仅好友：用来验证可见范围是真的 —— 陈宇单关注陈墨，这条他看不到 */
    who: 'ajie',
    at: -3 * 60 * 60 * 1000,
    content: '摸鱼成功的一天 🐟',
    topic: '#摸鱼日记',
    visibility: 'friends',
    likes: ['chenmo'],
    comments: [['chenmo', '低调点，老板在群里']],
  },
  {
    who: 'xiaolu',
    at: -5 * 60 * 60 * 1000,
    content: '分享一首最近单曲循环的歌，戴耳机效果更好 🎧',
    topic: '#音乐',
    visibility: 'public',
    music: { title: '晚风心里吹', artist: '林清野', duration: '3:42' },
    likes: ['chenmo', 'linxiaoxia', 'ajie'],
    comments: [['linxiaoxia', '这首歌我也在循环']],
  },
  {
    /* 仅自己：作者看得到，别人列表里不出现 */
    who: 'chenmo',
    at: -26 * 60 * 60 * 1000,
    content: '整理了一下今年的照片，发现最打动人的\n往往是那些没刻意去拍的瞬间。',
    topic: '#随手记',
    visibility: 'private',
    photos: ['plant'],
    likes: [],
    comments: [],
  },
  {
    who: 'xiatian',
    at: -30 * 60 * 60 * 1000,
    content: '新开的咖啡店，手冲很稳 ☕',
    topic: '#咖啡',
    location: '广州 · 天河',
    visibility: 'public',
    photos: ['desk'],
    likes: ['chenmo'],
    comments: [],
  },
  /* ===== 视频动态 =====
     横屏 + 竖屏各一条：这两条是「横竖屏自适应」的活样本 ——
     列表里它们的容器比例必须不一样（横屏宽幅、竖屏高幅），
     如果两条长得一样方，说明播放器没按真实宽高算，而是被写死成 16:9 了。 */
  {
    who: 'chenyu',
    at: -8 * 60 * 60 * 1000,
    content: '无人机第一次飞起来，手抖得不行 😂\n剪了 6 秒给你们看。',
    topic: '#航拍练习',
    location: '厦门 · 环岛路',
    visibility: 'public',
    video: { file: 'seed-video-landscape.mp4', width: 640, height: 360, duration: 6 },
    likes: ['chenmo', 'linxiaoxia', 'ajie'],
    comments: [
      ['chenmo', '稳住了，第二遍就好多了'],
      ['xiaolu', '这个配色好看'],
    ],
  },
  {
    who: 'xiaolu',
    at: -20 * 60 * 60 * 1000,
    content: '竖着拍的一段，手机上看着刚好 📱',
    topic: '#随手拍',
    visibility: 'public',
    video: { file: 'seed-video-portrait.mp4', width: 360, height: 640, duration: 5 },
    likes: ['chenmo'],
    comments: [['linxiaoxia', '竖屏看着舒服']],
  },
]

let photosWritten = 0
let videosWritten = 0
for (const s of momentScripts) {
  let media = (s.photos || []).map((kind, i) => {
    photosWritten += 1
    return {
      url: writePhoto(`${s.who}-${i + 1}`, kind),
      fileName: `${kind}.svg`,
      kind: 'image',
    }
  })
  if (s.video) {
    const url = writeVideo(s.video.file)
    if (url) {
      videosWritten += 1
      /* 视频与图片互斥，所以是「替换」而不是「追加」 */
      media = [
        {
          url,
          fileName: s.video.file,
          kind: 'video',
          /* 宽高时长和真实文件一致（ffmpeg 造的时候就是这几个数）。
             落库后列表**在加载视频之前**就能按真实比例占位，不会先按方的渲染再跳。 */
          width: s.video.width,
          height: s.video.height,
          duration: s.video.duration,
          fileSize: fs.statSync(path.join(UPLOAD_DIR, url.replace('/uploads/', ''))).size,
        },
      ]
    }
  }
  const id = createMoment({
    userId: ids[s.who],
    content: s.content,
    topic: s.topic,
    location: s.location,
    visibility: s.visibility,
    media,
    music: s.music,
  })
  // created_at 要往后推，否则六条动态的时间戳全挤在同一秒，列表看起来像同时发的
  q.run('UPDATE moments SET created_at = ? WHERE id = ?', Date.now() + s.at, id)
  for (const u of s.likes || []) toggleLike(id, ids[u])
  for (const [u, text] of s.comments || []) {
    addComment({ momentId: id, userId: ids[u], content: text })
  }
}
console.log(
  `动态 ${momentScripts.length} 条（${photosWritten} 张演示照片、${videosWritten} 个演示视频已落到 uploads）`
)
}

seedMoments(ids)

const seededPolls = seedPolls(ids)
console.log(`群投票 ${seededPolls} 条（在演示群里，带真实投票记录）`)

const seededFavs = seedFavorites(ids)
console.log(`消息收藏 ${seededFavs} 条（陈墨的，涵盖文字 / 图片 / 位置 / 投票）`)

console.log('\n可用登录账号：')
for (const u of users) console.log(`  ${u.username.padEnd(12)} 昵称 ${u.nickname}`)
console.log(`\n密码：${DEMO_PASSWORD}\n`)
