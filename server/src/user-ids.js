import { randomInt } from 'node:crypto'
import { q, exec, tx } from './db.js'

export const normalizeUserId = (value) => String(value ?? '').toLowerCase()
export const validUserId = (value) => /^[a-z0-9]{2,24}$/.test(value)
const conflict = () => Object.assign(new Error('该用户 ID 已被使用，请换一个'), { status: 409 })
let initialization
let mutationTail = Promise.resolve()

// SQLite shares one connection; serialize ID mutations. The persisted row lock
// additionally coordinates allocators and custom IDs across PostgreSQL instances.
export function userIdTransaction(fn) {
  const task = mutationTail.then(() => tx(async () => {
    await q.run('UPDATE user_id_sequence SET value = value WHERE singleton = 1')
    return fn()
  }))
  mutationTail = task.catch(() => {})
  return task
}

// All callers allocating an ID also insert the user within the same transaction.
export async function allocateUserId() {
  for (;;) {
    const row = await q.get('UPDATE user_id_sequence SET value = value + 1 WHERE singleton = 1 RETURNING value')
    if (Number(row.value) > 99999999) throw Object.assign(new Error('用户 ID 号段已用完，请联系管理员'), { status: 503 })
    const value = String(row.value)
    if (!(await q.get('SELECT 1 FROM user_id_claims WHERE value = ?', value)) &&
        !(await q.get('SELECT 1 FROM users WHERE lower(username) = ?', value))) return value
  }
}

export async function claimUserId(value, userId) {
  const row = await q.get('SELECT user_id FROM user_id_claims WHERE value = ?', value)
  if (row && Number(row.user_id) !== Number(userId)) throw conflict()
  if (row) return
  try {
    await q.run('INSERT INTO user_id_claims (value, user_id) VALUES (?, ?)', value, userId)
  } catch (error) {
    if (error.code === '23505' || String(error.code).startsWith('SQLITE_CONSTRAINT') || /UNIQUE constraint failed/.test(error.message)) throw conflict()
    throw error
  }
}

export function bootstrapUserIds() {
  if (initialization) return initialization
  initialization = (async () => {
    await exec(`CREATE TABLE IF NOT EXISTS user_id_sequence (singleton INTEGER PRIMARY KEY, value BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS user_id_claims (value TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE);`)
    await q.run('INSERT INTO user_id_sequence (singleton, value) VALUES (1, ?) ON CONFLICT (singleton) DO NOTHING', randomInt(10000000, 100000000) - 1)
    await userIdTransaction(async () => {
      // Reserve every previous name first, so neither migration nor future edits can hijack old QR codes.
      const users = await q.all('SELECT id, username FROM users ORDER BY id')
      for (const user of users) await q.run('INSERT INTO user_id_claims (value, user_id) VALUES (?, ?) ON CONFLICT (value) DO NOTHING', normalizeUserId(user.username), user.id)
      const changed = []
      for (const user of users) {
        let value = normalizeUserId(user.username)
        const owner = await q.get('SELECT user_id FROM user_id_claims WHERE value = ?', value)
        if (!validUserId(value) || Number(owner.user_id) !== Number(user.id)) value = await allocateUserId()
        await claimUserId(value, user.id)
        if (value !== user.username) changed.push({ id: user.id, value })
      }
      // Two phases also handle old accounts that differed only by letter case.
      for (const user of changed) await q.run('UPDATE users SET username = ? WHERE id = ?', `__id_migration_${user.id}_${randomInt(10000000, 99999999)}`, user.id)
      for (const user of changed) await q.run('UPDATE users SET username = ? WHERE id = ?', user.value, user.id)
      await q.run('CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique ON users (lower(username))')
    })
  })().catch((error) => { initialization = undefined; throw error })
  return initialization
}

export async function resolveUserId(value) {
  const normalized = normalizeUserId(String(value ?? '').trim())
  const current = await q.get('SELECT id FROM users WHERE lower(username) = ?', normalized)
  if (current) return Number(current.id)
  const alias = await q.get('SELECT user_id FROM user_id_claims WHERE value = ?', normalized)
  return alias ? Number(alias.user_id) : null
}
