/**
 * Core API regression: login, group announcement/message/notification,
 * membership permissions, and an authenticated file upload/share/read roundtrip.
 * Requires the seeded API at http://127.0.0.1:3002.
 */
import fs from 'node:fs'
import path from 'node:path'
import { PRIVATE_UPLOAD_DIR } from '../server/src/upload.js'
import { purgeDebris } from './lib/debris.mjs'

const API = 'http://127.0.0.1:3002/api/v1'
const PASSWORD = 'chatly123'
let failures = 0
let uploadedFilePath = null
let uploadedAudioPath = null
const check = (condition, label, detail = '') => {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

async function request(token, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body == null ? {} : { body }),
  })
  const data = await response.json().catch(() => ({}))
  return { status: response.status, data, contentType: response.headers.get('content-type') || '' }
}

async function login(username) {
  const response = await request(null, '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  if (response.status !== 200 || !response.data.token) throw new Error(`登录 ${username} 失败：HTTP ${response.status}`)
  return response.data
}

try {
  await purgeDebris({ quiet: true })
  const [owner, member, outsider] = await Promise.all([login('chenmo'), login('ajie'), login('linxiaoxia')])
  check(!!owner.token && !!member.token && !!outsider.token, '演示账号可登录')

  const created = await request(owner.token, '/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'group', title: `自检·核心链路-${Date.now()}`, memberIds: [member.user.id] }),
  })
  const conversationId = Number(created.data.conversationId)
  check(created.status === 201 && conversationId > 0, '群聊可创建')
  if (!conversationId) throw new Error('创建临时群失败，后续核心链路无法继续')

  const publish = async (text) => request(owner.token, `/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ announcement: text }),
  })
  const firstText = `核心回归公告一 ${Date.now()}`
  const firstPublish = await publish(firstText)
  check(firstPublish.status === 200, '群主可以发布公告', firstPublish.data.error)

  const memberMessages = await request(member.token, `/conversations/${conversationId}/messages?limit=30`)
  check(
    memberMessages.status === 200 && memberMessages.data.messages?.some((m) => m.kind === 'text' && m.text.includes(firstText)),
    '公告正文同步进入群消息记录'
  )
  const searchHit = await request(member.token, `/messages/search?q=${encodeURIComponent(firstText)}&limit=10`)
  check(searchHit.status === 200 && searchHit.data.messages?.some((m) => m.conversationId === conversationId && m.text.includes(firstText)), '聊天搜索可找到本人有权查看的公告消息')
  const hiddenSearch = await request(outsider.token, `/messages/search?q=${encodeURIComponent(firstText)}&limit=10`)
  check(hiddenSearch.status === 200 && !hiddenSearch.data.messages?.some((m) => m.conversationId === conversationId), '聊天搜索不会泄露无权访问会话的消息')
  const firstNotifications = await request(member.token, '/notifications?group=system&limit=100')
  check(
    firstNotifications.data.items?.some((n) => n.kind === 'group' && n.conversationId === conversationId && n.body?.includes(firstText)),
    '群成员收到公告通知'
  )

  const secondText = `核心回归公告二 ${Date.now()}`
  const secondPublish = await publish(secondText)
  const afterSecond = await Promise.all([
    request(member.token, `/conversations/${conversationId}/messages?limit=30`),
    request(member.token, '/notifications?group=system&limit=100'),
  ])
  check(secondPublish.status === 200, '群主可以修改并再次发布公告')
  check(afterSecond[0].data.messages?.filter((m) => m.kind === 'text' && m.text.includes('核心回归公告')).length === 2, '每次公告发布均同步生成消息')
  check(afterSecond[1].data.items?.filter((n) => n.kind === 'group' && n.conversationId === conversationId && n.body?.includes('核心回归公告')).length === 2, '未读旧通知不会拦截新公告提醒')

  const denied = await request(member.token, `/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ announcement: '普通成员不应发布' }),
  })
  check(denied.status === 403, '普通成员不能修改群公告', `HTTP ${denied.status}`)

  const form = new FormData()
  form.append('file', new Blob(['core upload check'], { type: 'text/plain' }), 'core-regression.txt')
  const upload = await request(owner.token, '/messages/upload', { method: 'POST', body: form })
  check(upload.status === 201 && !!upload.data.url, '登录用户可以上传群文件', upload.data.error)
  if (upload.data.url) {
    uploadedFilePath = path.join(PRIVATE_UPLOAD_DIR, path.basename(upload.data.url))
    const shared = await request(owner.token, '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        kind: 'file',
        fileUrl: upload.data.url,
        fileName: upload.data.fileName,
        fileSize: upload.data.fileSize,
      }),
    })
    check(shared.status === 201, '上传文件可以分享到群消息', shared.data.error)
    // `request` prefixes API, while upload returns a full `/api/v1/...` path.
    const fileRead = await request(member.token, upload.data.url.replace(/^\/api\/v1/, ''))
    check(fileRead.status === 200, '群成员可读取已分享文件', `HTTP ${fileRead.status}`)
    const hiddenFileRead = await request(outsider.token, upload.data.url.replace(/^\/api\/v1/, ''))
    check(hiddenFileRead.status === 404, '非群成员不能读取私有群文件', `HTTP ${hiddenFileRead.status}`)
  }

  const audioForm = new FormData()
  audioForm.append('file', new Blob(['OggS core audio route probe'], { type: 'audio/ogg' }), 'voice-note-core.ogg')
  const audioUpload = await request(owner.token, '/messages/upload', { method: 'POST', body: audioForm })
  if (audioUpload.data.url) uploadedAudioPath = path.join(PRIVATE_UPLOAD_DIR, path.basename(audioUpload.data.url))
  const audioMessage = audioUpload.data.url ? await request(owner.token, '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, kind: 'file', fileUrl: audioUpload.data.url, fileName: audioUpload.data.fileName, fileSize: audioUpload.data.fileSize }),
  }) : null
  check(audioUpload.status === 201 && audioMessage?.status === 201, '语音消息支持的 OGG 附件可上传并进入消息流', audioMessage?.data.error || audioUpload.data.error)
  if (audioMessage?.status === 201) {
    const audioRead = await request(member.token, audioUpload.data.url.replace(/^\/api\/v1/, ''))
    check(audioRead.status === 200 && audioRead.contentType.startsWith('audio/ogg'), '群成员收到可由音频播放器识别的 OGG MIME 类型', `${audioRead.status} ${audioRead.contentType}`)
  }
} catch (error) {
  failures++
  console.error(`💥 核心链路回归异常：${error.stack || error.message}`)
} finally {
  await purgeDebris({ quiet: true }).catch((error) => {
    failures++
    console.error(`清理临时会话失败：${error.message}`)
  })
  if (uploadedFilePath) fs.rmSync(uploadedFilePath, { force: true })
  if (uploadedAudioPath) fs.rmSync(uploadedAudioPath, { force: true })
}

console.log(failures ? `\n❌ 核心链路回归有 ${failures} 项未通过` : '\n✅ 核心链路回归全部通过')
process.exit(failures ? 1 : 0)
