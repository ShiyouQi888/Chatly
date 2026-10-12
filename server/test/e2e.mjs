/**
 * 端到端：两个用户通过 REST + WebSocket 完成一次收发
 *   node server/test/e2e.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'http://127.0.0.1:3002'
const WS = 'ws://127.0.0.1:3002/ws'
const PASS = 'chatly123'

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

async function login(username) {
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASS }),
  })
  if (!r.ok) throw new Error(`login ${username} failed: ${r.status}`)
  return r.json()
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?token=${token}`)
    const inbox = []
    ws.onmessage = (e) => inbox.push(JSON.parse(e.data))
    ws.onopen = () => resolve({ ws, inbox })
    ws.onerror = reject
    setTimeout(() => reject(new Error('ws timeout')), 5000)
  })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
/** 等待 inbox 中出现某类型事件 */
async function waitEvent(inbox, type, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = inbox.find((e) => e.type === type)
    if (hit) return hit
    await wait(50)
  }
  return null
}

const api = async (token, path, init = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

;(async () => {
  console.log('══════ Chatly 后端端到端测试 ══════\n')

  // 0. 先清掉历次自检的残留，再记一条消息基线 —— 本轮造的所有消息收尾时按这条线删掉
  const { purgeDebris, purgeMessagesAfter, maxMessageId, purgeOrphanUploads } = await import(
    '../../scripts/lib/debris.mjs'
  )
  purgeDebris({ quiet: true })
  const msgBaseline = maxMessageId()

  // 1. 登录
  const a = await login('chenmo')
  const b = await login('linxiaoxia')
  ok(!!a.token && !!b.token, '双方登录成功', `陈墨#${a.user.id} 林小夏#${b.user.id}`)

  // 2. 鉴权：无 token 应 401
  const noAuth = await fetch(`${BASE}/api/v1/conversations`)
  ok(noAuth.status === 401, '缺少 token 返回 401', String(noAuth.status))

  // 3. 建立会话
  const conv = await api(a.token, '/api/v1/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 'private', userId: b.user.id }),
  })
  const cid = conv.body.conversationId
  ok(conv.status === 201 && cid, '建立/复用私聊会话', `#${cid}`)

  // 4. WS 连接
  const A = await connect(a.token)
  const B = await connect(b.token)
  await waitEvent(A.inbox, 'hello')
  await waitEvent(B.inbox, 'hello')
  ok(A.inbox.some((e) => e.type === 'hello'), 'A 收到 hello')
  ok(B.inbox.some((e) => e.type === 'hello'), 'B 收到 hello')

  // 5. A 发消息 → B 应通过 WS 实时收到
  const sent = await api(a.token, '/api/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ conversationId: cid, kind: 'text', text: 'WS 实时测试消息' }),
  })
  ok(sent.status === 201, 'A 发送消息成功', `#${sent.body.message?.id}`)

  const got = await waitEvent(B.inbox, 'message.new')
  ok(!!got, 'B 通过 WebSocket 实时收到消息')
  ok(got?.payload?.message?.text === 'WS 实时测试消息', '消息内容一致', got?.payload?.message?.text)

  // 6a. B 标记已读 —— 只影响 B 自己的未读，不应影响 A
  await api(b.token, `/api/v1/conversations/${cid}/read`, { method: 'POST' })
  const bList = await api(b.token, '/api/v1/conversations')
  const bc = bList.body.conversations.find((x) => x.id === Number(cid))
  ok(bc && bc.unread === 0, 'B 标记已读后 B 侧未读归零', `unread=${bc?.unread}`)

  // 6a-2. 已读实时广播：B 推进已读后 A 应收到 conversation.read，否则对端「已读」永远不会亮
  const readEvt = await waitEvent(A.inbox, 'conversation.read')
  ok(
    readEvt?.payload?.userId === b.user.id,
    'B 的已读实时广播给了 A',
    `userId=${readEvt?.payload?.userId} cursor=${readEvt?.payload?.lastReadMessageId}`
  )

  // 6a-3. 成员级已读游标：前端要算「谁读了谁没读」，必须能读到每个人的 last_read
  const memAfterRead = await api(a.token, `/api/v1/conversations/${cid}/members`)
  const bMember = memAfterRead.body.members?.find((m) => m.user.id === b.user.id)
  ok(
    typeof bMember?.lastReadMessageId === 'number' && bMember.lastReadMessageId >= sent.body.message.id,
    '成员级已读游标已暴露给对端',
    `B lastRead=${bMember?.lastReadMessageId} ≥ msg#${sent.body.message.id}`
  )

  // 6b. A 标记已读 → A 侧未读才归零（未读是各自独立的游标）
  await api(a.token, `/api/v1/conversations/${cid}/read`, { method: 'POST' })
  const after = await api(a.token, '/api/v1/conversations')
  const c = after.body.conversations.find((x) => x.id === Number(cid))
  ok(c && c.unread === 0, 'A 标记已读后 A 侧未读归零', `unread=${c?.unread}`)

  // 7. 已读回执：A 的消息应标记 read
  const msgs = await api(a.token, `/api/v1/conversations/${cid}/messages?limit=50`)
  const mine = msgs.body.messages.filter((m) => m.sender.id === a.user.id)
  ok(mine.every((m) => m.read === true), 'A 的消息已读回执为 true', `${mine.length} 条`)

  // 8. 撤回（2 分钟内）
  const msgId = sent.body.message.id
  const rev = await api(a.token, `/api/v1/messages/${msgId}`, { method: 'DELETE' })
  ok(rev.status === 200, 'A 撤回自己的消息成功')

  const revokedEvt = await waitEvent(B.inbox, 'message.revoked')
  ok(!!revokedEvt, 'B 收到撤回事件')

  const afterRevoke = await api(a.token, `/api/v1/conversations/${cid}/messages?limit=50`)
  const target = afterRevoke.body.messages.find((m) => m.id === msgId)
  ok(target && target.revoked === true, '撤回后消息标记 revoked')

  // 9. 撤回他人消息应 403
  const other = await api(b.token, `/api/v1/messages/${mine[0]?.id}`, { method: 'DELETE' })
  ok(other.status === 403, '撤回他人消息返回 403', String(other.status))

  // 10. 非成员访问他人会话应 403
  const foreign = await api(a.token, '/api/v1/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 'group', title: 'X', memberIds: [] }),
  })
  ok(foreign.status === 400, '建群缺成员返回 400', String(foreign.status))

  // 11. 建群 + 群消息广播
  const g = await api(a.token, '/api/v1/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 'group', title: '联调群', memberIds: [b.user.id] }),
  })
  ok(g.status === 201, '创建群聊成功', `#${g.body.conversationId}`)

  const gm = await api(a.token, '/api/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ conversationId: g.body.conversationId, kind: 'text', text: '群消息测试' }),
  })
  const groupEvt = await waitEvent(B.inbox, 'message.new', 3000)
  ok(!!groupEvt, '群消息实时推送给成员')

  // 12. 群成员
  const mem = await api(a.token, `/api/v1/conversations/${g.body.conversationId}/members`)
  ok(mem.body.members?.length === 2, '群成员数量正确', String(mem.body.members?.length))

  /* 12b. 消息里的 fileUrl 白名单
     这个字段直接来自请求体、又会被前端塞进 <img src> / window.open，
     不卡的话客户端能往里写任意 URL：外链追踪像素（对方一打开就上报 IP）、
     伪协议、路径穿越。所以只放行 /uploads/ 与 /emoji/ 两个自家前缀。 */
  const badUrls = [
    ['http://tracker.example/px.gif', '外链'],
    ['//evil.example/x.js', '协议相对外链'],
    ['javascript:alert(1)', '伪协议'],
    ['data:image/svg+xml,<svg/>', 'data URI'],
    ['/uploads/../../etc/passwd', '路径穿越'],
    ['/uploads/.env', '隐藏文件'],
    ['/uploads/a.gif?x=1', '查询串绕扩展名'],
    ['/uploads/a.exe', '不可托管的扩展名'],
    /* 动画大表情目录同样要挡住 —— 加新前缀时最容易只顾着「放行」忘了「照旧拦截」 */
    ['/emoji-anim/../../etc/passwd', '动画目录路径穿越'],
    ['/emoji-anim/a.exe', '动画目录里的不可托管扩展名'],
    ['/emoji-anim/../emoji/1f602.svg', '借动画目录绕回静态目录'],
  ]
  let badPass = 0
  for (const [u, why] of badUrls) {
    const r = await api(a.token, '/api/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ conversationId: cid, kind: 'image', fileUrl: u }),
    })
    if (r.status === 400) badPass++
    else ok(false, `非法 fileUrl 应被拒（${why}）：${u}`, String(r.status))
  }
  ok(badPass === badUrls.length, `${badUrls.length} 种非法 fileUrl 全部被拒`, `${badPass}/${badUrls.length}`)

  /* 动画大表情是 .gif（第一版是 .webp，因帧处置方式导致叠影才换的）——
     合法清单要跟着真实产物走，否则白名单放行的格式和实际用的格式会悄悄脱节。 */
  for (const u of ['/emoji/1f602.svg', '/emoji-anim/1f602.gif', '/uploads/probe-ok.png']) {
    const r = await api(a.token, '/api/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ conversationId: cid, kind: 'image', fileUrl: u, fileName: '探针' }),
    })
    ok(r.status === 201, `合法 fileUrl 通过：${u}`, String(r.status))
  }

  // 13. 置顶 / 免打扰（成员个人偏好，需真正落库）
  await api(a.token, `/api/v1/conversations/${cid}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned: true, muted: true }),
  })
  const pinnedList = await api(a.token, '/api/v1/conversations')
  const pc = pinnedList.body.conversations.find((x) => x.id === Number(cid))
  ok(pc?.pinned === true && pc?.muted === true, '置顶/免打扰已落库', `pinned=${pc?.pinned} muted=${pc?.muted}`)
  ok(
    pinnedList.body.conversations[0]?.id === Number(cid),
    '置顶会话排到列表最前',
    `first=#${pinnedList.body.conversations[0]?.id}`
  )
  await api(a.token, `/api/v1/conversations/${cid}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned: false, muted: false }),
  })

  // 14. 删除会话 = 退出成员关系
  const del = await api(a.token, `/api/v1/conversations/${g.body.conversationId}`, { method: 'DELETE' })
  ok(del.status === 200, '删除会话成功', String(del.status))
  const memAfter = await api(a.token, `/api/v1/conversations/${g.body.conversationId}/members`)
  ok(memAfter.status === 403, '删除后已非成员，再访问返回 403', String(memAfter.status))

  /* ==================== 15. 用户资料 ==================== */

  /* 头像还原是个坑：换头像时服务端会顺手 `removeUpload()` 删掉旧文件（防止磁盘只涨不跌），
     于是「上传新头像」这个动作本身就把原头像文件销毁了。收尾时只把 avatar 字段 PATCH 回原地址
     会被 `uploadExists()` 判成悬空引用 → 400 → 整个 PATCH 被拒 → 昵称签名全都还原不了，
     演示库就此留下一个「陈墨·测试」。（血泪：这个污染被当成演示数据用了好几轮。）
     所以原头像若是上传文件，必须先把字节读进内存，收尾时写回磁盘再改字段。 */
  const UPLOADS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')
  const avatarFile = (avatar) => {
    if (typeof avatar !== 'string' || !avatar.startsWith('/uploads/')) return null
    const rel = avatar.slice('/uploads/'.length)
    if (!rel || rel.includes('/') || rel.includes('\\') || rel.includes('..')) return null
    return path.join(UPLOADS, rel)
  }

  // 改资料会脏数据，先拍快照，测完原样恢复，保证演示库不被测试污染
  const snapshot = (await api(a.token, '/api/v1/auth/me')).body.user
  const snapshotAvatarPath = avatarFile(snapshot.avatar)
  const snapshotAvatarBytes =
    snapshotAvatarPath && fs.existsSync(snapshotAvatarPath) ? fs.readFileSync(snapshotAvatarPath) : null

  // 15a. 他人资料：生日必须被打码成 MM-DD，且不给出生年
  const prof = await api(a.token, `/api/v1/users/${b.user.id}`)
  ok(prof.status === 200, '读取他人资料成功', `#${b.user.id} ${prof.body.user?.nickname}`)
  ok(
    /^\d{2}-\d{2}$/.test(prof.body.user?.birthday || ''),
    '他人资料里生日只给「月-日」不暴露出生年',
    `birthday=${prof.body.user?.birthday}`
  )
  ok(
    typeof prof.body.user?.age === 'number' && prof.body.user.age >= 0 && prof.body.user.age <= 120,
    '他人资料带年龄',
    `age=${prof.body.user?.age}`
  )
  ok(typeof prof.body.user?.sharedGroups === 'number', '他人资料带共同群聊数', `sharedGroups=${prof.body.user?.sharedGroups}`)
  ok(
    prof.body.conversationId === Number(cid),
    '他人资料带已有私聊会话 id（可直接跳去聊天）',
    `conversationId=${prof.body.conversationId} expect=${cid}`
  )
  ok(
    Array.isArray(prof.body.user?.tags) && !('password_hash' in (prof.body.user || {})),
    '他人资料不含任何密码字段',
    `tags=${JSON.stringify(prof.body.user?.tags)}`
  )
  const online = await api(a.token, '/api/v1/users')
  ok(
    online.body.users?.every((u) => !('password_hash' in u) && !('passwordHash' in u)),
    '用户列表同样不泄露密码字段',
    `${online.body.users?.length} 人`
  )

  // 15b. 非法目标
  ok((await api(a.token, '/api/v1/users/99999')).status === 404, '不存在的用户返回 404')
  ok((await api(a.token, '/api/v1/users/abc')).status === 400, '非法用户 id 返回 400')
  ok((await api(a.token, `/api/v1/users/${a.user.id}`)).body.conversationId === null, '看自己的资料没有「私聊会话」')

  // 15c. 校验：一条都不该放过去
  const bad = [
    ['昵称清空', { nickname: '   ' }],
    ['昵称超长', { nickname: 'x'.repeat(21) }],
    ['签名超长', { bio: 'x'.repeat(61) }],
    ['地区超长', { region: 'x'.repeat(21) }],
    ['性别非法', { gender: 'yes' }],
    ['生日不存在（2 月 30 日）', { birthday: '2025-02-30' }],
    ['生日是未来', { birthday: '2999-01-01' }],
    ['生日格式错', { birthday: '1996/03/18' }],
    ['单个标签超长', { tags: ['x'.repeat(9)] }],
    ['标签超过 8 个', { tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }],
    ['外链头像', { avatar: 'https://evil.example.com/x.png' }],
    ['路径穿越头像', { avatar: '/uploads/../db.js' }],
    ['指向不存在文件的头像', { avatar: '/uploads/does-not-exist-12345.png' }],
  ]
  for (const [label, body] of bad) {
    const r = await api(a.token, '/api/v1/auth/me', { method: 'PATCH', body: JSON.stringify(body) })
    ok(r.status === 400, `拒绝${label}`, `status=${r.status} ${r.body.error || ''}`)
  }

  // 15d. 合法修改 + 局部更新语义（没传的键不动）
  const upd = await api(a.token, '/api/v1/auth/me', {
    method: 'PATCH',
    body: JSON.stringify({ nickname: '陈墨·测试', bio: '来自 E2E 的签名', gender: 'other', region: '北京', tags: ['测试'] }),
  })
  ok(upd.status === 200 && upd.body.user?.nickname === '陈墨·测试', '修改资料成功', `nickname=${upd.body.user?.nickname}`)
  ok(upd.body.user?.birthday === snapshot.birthday, 'PATCH 未提交的字段保持原值（局部更新）', `birthday=${upd.body.user?.birthday}`)
  ok(JSON.stringify(upd.body.user?.tags) === '["测试"]', '标签整体替换', JSON.stringify(upd.body.user?.tags))

  // 显式传 null = 清空
  const cleared = await api(a.token, '/api/v1/auth/me', { method: 'PATCH', body: JSON.stringify({ gender: null }) })
  ok(cleared.body.user?.gender === null, '显式传 null 可清空性别', String(cleared.body.user?.gender))

  // 15e. 资料变更实时推给有共同会话的人（否则对方界面上还是旧昵称旧头像）
  const updEvt = await waitEvent(B.inbox, 'user.updated', 3000)
  ok(updEvt?.payload?.user?.id === a.user.id, '改资料实时广播给对端', `id=${updEvt?.payload?.user?.id}`)
  ok(updEvt?.payload?.user?.nickname === '陈墨·测试', '广播里带的是新昵称', updEvt?.payload?.user?.nickname)

  // 15f. 预设头像：库里只存编号，不是几 KB 的 data-URI
  const preset = await api(a.token, '/api/v1/auth/me', {
    method: 'PATCH',
    body: JSON.stringify({ avatar: 'preset:5' }),
  })
  ok(preset.body.user?.avatar === 'preset:5', '预设头像保存为 preset:<n>', String(preset.body.user?.avatar))
  const peerSeesPreset = await api(b.token, `/api/v1/users/${a.user.id}`)
  ok(peerSeesPreset.body.user?.avatar === 'preset:5', '对端看到的也是同一个预设头像')

  // 15g. 上传头像：multipart，服务端同时落盘 + 写库
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  )
  const uploadFile = async (buf, filename, mime) => {
    const fd = new FormData()
    fd.append('file', new Blob([buf], { type: mime }), filename)
    const r = await fetch(`${BASE}/api/v1/auth/me/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${a.token}` },
      body: fd,
    })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }

  const up1 = await uploadFile(png, 'a.png', 'image/png')
  const url1 = up1.body.url
  ok(up1.status === 201 && /^\/uploads\/[A-Za-z0-9._-]+\.png$/.test(url1 || ''), '上传头像成功', url1)
  ok(up1.body.user?.avatar === url1, '上传后头像字段被写成新地址', String(up1.body.user?.avatar))
  ok((await fetch(`${BASE}${url1}`)).status === 200, '上传后的头像可以访问', url1)

  // 换第二张 → 第一张应该被删掉，而不是留在磁盘上长草
  const up2 = await uploadFile(png, 'b.png', 'image/png')
  const url2 = up2.body.url
  ok(up2.status === 201 && url2 !== url1, '再次上传成功且地址不同', `${url1} → ${url2}`)
  ok((await fetch(`${BASE}${url1}`)).status === 404, '换头像后旧文件被清理', url1)

  // 伪装成图片的非图片文件：扩展名和 MIME 必须同时过关
  const fake = await uploadFile(Buffer.from('#!/bin/sh\necho hi\n'), 'evil.png', 'text/plain')
  ok(fake.status === 400, '拒绝「扩展名是 .png 但 MIME 是 text/plain」的文件', `status=${fake.status}`)
  const txt = await uploadFile(png, 'evil.txt', 'image/png')
  ok(txt.status === 400, '拒绝扩展名不是图片的文件', `status=${txt.status}`)
  ok((await api(a.token, '/api/v1/auth/me')).body.user.avatar === url2, '被拒的上传没有改动头像字段')

  // 15h. 恢复现场：昵称/签名/性别/生日/地区/标签/头像全部还原，并清掉测试上传的文件
  // 先把原头像文件写回磁盘（15g 换头像时它被删掉了），否则下面的 PATCH 会被 400 拒掉
  if (snapshotAvatarPath && snapshotAvatarBytes && !fs.existsSync(snapshotAvatarPath)) {
    fs.writeFileSync(snapshotAvatarPath, snapshotAvatarBytes)
  }
  const restore = await api(a.token, '/api/v1/auth/me', {
    method: 'PATCH',
    body: JSON.stringify({
      nickname: snapshot.nickname,
      bio: snapshot.bio,
      gender: snapshot.gender,
      birthday: snapshot.birthday,
      region: snapshot.region,
      tags: snapshot.tags,
      avatar: snapshot.avatar,
    }),
  })
  ok(restore.status === 200, '还原资料的请求本身要成功（头像文件必须先写回）', `status=${restore.status} ${restore.body.error || ''}`)
  const restored = (await api(a.token, '/api/v1/auth/me')).body.user
  ok(
    restored.nickname === snapshot.nickname &&
      restored.avatar === snapshot.avatar &&
      JSON.stringify(restored.tags) === JSON.stringify(snapshot.tags),
    '测试结束后资料已还原',
    `nickname=${restored.nickname} avatar=${restored.avatar}`
  )
  ok((await fetch(`${BASE}${url2}`)).status === 404, '测试上传的头像文件也一并清掉（磁盘不留垃圾）')

  /* 本轮建的「联调群」也删干净。
     ⚠️ 不能用 DELETE /conversations/:id —— 那个接口是「退出成员」，会话行还在，
     历次跑下来演示库里攒了一堆同名孤儿群。所以这里直接删库。 */
  const purged = purgeDebris({ quiet: true })
  // 按基线删本轮消息，而不是只删记住 id 的那几条 —— 撤回留下的空行最容易漏
  const roundN = purgeMessagesAfter(msgBaseline)
  purgeOrphanUploads({ quiet: true })
  console.log(
    `已清理自检残留：${purged.conversations} 个会话 / ${purged.messages} 条消息，另删掉本轮产生的 ${roundN} 条消息`
  )

  A.ws.close()
  B.ws.close()

  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error('测试异常:', e.message)
  process.exit(1)
})
