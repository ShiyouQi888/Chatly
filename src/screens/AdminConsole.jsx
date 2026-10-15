import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, mediaUrl } from '../api/client.js'
import { useAuth } from '../store/AuthContext.jsx'
import { Badge as UiBadge } from '../components/ui/badge.jsx'
import { Button } from '../components/ui/button.jsx'
import { Card } from '../components/ui/card.jsx'
import { Input } from '../components/ui/input.jsx'
import { ActionDialog } from '../components/ui/action-dialog.jsx'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog.jsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.jsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select.jsx'
import { Activity, ClipboardList, FileText, Home, Image, LayoutDashboard, LogOut, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, RefreshCw, ShieldCheck, Users, X } from 'lucide-react'
import './admin-tailwind.css'
import './admin-console.css'

const NAV = [
  { id: 'overview', label: '运营总览' },
  { id: 'users', label: '用户管理' },
  { id: 'moments', label: '内容治理' },
  { id: 'comments', label: '评论审核' },
  { id: 'feedback', label: '反馈工单' },
  { id: 'audit', label: '操作审计' },
  { id: 'system', label: '服务状态' },
  { id: 'staff', label: '后台成员' },
]
const NAV_ICONS = { overview: LayoutDashboard, users: Users, moments: FileText, comments: MessageSquare, feedback: ClipboardList, audit: Activity, system: ShieldCheck, staff: Users }

const FEEDBACK_STATUS = {
  open: '待处理',
  in_progress: '处理中',
  resolved: '已解决',
  closed: '已关闭',
}

function dateTime(value) {
  if (!value) return '—'
  return new Date(Number(value)).toLocaleString('zh-CN', { hour12: false })
}

function fmtNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0)
}

