/**
 * SQLite 数据层
 * 使用 Node 内置 node:sqlite（零外部依赖，需 Node >= 22.5）
 *
 * 约定：DB 内部 snake_case；API 出参在 routes 里转 camelCase。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'chatly.db')

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(DB_PATH)

db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')
/* 等锁而不是立刻报 SQLITE_BUSY。
   自检脚本会另开一个连接直接改库（清理残留），写事务是错开的 ——
   没有这个超时的话，撞上服务端正在写就会偶发报错，而且是「跑十次错一次」那种最难查的。 */
db.exec('PRAGMA busy_timeout = 5000')

/* ================= 建表 ================= */
/**
 * 允许的消息类型 —— **只在这里写一份**。
 *
 * `routes/messages.js` 的白名单、前端 `isVideoMessage()` / 位置气泡的判断
 * 都必须和它对上；将来再加类型（音乐、文件卡片…）也只改这一个数组。
 *
 * 为什么必须抽成常量：SQLite 改不了 CHECK 约束（没有 ALTER CONSTRAINT），
 * 加类型只能整表重建。建表和重建若各写一份列定义，迟早会漂移
 * —— 重建出来的表少一列，而且是「老库才错、新装库正常」这种最难复现的错。
 */
export const MESSAGE_KINDS = ['text', 'image', 'file', 'video', 'location', 'poll']
const KIND_CHECK = `CHECK (kind IN (${MESSAGE_KINDS.map((k) => `'${k}'`).join(',')}))`

const MESSAGES_COLS = `
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL DEFAULT 'text' ${KIND_CHECK},
  content         TEXT,
  file_url        TEXT,
  file_name       TEXT,
  file_size       INTEGER,
  reply_to_id     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  revoked_at      INTEGER
`
/* 位置消息（kind='location'）的四个字段单独占列，**不去重载 content / file_name** ——
   「用 content 存地点名、file_name 存地址」看着省事，但位置消息和文件消息就混在一个字段里了，
   以后想按地点查、想给位置加附言都下不去手。列多一点，语义是清楚的。 */
const MESSAGES_GEO_COLS = `
  geo_name        TEXT,
  geo_address     TEXT,
  geo_lat         REAL,
  geo_lng         REAL
`
/* 投票消息只指向 polls 的一行，题目 / 选项 / 票数一个都不冗余到 messages ——
   票数是会变的，存一份在消息行上就必然和 poll_votes 打架。
   和位置那四列同样的取舍：语义清楚的列比省列重要。

   ⚠️ 这一列**不在 MESSAGES_COLS 里**是有意的：老库要靠 `ensureMessageKinds()`
   整表重建来补 'poll'，而重建时新表的列定义取自 MESSAGES_COLS —— 如果 poll_id
   写在里面，重建出来的新表会变成一个指向不存在 poll_id 的 INSERT。
   两条路径（新建 / 重建）都会再经过一次 `addColumnIfMissing('messages','poll_id')`，
   所以两边不会漂移。 */
const MESSAGES_POLL_COLS = `
  poll_id         INTEGER
`
const MESSAGES_DDL = `CREATE TABLE IF NOT EXISTS messages (${MESSAGES_COLS}, ${MESSAGES_GEO_COLS}, ${MESSAGES_POLL_COLS});`

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  nickname      TEXT    NOT NULL,
  avatar        TEXT,
  bio           TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL CHECK (type IN ('private','group')),
  title      TEXT,
  avatar     TEXT,
  owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id      INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                 TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  muted                INTEGER NOT NULL DEFAULT 0,
  pinned               INTEGER NOT NULL DEFAULT 0,
  joined_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (conversation_id, user_id)
);

  ${MESSAGES_DDL}

CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);

/* ---------- 动态 ---------- */
CREATE TABLE IF NOT EXISTS moments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','video','music')),
  content        TEXT,
  topic          TEXT,
  location       TEXT,
  visibility     TEXT    NOT NULL DEFAULT 'public'
                         CHECK (visibility IN ('public','friends','private')),
  music_title    TEXT,
  music_artist   TEXT,
  music_duration TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  edited_at      INTEGER
);

/* 动态的图片 / 视频单独一张表：一条动态最多 9 张图，
   塞进 moments 的 content 里就没法按图查、也没法单独删一张。 */
