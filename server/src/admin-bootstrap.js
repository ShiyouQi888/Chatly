import { hashPassword, verifyPassword } from './auth.js'
import { q, insert } from './db.js'

/**
 * First boot can provision the fixed administrator from environment credentials.
 * The resulting user id is persisted in admin_root. Unchanged bootstrap values do
 * not reset console edits; deliberately changing them in the env file is an explicit
 * recovery/reset operation that rebinds the fixed administrator on next startup.
 */
export async function bootstrapAdmin() {
  /* Older deployments already have admin_root without these optional migration
     markers. Add them in-place so the configured credentials can take over once. */
  for (const column of ['bootstrap_username', 'bootstrap_password_hash']) {
    try {
      await q.run(`ALTER TABLE admin_root ADD COLUMN ${column} TEXT`)
    } catch (error) {
      if (!/duplicate column|already exists/i.test(error.message || '')) throw error
    }
  }

  const existingRoot = await q.get('SELECT user_id, bootstrap_username, bootstrap_password_hash FROM admin_root WHERE singleton = 1')

  const username = String(process.env.ADMIN_USERNAME || '').trim()
  const password = String(process.env.ADMIN_PASSWORD || '')
  if (Boolean(username) !== Boolean(password)) {
    throw new Error('首次初始化管理员时，ADMIN_USERNAME 和 ADMIN_PASSWORD 必须同时配置')
  }

  if (existingRoot && !username && !password) return
  if (
    existingRoot && username && password &&
    existingRoot.bootstrap_username === username &&
    verifyPassword(password, existingRoot.bootstrap_password_hash)
  ) return

  let userId
  if (username && password) {
    if (username.length < 2 || username.length > 32) throw new Error('ADMIN_USERNAME 长度必须为 2 到 32 个字符')
    if (password.length < 12 || password.length > 128) throw new Error('首次管理员密码必须为 12 到 128 个字符')
    if (/replace[-_ ]?with|change[-_ ]?me/i.test(password)) throw new Error('请先将 ADMIN_PASSWORD 示例值替换为强密码')

    const passwordHash = hashPassword(password)
    const existing = await q.get('SELECT id, is_banned FROM users WHERE lower(username) = lower(?) LIMIT 1', username)
    if (existing) {
      if (Number(existing.is_banned)) throw new Error('ADMIN_USERNAME 对应的账号已停用，请先恢复账号')
      userId = existing.id
      await q.run('UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, userId)
    } else {
      userId = await insert(
        'INSERT INTO users (username, password_hash, nickname, avatar, bio) VALUES (?, ?, ?, ?, ?)',
        username,
        passwordHash,
        String(process.env.ADMIN_NICKNAME || 'Chatly 管理员').slice(0, 40),
        null,
        ''
      )
    }
    await q.run(
      `INSERT INTO admin_root (singleton, user_id, bootstrap_username, bootstrap_password_hash, created_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         user_id = excluded.user_id,
         bootstrap_username = excluded.bootstrap_username,
         bootstrap_password_hash = excluded.bootstrap_password_hash`,
      userId, username, passwordHash, Date.now()
    )
    console.log(`[admin] 固定管理员已初始化/更新（用户 ID ${userId}）`)
    return
  } else {
    /* Backward compatibility for deployments that already provisioned a Chatly user. */
    const configuredAccount = String(process.env.ADMIN_ACCOUNT || process.env.ADMIN_USER_ID || process.env.ADMIN_USER_IDS || '')
      .split(',')[0]
      .trim()
    if (!configuredAccount) return
    const existing = /^\d+$/.test(configuredAccount)
      ? await q.get('SELECT id FROM users WHERE id = ?', Number(configuredAccount))
      : await q.get('SELECT id FROM users WHERE lower(username) = lower(?) LIMIT 1', configuredAccount)
    if (!existing) {
      console.warn('[admin] ADMIN_ACCOUNT 未匹配到用户；请使用 ADMIN_USERNAME / ADMIN_PASSWORD 创建管理员，或修正旧账号配置')
      return
    }
    userId = existing.id
  }

  await q.run(
    'INSERT INTO admin_root (singleton, user_id, created_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO NOTHING',
    userId,
    Date.now()
  )
  console.log(`[admin] 已从旧版 ADMIN_ACCOUNT 迁移固定管理员（用户 ID ${userId}）`)
}
