/**
 * 统一的 .env 加载。
 *
 * 为什么做成一个「import 到就生效」的模块，而不是在 npm script 里加
 * `node --env-file=.env`：
 *   后端的入口不止一个 —— `src/index.js`（服务）、`src/seed.js`（种子）、
 *   以及 `scripts/check-*.mjs`（自检里直接 import db.js）。**每一个**都要能读到
 *   同一份配置，漏一个就会出现「服务连 PG、自检连 SQLite」这种最难查的错位。
 *
 * 覆盖优先级：**已经存在的环境变量优先**（实测 `process.loadEnvFile` 与
 * `node --env-file` 都是这个行为）。所以
 *     `DB_DRIVER=postgres node src/index.js`
 * 这种临时覆盖不会被 .env 里的 `DB_DRIVER=sqlite` 盖掉 —— 这一点很关键，
 * 自检就是靠它来跑「同一套用例、两种数据库」的。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
export const ENV_FILE = path.join(DIR, '..', '.env')

if (fs.existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE)
  } catch (e) {
    /* 读不了不该让服务起不来（比如格式写坏了），但要说出来 —— 静默吞掉的话
       表现是「配置没生效」，比报错难查得多。 */
    console.warn(`[env] ${ENV_FILE} 读取失败，将只用环境变量：${e.message}`)
  }
}

/** 布尔型环境变量的统一读法（'0' / 'false' / 'no' 都算假） */
export function envFlag(name, dflt = false) {
  const v = process.env[name]
  if (v === undefined || v === '') return dflt
  return !/^(0|false|no|off)$/i.test(String(v).trim())
}

/** 整数型环境变量的统一读法（非法值回退默认，不抛） */
export function envInt(name, dflt) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
}