CREATE TABLE IF NOT EXISTS moment_media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  moment_id  INTEGER NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL CHECK (kind IN ('image','video')),
  url        TEXT    NOT NULL,
  file_name  TEXT,
  file_size  INTEGER,
  sort       INTEGER NOT NULL DEFAULT 0,
  /* 视频的宽高与时长：列表要按真实比例占位，不然得等视频加载完才知道是横屏还是竖屏，
     中间会先按方的渲染再跳一下。图片也存，让「竖图 / 横图」能一视同仁地排。
     可为 NULL —— 老数据没有，客户端拿不到就退回固定比例。 */
  width      INTEGER,
  height     INTEGER,
  duration   REAL
);

CREATE TABLE IF NOT EXISTS moment_likes (
  moment_id  INTEGER NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (moment_id, user_id)
);

/* parent_id 自引用：评论可以回复评论（PRD 16.4）。
   reply_to_user_id 记「回复的是谁」，删了那条评论也还能显示「回复 @某人」的语境。 */
CREATE TABLE IF NOT EXISTS moment_comments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  moment_id       INTEGER NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id       INTEGER REFERENCES moment_comments(id) ON DELETE CASCADE,
  reply_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content         TEXT    NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

/* 关注关系。「仅好友可见」需要它 —— 没有这张表的话
   「可见范围」就是一个点了不生效的假开关。 */
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (follower_id, followee_id)
);

CREATE INDEX IF NOT EXISTS idx_moments_user ON moments(user_id, id);
CREATE INDEX IF NOT EXISTS idx_moments_created ON moments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moment_media_moment ON moment_media(moment_id, sort);
CREATE INDEX IF NOT EXISTS idx_moment_comments_moment ON moment_comments(moment_id, id);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

/* ================= 消息收藏 =================
 *
 * ## 为什么是**快照**而不是「指向 messages 的一行引用」
 *
 * 收藏的本质是「这条内容我要留着」。做成引用的话：
 *   · 对方撤回消息 → 收藏跟着变空（getMessage 对已撤回的消息返回空 text）
 *   · 会话被清掉 / 消息被清理 → 收藏直接消失
 * 那就不是收藏了。所以这里把**内容和文件地址抄一份**存下来。
 * 代价有两个，都必须处理，不然就是个半成品：
 *   ① 文件的生命周期：快照的 file_url 是**唯一**还指着那个文件的地方
 *      （原消息删了），所以 purgeOrphanUploads() 必须把它算作引用方
 *      —— 漏了就是「第一次跑清理，收藏的图集体变破图」。
 *   ② 快照会陈旧：原消息编辑不了（消息本来就没有编辑），所以文字不会过期；
 *      头像/昵称属于**发送者**，那个会变 —— 所以 sender 只存 id，
 *      渲染时现查，不抄名字（抄了就是「好友改名后收藏里还是旧名字」）。
 *
 * ## 为什么还要留 message_id
 *
 * 用于「在聊天中查看」：跳过去要定位那一行。但它是 ON DELETE SET NULL
 * 而不是 CASCADE —— 消息被物理删掉时收藏要**活着**，只是跳不过去了。
 * （产品侧没有「删除消息」，只有撤回；物理删除只发生在自检清理和会话级联。）
 *
 * ⚠️ 本段在 db.exec 的模板字符串内部，注释里**不能出现反引号** ——
 * 会把模板提前收掉，整个文件语法错误（这个坑本项目踩过两次了）。
 */
CREATE TABLE IF NOT EXISTS favorites (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /* 原消息。可为 NULL：消息没了收藏还在（见上）。 */
  message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  /* 快照：发送者只存 id（名字/头像会变，渲染时现查） */
  sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind            TEXT    NOT NULL DEFAULT 'text',
  content         TEXT,
  file_url        TEXT,
  file_name       TEXT,
  file_size       INTEGER,
  geo_name        TEXT,
  geo_address     TEXT,
  geo_lat         REAL,
  geo_lng         REAL,
  poll_id         INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

/* 一条消息只能被同一个人收藏一次（重复点就是「已收藏」，不该多出一行）。
   ⚠️ 用**部分**唯一索引：message_id 可能为 NULL（原消息已物理删除），
   而 SQLite 里 NULL 互不相等 —— 不带 WHERE 的话，多行 NULL 不会判重，
   但带着 WHERE 语义更准，也避免把 NULL 行塞进索引。 */
CREATE UNIQUE INDEX IF NOT EXISTS uniq_favorite_msg
  ON favorites(user_id, message_id) WHERE message_id IS NOT NULL;
/* 列表按人查、新到旧 */
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, id DESC);

