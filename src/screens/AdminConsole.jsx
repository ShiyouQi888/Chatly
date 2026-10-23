import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AdminPrivateMessages from './AdminPrivateMessages.jsx'
import { api, adminTokenStore } from '../api/client.js'
import { Badge as UiBadge } from '../components/ui/badge.jsx'
import { Button } from '../components/ui/button.jsx'
import { Card } from '../components/ui/card.jsx'
import { Input } from '../components/ui/input.jsx'
import { ActionDialog } from '../components/ui/action-dialog.jsx'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog.jsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.jsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select.jsx'
import { Activity, ArrowUpRight, CalendarDays, ChartNoAxesColumn, ChevronRight, ClipboardList, Eye, EyeOff, FileText, Headphones, Home, Image, Inbox, Info, LayoutDashboard, LockKeyhole, LogOut, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, ShieldCheck, UserRoundPlus, Users, X } from 'lucide-react'
import './admin-tailwind.css'
import './admin-console.css'

const NAV = [
  { id: 'overview', label: '运营总览', group: '工作台', description: '了解社区的运行情况，关注关键数据与待处理事项。' },
  { id: 'users', label: '用户管理', group: '社区管理', description: '查看用户资料、管理账号状态，让社区保持有序。' },
  { id: 'moments', label: '内容治理', group: '社区管理', description: '浏览公开动态，审核并处理不符合社区规范的内容。' },
  { id: 'comments', label: '评论审核', group: '社区管理', description: '查看社区评论与回复，及时处理违规内容。' },
  { id: 'feedback', label: '反馈工单', group: '社区管理', description: '跟进用户反馈，记录处理进展并完成问题闭环。' },
  { id: 'private', label: '私聊查阅', group: '系统管理', description: '检索私聊会话，填写原因后查阅正文并保留访问记录。' },
  { id: 'audit', label: '操作审计', group: '系统管理', description: '追踪后台操作记录，让每一次管理都有据可查。' },
  { id: 'system', label: '服务状态', group: '系统管理', description: '查看服务运行状态，管理自己的后台登录凭据。' },
  { id: 'staff', label: '后台成员', group: '系统管理', description: '为运营团队创建独立账号，分配角色并管理访问权限。' },
]
const NAV_ICONS = { overview: LayoutDashboard, users: Users, moments: FileText, comments: MessageSquare, feedback: ClipboardList, private: LockKeyhole, audit: Activity, system: ShieldCheck, staff: Users }

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
  return <Card className="op-metric"><div className="op-metric-head"><span>{label}</span><div className={`op-metric-icon is-${tone}`}>{icon}</div></div><strong>{fmtNumber(value)}</strong><small>{detail}</small></Card>
}

function Empty({ text, description = '试试调整筛选条件，或稍后再来查看。', icon: Icon = Inbox, action }) {
  return <div className="op-empty"><div className="op-empty-art"><Icon size={28} strokeWidth={1.5} />{action && <i><Plus size={12} strokeWidth={2.5} /></i>}</div><h3>{text}</h3><p>{description}</p>{action}</div>
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
        <p className="op-muted">使用独立的后台管理员账号登录。</p>
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
  messages: { label: '消息发送', color: '#7ad7b1' },
  users: { label: '新增用户', color: '#8fbdf2' },
  activeUsers: { label: '活跃用户', color: '#b5aadf' },
  moments: { label: '新增动态', color: '#e4bc85' },
}