function downloadCsv(filename, columns, rows) {
  const escape = (value) => {
    let text = String(value ?? '')
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`
    return `"${text.replaceAll('"', '""')}"`
  }
  const csv = `\uFEFF${[columns.map(([, label]) => escape(label)), ...rows.map((row) => columns.map(([key]) => escape(row[key])))].map((line) => line.join(',')).join('\r\n')}`
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function Badge({ tone = 'neutral', children }) {
  const variant = tone === 'red' ? 'destructive' : tone === 'blue' ? 'secondary' : 'outline'
  return <UiBadge variant={variant} className={`op-badge is-${tone}`}>{children}</UiBadge>
}

function Metric({ label, value, detail, icon, tone }) {
  return (
    <Card className="op-metric">
      <div className={`op-metric-icon is-${tone}`}>{icon}</div>
      <div className="op-metric-copy">
        <span>{label}</span>
        <strong>{fmtNumber(value)}</strong>
        <small>{detail}</small>
      </div>
    </Card>
  )
}

function Empty({ text }) {
  return <div className="op-empty"><span>—</span><p>{text}</p></div>
}

function AdminLogin({ onSubmit, busy, error }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  return (
    <main className="op-login-wrap">
      <form className="op-login" onSubmit={(event) => { event.preventDefault(); onSubmit({ username, password }) }}>
        <div className="op-brand-mark">C</div>
        <p className="op-eyebrow">CHATLY · OPERATIONS</p>
        <h1>运营管理后台</h1>
        <p className="op-muted">使用 Chatly 账号登录。管理员可在服务端配置账号名或用户 ID。</p>
        <label>账号<Input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
        <label>密码<Input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {error && <p className="op-error" role="alert">{error}</p>}
        <Button className="op-primary" disabled={busy}>{busy ? '正在验证…' : '登录后台'}</Button>
        <a href="/" className="op-back-link">返回 Chatly</a>
      </form>
    </main>
  )
}

const TREND_METRICS = {
  messages: { label: '消息发送', color: '#e5e5e5' },
  users: { label: '新增用户', color: '#b5b5b5' },
  activeUsers: { label: '活跃用户', color: '#858585' },
  moments: { label: '新增动态', color: '#5d5d5d' },
}

function TrendChart({ points, metric }) {
  const width = 760
  const height = 240
  const left = 42
  const right = 12
  const top = 18
  const bottom = 32
  const values = points.map((point) => Number(point[metric]) || 0)
  const max = Math.max(1, ...values)
  const chartWidth = width - left - right
  const chartHeight = height - top - bottom
  const coords = values.map((value, index) => ({
    x: left + (values.length < 2 ? chartWidth / 2 : index * chartWidth / (values.length - 1)),
    y: top + chartHeight - value / max * chartHeight,
    value,
    date: points[index].date,
  }))
  const line = coords.map(({ x, y }) => `${x},${y}`).join(' ')
  const area = `${left},${top + chartHeight} ${line} ${left + chartWidth},${top + chartHeight}`
  const labels = [coords[0], coords[Math.floor((coords.length - 1) / 2)], coords[coords.length - 1]].filter(Boolean)
  return (
    <svg className="op-trend-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${TREND_METRICS[metric].label}趋势图`}>
      {[0, 1, 2, 3].map((index) => { const y = top + chartHeight * index / 3; return <g key={index}><line x1={left} x2={width - right} y1={y} y2={y} className="op-chart-grid" /><text x={left - 9} y={y + 4} className="op-chart-y-label" textAnchor="end">{fmtNumber(Math.round(max * (3 - index) / 3))}</text></g> })}
      <polygon points={area} fill={TREND_METRICS[metric].color} opacity=".09" />
      <polyline points={line} fill="none" stroke={TREND_METRICS[metric].color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {coords.map((point) => <circle key={point.date} cx={point.x} cy={point.y} r="3" fill={TREND_METRICS[metric].color}><title>{point.date} · {fmtNumber(point.value)}</title></circle>)}
      {labels.map((point) => <text key={point.date} x={point.x} y={height - 6} className="op-chart-x-label" textAnchor={point.x === left ? 'start' : point.x > width / 2 ? 'end' : 'middle'}>{point.date.slice(5)}</text>)}
    </svg>
  )
}

function Overview({ data, onNavigate, toast }) {
  const [days, setDays] = useState(7)
  const [metric, setMetric] = useState('messages')
  const [trend, setTrend] = useState(null)
  useEffect(() => { let alive = true; api.adminAnalytics(days).then((result) => alive && setTrend(result)).catch((error) => toast(error.message)); return () => { alive = false } }, [days, toast])
  if (!data) return null
  const { stats = {}, service = {} } = data
  const permissions = data.operator?.permissions || []
  return (
    <>
      <div className="op-metrics">
        <Metric label="注册用户" value={stats.users} detail={`${fmtNumber(stats.activeUsers24h)} 位近 24 小时发言`} icon={<Users size={16} />} tone="blue" />
        <Metric label="消息总量" value={stats.messages} detail={`${fmtNumber(stats.conversations)} 个会话`} icon={<MessageSquare size={16} />} tone="violet" />
        <Metric label="动态内容" value={stats.moments} detail="社区发布总数" icon={<Image size={16} />} tone="green" />
        <Metric label="待处理反馈" value={stats.openFeedback} detail={`${fmtNumber(stats.feedback24h)} 条近 24 小时新增`} icon={<ClipboardList size={16} />} tone="amber" />
      </div>
      <div className="op-overview-grid">
        <section className="op-panel op-service-card">
          <div className="op-panel-head"><div><span className="op-eyebrow">PLATFORM HEALTH</span><h2>服务健康</h2></div><Badge tone="green">运行中</Badge></div>
          <div className="op-health-row"><span><i className="op-dot is-live" />API 服务</span><strong>运行中</strong></div>
          <div className="op-health-row"><span><i className="op-dot is-live" />数据库</span><strong>{service.database?.driver || '未知'} · {service.database?.ok === false ? '异常' : '已连接'}</strong></div>
          <div className="op-health-row"><span><i className={`op-dot ${service.redis?.state === 'on' ? 'is-live' : 'is-muted'}`} />Redis</span><strong>{service.redis?.state === 'on' ? '已连接' : '未启用 / 降级运行'}</strong></div>
          <div className="op-health-row"><span><i className="op-dot is-live" />进程运行时间</span><strong>{Math.floor((service.uptimeSeconds || 0) / 3600)} 小时</strong></div>
          <p className="op-panel-foot">健康状态取自当前服务实例，不代表集中式监控或告警。</p>
        </section>
        <section className="op-panel op-quick-card">
          <div className="op-panel-head"><div><span className="op-eyebrow">WORKSPACE</span><h2>快捷处理</h2></div></div>
          {permissions.includes('support') && <button onClick={() => onNavigate('feedback')}><span className="op-quick-icon is-amber">▤</span><span><b>处理用户反馈</b><small>{fmtNumber(stats.openFeedback)} 条待处理</small></span><i>›</i></button>}
          {permissions.includes('users.view') && <button onClick={() => onNavigate('users')}><span className="op-quick-icon is-blue">◉</span><span><b>查看用户状态</b><small>{fmtNumber(stats.bannedUsers)} 个停用账号</small></span><i>›</i></button>}
          {permissions.includes('content.moments') && <button onClick={() => onNavigate('moments')}><span className="op-quick-icon is-green">▧</span><span><b>审核动态内容</b><small>{fmtNumber(stats.moments)} 条动态</small></span><i>›</i></button>}
        </section>
      </div>
      <section className="op-panel op-trend-panel">
        <div className="op-trend-head"><div><span className="op-eyebrow">PRODUCT ANALYTICS</span><h2>运营趋势</h2><p>按日统计产品核心行为，支持快速切换时间范围与指标。</p></div><div className="op-segmented" aria-label="趋势时间范围">{[7, 30].map((value) => <button key={value} className={days === value ? 'is-active' : ''} onClick={() => setDays(value)}>{value} 天</button>)}</div></div>
        <div className="op-trend-tools">{Object.entries(TREND_METRICS).map(([key, item]) => <button key={key} className={metric === key ? 'is-active' : ''} onClick={() => setMetric(key)}><i style={{ background: item.color }} />{item.label}</button>)}</div>
        {trend?.points?.length ? <TrendChart points={trend.points} metric={metric} /> : <div className="op-loading">正在加载趋势数据…</div>}
      </section>
      <section className="op-panel op-note-panel">
        <div className="op-note-icon">i</div>
        <div><b>后台隐私边界</b><p>运营接口不提供私聊正文读取。动态审核只展示动态内容；账号停用会撤销该账号现有登录设备。</p></div>
      </section>
    </>
  )
}

function Pager({ page, total, limit, onChange }) {
  const pages = Math.max(1, Math.ceil(total / limit))
  return (
    <div className="op-pager">
      <span>共 {fmtNumber(total)} 条 · 第 {page} / {pages} 页</span>
      <div><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</Button><Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>下一页</Button></div>
    </div>
  )
}

function UserProfileModal({ user, loading, onClose }) {
  if (!user && !loading) return null
  return (
    <Dialog open={!!user || loading} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="op-user-detail" showClose={false}>
        <DialogDescription className="sr-only">用户公开资料和账号状态详情</DialogDescription>
        <header className="op-user-detail-head">
          <div><span className="op-eyebrow">ACCOUNT PROFILE</span><DialogTitle id="op-user-detail-title">用户资料</DialogTitle></div>
          <button type="button" className="op-detail-close" aria-label="关闭用户资料" onClick={onClose}>×</button>
        </header>
        {loading || !user ? <div className="op-loading">正在加载用户资料…</div> : <>
          <div className="op-profile-hero">
            {user.avatar ? <img className="op-profile-avatar" src={mediaUrl(user.avatar)} alt="" /> : <span className="op-profile-avatar op-profile-fallback">{(user.nickname || user.username || '?').slice(0, 1)}</span>}
            <div><h3>{user.nickname || user.username}</h3><p>@{user.username} · ID {user.id}</p><Badge tone={user.isBanned ? 'red' : 'green'}>{user.isBanned ? '已停用' : '正常'}</Badge></div>
          </div>
          {user.profileCover && <img className="op-profile-cover" src={mediaUrl(user.profileCover)} alt="用户主页封面" />}
          <p className="op-profile-bio">{user.bio || '用户尚未填写简介'}</p>
          <dl className="op-profile-fields">
            <div><dt>性别</dt><dd>{{ male: '男', female: '女', other: '其他' }[user.gender] || user.gender || '未填写'}</dd></div>
            <div><dt>生日</dt><dd>{user.birthday || '未填写'}</dd></div>
            <div><dt>地区</dt><dd>{user.region || '未填写'}</dd></div>
            <div><dt>注册时间</dt><dd>{dateTime(user.createdAt)}</dd></div>
            <div><dt>消息 / 动态</dt><dd>{fmtNumber(user.messageCount)} / {fmtNumber(user.momentCount)}</dd></div>
            {user.isBanned && <div><dt>停用原因</dt><dd>{user.banReason || '运营限制'}{user.bannedAt ? ` · ${dateTime(user.bannedAt)}` : ''}</dd></div>}
          </dl>
          <div className="op-profile-tags"><b>兴趣标签</b><div>{user.tags?.length ? user.tags.map((tag) => <Badge key={tag}>{tag}</Badge>) : <span>暂无标签</span>}</div></div>
          <p className="op-profile-privacy">此资料面板不显示手机号、精确位置或私聊内容。</p>
        </>}
      </DialogContent>
    </Dialog>
  )
}

function UsersView({ toast }) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [selectedUser, setSelectedUser] = useState(null)
  const [pendingAction, setPendingAction] = useState(null)
  const [profile, setProfile] = useState(null)
  const [profileBusy, setProfileBusy] = useState(false)
  const profileRequest = useRef(0)
  const load = useCallback(() => api.adminUsers({ q: search, status: statusFilter, page }).then(setData).catch((error) => toast(error.message)), [search, statusFilter, page, toast])
  useEffect(() => { load() }, [load])
  const viewProfile = async (user) => {
    const requestId = ++profileRequest.current
    setSelectedUser(user)
    setProfile(null)
    setProfileBusy(true)
    try {
      const result = await api.adminUser(user.id)
      if (profileRequest.current === requestId) setProfile(result.user)
    } catch (error) {
      if (profileRequest.current === requestId) toast(error.message)
    } finally {
      if (profileRequest.current === requestId) setProfileBusy(false)
    }
  }
  const closeProfile = () => { profileRequest.current += 1; setSelectedUser(null); setProfile(null); setProfileBusy(false) }
  const toggle = async (user, reason = null) => {
    if (!user.isBanned && reason === null) { setPendingAction(user); return false }
    setBusyId(user.id)
    try {
      await api.adminSetUserStatus(user.id, !user.isBanned, reason ?? '')
      toast(user.isBanned ? '账号已恢复' : '账号已停用，登录设备已撤销')
      await load()
      return true
    } catch (error) { toast(error.message); return false } finally { setBusyId(null) }
  }
  return (
    <section className="op-panel op-table-panel">
      <div className="op-panel-head op-table-toolbar"><div><span className="op-eyebrow">ACCOUNT DIRECTORY</span><h2>用户管理</h2></div>
        <div className="op-user-toolbar"><form className="op-search" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(query.trim()) }}><input aria-label="搜索用户" placeholder="搜索昵称、账号或 ID" value={query} onChange={(event) => setQuery(event.target.value)} /><Button type="submit" variant="outline" size="sm">搜索</Button></form><Select value={statusFilter || 'all'} onValueChange={(value) => { setPage(1); setStatusFilter(value === 'all' ? '' : value) }}><SelectTrigger className="op-status-filter" aria-label="按账号状态筛选"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="active">正常</SelectItem><SelectItem value="banned">已停用</SelectItem></SelectContent></Select><Button variant="outline" className="op-secondary op-export-button" disabled={!data?.users?.length} onClick={() => downloadCsv('chatly-users.csv', [['id', '用户 ID'], ['username', '账号'], ['nickname', '昵称'], ['createdAt', '注册时间'], ['isBanned', '是否停用'], ['messageCount', '消息数'], ['momentCount', '动态数']], data?.users || [])}>导出本页</Button></div>
      </div>
      {data?.users?.length ? <div className="op-table-scroll"><Table className="op-table"><TableHeader><TableRow><TableHead>用户</TableHead><TableHead>注册时间</TableHead><TableHead>消息 / 动态</TableHead><TableHead>状态</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
        {data.users.map((user) => <TableRow key={user.id}><TableCell><div className="op-user-cell"><span className="op-avatar">{(user.nickname || user.username || '?').slice(0, 1)}</span><span><b>{user.nickname || user.username}</b><small>@{user.username} · ID {user.id}</small></span></div></TableCell><TableCell>{dateTime(user.createdAt)}</TableCell><TableCell>{fmtNumber(user.messageCount)} / {fmtNumber(user.momentCount)}</TableCell><TableCell>{user.isBanned ? <Badge tone="red">已停用</Badge> : <Badge tone="green">正常</Badge>}</TableCell><TableCell><div className="op-user-actions"><Button variant="ghost" size="sm" onClick={() => viewProfile(user)}>查看资料</Button><Button variant={user.isBanned ? 'secondary' : 'destructive'} size="sm" disabled={busyId === user.id} onClick={() => toggle(user)}>{busyId === user.id ? '处理中…' : user.isBanned ? '恢复账号' : '停用账号'}</Button></div>{user.banReason && user.isBanned && <small className="op-reason">{user.banReason}</small>}</TableCell></TableRow>)}
      </TableBody></Table></div> : data ? <Empty text="没有找到用户" /> : <div className="op-loading">正在加载用户…</div>}
      {data && <Pager page={data.page} total={data.total} limit={data.limit} onChange={setPage} />}
      <UserProfileModal user={profile} loading={profileBusy && !!selectedUser} onClose={closeProfile} />
      <ActionDialog open={!!pendingAction} onOpenChange={(open) => !open && setPendingAction(null)} title={`停用 ${pendingAction?.nickname || pendingAction?.username || '用户'}？`} description="停用后该账号的登录设备会被撤销。操作原因会写入审计记录。" requireReason defaultReason="违反社区规则" confirmLabel="停用账号" pending={!!pendingAction && busyId === pendingAction.id} onConfirm={(reason) => pendingAction ? toggle(pendingAction, reason) : false} />
    </section>
  )
}