/* ===== 稍后看 =====
 * 用户在聊天中长按消息 →「稍后看」，把消息保存到稍后看列表。
 * 稍后看列表独立于收藏，用于标记「稍后需要处理」的消息。
 *
 * 和收藏的区别：
 * - 收藏是**快照**（消息撤回后还在）
 * - 稍后看是**引用**（消息撤回/删除后条目消失）
 * - 收藏适合「重要内容存档」，稍后看适合「待办事项」
 */
CREATE TABLE IF NOT EXISTS watch_later (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

/* 同一个人对同一条消息只能稍后看一次 */
CREATE UNIQUE INDEX IF NOT EXISTS uniq_watch_later_msg
  ON watch_later(user_id, message_id);
/* 列表按人查、新到旧 */
CREATE INDEX IF NOT EXISTS idx_watch_later_user ON watch_later(user_id, id DESC);

/* ===== 用户设置 =====
 * 存储用户的各种设置（通知、隐私、通用等）
 * key-value 结构，value 存 JSON 字符串
 */
CREATE TABLE IF NOT EXISTS user_settings (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  PRIMARY KEY (user_id, key)
);

/* ===== 登录设备 =====
 * 记录用户登录过的设备，用于设备管理和安全审计
 */
CREATE TABLE IF NOT EXISTS user_devices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT    NOT NULL,
  device_type TEXT    NOT NULL DEFAULT 'unknown',
  last_active INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  is_current  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);
`)

/* ================= 迁移（幂等） ================= */
/**
 * users 的资料字段是后加的，逐列补齐。
 * SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，只能先查 PRAGMA 再决定加不加 ——
 * 这样老库直接跑起来也能长出新列，不用删库重建。
 */
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (cols.some((c) => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  return true
}

{
  const added = []
  if (addColumnIfMissing('users', 'gender', 'gender TEXT')) added.push('gender')
  if (addColumnIfMissing('users', 'birthday', 'birthday TEXT')) added.push('birthday')
  if (addColumnIfMissing('users', 'region', 'region TEXT')) added.push('region')
  if (addColumnIfMissing('users', 'tags', 'tags TEXT')) added.push('tags')
  // tags 存 JSON 文本（SQLite 没有数组类型）：'["电影","旅行"]'
  if (added.length) console.log(`[db] users 表已补充字段：${added.join(', ')}`)
}

/* 群是否公开在「发现页」里被找到。
   ⚠️ 不加这一列，发现页就只能列出**所有**群 —— 那等于把「设计部」这种工作群
   挂牌公开，任何人点一下就能进。默认 0（不公开），种子里显式打开那几个兴趣群。 */
{
  if (addColumnIfMissing('conversations', 'discoverable', 'discoverable INTEGER NOT NULL DEFAULT 0')) {
    console.log('[db] conversations 表已补充字段：discoverable')
  }
}

/* 动态媒体的宽高 / 时长 —— 视频动态要按真实比例占位（横屏宽幅、竖屏高幅），
   这两个数是发布时由客户端读出来的。老库逐列补齐，不用删库重建。 */
{
  const added = []
  if (addColumnIfMissing('moment_media', 'width', 'width INTEGER')) added.push('width')
  if (addColumnIfMissing('moment_media', 'height', 'height INTEGER')) added.push('height')
  if (addColumnIfMissing('moment_media', 'duration', 'duration REAL')) added.push('duration')
  if (added.length) console.log(`[db] moment_media 表已补充字段：${added.join(', ')}`)
}

/**
 * 把 messages.kind 的 CHECK 补齐到 `MESSAGE_KINDS` —— SQLite 没有 ALTER CONSTRAINT，
 * 改 CHECK 只能整表重建。标准的 12 步流程，几个不能省的点：
 *
 *   1. `PRAGMA foreign_keys = OFF` 必须在 BEGIN **之前** ——
 *      在事务里改这个 pragma 是空操作（SQLite 明确规定），
 *      那样 DROP TABLE 时外键动作会直接参与进来。
 *   2. 重建完不能只看行数对不对，要跑 `PRAGMA foreign_key_check`：
 *      行数一样但引用断了的情况，`foreign_key_check` 才抓得到。
 *   3. `reply_to_id` 是自引用（`REFERENCES messages(id)`），
 *      所以新表建出来时旧表必须还在，最后一步才改名。
 *   4. 幂等：先读 sqlite_master 的建表语句，**每个** kind 都在里面就什么都不做。
 *      ⚠️ 判据要按 `MESSAGE_KINDS` 全量比，不能只比最新加的那个 ——
 *      只比 'location' 的话，一个停在「有 video 没 location」的老库会被判成已升级。
 *
 * 宁可多写几步，也不要让人去跑 `npm run reset`（那会把会话和消息一起清掉）。
 */
function ensureMessageKinds() {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'`).get()
  if (!row) return false
  const missing = MESSAGE_KINDS.filter((k) => !row.sql.includes(`'${k}'`))
  if (!missing.length) return false

  const cols = db.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name)
  const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n

  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN')
  try {
    db.exec(`
      CREATE TABLE messages_new (${MESSAGES_COLS}, ${MESSAGES_GEO_COLS});
      INSERT INTO messages_new (${cols.join(', ')})
        SELECT ${cols.join(', ')} FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;
      CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id, id);
    `)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    db.exec('PRAGMA foreign_keys = ON')
    throw new Error(`messages 表重建失败（已回滚，未改动数据）：${e.message}`)
  }
  db.exec('PRAGMA foreign_keys = ON')

  const after = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n
  const bad = db.prepare('PRAGMA foreign_key_check').all()
  if (after !== before) {
    throw new Error(`messages 表重建后行数对不上：${before} → ${after}（未提交前已回滚？请检查备份）`)
  }
  if (bad.length) {
    throw new Error(`messages 表重建后有 ${bad.length} 条外键引用断裂`)
  }
  console.log(
    `[db] messages 表已重建：kind 补上 ${missing.join(' / ')}（${after} 条消息完整迁移）`
  )
  return true
}