function TrendChart({ points, metric }) {
  const width = 760
  const height = 240
  const left = 42
  const right = 12
  const top = 18
  const bottom = 32
  const values = points.map((point) => Number(point[metric]) || 0)
  const max = Math.max(4, Math.ceil(Math.max(...values) / 4) * 4)
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
      <path d={`M ${coords[0].x},${top + chartHeight} L ${coords.map((point) => `${point.x},${point.y}`).join(' L ')} L ${coords[coords.length - 1].x},${top + chartHeight} Z`} fill={TREND_METRICS[metric].color} opacity=".06" />
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
  const quickActions = [
    { id: 'feedback', permission: 'support', label: '处理用户反馈', detail: `${fmtNumber(stats.openFeedback)} 条待处理`, icon: ClipboardList },
    { id: 'users', permission: 'users.view', label: '查看用户状态', detail: `${fmtNumber(stats.bannedUsers)} 个账号已停用`, icon: Users },
    { id: 'moments', permission: 'content.moments', label: '审核社区动态', detail: `${fmtNumber(stats.moments)} 条动态`, icon: FileText },
  ].filter((item) => permissions.includes(item.permission))
  return <>
    <div className="op-metrics">
      <Metric label="注册用户" value={stats.users} detail={`${fmtNumber(stats.activeUsers24h)} 位用户近 24 小时发言`} icon={<Users size={16} />} />
      <Metric label="消息总量" value={stats.messages} detail={`来自 ${fmtNumber(stats.conversations)} 个会话`} icon={<MessageSquare size={16} />} />
      <Metric label="社区动态" value={stats.moments} detail="用户发布的动态总数" icon={<Image size={16} />} />
      <Metric label="待处理反馈" value={stats.openFeedback} detail={`近 24 小时新增 ${fmtNumber(stats.feedback24h)} 条`} icon={<ClipboardList size={16} />} />
    </div>
    <div className="op-dashboard-grid">
      <section className="op-panel op-trend-panel">
        <div className="op-trend-head"><div><h2>社区活跃趋势</h2><p>关注用户增长与社区互动的变化。</p></div><div className="op-segmented" aria-label="趋势时间范围">{[7, 30].map((value) => <button key={value} aria-pressed={days === value} className={days === value ? 'is-active' : ''} onClick={() => setDays(value)}>近 {value} 天</button>)}</div></div>
        <div className="op-trend-tools">{Object.entries(TREND_METRICS).map(([key, item]) => <button key={key} aria-pressed={metric === key} className={metric === key ? 'is-active' : ''} onClick={() => setMetric(key)}><i style={{ background: item.color }} />{item.label}</button>)}</div>
        {trend?.points?.length ? <TrendChart points={trend.points} metric={metric} /> : <div className="op-loading">正在加载趋势数据…</div>}
        <div className="op-panel-foot">数据按日汇总 · 最近 {days} 天</div>
      </section>
      <div className="op-right-rail">
        {quickActions.length > 0 && <section className="op-panel op-quick-card"><div className="op-panel-head"><h2>快捷处理</h2><ArrowUpRight size={16} aria-hidden="true" /></div>{quickActions.map((item) => <button key={item.id} onClick={() => onNavigate(item.id)}><span className="op-quick-icon"><item.icon size={18} /></span><span><b>{item.label}</b><small>{item.detail}</small></span><ChevronRight size={16} /></button>)}</section>}
        <section className="op-panel op-service-card"><div className="op-panel-head"><h2>服务健康</h2><Badge tone={service.database?.ok === false ? 'red' : 'green'}>{service.database?.ok === false ? '需关注' : '运行中'}</Badge></div><div className="op-health-row"><span><i className="op-dot is-live" />API 服务</span><strong>已连接</strong></div><div className="op-health-row"><span><i className={`op-dot ${service.database?.ok === false ? 'is-muted' : 'is-live'}`} />数据库</span><strong>{service.database?.driver || '未知'}</strong></div><div className="op-health-row"><span><i className={`op-dot ${service.redis?.state === 'on' ? 'is-live' : 'is-muted'}`} />Redis</span><strong>{service.redis?.state === 'on' ? '已连接' : '未启用'}</strong></div><div className="op-panel-foot">当前实例已运行 {Math.floor((service.uptimeSeconds || 0) / 3600)} 小时 {Math.floor((service.uptimeSeconds || 0) / 60) % 60} 分钟</div></section>
      </div>
    </div>
    <div className="op-note-panel"><ShieldCheck size={18} /><div><b>隐私与访问边界</b><p>私聊正文由专属权限控制，查阅时填写原因并记录访问范围。所有管理操作均记录在审计日志中。</p></div></div>
  </>
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
          <div><span className="op-eyebrow">公开资料</span><DialogTitle id="op-user-detail-title">用户资料</DialogTitle></div>
          <button type="button" className="op-detail-close" aria-label="关闭用户资料" onClick={onClose}>×</button>
        </header>
        {loading || !user ? <div className="op-loading">正在加载用户资料…</div> : <>
          <div className="op-profile-hero">
            {user.avatar ? <img className="op-profile-avatar" src={user.avatar} alt="" /> : <span className="op-profile-avatar op-profile-fallback">{(user.nickname || user.username || '?').slice(0, 1)}</span>}
            <div><h3>{user.nickname || user.username}</h3><p>@{user.username} · ID {user.id}</p><Badge tone={user.isBanned ? 'red' : 'green'}>{user.isBanned ? '已停用' : '正常'}</Badge></div>
          </div>
          {user.profileCover && <img className="op-profile-cover" src={user.profileCover} alt="用户主页封面" />}
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
      <div className="op-panel-head op-table-toolbar"><div><h2>用户管理</h2></div>
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
      <div className="op-panel-head op-table-toolbar"><div><h2>动态审核</h2></div>
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
      <div className="op-panel-head op-table-toolbar"><div><h2>评论审核</h2></div>
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
      <div className="op-panel-head op-table-toolbar"><div><h2>反馈工单</h2></div><label className="op-filter">状态<Select value={status || 'all'} onValueChange={(value) => setStatus(value === 'all' ? '' : value)}><SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem>{Object.entries(FEEDBACK_STATUS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></label></div>
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
  return <section className="op-panel op-table-panel"><div className="op-panel-head op-table-toolbar"><div><h2>操作审计</h2></div><div className="op-audit-toolbar"><form className="op-search" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(query.trim()) }}><input aria-label="搜索审计记录" placeholder="搜索操作、管理员或目标类型" value={query} onChange={(event) => setQuery(event.target.value)} /><button>搜索</button></form><button className="op-secondary op-export-button" disabled={!logs?.logs?.length} onClick={() => downloadCsv('chatly-audit.csv', [['id', '记录 ID'], ['adminUsername', '操作账号'], ['action', '操作'], ['targetType', '目标类型'], ['targetId', '目标 ID'], ['createdAt', '时间']], logs?.logs || [])}>导出本页</button></div></div>{logs?.logs?.length ? <div className="op-table-scroll"><table className="op-table"><thead><tr><th>操作人</th><th>动作</th><th>目标</th><th>备注</th><th>时间</th></tr></thead><tbody>{logs.logs.map((log) => <tr key={log.id}><td>{log.adminNickname || log.adminUsername || `管理员 ${log.adminId || ''}`}</td><td><code>{{ 'private.conversations.list': '检索私聊会话', 'private.messages.read': '查阅私聊正文' }[log.action] || log.action}</code></td><td>{log.targetType} #{log.targetId || '—'}</td><td>{log.detail?.reason || log.detail?.status || log.detail?.query || '—'}{log.action === 'private.messages.read' && <small className="op-reason">读取 {log.detail?.returnedCount || 0} 条消息 · 会话 #{log.targetId}</small>}</td><td>{dateTime(log.createdAt)}</td></tr>)}</tbody></table></div> : logs ? <Empty text="没有匹配的操作记录" /> : <div className="op-loading">正在加载审计记录…</div>}{logs && <Pager page={logs.page} total={logs.total} limit={logs.limit} onChange={setPage} />}</section>
}

const ROLE_LABELS = { moderator: '内容审核', support: '客服运营', analyst: '数据分析' }
const NAV_PERMISSION = { overview: 'overview', users: 'users.view', moments: 'content.moments', comments: 'content.comments', feedback: 'support', private: 'messages.private.read', audit: 'audit', system: 'system', staff: 'staff.manage' }

const ROLE_DETAILS = {
  moderator: { description: '审核社区动态与评论，处理违规内容', icon: ShieldCheck },
  support: { description: '管理用户账号状态，跟进反馈工单', icon: Headphones },
  analyst: { description: '查看运营趋势、操作审计与服务状态', icon: ChartNoAxesColumn },
}

function StaffView({ toast }) {
  const [staff, setStaff] = useState(null)
  const [username, setUsername] = useState('')
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [role, setRole] = useState('moderator')
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [formError, setFormError] = useState('')
  const [pendingStaff, setPendingStaff] = useState(null)
  const load = useCallback(() => api.adminStaff().then((result) => setStaff(result.staff)).catch((error) => toast(error.message)), [toast])
  useEffect(() => { load() }, [load])
  const openCreate = () => { setUsername(''); setNickname(''); setPassword(''); setShowPassword(false); setRole('moderator'); setFormError(''); setCreateOpen(true) }
  const create = async (event) => {
    event.preventDefault()
    setBusy(true); setFormError('')
    try {
      await api.adminCreateStaff({ username: username.trim(), nickname: nickname.trim(), password, role })
      setCreateOpen(false); setPassword('')
      toast('后台成员账号已创建'); await load()
    } catch (error) { setFormError(error.message) } finally { setBusy(false) }
  }
  const remove = async (item) => {
    setBusy(true)
    try { await api.adminRemoveStaff(item.id); toast('后台成员已停用，其会话已撤销'); await load(); return true }
    catch (error) { toast(error.message); return false } finally { setBusy(false) }
  }
  const updateRole = async (item, nextRole) => {
    setBusy(true)
    try { await api.adminSetStaffRole(item.id, nextRole); toast('后台角色已更新'); await load() }
    catch (error) { toast(error.message) } finally { setBusy(false) }
  }
  return <>
    <div className="op-team-summary">
      <div><span className="op-team-summary-icon"><Users size={20} /></span><div><small>团队成员</small><strong>{staff ? staff.length : '—'}<em>位成员</em></strong></div></div>
      <div><span className="op-team-summary-icon"><ShieldCheck size={20} /></span><div><small>权限角色</small><strong>3<em>种角色</em></strong></div></div>
      <div><span className="op-team-summary-icon"><LockKeyhole size={20} /></span><div><small>账号体系</small><strong>独立认证</strong></div></div>
    </div>
    <section className="op-panel op-table-panel op-team-table">
      <div className="op-panel-head op-table-toolbar"><div><h2>团队成员 {staff && <Badge>{staff.length}</Badge>}</h2><p className="op-panel-description">管理成员的后台访问权限与运营角色。</p></div><Button onClick={openCreate}><Plus size={16} />新增成员</Button></div>
      {staff?.length ? <div className="op-table-scroll"><Table className="op-table"><TableHeader><TableRow><TableHead>成员</TableHead><TableHead>运营角色</TableHead><TableHead>创建人</TableHead><TableHead>创建时间</TableHead><TableHead>状态</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{staff.map((item) => <TableRow key={item.id}><TableCell><div className="op-user-cell"><span className="op-avatar op-member-avatar">{(item.nickname || item.username).slice(0, 1)}</span><span><b>{item.nickname || item.username}</b><small>{item.username}</small></span></div></TableCell><TableCell><Select value={item.role} disabled={busy} onValueChange={(value) => updateRole(item, value)}><SelectTrigger className="op-member-role" aria-label={`修改 ${item.username} 的后台角色`}><SelectValue /></SelectTrigger><SelectContent>{Object.entries(ROLE_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></TableCell><TableCell>{item.createdByUsername || '—'}</TableCell><TableCell>{dateTime(item.createdAt)}</TableCell><TableCell><Badge tone="green"><i className="op-dot is-live" />正常</Badge></TableCell><TableCell><Button variant="destructive" size="sm" disabled={busy} onClick={() => setPendingStaff(item)}>停用成员</Button></TableCell></TableRow>)}</TableBody></Table></div> : staff ? <Empty icon={Users} text="邀请团队，一起管理社区" description="创建成员账号并分配合适的角色，开始协作管理。" action={<Button variant="outline" onClick={openCreate}><UserRoundPlus size={16} />创建第一位成员</Button>} /> : <div className="op-loading">正在加载后台成员…</div>}
      <div className="op-team-foot"><ShieldCheck size={14} /><span>成员仅能访问其角色授权的功能。权限变更即时生效，管理操作会写入审计日志。</span></div>
    </section>
    <Dialog open={createOpen} onOpenChange={(open) => { if (!busy) { setCreateOpen(open); if (!open) setPassword('') } }}>
      <DialogContent className="op-member-dialog">
        <div className="op-dialog-heading"><span><UserRoundPlus size={22} /></span><div><DialogTitle>新增后台成员</DialogTitle><DialogDescription>创建账号，为新成员分配合适的权限。</DialogDescription></div></div>
        <form className="op-credential-form" onSubmit={create}>
          <div className="op-form-row"><label>后台账号<Input autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用户名或邮箱" minLength={2} maxLength={128} required /></label><label><span className="op-label-row">成员名称 <small>选填</small></span><Input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="填写成员的显示名称" maxLength={40} /></label></div>
          <label>初始密码<div className="op-password-field"><Input aria-label="初始密码" type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="设置至少 12 位的密码" minLength={12} maxLength={128} required /><button type="button" aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
          <fieldset className="op-role-picker"><legend>运营角色</legend>{Object.entries(ROLE_LABELS).map(([value, label]) => { const Icon = ROLE_DETAILS[value].icon; return <label key={value} className={`op-role-choice${role === value ? ' is-selected' : ''}`}><input type="radio" name="staff-role" value={value} checked={role === value} onChange={() => setRole(value)} /><span><b>{label}</b><small>{ROLE_DETAILS[value].description}</small></span><Icon size={20} /></label> })}</fieldset>
          {formError && <p className="op-error" role="alert">{formError}</p>}
          <div className="op-dialog-footer"><Button type="button" variant="outline" disabled={busy} onClick={() => { setCreateOpen(false); setPassword('') }}>取消</Button><Button type="submit" loading={busy} disabled={username.trim().length < 2 || password.length < 12}>{busy ? '正在创建…' : '创建成员'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
    <ActionDialog open={!!pendingStaff} onOpenChange={(open) => !open && setPendingStaff(null)} title="停用后台成员？" description={`将停用 ${pendingStaff?.nickname || pendingStaff?.username || '该成员'} 的后台账号并撤销全部后台会话。`} confirmLabel="停用成员" pending={busy} onConfirm={() => pendingStaff ? remove(pendingStaff) : false} />
  </>
}

function SystemView({ data, toast, onUpdated }) {
  const service = data?.service || {}
  const role = data?.operator?.role || 'owner'
  const [username, setUsername] = useState(data?.operator?.username || '')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => setUsername(data?.operator?.username || ''), [data?.operator?.username])
  const saveCredentials = async (event) => {
    event.preventDefault()
    setSaving(true)
    try {
      const result = await api.adminUpdateCredentials({ currentPassword, username, newPassword })
      onUpdated(result.admin)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      toast('管理员账号和密码已更新，其他设备已退出')
    } catch (error) { toast(error.message) } finally { setSaving(false) }
  }
  return <div className="op-system-grid"><section className="op-panel"><div className="op-panel-head"><div><h2>应用服务</h2></div><Badge tone="green">在线</Badge></div><div className="op-health-row"><span>进程运行时间</span><strong>{Math.floor((service.uptimeSeconds || 0) / 3600)} 小时 {(Math.floor((service.uptimeSeconds || 0) / 60) % 60)} 分</strong></div><div className="op-health-row"><span>数据库驱动</span><strong>{service.database?.driver || '未知'}</strong></div><div className="op-health-row"><span>Redis</span><strong>{service.redis?.state === 'on' ? '就绪' : '未启用 / 降级运行'}</strong></div><div className="op-panel-foot">当前展示本实例健康快照。集中日志、历史指标、备份恢复和通知告警需要接入独立运维服务与备份存储。</div></section><section className="op-panel"><div className="op-panel-head"><div><h2>管理员账号与密码</h2></div><Badge tone="blue">{ROLE_LABELS[role] || '超级管理员'}</Badge></div><p className="op-system-copy">首次部署时从环境变量初始化固定管理员。初始化后，账号和密码保存在数据库中，可在此修改；容器重建不会覆盖后台修改。</p><form className="op-credential-form" onSubmit={saveCredentials}><label>管理员账号<Input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} minLength={2} maxLength={128} required /></label><label>当前密码<Input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label><label>新密码（至少 12 位）<Input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={12} maxLength={128} required /></label><label>确认新密码<Input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={12} maxLength={128} required /></label>{confirmPassword && newPassword !== confirmPassword && <small className="op-reason">两次输入的新密码不一致</small>}<Button type="submit" disabled={saving || !username || !currentPassword || newPassword.length < 12 || newPassword !== confirmPassword}>{saving ? '正在保存…' : '更新管理员凭据'}</Button></form><p className="op-system-copy">保存后其他已登录设备会退出，当前设备保持登录。请妥善保存新密码。</p></section><section className="op-panel"><div className="op-panel-head"><div><h2>后台权限</h2></div><Badge tone="blue">{ROLE_LABELS[role] || '超级管理员'}</Badge></div><p className="op-system-copy">后台账号与会话独立保存，运营接口按后台角色校验权限。可在“后台成员”中创建团队成员账号。</p><p className="op-system-copy">停用账号会撤销其全部登录设备；动态与评论审核仅展示公开内容；管理操作持续写入可搜索的审计日志。手机号与精确位置不对后台开放。私聊正文仅超级管理员可在“私聊查阅”中按原因读取，访问范围会记录到操作审计。</p></section></div>
}

export default function AdminConsole() {
  const [admin, setAdmin] = useState(null)
  const [active, setActive] = useState('overview')
  const [isMobileSidebar, setIsMobileSidebar] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('admin-sidebar-collapsed') === '1')
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const sidebarRef = useRef(null)
  const sidebarTriggerRef = useRef(null)
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
      setAdmin(data.operator)
      setLoginError('')
      setAuthorized(true)
    } catch (error) {
      setAuthorized(false)
      if (error.status === 401) { adminTokenStore.clear(); setAdmin(null) }
      else setLoginError(error.message)
    } finally { setChecking(false) }
  }, [])

  useEffect(() => {
    if (adminTokenStore.get()) void refresh()
    else setChecking(false)
    const expired = () => { setAdmin(null); setAuthorized(false); setOverview(null); setActive('overview'); setLoginError('后台登录已过期，请重新登录') }
    const changed = (event) => {
      if (event.key !== 'chatly.admin.token') return
      setActive('overview')
      if (event.newValue) void refresh()
      else { setAdmin(null); setAuthorized(false); setOverview(null) }
    }
    window.addEventListener('chatly:admin-session-expired', expired)
    window.addEventListener('storage', changed)
    return () => { window.removeEventListener('chatly:admin-session-expired', expired); window.removeEventListener('storage', changed) }
  }, [refresh])
  const logout = async () => {
    try { await api.adminLogout() } catch {} finally {
      adminTokenStore.clear(); setAdmin(null); setAuthorized(false); setOverview(null); setLoginError(''); setActive('overview')
    }
  }
  const submitLogin = async (credentials) => {
    setLoginBusy(true)
    setLoginError('')
    try {
      const result = await api.adminLogin(credentials)
      adminTokenStore.set(result.token)
      setAdmin(result.admin)
      await refresh()
    }
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
      if (event.key === 'Escape' && isMobileSidebar) { document.activeElement?.blur(); setMobileSidebarOpen(false); requestAnimationFrame(() => sidebarTriggerRef.current?.focus()) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [authorized, isMobileSidebar])

  useEffect(() => {
    if (!isMobileSidebar || !mobileSidebarOpen) return undefined
    sidebarRef.current?.querySelector('[aria-label="关闭菜单"]')?.focus()
    const keepFocus = (event) => {
      if (event.key !== 'Tab') return
      const items = [...sidebarRef.current.querySelectorAll('button:not(:disabled), a[href]')].filter((element) => element.getClientRects().length && getComputedStyle(element).display !== 'none')
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keepFocus)
    return () => document.removeEventListener('keydown', keepFocus)
  }, [isMobileSidebar, mobileSidebarOpen])
  const closeMobileSidebar = () => { if (sidebarRef.current?.contains(document.activeElement)) document.activeElement.blur(); setMobileSidebarOpen(false); requestAnimationFrame(() => sidebarTriggerRef.current?.focus()) }
  const toggleSidebar = () => {
    if (isMobileSidebar) setMobileSidebarOpen((open) => !open)
    else setSidebarCollapsed((collapsed) => !collapsed)
  }
  const navigate = (id) => { setActive(id); if (isMobileSidebar) closeMobileSidebar() }

  if (checking) return <main className="op-login-wrap"><div className="op-loading">正在验证后台权限…</div></main>
  if (!admin || !authorized) return <AdminLogin onSubmit={submitLogin} busy={loginBusy} error={loginError} />

  return (
    <div className={`op-app${sidebarCollapsed ? ' is-collapsed' : ''}${mobileSidebarOpen ? ' is-mobile-open' : ''}`}>
      {mobileSidebarOpen && <button className="op-sidebar-scrim" aria-label="关闭导航菜单" onClick={closeMobileSidebar} />}
      <aside ref={sidebarRef} className="op-sidebar" aria-label="后台侧边栏" role={isMobileSidebar ? 'dialog' : undefined} aria-modal={isMobileSidebar && mobileSidebarOpen ? true : undefined} aria-hidden={isMobileSidebar && !mobileSidebarOpen ? true : undefined} inert={isMobileSidebar && !mobileSidebarOpen ? '' : undefined}>
        <div className="op-sidebar-header"><a href="/qishiyou" className="op-brand" aria-label="Chatly 运营管理平台"><span className="op-brand-mark">C</span><span><b>Chatly</b><small>运营管理平台</small></span></a><button className="op-sidebar-collapse" onClick={toggleSidebar} aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'} title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}>{sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button><button className="op-sidebar-mobile-close" onClick={closeMobileSidebar} aria-label="关闭菜单"><X size={18} /></button></div>
        <div className="op-workspace"><LayoutDashboard size={18} /><div><b>运营工作空间</b><small>Chatly Operations</small></div><i className="op-dot is-live" /></div>
        <nav aria-label="后台导航">{visibleNav.map((item, index) => { const Icon = NAV_ICONS[item.id]; return <React.Fragment key={item.id}>{(index === 0 || visibleNav[index - 1].group !== item.group) && <p className="op-side-label">{item.group}</p>}<button title={sidebarCollapsed ? item.label : undefined} aria-label={item.label} aria-current={active === item.id ? 'page' : undefined} className={active === item.id ? 'is-active' : ''} onClick={() => navigate(item.id)}><span className="op-nav-icon"><Icon size={20} strokeWidth={1.75} /></span><span className="op-nav-label">{item.label}</span>{item.id === 'feedback' && overview?.stats?.openFeedback > 0 && <em>{overview.stats.openFeedback}</em>}</button></React.Fragment> })}</nav>
        <div className="op-sidebar-bottom"><div className="op-admin-user"><span className="op-avatar">{(admin.nickname || admin.username || 'A').slice(0, 1)}</span><span><b>{admin.nickname || admin.username}</b><small>{ROLE_LABELS[overview?.operator?.role] || '超级管理员'} · ID {admin.id}</small></span></div><button className="op-logout" aria-label="退出后台登录" onClick={logout}><LogOut size={15} /><span>退出登录</span></button><a href="/" className="op-exit-link" aria-label="返回用户端"><Home size={15} /><span>返回用户端</span></a></div>
      </aside>
      <main className="op-main" inert={isMobileSidebar && mobileSidebarOpen ? '' : undefined}>
        <header className="op-topbar"><div className="op-topbar-leading"><Button variant="ghost" size="icon" className="op-sidebar-trigger" ref={sidebarTriggerRef} onClick={toggleSidebar} aria-label={isMobileSidebar ? mobileSidebarOpen ? '关闭导航菜单' : '打开导航菜单' : sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'} aria-expanded={isMobileSidebar ? mobileSidebarOpen : !sidebarCollapsed}>{isMobileSidebar ? <Menu size={17} /> : sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</Button><div className="op-breadcrumb"><span className="op-breadcrumb-root">工作空间</span><span>/</span><strong>{title}</strong></div></div><div><span className="op-live-label"><i className="op-dot is-live" />系统在线</span><Button variant="outline" size="icon" className="op-refresh" onClick={() => refresh()} aria-label="刷新总览"><RefreshCw size={15} /></Button></div></header>
        <div className="op-content"><div className="op-page-title"><div><p className="op-eyebrow">CHATLY <span> / </span> OPERATIONS</p><h1>{title}</h1><p>{NAV.find((item) => item.id === active)?.description}</p></div><span className="op-date"><CalendarDays size={14} />{new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</span></div>
          {active === 'overview' && <Overview data={overview} onNavigate={navigate} toast={toast} />}
          {active === 'users' && <UsersView toast={toast} />}
          {active === 'moments' && <MomentsView toast={toast} />}
          {active === 'comments' && <CommentsView toast={toast} />}
          {active === 'feedback' && <FeedbackView toast={toast} />}
          {active === 'private' && <AdminPrivateMessages />}
          {active === 'audit' && <AuditView toast={toast} />}
          {active === 'system' && <SystemView data={overview} toast={toast} onUpdated={(updatedAdmin) => { setAdmin(updatedAdmin); void refresh() }} />}
          {active === 'staff' && <StaffView toast={toast} />}
        </div>
      </main>
      {toastText && <div className="op-toast" role="status"><Info size={16} />{toastText}</div>}
    </div>
  )
}
