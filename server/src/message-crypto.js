import crypto from 'node:crypto'

function encryptionKey() {
  const raw = String(process.env.MESSAGE_ENCRYPTION_KEY || '').trim()
  if (!raw) return null
  const key = /^[\da-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('MESSAGE_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)')
  return key
}

export function messageEncryptionConfigured() {
  try {
    return !!encryptionKey()
  } catch {
    return false
  }
}

export function encryptMessageText(value) {
  const key = encryptionKey()
  if (!key) throw Object.assign(new Error('服务端尚未配置消息加密密钥'), { status: 503 })
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`
}

export function decryptMessageText(value) {
  if (!value) return ''
  const key = encryptionKey()
  if (!key) throw new Error('无法读取加密消息：服务端未配置 MESSAGE_ENCRYPTION_KEY')
  const [version, iv, tag, data] = String(value).split(':')
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('加密消息格式无效')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
}
