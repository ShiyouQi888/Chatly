/**
 * 后端 API 客户端
 * 所有请求走 Vite 代理 /api/v1 → http://127.0.0.1:3002
 */
const BASE = '/api/v1'
const TOKEN_KEY = 'chatly.token'

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY)),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

/** Browser media tags cannot attach Authorization headers; pass the session token only for uploads. */
export function mediaUrl(url) {
  const value = String(url || '')
  const token = tokenStore.get()
  if (!token || (!value.startsWith('/uploads/') && !value.startsWith('/api/v1/files/private/'))) return value
  const join = value.includes('?') ? '&' : '?'
  return `${value}${join}token=${encodeURIComponent(token)}`
}

async function request(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {}
  const token = tokenStore.get()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body && !raw) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  })

  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { error: text }
  }

  if (!res.ok) {
    const err = new Error(data.error || data.message || `请求失败 (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}

export const api = {
  /* ---- 认证 ---- */
  login: (identifier, password) => request('/auth/login', { method: 'POST', body: { identifier, password } }),
  register: (username, password, nickname) =>
    request('/auth/register', { method: 'POST', body: { username, password, nickname } }),
  sendPhoneRegistrationCode: (phone) => request('/auth/register/phone/code', { method: 'POST', body: { phone } }),
  sendEmailRegistrationCode: (email) => request('/auth/register/email/code', { method: 'POST', body: { email } }),
  registerPhone: (payload) => request('/auth/register/phone', { method: 'POST', body: payload }),
  registerEmail: (payload) => request('/auth/register/email', { method: 'POST', body: payload }),
  me: () => request('/auth/me'),
  logout: () => request('/auth/logout', { method: 'POST' }),

  /* ---- 资料 ---- */
  updateProfile: (fields) => request('/auth/me', { method: 'PATCH', body: fields }),
  uploadAvatar: (file) => {
    const fd = new FormData()
    fd.append('file', file, file.name || 'avatar.png')
    return request('/auth/me/avatar', { method: 'POST', body: fd, raw: true })
  },
  /** 主页背景图：和头像同构，服务端一步落库并删掉旧图 */
  uploadCover: (file) => {
    const fd = new FormData()
    fd.append('file', file, file.name || 'cover.jpg')
    return request('/auth/me/cover', { method: 'POST', body: fd, raw: true })
  },
  /** 恢复默认背景（库里把 profile_cover 置空，前端画原来的插画） */
  resetCover: () => request('/auth/me', { method: 'PATCH', body: { profileCover: null } }),
  /** 修改密码：服务端会先校验旧密码（见 routes/auth.js 的说明） */
  changePassword: (oldPassword, newPassword) =>
    request('/auth/me/password', { method: 'POST', body: { oldPassword, newPassword } }),

  /* ---- 用户 ---- */
  users: () => request('/users'),
  userProfile: (userId) => request(`/users/${userId}`),
  /**
   * 按界面上的「ID: xxxx」（username）查用户 —— 扫一扫和手动输入走的都是这一条。
   * 返回体与 `userProfile` 同形（含 following / conversationId / isSelf），
   * 外加 `addable: { allowed, reason }`。
   *
   * ⚠️ `from` 决定服务端走哪个隐私开关：`'qr'` ← 扫码，`'search'` ← 手动输 ID。
   * 不传就不设闸 —— 但「扫码」和「手输」都必须传，否则用户关掉的开关形同虚设。
   */
  findUserByUsername: (username, from) => {
    const u = encodeURIComponent(String(username).replace(/^@+/, '').trim())
    return request(`/users/by-username/${u}${from ? `?from=${encodeURIComponent(from)}` : ''}`)
  },
  /**
   * 全局「找人」——在**全体用户**里搜，不是搜自己的会话。
   * q 是手机号形态时后端按精确手机号找，否则按 ID / 昵称模糊找。
   * 命中对方隐私开关的人不会出现在结果里（后端过滤，不是前端藏起来）。
   */
  searchUsers: (q) => request(`/users/search?q=${encodeURIComponent(String(q))}`),

  /* ---- 会话 ---- */
  conversations: () => request('/conversations'),
  createPrivate: (userId) => request('/conversations', { method: 'POST', body: { type: 'private', userId } }),
  createGroup: (title, memberIds) =>
    request('/conversations', { method: 'POST', body: { type: 'group', title, memberIds } }),
  patchConversation: (conversationId, fields) =>
    request(`/conversations/${conversationId}`, { method: 'PATCH', body: fields }),
  deleteConversation: (conversationId) =>
    request(`/conversations/${conversationId}`, { method: 'DELETE' }),

  /* ---- 群聊：资料 / 成员 / 设置 ---- */
  /** 群成员 + 群资料 + 我在群里的角色 */
  groupMembers: (conversationId) => request(`/conversations/${conversationId}/members`),
  /** 改群名 / 群头像 / 群公告 / 群开关（只有群主和管理员能调，否则 403） */
  updateGroup: (conversationId, fields) =>
    request(`/conversations/${conversationId}`, { method: 'PATCH', body: fields }),
  pushGroupAnnouncement: (conversationId) =>
    request(`/conversations/${conversationId}/announcement/push`, { method: 'POST' }),
  addGroupMembers: (conversationId, userIds) =>
    request(`/conversations/${conversationId}/members`, { method: 'POST', body: { userIds } }),
  /** 移出成员；userId 传自己就是「退出群聊」 */
  removeGroupMember: (conversationId, userId) =>
    request(`/conversations/${conversationId}/members/${userId}`, { method: 'DELETE' }),
  setGroupRole: (conversationId, userId, role) =>
    request(`/conversations/${conversationId}/members/${userId}`, { method: 'PATCH', body: { role } }),
  messages: (conversationId, { limit = 50, beforeId } = {}) => {
    const qs = new URLSearchParams({ limit: String(limit) })
    if (beforeId) qs.set('beforeId', String(beforeId))
    return request(`/conversations/${conversationId}/messages?${qs}`)
  },
  searchMessages: ({ q, limit = 30, beforeId } = {}) => {
    const params = new URLSearchParams({ q: String(q || ''), limit: String(limit) })
    if (beforeId) params.set('beforeId', String(beforeId))
    return request(`/messages/search?${params}`)
  },
  markRead: (conversationId, messageId) =>
    request(`/conversations/${conversationId}/read`, { method: 'POST', body: messageId ? { messageId } : {} }),

  /* ---- 消息 ---- */
  sendMessage: (payload) => request('/messages', { method: 'POST', body: payload }),
  revokeMessage: (messageId) => request(`/messages/${messageId}`, { method: 'DELETE' }),
  /** 转发：按目标会话逐条重发。返回 { forwarded, skipped } —— 逐条失败互不影响，
      skipped 里带原因，界面要如实报数（和批量收藏同一个口径）。 */
  forwardMessages: (targetConversationId, messageIds) =>
    request('/messages/forward', { method: 'POST', body: { targetConversationId, messageIds } }),

  /* ---- 动态 ---- */
  statuses: () => request('/statuses'),
  createStatus: (payload) => request('/statuses', { method: 'POST', body: payload }),
  viewStatus: (id) => request(`/statuses/${id}/view`, { method: 'POST' }),
  deleteStatus: (id) => request(`/statuses/${id}`, { method: 'DELETE' }),
  /** scope: friends（默认）| mine | hot */
  moments: ({ scope = 'friends', beforeId, limit = 20 } = {}) => {
    const qs = new URLSearchParams({ scope, limit: String(limit) })
    if (beforeId) qs.set('beforeId', String(beforeId))
    return request(`/moments?${qs}`)
  },
  moment: (id) => request(`/moments/${id}`),
  publishMoment: (payload) => request('/moments', { method: 'POST', body: payload }),
  editMoment: (id, fields) => request(`/moments/${id}`, { method: 'PATCH', body: fields }),
  deleteMoment: (id) => request(`/moments/${id}`, { method: 'DELETE' }),
  voteMomentCard: (id, optionIndexes) => request(`/moments/${id}/card-vote`, { method: 'POST', body: { optionIndexes } }),
  respondMomentActivity: (id, status) => request(`/moments/${id}/activity-rsvp`, { method: 'POST', body: { status } }),
  /** 点赞 / 取消：同一个接口，服务端按当前状态翻转 */
  toggleMomentLike: (id) => request(`/moments/${id}/like`, { method: 'POST' }),
  momentLikes: (id) => request(`/moments/${id}/likes`),
  momentComments: (id) => request(`/moments/${id}/comments`),
  addMomentComment: (id, content, parentId = null) =>
    request(`/moments/${id}/comments`, { method: 'POST', body: { content, parentId } }),
  deleteMomentComment: (momentId, commentId) =>
    request(`/moments/${momentId}/comments/${commentId}`, { method: 'DELETE' }),

  /* ---- 群投票（PRD §14） ----
     投票同时是一条 kind='poll' 的消息，所以 **发起** 走这个接口而不是 sendMessage：
     题目 / 选项 / 匿名 / 截止时间的校验全在服务端，一次请求把投票和消息一起建出来。
     `polls(ids)` 是给聊天记录用的批量查询 —— 消息出参只带 pollId，不带票数明细。 */
  polls: (ids) => request(`/polls?ids=${ids.join(',')}`),
  pollsOf: (conversationId) => request(`/polls/of/${conversationId}`),
  createPoll: (payload) => request('/polls', { method: 'POST', body: payload }),
  /** optionIds 是首次提交的选项：至少 1 个；提交后服务端禁止改票或撤销。 */
  votePoll: (pollId, optionIds) => request(`/polls/${pollId}/vote`, { method: 'POST', body: { optionIds } }),
  closePoll: (pollId) => request(`/polls/${pollId}/close`, { method: 'POST' }),

  /* ---- 运营管理后台（所有权限由服务端 ADMIN_USER_IDS 再校验） ---- */
  adminOverview: () => request('/admin/overview'),
  adminAnalytics: (days = 7) => request(`/admin/analytics?days=${days}`),
  adminUsers: ({ q = '', status = '', page = 1, limit = 20 } = {}) =>
    request(`/admin/users?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}&page=${page}&limit=${limit}`),
  adminUser: (id) => request(`/admin/users/${id}`),
  adminSetUserStatus: (id, banned, reason = '') =>
    request(`/admin/users/${id}/status`, { method: 'PATCH', body: { banned, reason } }),
  adminMoments: ({ q = '', page = 1, limit = 20 } = {}) =>
    request(`/admin/moments?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}`),
  adminRemoveMoment: (id, reason = '') =>
    request(`/admin/moments/${id}`, { method: 'DELETE', body: { reason } }),
  adminComments: ({ q = '', page = 1, limit = 20 } = {}) =>
    request(`/admin/comments?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}`),
  adminRemoveComment: (id, reason = '') =>
    request(`/admin/comments/${id}`, { method: 'DELETE', body: { reason } }),
  adminFeedback: ({ status = '', page = 1, limit = 20 } = {}) =>
    request(`/admin/feedback?status=${encodeURIComponent(status)}&page=${page}&limit=${limit}`),
  adminSetFeedbackStatus: (id, status) =>
    request(`/admin/feedback/${id}`, { method: 'PATCH', body: { status } }),
  adminAudit: ({ q = '', page = 1, limit = 50 } = {}) =>
    request(`/admin/audit?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}`),
  adminStaff: () => request('/admin/staff'),
  adminSetStaffRole: (userId, role) => request('/admin/staff', { method: 'POST', body: { userId, role } }),
  adminRemoveStaff: (userId) => request(`/admin/staff/${userId}`, { method: 'DELETE' }),

  /* ---- 消息收藏（PRD §9） ----
     收藏是**快照**：原消息撤回后收藏里的内容仍在，所以列表出参自带正文与文件地址，
     不需要再按 messageId 去拉原消息。
     `favoriteMessage` 是幂等的（重复收藏返回既有那条，created=false），
     前端那个「收藏 / 取消收藏」开关重复点不会炸。 */
  favorites: ({ beforeId, limit } = {}) => {
    const qs = new URLSearchParams()
    if (beforeId) qs.set('beforeId', String(beforeId))
    if (limit) qs.set('limit', String(limit))
    const s = qs.toString()
    return request(`/favorites${s ? `?${s}` : ''}`)
  },
  favoriteMessage: (messageId) => request('/favorites', { method: 'POST', body: { messageId } }),
  favoriteMessages: (messageIds) => request('/favorites/batch', { method: 'POST', body: { messageIds } }),
  unfavoriteMessage: (messageId) => request(`/favorites?messageId=${messageId}`, { method: 'DELETE' }),
  unfavoriteMessages: (messageIds) => request('/favorites/unbatch', { method: 'POST', body: { messageIds } }),
  removeFavorite: (favoriteId) => request(`/favorites/${favoriteId}`, { method: 'DELETE' }),

  /* ---- 稍后看 ---- */
  watchLater: ({ beforeId, limit } = {}) => {
    const qs = new URLSearchParams()
    if (beforeId) qs.set('beforeId', String(beforeId))
    if (limit) qs.set('limit', String(limit))
    const s = qs.toString()
    return request(`/watch-later${s ? `?${s}` : ''}`)
  },
  addToWatchLater: (messageId, conversationId) =>
    request('/watch-later', { method: 'POST', body: { messageId, conversationId } }),
  removeFromWatchLater: (id) => request(`/watch-later/${id}`, { method: 'DELETE' }),
  removeByMessageFromWatchLater: (messageId) =>
    request(`/watch-later/message/${messageId}`, { method: 'DELETE' }),

  /* ---- 最近文件 ---- */
  recentFiles: ({ limit = 20, beforeId, type = 'all', conversationId } = {}) => {
    const params = new URLSearchParams({ limit: String(limit), type })
    if (beforeId) params.set('beforeId', String(beforeId))
    if (conversationId) params.set('conversationId', String(conversationId))
    return request(`/files?${params}`)
  },
  groupFiles: (conversationId, { limit = 30, beforeId, type = 'all' } = {}) => {
    const params = new URLSearchParams({ conversationId: String(conversationId), limit: String(limit), type })
    if (beforeId) params.set('beforeId', String(beforeId))
    return request(`/files?${params}`)
  },

  /* ---- 用户设置 ---- */
  getSettings: () => request('/settings'),
  updateSetting: (key, value) =>
    request(`/settings/${key}`, { method: 'PUT', body: { value } }),
  updateSettings: (settings) =>
    request('/settings', { method: 'PUT', body: settings }),

  /* ---- 通知（「消息通知」与通知中心的数据源） ----
     偏好写入复用上面的 /settings（那里已经是 key-value 通用存储，
     再开一套专用接口等于给同一份数据两个写入点）。
     /notifications/prefs 只是把默认值合并好交出来，省得前端各页自己拼。 */
  notifications: ({ beforeId, limit = 30, group = 'all' } = {}) => {
    const qs = new URLSearchParams({ group, limit: String(limit) })
    if (beforeId) qs.set('beforeId', String(beforeId))
    return request(`/notifications?${qs}`)
  },
  unreadNotifications: () => request('/notifications/unread'),
  notificationPrefs: () => request('/notifications/prefs'),
  markNotificationsRead: (ids) =>
    request('/notifications/read', { method: 'POST', body: ids ? { ids } : {} }),

  /* ---- 设备管理 ---- */
  getDevices: () => request('/devices'),
  removeDevice: (id) => request(`/devices/${id}`, { method: 'DELETE' }),
  getSecuritySettings: () => request('/devices/settings'),
  updateSecuritySettings: (settings) =>
    request('/devices/settings', { method: 'PUT', body: settings }),

  /* ---- 用户反馈（「我 → 帮助与反馈」） ---- */
  /** 截图先单独上传，拿到 /uploads 地址后再随反馈一起提交 */
  uploadFeedbackScreenshot: (formData) =>
    request('/feedback/screenshot', { method: 'POST', body: formData, raw: true }),
  submitFeedback: ({ type, description, contact, screenshotUrl }) =>
    request('/feedback', { method: 'POST', body: { type, description, contact, screenshotUrl } }),

  /* ---- 关注（动态的「仅好友可见」按互相关注判定） ----
     `source` 是**可选**的渠道声明：只有「扫码 / 搜索」这类「被找到」的入口才传，
     服务端据此校验对方的隐私开关。群成员列表、发现页推荐不传（那些人本就在你眼前）。 */
  followUser: (id, source) =>
    request(`/users/${id}/follow`, { method: 'POST', body: source ? { source } : undefined }),
  unfollowUser: (id) => request(`/users/${id}/follow`, { method: 'DELETE' }),
  contacts: () => request('/users/contacts'),
  removeContact: (id) => request(`/users/contacts/${id}`, { method: 'DELETE' }),

  /* ---- 发现页 ---- */
  /** 推荐用户。tag 为空=全部；排序由后端按「共同群聊 > 共同兴趣 > 同城」给 */
  discoverUsers: ({ tag = '', limit = 20, offset = 0 } = {}) => {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    if (tag) qs.set('tag', tag)
    return request(`/discover/recommend?${qs}`)
  },
  /** 附近的人：默认按资料地区匹配；双方都明确分享城市后才显示城市中心点估算距离 */
  discoverNearby: (limit = 20) => request(`/discover/nearby?limit=${limit}`),
  /** 兴趣标签聚合（人数 + 我是否选了这个标签） */
  discoverTags: () => request('/discover/tags'),
  /** 可加入的公开兴趣群（会过滤掉我已经在里面的） */
  discoverGroups: () => request('/discover/groups'),
  /** 加入公开群。非公开群会被 403 挡下（不是邀请制） */
  joinGroup: (groupId) => request(`/discover/groups/${groupId}/join`, { method: 'POST' }),
  /** 尚未开始、且当前用户有权查看的动态活动 */
  discoverActivities: (limit = 20) => request(`/discover/activities?limit=${limit}`),
  /** 仅由公开动态聚合的话题榜 */
  discoverTopics: () => request('/discover/topics'),
  viewDiscoverTopic: (topic) => request(`/discover/topics/${encodeURIComponent(topic)}/view`, { method: 'POST' }),
  discoverTopicMoments: (topic, limit = 20) =>
    request(`/discover/topics/${encodeURIComponent(topic)}/moments?limit=${limit}`),

  /* ---- 位置 ----
     这两条都只是「转发给服务端」——key 在服务端，前端不认识腾讯那套接口。
     `geoStatus()` 让界面在**画定位按钮之前**就知道这一层通不通，
     免得点了才发现没配 key（那就成了一个点了没反应的假按钮）。 */
  geoStatus: () => request('/geo/status'),

  /**
   * 坐标 → 地址（+ 附近地点）。
   * ⚠️ 传进来的必须是 **GCJ-02**（见 `src/lib/geo.js` 的 `wgs84ToGcj02`），
   * 直接丢 WGS-84 会偏半公里。
   */
  locate: (lat, lng, { pois = true, radius = 1000 } = {}) =>
    request(
      `/geo/locate?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}` +
        `&pois=${pois ? 1 : 0}&radius=${encodeURIComponent(radius)}`
    ),

  /* ---- 上传 ---- */
  upload: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return request('/messages/upload', { method: 'POST', body: fd, raw: true })
  },

  /**
   * 上传动态媒体（配图 / 视频）。
   * 走动态自己的接口而不是 `/messages/upload` —— 两边体积上限不同
   * （图片 12MB / 视频 80MB，聊天附件只有 20MB），视频根本传不动。
   */
  uploadMomentMedia: (file, kind) => {
    const fd = new FormData()
    fd.append('file', file)
    return request(`/moments/upload?kind=${kind === 'video' ? 'video' : 'image'}`, {
      method: 'POST',
      body: fd,
      raw: true,
    })
  },

  /**
   * 读出媒体的宽高与时长 —— 发布时一起提交，列表才能**在加载视频之前**
   * 按真实比例占位（横屏宽幅 / 竖屏高幅），不会先按方的渲染再跳一下。
   *
   * 用临时 <video> / <img> 加载同一个本地 URL 去读元数据：
   * 服务端没有抽帧能力，这是唯一不需要额外解码依赖的办法。
   * 读不出来就返回 null，让服务端存 NULL、前端退回默认比例 —— **不要编数字**。
   */
  probeMedia: (file, kind) =>
    new Promise((resolve) => {
      const url = URL.createObjectURL(file)
      const done = (out) => {
        URL.revokeObjectURL(url)
        resolve(out)
      }
      const timer = setTimeout(() => done({ width: null, height: null, duration: null }), 8000)

      if (kind === 'video') {
        const v = document.createElement('video')
        v.preload = 'metadata'
        v.muted = true
        v.playsInline = true
        v.onloadedmetadata = () => {
          clearTimeout(timer)
          done({
            width: v.videoWidth || null,
            height: v.videoHeight || null,
            duration: Number.isFinite(v.duration) ? v.duration : null,
          })
        }
        v.onerror = () => {
          clearTimeout(timer)
          done({ width: null, height: null, duration: null })
        }
        v.src = url
        return
      }
      const img = new Image()
      img.onload = () => {
        clearTimeout(timer)
        done({ width: img.naturalWidth || null, height: img.naturalHeight || null, duration: null })
      }
      img.onerror = () => {
        clearTimeout(timer)
        done({ width: null, height: null, duration: null })
      }
      img.src = url
    }),
}

/** WebSocket 地址：沿用当前页面 origin，走 Vite 的 /ws 代理 */
export function wsUrl(token) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`
}

