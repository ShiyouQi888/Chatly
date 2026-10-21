import { hashPassword } from './auth.js'
import { q, insert } from './db.js'

/**
 * First boot can provision the fixed administrator from environment credentials.
 * The resulting user id is persisted in admin_root, so changing credentials later
 * in the console survives container recreation and is not reset from the env file.
 */
export async function bootstrapAdmin() {
  if (await q.get('SELECT user_id FROM admin_root WHERE singleton = 1')) return

  const username = String(process.env.ADMIN_USERNAME || '').trim()
  const password = String(process.env.ADMIN_PASSWORD || '')
  if (Boolean(username) !== Boolean(password)) {
    throw new Error('首次初始化管理员时，ADMIN_USERNAME 和 ADMIN_PASSWORD 必须同时配置')
  }

  let userId
  if (username && password) {
    if (username.length < 2 || username.length > 32) throw new Error('ADMIN_USERNAME 长度必须为 2 到 32 个字符')
    if (password.length < 12 || password.length > 128) throw new Error('首次管理员密码必须为 12 到 128 个字符')
    if (/replace[-_ ]?with|change[-_ ]?me/i.test(password)) throw new Error('请先将 ADMIN_PASSWORD 示例值替换为强密码')

    const existing = await q.get('SELECT id, is_banned FROM users WHERE lower(username) = lower(?) LIMIT 1', username)
    if (existing) {
      if (Number(existing.is_banned)) throw new Error('ADMIN_USERNAME 对应的账号已停用，请先恢复账号')
      userId = existing.id
      await q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), userId)
    } else {
      userId = await insert(
        'INSERT INTO users (username, password_hash, nickname, avatar, bio) VALUES (?, ?, ?, ?, ?)',
        username,
        hashPassword(password),
        String(process.env.ADMIN_NICKNAME || 'Chatly 管理员').slice(0, 40),
        null,
        ''
      )
    }
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
    'INSERT INTO admin_root (singleton, user_id, created_at) VALUES (1, ?, ?)',
    userId,
    Date.now()
  )
  console.log(`[admin] 固定管理员已初始化（用户 ID ${userId}）`)
}