function MomentsView({ toast }) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const load = useCallback(() => api.adminMoments({ q: search, page }).then(setData).catch((error) => toast(error.message)), [search, page, toast])
  useEffect(() => { load() }, [load])
  const [pendingMoment, setPendingMoment] = useState(null)
  const remove = async (moment, reason) => {
    setBusyId(moment.id)
    try { await api.adminRemoveMoment(moment.id, reason); toast('动态已移除'); await load(); return true }
    catch (error) { toast(error.message); return false } finally { setBusyId(null) }
  }
  return (
    <section className="op-panel op-table-panel">
      <div className="op-panel-head op-table-toolbar"><div><span className="op-eyebrow">COMMUNITY MODERATION</span><h2>动态审核</h2></div>
        <form className="op-search" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(query.trim()) }}><input aria-label="搜索动态" placeholder="搜索动态内容或发布者" value={query} onChange={(event) => setQuery(event.target.value)} /><button>搜索</button></form>
      </div>
        {data?.moments?.length ? <div className="op-moment-list">{data.moments.map((moment) => <article className="op-moment-row" key={moment.id}><div className="op-moment-main"><div className="op-moment-meta"><b>{moment.nickname || moment.username}</b><span>@{moment.username}</span><span>·</span><span>{dateTime(moment.createdAt)}</span><Badge>{moment.visibility}</Badge></div><p>{moment.content || '（无文字内容）'}</p><small>{moment.kind} · {moment.mediaCount} 个媒体 · {moment.commentCount} 条评论 · 动态 #{moment.id}</small></div><Button variant="destructive" size="sm" disabled={busyId === moment.id} onClick={() => setPendingMoment(moment)}>{busyId === moment.id ? '处理中…' : '移除动态'}</Button></article>)}</div> : data ? <Empty text="没有找到动态" /> : <div className="op-loading">正在加载动态…</div>}
      {data && <Pager page={data.page} total={data.total} limit={data.limit} onChange={setPage} />}
      <ActionDialog open={!!pendingMoment} onOpenChange={(open) => !open && setPendingMoment(null)} title="移除这条动态？" description={`将从社区移除 ${pendingMoment?.nickname || pendingMoment?.username || '用户'} 发布的动态。请填写审核原因。`} requireReason defaultReason="违反社区规范" confirmLabel="移除动态" pending={!!pendingMoment && busyId === pendingMoment.id} onConfirm={(reason) => pendingMoment ? remove(pendingMoment, reason) : false} />
    </section>
  )
}

function CommentsView({ toast }) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [pendingComment, setPendingComment] = useState(null)
  const load = useCallback(() => api.adminComments({ q: search, page }).then(setData).catch((error) => toast(error.message)), [search, page, toast])
  useEffect(() => { load() }, [load])
  const remove = async (comment, reason) => {
    setBusyId(comment.id)
    try { await api.adminRemoveComment(comment.id, reason); toast('评论已删除'); await load(); return true }
    catch (error) { toast(error.message); return false } finally { setBusyId(null) }
  }
  return (
    <section className="op-panel op-table-panel">
      <div className="op-panel-head op-table-toolbar"><div><span className="op-eyebrow">COMMUNITY MODERATION</span><h2>评论审核</h2></div>
        <form className="op-search" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(query.trim()) }}><input aria-label="搜索评论" placeholder="搜索评论、用户或动态 ID" value={query} onChange={(event) => setQuery(event.target.value)} /><button>搜索</button></form>
      </div>
      {data?.comments?.length ? <div className="op-comment-list">{data.comments.map((comment) => <article className="op-comment-row" key={comment.id}><div className="op-comment-copy"><div className="op-moment-meta"><b>{comment.nickname || comment.username}</b><span>@{comment.username}</span><span>·</span><span>{dateTime(comment.createdAt)}</span><Badge>评论 #{comment.id}</Badge></div><p>{comment.content}</p><small>动态 #{comment.momentId} · 发布者 {comment.authorNickname || '未知'} · {comment.parentId ? `回复评论 #${comment.parentId}` : '一级评论'}</small>{comment.momentContent && <blockquote>动态内容：{comment.momentContent}</blockquote>}</div><Button variant="destructive" size="sm" disabled={busyId === comment.id} onClick={() => setPendingComment(comment)}>{busyId === comment.id ? '处理中…' : '删除评论'}</Button></article>)}</div> : data ? <Empty text="没有找到评论" /> : <div className="op-loading">正在加载评论…</div>}
      {data && <Pager page={data.page} total={data.total} limit={data.limit} onChange={setPage} />}
      <ActionDialog open={!!pendingComment} onOpenChange={(open) => !open && setPendingComment(null)} title="删除这条评论？" description="删除后，该评论的回复也会一并删除。请填写审核原因。" requireReason defaultReason="违反社区规范" confirmLabel="删除评论" pending={!!pendingComment && busyId === pendingComment.id} onConfirm={(reason) => pendingComment ? remove(pendingComment, reason) : false} />
    </section>
  )
}

function FeedbackView({ toast }) {
  const [status, setStatus] = useState('')
  const [data, setData] = useState(null)
  const load = useCallback(() => api.adminFeedback({ status }).then(setData).catch((error) => toast(error.message)), [status, toast])
  useEffect(() => { load() }, [load])
  const update = async (item, next) => {
    try { await api.adminSetFeedbackStatus(item.id, next); toast('工单状态已更新'); await load() }
    catch (error) { toast(error.message) }
  }
  return (
    <section className="op-panel op-table-panel">
      <div className="op-panel-head op-table-toolbar"><div><span className="op-eyebrow">CUSTOMER SUPPORT</span><h2>反馈工单</h2></div><label className="op-filter">状态<Select value={status || 'all'} onValueChange={(value) => setStatus(value === 'all' ? '' : value)}><SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem>{Object.entries(FEEDBACK_STATUS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></label></div>
      {data?.feedback?.length ? <div className="op-feedback-list">{data.feedback.map((item) => <article className="op-feedback" key={item.id}><div className="op-feedback-head"><div><Badge tone={item.type === 'bug' ? 'red' : 'blue'}>{item.type}</Badge><b>工单 #{item.id}</b><span>{item.nickname || item.username} · {dateTime(item.createdAt)}</span></div><Select value={item.status} onValueChange={(value) => update(item, value)}><SelectTrigger className="w-[140px]" aria-label={`工单 ${item.id} 状态`}><SelectValue /></SelectTrigger><SelectContent>{Object.entries(FEEDBACK_STATUS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div><p>{item.description}</p>{item.screenshotUrl && <a href={item.screenshotUrl} target="_blank" rel="noreferrer">查看截图 ↗</a>}{item.contact && <small>联系方式：{item.contact}</small>}</article>)}</div> : data ? <Empty text="当前筛选下没有反馈" /> : <div className="op-loading">正在加载反馈…</div>}
      {data && <Pager page={data.page} total={data.total} limit={data.limit} onChange={(page) => api.adminFeedback({ status, page }).then(setData).catch((error) => toast(error.message))} />}
    </section>
  )
}

function AuditView({ toast }) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [logs, setLogs] = useState(null)
  const load = useCallback(() => api.adminAudit({ q: search, page }).then((result) => setLogs(result)).catch((error) => toast(error.message)), [search, page, toast])
  useEffect(() => { load() }, [load])
  return <section className="op-panel op-table-panel"><div className="op-panel-head op-table-toolbar"><div><span className="op-eyebrow">ADMIN ACTIVITY</span><h2>操作审计</h2></div><div className="op-audit-toolbar"><form className="op-search" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(query.trim()) }}><input aria-label="搜索审计记录" placeholder="搜索操作、管理员或目标类型" value={query} onChange={(event) => setQuery(event.target.value)} /><button>搜索</button></form><button className="op-secondary op-export-button" disabled={!logs?.logs?.length} onClick={() => downloadCsv('chatly-audit.csv', [['id', '记录 ID'], ['adminUsername', '操作账号'], ['action', '操作'], ['targetType', '目标类型'], ['targetId', '目标 ID'], ['createdAt', '时间']], logs?.logs || [])}>导出本页</button></div></div>{logs?.logs?.length ? <div className="op-table-scroll"><table className="op-table"><thead><tr><th>操作人</th><th>动作</th><th>目标</th><th>备注</th><th>时间</th></tr></thead><tbody>{logs.logs.map((log) => <tr key={log.id}><td>{log.adminNickname || log.adminUsername || `管理员 ${log.adminId || ''}`}</td><td><code>{log.action}</code></td><td>{log.targetType} #{log.targetId || '—'}</td><td>{log.detail?.reason || log.detail?.status || '—'}</td><td>{dateTime(log.createdAt)}</td></tr>)}</tbody></table></div> : logs ? <Empty text="没有匹配的操作记录" /> : <div className="op-loading">正在加载审计记录…</div>}{logs && <Pager page={logs.page} total={logs.total} limit={logs.limit} onChange={setPage} />}</section>
}

const ROLE_LABELS = { moderator: '内容审核', support: '客服运营', analyst: '数据分析' }
const NAV_PERMISSION = { overview: 'overview', users: 'users.view', moments: 'content.moments', comments: 'content.comments', feedback: 'support', audit: 'audit', system: 'system', staff: 'staff.manage' }

function StaffView({ toast }) {
  const [staff, setStaff] = useState(null)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState([])
  const [selectedUser, setSelectedUser] = useState(null)
  const [role, setRole] = useState('moderator')
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => api.adminStaff().then((result) => setStaff(result.staff)).catch((error) => toast(error.message)), [toast])
  useEffect(() => { load() }, [load])
  const searchUsers = async (value) => {
    setQuery(value)
    setSelectedUser(null)
    if (!value.trim()) { setMatches([]); return }
    try { const result = await api.adminUsers({ q: value.trim(), limit: 20 }); setMatches(result.users || []) }
    catch (error) { toast(error.message) }
  }
  const assign = async () => {
    if (!selectedUser) return
    setBusy(true)
    try { await api.adminSetStaffRole(selectedUser.id, role); toast(`已将 ${selectedUser.nickname || selectedUser.username} 设为${ROLE_LABELS[role]}`); setSelectedUser(null); setQuery(''); setMatches([]); await load() }
    catch (error) { toast(error.message) } finally { setBusy(false) }
  }
  const [pendingStaff, setPendingStaff] = useState(null)
  const remove = async (item) => {
    setBusy(true)
    try { await api.adminRemoveStaff(item.userId); toast('后台成员权限已移除'); await load(); return true }
    catch (error) { toast(error.message); return false } finally { setBusy(false) }
  }
  return <div className="op-staff-grid"><section className="op-panel"><div className="op-panel-head"><div><span className="op-eyebrow">ROLE BASED ACCESS</span><h2>添加后台成员</h2></div></div><p className="op-system-copy">为团队成员分配最小必要权限。超级管理员由服务端 ADMIN_USER_IDS 控制，不能通过此处降权。</p><label className="op-staff-label">按账号或昵称搜索用户</label><div className="op-staff-picker"><Input value={query} onChange={(event) => searchUsers(event.target.value)} placeholder="输入账号、昵称或用户 ID" /><div className="op-staff-results">{matches.map((user) => <button key={user.id} className={selectedUser?.id === user.id ? 'is-selected' : ''} onClick={() => { setSelectedUser(user); setQuery(`${user.nickname || user.username} · @${user.username}`); setMatches([]) }}><span>{user.nickname || user.username}<small>@{user.username} · ID {user.id}</small></span></button>)}</div></div><label className="op-staff-label" htmlFor="op-staff-role">运营角色</label><Select value={role} onValueChange={setRole}><SelectTrigger id="op-staff-role"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(ROLE_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select><p className="op-role-description">{role === 'moderator' ? '查看运营数据并处理动态与评论内容。' : role === 'support' ? '查看用户资料、管理账号状态并处理反馈工单。' : '查看产品趋势、操作审计与服务状态，不可执行写操作。'}</p><Button className="op-staff-submit" disabled={!selectedUser || busy} onClick={assign}>{busy ? '正在保存…' : '分配后台角色'}</Button></section><section className="op-panel op-table-panel"><div className="op-panel-head op-table-toolbar"><div><span className="op-eyebrow">TEAM ACCESS</span><h2>后台成员</h2></div></div>{staff?.length ? <div className="op-table-scroll"><Table className="op-table"><TableHeader><TableRow><TableHead>成员</TableHead><TableHead>角色</TableHead><TableHead>授权人</TableHead><TableHead>授权时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{staff.map((item) => <TableRow key={item.userId}><TableCell>{item.nickname || item.username}<small className="op-reason">@{item.username} · ID {item.userId}</small></TableCell><TableCell><Badge tone="blue">{ROLE_LABELS[item.role] || item.role}</Badge></TableCell><TableCell>{item.createdByUsername || '—'}</TableCell><TableCell>{dateTime(item.createdAt)}</TableCell><TableCell><Button variant="destructive" size="sm" disabled={busy} onClick={() => setPendingStaff(item)}>移除权限</Button></TableCell></TableRow>)}</TableBody></Table></div> : staff ? <Empty text="还没有分配后台角色的成员" /> : <div className="op-loading">正在加载后台成员…</div>}</section><ActionDialog open={!!pendingStaff} onOpenChange={(open) => !open && setPendingStaff(null)} title="移除后台权限？" description={`将移除 ${pendingStaff?.nickname || pendingStaff?.username || '该成员'} 的运营后台角色，操作会写入审计日志。`} confirmLabel="移除权限" pending={busy} onConfirm={() => pendingStaff ? remove(pendingStaff) : false} /></div>
}

function SystemView({ data }) {
  const service = data?.service || {}
  const role = data?.operator?.role || 'owner'
  return <div className="op-system-grid"><section className="op-panel"><div className="op-panel-head"><div><span className="op-eyebrow">SERVICE</span><h2>应用服务</h2></div><Badge tone="green">在线</Badge></div><div className="op-health-row"><span>进程运行时间</span><strong>{Math.floor((service.uptimeSeconds || 0) / 3600)} 小时 {(Math.floor((service.uptimeSeconds || 0) / 60) % 60)} 分</strong></div><div className="op-health-row"><span>数据库驱动</span><strong>{service.database?.driver || '未知'}</strong></div><div className="op-health-row"><span>Redis</span><strong>{service.redis?.state === 'on' ? '就绪' : '未启用 / 降级运行'}</strong></div><div className="op-panel-foot">当前展示本实例健康快照。集中日志、历史指标、备份恢复和通知告警需要接入独立运维服务与备份存储。</div></section><section className="op-panel"><div className="op-panel-head"><div><span className="op-eyebrow">SECURITY</span><h2>后台权限</h2></div><Badge tone="blue">{ROLE_LABELS[role] || '超级管理员'}</Badge></div><p className="op-system-copy">超级管理员由服务端环境变量 <code>ADMIN_USER_IDS</code> 配置，可在“后台成员”中分配内容审核、客服运营或数据分析角色。每个运营接口都会在服务端校验角色权限，不依赖前端隐藏按钮。</p><p className="op-system-copy">停用账号会撤销其全部登录设备；动态与评论审核仅展示公开内容；管理操作持续写入可搜索的审计日志。后台不会展示手机号、精确位置或私聊正文。</p></section></div>
}

export default function AdminConsole() {
  const { user, ready, login, logout } = useAuth()
  const [active, setActive] = useState('overview')
  const [isMobileSidebar, setIsMobileSidebar] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('admin-sidebar-collapsed') === '1')
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [overview, setOverview] = useState(null)
  const [authorized, setAuthorized] = useState(false)
  const [checking, setChecking] = useState(true)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [toastText, setToastText] = useState('')
  const toast = useCallback((text) => { setToastText(text); window.setTimeout(() => setToastText(''), 2800) }, [])

  const refresh = useCallback(async () => {
    setChecking(true)
    try {
      const data = await api.adminOverview()
      setOverview(data)
      setAuthorized(true)
    } catch (error) {
      setAuthorized(false)
      if (error.status !== 401) setLoginError(error.message)
    } finally { setChecking(false) }
  }, [])

  useEffect(() => { if (ready && user) refresh(); else if (ready) setChecking(false) }, [ready, user, refresh])
  const submitLogin = async (credentials) => {
    setLoginBusy(true)
    setLoginError('')
    try { await login(credentials); await refresh() }
    catch (error) { setLoginError(error.message) }
    finally { setLoginBusy(false) }
  }
  const title = useMemo(() => NAV.find((item) => item.id === active)?.label || '运营总览', [active])
  const visibleNav = NAV.filter((item) => overview?.operator?.permissions?.includes(NAV_PERMISSION[item.id]))

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const onChange = (event) => { setIsMobileSidebar(event.matches); if (!event.matches) setMobileSidebarOpen(false) }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    window.localStorage.setItem('admin-sidebar-collapsed', sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  useEffect(() => {
    if (!authorized) return undefined
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b' && !event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) {
        event.preventDefault()
        if (isMobileSidebar) setMobileSidebarOpen((open) => !open)
        else setSidebarCollapsed((collapsed) => !collapsed)
      }
      if (event.key === 'Escape') setMobileSidebarOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [authorized, isMobileSidebar])

  const toggleSidebar = () => {
    if (isMobileSidebar) setMobileSidebarOpen((open) => !open)
    else setSidebarCollapsed((collapsed) => !collapsed)
  }
  const navigate = (id) => { setActive(id); setMobileSidebarOpen(false) }

  if (!ready || checking) return <main className="op-login-wrap"><div className="op-loading">正在验证后台权限…</div></main>
  if (!user) return <AdminLogin onSubmit={submitLogin} busy={loginBusy} error={loginError} />
  if (!authorized) return <main className="op-login-wrap"><section className="op-denied"><div className="op-brand-mark">C</div><p className="op-eyebrow">ACCESS CONTROL</p><h1>账号尚无后台权限</h1><p>{loginError || '请在服务端 server/.env 的 ADMIN_USER_IDS 中添加当前账号名或用户 ID，并重启服务。'}</p><code className="op-config-hint">ADMIN_USER_IDS={user.username || user.id}</code><div><button className="op-secondary" onClick={() => { logout(); setLoginError('') }}>切换账号</button><a className="op-primary as-link" href="/">返回 Chatly</a></div></section></main>

  return (
    <div className={`op-app${sidebarCollapsed ? ' is-collapsed' : ''}${mobileSidebarOpen ? ' is-mobile-open' : ''}`}>
      {mobileSidebarOpen && <button className="op-sidebar-scrim" aria-label="关闭导航菜单" onClick={() => setMobileSidebarOpen(false)} />}
      <aside className="op-sidebar" aria-label="后台侧边栏">
        <div className="op-sidebar-header"><a href="/admin" className="op-brand" aria-label="Chatly 运营管理平台"><span className="op-brand-mark">C</span><span><b>Chatly</b><small>运营管理平台</small></span></a><button className="op-sidebar-collapse" onClick={toggleSidebar} aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'} title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}>{sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button><button className="op-sidebar-mobile-close" onClick={() => setMobileSidebarOpen(false)} aria-label="关闭菜单"><X size={18} /></button></div>
        <div className="op-side-label">工作空间</div>
        <nav aria-label="后台导航">{visibleNav.map((item) => { const Icon = NAV_ICONS[item.id]; return <button key={item.id} title={sidebarCollapsed ? item.label : undefined} aria-label={item.label} aria-current={active === item.id ? 'page' : undefined} className={active === item.id ? 'is-active' : ''} onClick={() => navigate(item.id)}><span className="op-nav-icon"><Icon size={17} strokeWidth={1.8} /></span><span className="op-nav-label">{item.label}</span>{item.id === 'feedback' && overview?.stats?.openFeedback > 0 && <em>{overview.stats.openFeedback}</em>}</button> })}</nav>
        <div className="op-sidebar-bottom"><div className="op-admin-user"><span className="op-avatar">{(user.nickname || user.username || 'A').slice(0, 1)}</span><span><b>{user.nickname || user.username}</b><small>{ROLE_LABELS[overview?.operator?.role] || '超级管理员'} · ID {user.id}</small></span></div><button className="op-logout" onClick={logout}><LogOut size={15} /><span>退出登录</span></button><a href="/" className="op-exit-link"><Home size={15} /><span>返回用户端</span></a></div>
      </aside>
      <main className="op-main">
        <header className="op-topbar"><div className="op-topbar-leading"><Button variant="ghost" size="icon" className="op-sidebar-trigger" onClick={toggleSidebar} aria-label={isMobileSidebar ? mobileSidebarOpen ? '关闭导航菜单' : '打开导航菜单' : sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'} aria-expanded={isMobileSidebar ? mobileSidebarOpen : !sidebarCollapsed}>{isMobileSidebar ? <Menu size={17} /> : sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</Button><div className="op-breadcrumb">Chatly <span>/</span> {title}</div></div><div><span className="op-live-label"><i className="op-dot is-live" />系统在线</span><Button variant="outline" size="icon" className="op-refresh" onClick={() => refresh()} aria-label="刷新总览"><RefreshCw size={15} /></Button></div></header>
        <div className="op-content"><div className="op-page-title"><div><p className="op-eyebrow">CHATLY OPERATIONS</p><h1>{title}</h1><p>管理社区运行状态、用户账号与用户反馈。</p></div><span className="op-date">{new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</span></div>
          {active === 'overview' && <Overview data={overview} onNavigate={navigate} toast={toast} />}
          {active === 'users' && <UsersView toast={toast} />}
          {active === 'moments' && <MomentsView toast={toast} />}
          {active === 'comments' && <CommentsView toast={toast} />}
          {active === 'feedback' && <FeedbackView toast={toast} />}
          {active === 'audit' && <AuditView toast={toast} />}
          {active === 'system' && <SystemView data={overview} />}
          {active === 'staff' && <StaffView toast={toast} />}
        </div>
      </main>
      {toastText && <div className="op-toast" role="status">{toastText}</div>}
    </div>
  )
}