/* ================= 时间格式化 ================= */
const pad = (n) => String(n).padStart(2, '0')

export function formatTime(ts) {
  const d = new Date(Number(ts))
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 会话列表用的相对时间：今天显示 HH:mm，昨天显示「昨天」，更早显示 M/D */
export function formatRelative(ts) {
  const d = new Date(Number(ts))
  const now = new Date()
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

  if (sameDay(d, now)) return formatTime(ts)

  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (sameDay(d, y)) return '昨天'

  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 消息分组用的日期标签 */
export function formatDayLabel(ts) {
  const d = new Date(Number(ts))
  const now = new Date()
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

  if (sameDay(d, now)) return `今天 ${formatTime(ts)}`
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (sameDay(d, y)) return `昨天 ${formatTime(ts)}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${formatTime(ts)}`
}

/** 动态用的相对时间：「刚刚 / N 分钟前 / N 小时前 / 昨天 HH:mm / M/D」 */
export function formatAgo(ts) {
  const t = Number(ts)
  if (!t) return ''
  const diff = Date.now() - t
  if (diff < 60 * 1000) return '刚刚'
  const min = Math.floor(diff / 60000)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const d = new Date(t)
  const y = new Date(Date.now() - 86400000)
  const same = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (same(d, y)) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 头像兜底：后端没有头像时用种子色生成 SVG data-URI */
export function fallbackAvatar(seedText, colors = ['#a99bfb', '#6d5df6']) {
  let h = 0
  for (const ch of String(seedText || '?')) h = (h * 31 + ch.codePointAt(0)) % 997
  const [c1, c2] = colors
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="120" height="120" fill="url(#g)"/><circle cx="${30 + (h % 40)}" cy="${40 + (h % 30)}" r="${24 + (h % 14)}" fill="rgba(255,255,255,.22)"/></svg>`
  )}`
}

/* ================= 预设头像 ================= */
/**
 * 内置预设头像：库里只存 `preset:<n>`，前端按编号现渲染 SVG。
 * 好处 —— 数据库里不会塞进几 KB 的 data-URI，换画风也不用改存量数据。
 * 12 款 = 6 种图形 × 2 种变体（变体做了水平镜像，避免同一图形看起来完全一样）。
 */
export const PRESET_COUNT = 12

const PRESET_PALETTES = [
  ['#9b8cfb', '#6d5df6'], // 品牌紫
  ['#8fd3f4', '#3f8efc'], // 天蓝
  ['#a8e6cf', '#3fae7d'], // 薄荷
  ['#ffd08a', '#f59f3c'], // 琥珀
  ['#f6b9c9', '#e8657f'], // 玫瑰
  ['#c7b3ff', '#8b6cf0'], // 薰衣草
  ['#9fe8e0', '#2fb3a8'], // 青绿
  ['#ffb9a3', '#f2704f'], // 珊瑚
  ['#b8c8f0', '#5c74c8'], // 雾蓝
  ['#e6c9a8', '#c08a4a'], // 焦糖
  ['#c9e8a8', '#7aa83f'], // 草绿
  ['#f0b8d8', '#c85ca8'], // 桃粉
]

/** 图形母题：粗、对比强 —— 缩到 24px 还要能分辨出是哪一款 */
function presetMotif(kind, flip) {
  switch (kind) {
    case 0:
      return (
        `<circle cx="${flip ? 84 : 36}" cy="44" r="30" fill="rgba(255,255,255,.28)"/>` +
        `<circle cx="${flip ? 36 : 84}" cy="86" r="44" fill="rgba(255,255,255,.16)"/>`
      )
    case 1:
      return (
        `<g fill="none" stroke="rgba(255,255,255,.45)" stroke-width="7">` +
        `<circle cx="60" cy="60" r="42"/><circle cx="60" cy="60" r="26"/></g>` +
        `<circle cx="60" cy="60" r="11" fill="rgba(255,255,255,.85)"/>`
      )
    case 2:
      return (
        `<g transform="rotate(${flip ? 22 : -22} 60 60)" fill="rgba(255,255,255,.3)">` +
        `<rect x="-60" y="-10" width="240" height="15"/>` +
        `<rect x="-60" y="22" width="240" height="15"/>` +
        `<rect x="-60" y="54" width="240" height="15"/>` +
        `<rect x="-60" y="86" width="240" height="15"/>` +
        `<rect x="-60" y="118" width="240" height="15"/></g>`
      )
    case 3:
      return Array.from({ length: 9 }, (_, j) => {
        const x = 30 + (j % 3) * 30
        const y = 30 + Math.floor(j / 3) * 30
        const mid = j === 4
        return `<circle cx="${x}" cy="${y}" r="${mid ? 13 : 7.5}" fill="rgba(255,255,255,${
          mid ? 0.88 : 0.34
        })"/>`
      }).join('')
    case 4:
      return (
        `<path d="M0 84 L34 48 L56 72 L80 34 L120 76 L120 120 L0 120 Z" fill="rgba(255,255,255,.3)"/>` +
        `<path d="M0 104 L42 72 L72 94 L106 60 L120 74 L120 120 L0 120 Z" fill="rgba(255,255,255,.52)"/>`
      )
    case 5:
      return (
        `<g fill="rgba(255,255,255,.36)">` +
        `<ellipse cx="60" cy="33" rx="16" ry="26"/>` +
        `<ellipse cx="60" cy="87" rx="16" ry="26"/>` +
        `<ellipse cx="33" cy="60" rx="26" ry="16"/>` +
        `<ellipse cx="87" cy="60" rx="26" ry="16"/></g>` +
        `<circle cx="60" cy="60" r="10" fill="rgba(255,255,255,.88)"/>`
      )
    default:
      return ''
  }
}

export function presetAvatar(n) {
  const i = (((Math.trunc(Number(n)) || 1) - 1) % PRESET_COUNT + PRESET_COUNT) % PRESET_COUNT
  const [c1, c2] = PRESET_PALETTES[i]
  const gid = `pa${i}`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">` +
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>` +
    `</linearGradient></defs>` +
    `<rect width="120" height="120" fill="url(#${gid})"/>` +
    presetMotif(i % 6, i >= 6) +
    `</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/**
 * users.avatar 的取值解析成能直接塞进 <img src> 的地址。
 * 支持 `preset:<n>`；其它值（/uploads/... 或 data:）原样返回。
 */
export function resolveAvatarValue(value) {
  if (!value) return null
  const m = /^preset:(\d{1,2})$/.exec(String(value))
  return m ? presetAvatar(Number(m[1])) : String(value)
}
