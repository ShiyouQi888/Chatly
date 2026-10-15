/**
 * PostgreSQL 驱动（线上）
 *
 * ## 与 SQLite 的接口完全一致
 *
 * `q.all/get/run`、`insert`、`tx`、`exec`、`close`、`info` —— 名字与签名都一样，
 * 只有 `raw`（SQLite 的同步句柄）没有。上层代码一律 `await`，不分叉。
 *
 * ## 三个不得不处理的差异
 *
 * 1. **类型映射。** `pg` 默认把 `int8`(OID 20) 解析成**字符串**（怕超 2^53 丢精度），
 *    而我们的 `created_at` 是 epoch 毫秒（约 1.7e12）、`COUNT(*)` 也是 int8 ——
 *    不覆盖的话时间戳会变成 `"1791863511047"` 这种字符串，
 *    直接后果是前端 `formatAgo()` 拿到字符串算不出相对时间，
 *    而且是**静默**的（接口 200、字段有值，只是类型不对）。
 *    `numeric`(1700) 同理（SUM 的结果）。
 *    → 统一解析成 Number。本项目没有超过 2^53 的数。
 *
 * 2. **事务不能用连接池。** `tx()` 必须独占一条连接，而且 `fn` 里**所有** `q.*`
 *    都得走那条连接 —— 否则事务是空的，BEGIN 在 A 连接、INSERT 在 B 连接，
 *    回滚自然回滚不掉。用 AsyncLocalStorage 把「当前事务连接」隐式传下去。
 *
 * 3. **占位符 / 方言。** 应用层写的是 SQLite 风格的 `?`，在这里翻成 `$n`（见 sql.js）。
 *
 * ## 反例：为什么不用「同步桥」保住原来的同步签名
 *
 * 让 PG 变成同步调用只有一条路：把查询丢进 worker 线程再用 Atomics.wait 阻塞主线程。
 * 那意味着**每一次查询都把整个进程卡住** —— 对一个 WebSocket 聊天服务来说，
 * 某个人的一次慢查询会冻结所有人的心跳与消息。省下的重构量换不来这个。
 */
import pg from 'pg'
import { AsyncLocalStorage } from 'node:async_hooks'

import { envInt } from '../env.js'
import { toPostgres, withReturningId, restoreAliasCase } from './sql.js'
import { MESSAGE_KINDS, NOTIFICATION_KINDS } from './kinds.js'

const { Pool, types } = pg

/* ---- 类型解析：见文件头第 1 条 ---- */
types.setTypeParser(20, (v) => (v === null ? null : Number(v))) // int8
types.setTypeParser(1700, (v) => (v === null ? null : Number(v))) // numeric

const CONNECTION_STRING = process.env.DATABASE_URL
if (!CONNECTION_STRING) {
  throw new Error(
    'DB_DRIVER=postgres 需要 DATABASE_URL（例：postgres://chatly:chatly_dev_pw@127.0.0.1:55433/chatly）。' +
      '本地开发不用设 DB_DRIVER，默认走 SQLite。',
  )
}