try {
  ensureMessageKinds()
} catch (e) {
  console.error('[db] 迁移失败：', e.message)
  process.exit(1)
}

/* 位置消息的四个字段。
   单独补一次是因为两条升级路径都要覆盖：
   ① 刚从老库重建完（重建时已经带上这四列，这里会全部跳过）；
   ② CHECK 早就含 'location'、只是列还没加（中间态的开发库）。 */
{
  const added = []
  if (addColumnIfMissing('messages', 'geo_name', 'geo_name TEXT')) added.push('geo_name')
  if (addColumnIfMissing('messages', 'geo_address', 'geo_address TEXT')) added.push('geo_address')
  if (addColumnIfMissing('messages', 'geo_lat', 'geo_lat REAL')) added.push('geo_lat')
  if (addColumnIfMissing('messages', 'geo_lng', 'geo_lng REAL')) added.push('geo_lng')
  if (added.length) console.log(`[db] messages 表已补充字段：${added.join(', ')}`)
}

/* 投票消息（kind='poll'）的 poll_id 列 —— 覆盖两条升级路径：
   ① 刚从老库整表重建完（重建已带上这列，这里全部跳过）；
   ② CHECK 早就含 'poll'、只是列还没加（中间态的开发库）。
   和上面位置那四列是同一个写法。 */
{
  if (addColumnIfMissing('messages', 'poll_id', 'poll_id INTEGER')) {
    console.log('[db] messages 表已补充字段：poll_id')
  }
}

/* 位置隐私：**只存城市级坐标**，绝不存用户的精确位置。
   `city_*` 是用户自己在「我页 → 所在地区」点「使用当前位置」并**明确同意公开城市**后才写；
   `city_public = 0` 时对外一律当作没有位置（发现页退回「未知地区」，不编）。
   谁都没设置过 → 全表为 NULL，发现页就维持原样，不会凭空冒出公里数。 */
{
  const added = []
  if (addColumnIfMissing('users', 'city', 'city TEXT')) added.push('city')
  if (addColumnIfMissing('users', 'city_lat', 'city_lat REAL')) added.push('city_lat')
  if (addColumnIfMissing('users', 'city_lng', 'city_lng REAL')) added.push('city_lng')
  if (addColumnIfMissing('users', 'city_public', 'city_public INTEGER NOT NULL DEFAULT 0')) {
    added.push('city_public')
  }
  if (added.length) console.log(`[db] users 表已补充字段：${added.join(', ')}`)
}

