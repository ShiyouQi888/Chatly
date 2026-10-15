/**
 * 数据层**门面**：按 `DB_DRIVER` 选驱动，对外只暴露一套接口。
 *
 *   DB_DRIVER=sqlite    本地开发与全部自检（默认，零依赖）
 *   DB_DRIVER=postgres  线上，需要 DATABASE_URL（见 server/.env.example）
 *
 * ## 为什么门面是 `db.js` 而不是让 17 个文件改 import
 *
 * 上层（chat.js / moment.js / poll.js / routes/* …）一律写
 * `import { q, insert, tx } from './db.js'`。把 `db.js` 本身做成门面，
 * 这些文件**一行都不用改** —— 改 17 处 import 路径、漏一处就是运行时才炸。
 *
 * 驱动实现放在 `./db/` 下（sqlite.js / postgres.js / sql.js / kinds.js）。
 * 文件系统里 `db.js` 与 `db/` 可以共存，ESM 的 `'./db.js'` 无歧义地指向文件。
 *
 * ## 上层代码只允许用 q / insert / tx / exec
 *
 * `db`（SQLite 的同步句柄）**只在 SQLite 模式下存在**，是留给自检脚本直连用的。
 * PG 模式下它是一个「一碰就报错」的代理 —— 报错信息直接说清「这个用法是 SQLite 专有的」，
 * 而不是让调用方拿到 `undefined` 再抛一个不知所云的 `Cannot read properties of null`。
 */
import './env.js'
import { MESSAGE_KINDS } from './db/kinds.js'

const DRIVER = String(process.env.DB_DRIVER || 'sqlite')
  .trim()
  .toLowerCase()

export const DB_DRIVER = DRIVER

let impl
if (DRIVER === 'sqlite') {
  impl = await import('./db/sqlite.js')
} else if (DRIVER === 'postgres' || DRIVER === 'pg') {
  impl = await import('./db/postgres.js')
} else {
  throw new Error(`未知的 DB_DRIVER=${DRIVER}（只支持 sqlite / postgres）`)
}

export const q = impl.q
export const insert = impl.insert
export const tx = impl.tx
export const exec = impl.exec
export const close = impl.close
export const info = impl.info
export { MESSAGE_KINDS }

/**
 * 等数据层就绪。
 * SQLite 在 import 时就建好表了，所以是空实现；PG 要等第一次连接建表 + 迁移。
 * 服务端启动时应当显式 `await ready()` —— **早失败**：连不上 PG 要在启动时报出来，
 * 而不是等第一个用户请求才 500。
 */
export const ready = impl.ready ?? (async () => {})

/** SQLite 的同步句柄。PG 模式下为 null（见下面 db 的说明） */
export const raw = impl.raw ?? null

/**
 * 「只有 SQLite 有」的东西统一在这里守住。
 *
 * 别让它返回 `undefined` 再让调用方抛一个不知所云的
 * `Cannot read properties of undefined` —— 直接把**为什么**说清楚。
 * 符号（util.inspect、thenable 探测等）一律放过去，否则控制台打印会炸。
 */
function sqliteOnly(name, driver) {
  const why = () =>
    new Error(
      `${name} 是 SQLite 专有的**同步**直连，当前 DB_DRIVER=${driver} 用不了。` +
        `应用代码请用 q.get / q.all / q.run / insert（都是 async，两种驱动通用）；` +
        `自检脚本请改用 HTTP 接口 —— 或把 DB_DRIVER 切回 sqlite。`,
    )
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined
      throw why()
    },
    apply() {
      throw why()
    },
  })
}

/** 兼容自检脚本里的旧名字 `db` */
export const db = impl.raw ?? sqliteOnly('db', DRIVER)

/** SQLite 的库文件路径（PG 模式没有这个概念） */
export const DB_PATH = impl.DB_PATH ?? null

/**
 * 自检脚本用的**同步**查询助手 —— 只有 SQLite 模式可用（见 db/sqlite.js 的说明）。
 * 应用代码一律用上面的 `q`。
 */
export const qSync = impl.qSync ?? sqliteOnly('qSync', DRIVER)

/** `insert()` 的同步版本，同样只给自检脚本用 */
export const insertSync = impl.insertSync ?? sqliteOnly('insertSync', DRIVER)

if (DRIVER !== 'sqlite') {
  console.log(`[db] 驱动 = postgres ${JSON.stringify(info())}`)
}