export const pool = new Pool({
  connectionString: CONNECTION_STRING,
  /* 进程数 × 这个值不要超过 PG 的 max_connections（默认 100） */
  max: envInt('PG_POOL_MAX', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
})

pool.on('error', (e) => {
  /* 空闲连接被服务端掐掉是正常的（PG 会关 idle 超时的连接），
     但**必须打出来** —— 否则「偶发 500」会变成查不出原因的那种。 */
  console.error('[pg] 空闲连接出错（已丢弃，下次请求会重建）：', e.message)
})

/** 当前事务连接。没有它的话 `tx()` 里所有的 `q.*` 都会跑到池子上，事务形同虚设。 */
const als = new AsyncLocalStorage()

function explain(e, sql) {
  /* PG 的报错信息在 e.message 里，但**不带是哪句 SQL** —— 加上这一句，
     排查「哪个字段名写错了」从「翻遍调用栈」变成「看一眼」。 */
  const one = String(sql).replace(/\s+/g, ' ').trim().slice(0, 160)
  const err = new Error(`${e.message} :: ${one}`)
  err.code = e.code
  err.detail = e.detail
  return err
}

/**
 * 建表 + 迁移。幂等，可以反复调用。
 *
 * ⚠️ 用 `pool.query` 而不是 `q.*` —— 否则 `q.*` 又要 await ready()，
 *    自己把自己递归进去。
 */
async function initSchema() {
  try {
    await pool.query(toPostgres(SCHEMA).text)
    for (const [table, ddl] of BACKFILL_COLUMNS) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${ddl}`)
    }
    await pool.query('UPDATE users SET city_lat = NULL, city_lng = NULL WHERE city_public = 0')
    await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_burn_at ON messages(burn_at) WHERE burn_at IS NOT NULL')
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_devices_session ON user_devices(session_id) WHERE session_id IS NOT NULL')
    await ensureMessageKinds(MESSAGE_KINDS)
    await ensureConstraintKinds('notifications', 'notifications_kind_check', NOTIFICATION_KINDS)
  } catch (e) {
    console.error('[pg] 初始化失败：', e.message)
    throw e
  }
}

let readyPromise = null

/**
 * 惰性初始化：**第一次查询时**自动建表 + 迁移。
 *
 * 为什么不做成「import 时初始化」：SQLite 是同步的，import 完就建好了；
 * PG 是异步的，而 `db.js` 是被**同步 import** 的（`import { q } from './db.js'`）。
 * 要么让每个调用方记得先 await 一个 init，要么就在这里兜住 —— 后者不会漏。
 * 服务端启动时仍会显式 await 一次（`await ready()`），为的是**早失败**：
 * 连不上 PG 应该在启动时就报出来，而不是等第一个用户请求。
 */
export function ready() {
  if (!readyPromise) readyPromise = initSchema()
  return readyPromise
}

async function run(kind, sql, args) {
  await ready()
  const client = als.getStore()?.client
  const exec = client ?? pool
  /* `toPostgres` 同时负责把 `?` 与 `@name` 收敛成 `$n`，并把 values 排好 ——
     所以这里拿到的是「可以直接喂给 pg 的」一对 (text, values)。 */
  const { text, values } = toPostgres(sql, args)
  let r
  try {
    r = await exec.query(text, values)
  } catch (e) {
    throw explain(e, text)
  }
  /* ★ PG 把未加引号的标识符折成小写，SQLite 不折叠 —— 不还原的话
     `SELECT id AS userId` 在 PG 上给的键是 `userid`，调用方拿到的就是 undefined。
     还原用**原文 SQL**（不是翻过的 text），于是 `AS` 在哪个位置都能认出来。 */
  const rows = restoreAliasCase(r.rows, sql)
  if (kind === 'get') return rows[0] ?? undefined
  if (kind === 'all') return rows
  return { changes: r.rowCount, lastInsertRowid: null }
}

export const q = {
  all: (sql, ...args) => run('all', sql, args),
  get: (sql, ...args) => run('get', sql, args),
  run: (sql, ...args) => run('run', sql, args),
}

/** 插入后返回自增 id。PG 没有 lastInsertRowid，靠 `RETURNING id` */
export async function insert(sql, ...args) {
  await ready()
  const { text: sqlText, values } = toPostgres(sql, args)
  const text = withReturningId(sqlText)
  const client = als.getStore()?.client
  const exec = client ?? pool
  try {
    const r = await exec.query(text, values)
    const id = r.rows[0]?.id
    if (id === undefined) {
      throw new Error(`insert() 没拿到 RETURNING id —— SQL 是不是指向了一张没有 id 列的表？:: ${text.slice(0, 120)}`)
    }
    return Number(id)
  } catch (e) {
    throw explain(e, text)
  }
}

/**
 * 事务。`await tx(async () => { … })`。
 *
 * ⚠️ `fn` 里必须用 `q.*` / `insert()`，**不要**直接用 `pool.query()` ——
 *    那样会拿到池子里另一条连接，跑到事务外面去（不会报错，只是回滚不掉）。
 *    `q.*` 是通过 AsyncLocalStorage 认连接的，所以异步链路上也认得出来。
 */
export async function tx(fn) {
  await ready()
  const parent = als.getStore()?.client
  if (parent) {
    /* 嵌套调用：已经在一个事务里了，用 SAVEPOINT 做内层，
       这样内层失败只回滚内层，不会被外层那道 BEGIN 报错打断。 */
    const name = 'sp_' + Math.random().toString(36).slice(2, 10)
    await parent.query(`SAVEPOINT ${name}`)
    try {
      const out = await fn()
      await parent.query(`RELEASE SAVEPOINT ${name}`)
      return out
    } catch (e) {
      await parent.query(`ROLLBACK TO SAVEPOINT ${name}`)
      throw e
    }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const out = await als.run({ client }, () => fn())
    await client.query('COMMIT')
    return out
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* 连接已经坏了，回滚失败不该盖住原始错误 */
    }
    throw e
  } finally {
    client.release()
  }
}

/** 执行**多条**无参数语句（DDL / 迁移）。有参数请走 q.* */
export async function exec(sql) {
  await ready()
  await pool.query(toPostgres(sql).text)
}

export async function close() {
  await pool.end()
}

export function info() {
  const u = new URL(CONNECTION_STRING)
  return { driver: 'postgres', host: u.hostname, port: u.port, database: u.pathname.slice(1) }
}

/* ================= 建表 =================
 *
 * 与 SQLite 的那份**刻意保持同样的表名与列名**（连 0/1 的布尔都不用 PG 的真 BOOLEAN）——
 * 这样应用层的 `row.pinned === 1`、`!!row.anonymous` 这类判断两边都成立，
 * 不需要「按驱动写两套取值」。少一层分叉就少一处会漂的地方。
 *
 * 时间戳一律 BIGINT（epoch，秒或毫秒由各表自己约定，和 SQLite 完全一致）。
 * id 用 INTEGER IDENTITY（int4，21 亿够用），**不用 BIGSERIAL** ——
 * int8 即便被我们解析成 Number，也没必要为 id 增加一个隐形上限。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  nickname      TEXT    NOT NULL,
  avatar        TEXT,
  bio           TEXT,
  profile_cover TEXT,
  email         TEXT,
  created_at    BIGINT  NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())::bigint),
  gender        TEXT,
  birthday      TEXT,
  region        TEXT,
  tags          TEXT,
  phone         TEXT,
  city          TEXT,
  city_lat      DOUBLE PRECISION,
  city_lng      DOUBLE PRECISION,
  city_public   INTEGER NOT NULL DEFAULT 0,
  is_banned     INTEGER NOT NULL DEFAULT 0,
  ban_reason    TEXT,
  banned_at     BIGINT,
  banned_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id              INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  type            TEXT    NOT NULL CHECK (type IN ('private','group')),
  title           TEXT,
  avatar          TEXT,
  owner_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      BIGINT  NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())::bigint),
  updated_at      BIGINT  NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())::bigint),
  discoverable    INTEGER NOT NULL DEFAULT 0,
  announcement    TEXT,
  announcement_at BIGINT,
  mute_all        INTEGER NOT NULL DEFAULT 0,
  admin_only      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id      INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                 TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  muted                INTEGER NOT NULL DEFAULT 0,
  pinned               INTEGER NOT NULL DEFAULT 0,
  joined_at            BIGINT  NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())::bigint),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL DEFAULT 'text'
                  CONSTRAINT messages_kind_check CHECK (kind IN ('text','image','file','video','location','poll')),
  content         TEXT,
  file_url        TEXT,
  file_name       TEXT,
  file_size       BIGINT,
  reply_to_id     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at      BIGINT  NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint),
  revoked_at      BIGINT,
  content_encrypted INTEGER NOT NULL DEFAULT 0,
  burn_at         BIGINT,
  geo_name        TEXT,
  geo_address     TEXT,
  geo_lat         DOUBLE PRECISION,
  geo_lng         DOUBLE PRECISION,
  poll_id         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS moments (
  id             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','video','music')),
  content        TEXT,
  topic          TEXT,
  location       TEXT,
  location_lat   DOUBLE PRECISION,
  location_lng   DOUBLE PRECISION,
  visibility     TEXT    NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','friends','private')),
  music_title    TEXT,
  music_artist   TEXT,
  music_duration TEXT,
  created_at     BIGINT  NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint),
  edited_at      BIGINT
);

CREATE TABLE IF NOT EXISTS moment_media (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  moment_id  INTEGER NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL CHECK (kind IN ('image','video')),
  url        TEXT    NOT NULL,
  file_name  TEXT,
  file_size  BIGINT,
  sort       INTEGER NOT NULL DEFAULT 0,
  width      INTEGER,
  height     INTEGER,
  duration   DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS moment_cards (
  moment_id INTEGER PRIMARY KEY REFERENCES moments(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('poll','activity','link')),
  payload   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moment_cards_kind ON moment_cards(kind, moment_id);
CREATE INDEX IF NOT EXISTS idx_moments_topic_created ON moments(topic, created_at DESC);

CREATE TABLE IF NOT EXISTS moment_topic_views (
  topic     TEXT NOT NULL,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at BIGINT NOT NULL,
  PRIMARY KEY (topic, user_id)
);
CREATE INDEX IF NOT EXISTS idx_moment_topic_views_recent ON moment_topic_views(viewed_at DESC);

CREATE TABLE IF NOT EXISTS moment_card_votes (
  moment_id  INTEGER NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_idx INTEGER NOT NULL,
  created_at BIGINT NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint),
  PRIMARY KEY (moment_id, user_id, option_idx)
);
CREATE INDEX IF NOT EXISTS idx_moment_card_votes ON moment_card_votes(moment_id, option_idx);

CREATE TABLE IF NOT EXISTS moment_card_voters (
  moment_id BIGINT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint),
  PRIMARY KEY (moment_id, user_id)
);
INSERT INTO moment_card_voters (moment_id, user_id, created_at)
  SELECT moment_id, user_id, MIN(created_at) FROM moment_card_votes GROUP BY moment_id, user_id
  ON CONFLICT (moment_id, user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS moment_card_rsvps (
  moment_id  INTEGER NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('going','interested')),
  created_at BIGINT NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint),
  PRIMARY KEY (moment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_moment_card_rsvps ON moment_card_rsvps(moment_id, status);

CREATE TABLE IF NOT EXISTS moment_likes (
  moment_id  INTEGER NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT  NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint),
  PRIMARY KEY (moment_id, user_id)
);

CREATE TABLE IF NOT EXISTS moment_comments (
  id               INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  moment_id        INTEGER NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id        INTEGER REFERENCES moment_comments(id) ON DELETE CASCADE,
  reply_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content          TEXT    NOT NULL,
  created_at       BIGINT  NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint)
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  BIGINT  NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())::bigint),
  PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE IF NOT EXISTS user_statuses (
  id          INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  mood        TEXT NOT NULL DEFAULT '✨',
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_statuses_expiry ON user_statuses(expires_at);
CREATE TABLE IF NOT EXISTS status_views (
  status_id  INTEGER NOT NULL REFERENCES user_statuses(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at  BIGINT NOT NULL,
  PRIMARY KEY (status_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_moments_user ON moments(user_id, id);
CREATE INDEX IF NOT EXISTS idx_moments_created ON moments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moment_media_moment ON moment_media(moment_id, sort);
CREATE INDEX IF NOT EXISTS idx_moment_comments_moment ON moment_comments(moment_id, id);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

CREATE TABLE IF NOT EXISTS favorites (
  id              INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind            TEXT    NOT NULL DEFAULT 'text',
  content         TEXT,
  content_encrypted INTEGER NOT NULL DEFAULT 0,
  file_url        TEXT,
  file_name       TEXT,
  file_size       BIGINT,
  geo_name        TEXT,
  geo_address     TEXT,
  geo_lat         DOUBLE PRECISION,
  geo_lng         DOUBLE PRECISION,
  poll_id         INTEGER,
  created_at      BIGINT  NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_favorite_msg
  ON favorites(user_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, id DESC);

CREATE TABLE IF NOT EXISTS watch_later (
  id              INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at      BIGINT  NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_watch_later_msg ON watch_later(user_id, message_id);
CREATE INDEX IF NOT EXISTS idx_watch_later_user ON watch_later(user_id, id DESC);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT    NOT NULL,
  value   TEXT    NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS user_devices (
  id          INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT    NOT NULL,
  device_type TEXT    NOT NULL DEFAULT 'unknown',
  session_id  TEXT UNIQUE,
  last_active BIGINT  NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint),
  is_current  INTEGER NOT NULL DEFAULT 0,
  created_at  BIGINT  NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint)
);
CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);

CREATE TABLE IF NOT EXISTS feedbacks (
  id             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           TEXT    NOT NULL DEFAULT 'other',
  description    TEXT    NOT NULL,
  contact        TEXT,
  screenshot_url TEXT,
  created_at     BIGINT  NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint),
  status         TEXT NOT NULL DEFAULT 'open',
  handled_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  handled_at     BIGINT
);
CREATE INDEX IF NOT EXISTS idx_feedbacks_user ON feedbacks(user_id, id DESC);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id          INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  admin_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   INTEGER,
  detail      TEXT,
  created_at  BIGINT NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint)
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at DESC);
CREATE TABLE IF NOT EXISTS admin_staff (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('moderator','support','analyst')),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  BIGINT NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint)
);
CREATE TABLE IF NOT EXISTS auth_identities (
  kind        TEXT NOT NULL CHECK (kind IN ('phone','email')),
  address     TEXT NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at BIGINT NOT NULL,
  PRIMARY KEY (kind, address),
  UNIQUE (user_id, kind)
);
CREATE TABLE IF NOT EXISTS auth_verification_codes (
  kind       TEXT NOT NULL CHECK (kind IN ('phone','email')),
  address    TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (kind, address)
);

/* 互动通知 —— 列定义与 CHECK 必须和 db/sqlite.js 里的 notifications 一字不差，
   否则「SQLite 下能存、PG 下报约束错」这种只在生产出现的问题又会重演一遍。
   （语义、为什么只给 @我和私聊落行，都写在那边。）
   ⚠️ 这里的 kind 清单同样**不要手写**：老库靠下面 ensureNotificationKinds 自愈。 */
CREATE TABLE IF NOT EXISTS notifications (
  id              INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('message','mention','like','comment','follow','group','system')),
  ref_id          INTEGER,
  ref_parent_id   INTEGER,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  body            TEXT,
  read_at         BIGINT,
  created_at      BIGINT  NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS polls (
  id              INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  creator_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question        TEXT    NOT NULL,
  multi           INTEGER NOT NULL DEFAULT 0,
  anonymous       INTEGER NOT NULL DEFAULT 0,
  deadline        BIGINT,
  closed_at       BIGINT,
  created_at      BIGINT  NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint)
);

CREATE TABLE IF NOT EXISTS poll_options (
  id      INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  text    TEXT    NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_votes (
  id        INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  poll_id   INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint)
);

CREATE TABLE IF NOT EXISTS poll_replies (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  poll_id    INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  created_at BIGINT  NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::bigint)
);

CREATE INDEX IF NOT EXISTS idx_polls_conversation ON polls(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id, sort);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id, user_id);
CREATE INDEX IF NOT EXISTS idx_poll_replies_poll ON poll_replies(poll_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_poll_reply_user
  ON poll_replies(poll_id, user_id) WHERE user_id IS NOT NULL;
`

/* 历史上「后加」的列。新建库时上面的 DDL 已经带上了，这里是给**老库**补的 ——
   PG 的 `ADD COLUMN IF NOT EXISTS` 天生幂等，不需要像 SQLite 那样先查 PRAGMA。 */
const BACKFILL_COLUMNS = [
  ['users', 'gender TEXT'],
  ['users', 'birthday TEXT'],
  ['users', 'region TEXT'],
  ['users', 'tags TEXT'],
  ['users', 'phone TEXT'],
  ['users', 'profile_cover TEXT'],
  ['users', 'email TEXT'],
  ['users', 'city TEXT'],
  ['users', 'city_lat DOUBLE PRECISION'],
  ['users', 'city_lng DOUBLE PRECISION'],
  ['users', 'city_public INTEGER NOT NULL DEFAULT 0'],
  ['users', 'is_banned INTEGER NOT NULL DEFAULT 0'],
  ['users', 'ban_reason TEXT'],
  ['users', 'banned_at BIGINT'],
  ['users', 'banned_by INTEGER REFERENCES users(id) ON DELETE SET NULL'],
  ['feedbacks', "status TEXT NOT NULL DEFAULT 'open'"],
  ['feedbacks', 'handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL'],
  ['feedbacks', 'handled_at BIGINT'],
  ['conversations', 'discoverable INTEGER NOT NULL DEFAULT 0'],
  ['conversations', 'announcement TEXT'],
  ['conversations', 'announcement_at BIGINT'],
  ['conversations', 'mute_all INTEGER NOT NULL DEFAULT 0'],
  ['conversations', 'admin_only INTEGER NOT NULL DEFAULT 0'],
  ['messages', 'geo_name TEXT'],
  ['messages', 'geo_address TEXT'],
  ['messages', 'geo_lat DOUBLE PRECISION'],
  ['messages', 'geo_lng DOUBLE PRECISION'],
  ['messages', 'poll_id INTEGER'],
  ['moment_media', 'width INTEGER'],
  ['moment_media', 'height INTEGER'],
  ['moment_media', 'duration DOUBLE PRECISION'],
  ['moments', 'location_lat DOUBLE PRECISION'],
  ['moments', 'location_lng DOUBLE PRECISION'],
  ['user_devices', 'session_id TEXT'],
  ['messages', 'content_encrypted INTEGER NOT NULL DEFAULT 0'],
  ['messages', 'burn_at BIGINT'],
  ['favorites', 'content_encrypted INTEGER NOT NULL DEFAULT 0'],
]

/**
 * 把某张表 kind 列的 CHECK 补齐到给定清单（messages / notifications 共用一份实现）。
 *
 * SQLite 没有 ALTER CONSTRAINT，只能整表重建（见 db/sqlite.js 那边）。
 * PG 这边简单得多：CHECK 是有名字的约束，删了再加即可，**数据一行不动** ——
 * 但「幂等 + 全量比对」这两条要求和 SQLite 那边完全一致，理由也一样：
 * 只比最新加的那个 kind 的话，一个停在「有 video 没 location」的老库会被判成已升级。
 *
 * notifications 就是现成的例子：开发期 DDL 漏写了 group，
 * 而 PG 侧靠这个自愈补上，不需要有人删库重建。
 *
 * 约束名用 PG 对「内联 CHECK」的自动命名规则 `<表>_<列>_check`，
 * 所以 DDL 里不写 CONSTRAINT 名字也能按名字找回它（messages 一直是这么工作的）。
 */
async function ensureConstraintKinds(table, constraint, kinds) {
  const want = kinds.map((k) => `'${k}'`).join(', ')
  const cur = (
    await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = $1::regclass AND conname = $2`,
      [table, constraint],
    )
  ).rows[0]
  const missing = kinds.filter((k) => !String(cur?.def || '').includes(`'${k}'`))
  if (cur && !missing.length) return false

  await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint}`)
  /* 给一个明确的约束名，下一次才能按名字找到它 */
  await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (kind IN (${want}))`)
  console.log(
    cur
      ? `[pg] ${constraint} 已重建：补上 ${missing.join(' / ')}（数据一行未动）`
      : `[pg] ${constraint} 已建立`,
  )
  return true
}

async function ensureMessageKinds(kinds) {
  return ensureConstraintKinds('messages', 'messages_kind_check', kinds)
}