/* 动态的地点坐标：选了 POI 才有，手输的位置名没有 —— 这时坐标留 NULL，
   界面照旧只显示名字，**不假装它在地图上有位置**。 */
{
  const added = []
  if (addColumnIfMissing('moments', 'location_lat', 'location_lat REAL')) added.push('location_lat')
  if (addColumnIfMissing('moments', 'location_lng', 'location_lng REAL')) added.push('location_lng')
  if (added.length) console.log(`[db] moments 表已补充字段：${added.join(', ')}`)
}

{
  /* 群聊扩展字段。加列比重建表安全得多（SQLite 的 ADD COLUMN 不动已有数据），
     所以凡是「新增可空列」都走这里，只有改 CHECK 才被迫重建。 */
  const added = []
  if (addColumnIfMissing('conversations', 'announcement', 'announcement TEXT')) {
    added.push('announcement')
  }
  if (addColumnIfMissing('conversations', 'announcement_at', 'announcement_at INTEGER')) {
    added.push('announcement_at')
  }
  if (addColumnIfMissing('conversations', 'mute_all', 'mute_all INTEGER NOT NULL DEFAULT 0')) {
    added.push('mute_all')
  }
  if (addColumnIfMissing('conversations', 'admin_only', 'admin_only INTEGER NOT NULL DEFAULT 0')) {
    added.push('admin_only')
  }
  if (added.length) console.log(`[db] conversations 表已补充字段：${added.join(', ')}`)
}

/* ================= 群投票 =================
 *
 * 四张表，而不是「一条消息里塞一段 JSON」：
 *   票数会被查询、会被排序、要按选项聚合、还要回答「我投了没」——
 *   塞进 JSON 就只能在应用层用 JS 过滤，分页和统计立刻变成全表扫描。
 *   （同一个理由写在 chat.js：本项目的原则是别让两处数据打架。）
 *
 * 为什么选项票数不存一个 `count` 列：**计数是可以算出来的，存下来就要维护**。
 * 投票 / 改票 / 取消投票三处都要记得减一，漏一处就是一个永远对不上的数字。
 * 所以真相只有 `poll_votes` 一张表，票数一律 COUNT 出来。
 *
 * 一条投票被撤回的消息挂着的 poll 行**不删**：撤回的语义是「这条消息不作数了」，
 * 不是「投票的历史被抹掉」。界面上它渲染成一条已撤回的消息，投票数据留着不影响任何统计
 * （投票列表也只列「消息还在」的那些）。
 * 投票行只在会话被真删（成员清零 → conversations 级联）时跟着 CASCADE 消失。
 */
db.exec(`
CREATE TABLE IF NOT EXISTS polls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  creator_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question        TEXT    NOT NULL,
  multi           INTEGER NOT NULL DEFAULT 0,
  anonymous       INTEGER NOT NULL DEFAULT 0,
  deadline        INTEGER,
  closed_at       INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS poll_options (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id  INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  text     TEXT    NOT NULL,
  sort     INTEGER NOT NULL DEFAULT 0
);

-- 一行 = 某人对某个选项的一票。多选就是同一个人对同一 poll 有多行。
CREATE TABLE IF NOT EXISTS poll_votes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id   INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- 附言：一个人对一条投票最多一条，靠下面的唯一索引挡重复。
-- 只用来回答「还有谁投了」，不承载「投了哪些选项」——那是 poll_votes 的事。
CREATE TABLE IF NOT EXISTS poll_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id    INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_polls_conversation ON polls(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id, sort);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id, user_id);
CREATE INDEX IF NOT EXISTS idx_poll_replies_poll ON poll_replies(poll_id, user_id);
-- 唯一索引带上 user_id IS NOT NULL：SQLite 里 NULL 互不相等，不带条件的话
-- 一堆 user_id 为 NULL 的行不会被判重复（本项目不会有这种行，但索引语义要写准）。
CREATE UNIQUE INDEX IF NOT EXISTS uniq_poll_reply_user
  ON poll_replies(poll_id, user_id) WHERE user_id IS NOT NULL;
`)

/* ================= 通用查询助手 ================= */
export const q = {
  all: (sql, ...args) => db.prepare(sql).all(...args),
  get: (sql, ...args) => db.prepare(sql).get(...args),
  run: (sql, ...args) => db.prepare(sql).run(...args),
}

/** 插入后返回自增 id —— node:sqlite 的 lastInsertRowid 在 TEXT 主键表不可靠，但这里是 INTEGER 自增，可用 */
export function insert(sql, ...args) {
  const r = db.prepare(sql).run(...args)
  return Number(r.lastInsertRowid)
}

export function tx(fn) {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export { DB_PATH }
