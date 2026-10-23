import React, { useCallback, useEffect, useRef, useState } from 'react'
import { FileSearch, LockKeyhole, MessageSquare, ShieldCheck, Users } from 'lucide-react'
import { api } from '../api/client.js'
import { Button } from '../components/ui/button.jsx'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog.jsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.jsx'
import './admin-private-messages.css'

const time = (value) => value ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : '—'
const kinds = { image: '图片消息', video: '视频消息', file: '文件或语音消息', location: '位置消息', poll: '投票消息', text: '文本消息' }

export default function AdminPrivateMessages() {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [selection, setSelection] = useState(null)
  const [reason, setReason] = useState('')
  const [messages, setMessages] = useState([])
  const [access, setAccess] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [beforeId, setBeforeId] = useState(null)
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState('')
  const listVersion = useRef(0)
  const readVersion = useRef(0)
  const scrollRef = useRef(null)

  const load = useCallback(async () => {
    const version = ++listVersion.current
    setData(null); setLoadError('')
    try {
      const result = await api.adminPrivateConversations({ q: search, page })
      if (version === listVersion.current) setData(result)
    } catch (error) { if (version === listVersion.current) setLoadError(error.message) }
  }, [search, page])
  useEffect(() => { void load(); return () => { listVersion.current++ } }, [load])
  useEffect(() => () => { readVersion.current++ }, [])

  const close = () => {
    readVersion.current++
    setSelection(null); setMessages([]); setAccess(null); setReason(''); setReading(false); setReadError('')
  }
  const open = (conversation) => {
    readVersion.current++
    setSelection(conversation); setReason(''); setMessages([]); setAccess(null); setHasMore(false); setBeforeId(null); setReadError(''); setReading(false)
  }
  const read = async (older = false) => {
    if (!selection || reading) return
    const version = ++readVersion.current
    const previousHeight = scrollRef.current?.scrollHeight || 0
    const previousTop = scrollRef.current?.scrollTop || 0
    setReading(true); setReadError('')
    try {
      const result = await api.adminReadPrivateMessages(selection.id, { reason: older ? access.reason : reason.trim(), ...(older ? { beforeId } : {}), limit: 50 })
      if (version !== readVersion.current) return
      setMessages((previous) => older ? [...result.messages, ...previous] : result.messages)
      setAccess(result.access); setBeforeId(result.nextBeforeId); setHasMore(result.hasMore)
      requestAnimationFrame(() => {
        if (version !== readVersion.current || !scrollRef.current) return
        scrollRef.current.scrollTop = older ? previousTop + scrollRef.current.scrollHeight - previousHeight : scrollRef.current.scrollHeight
      })
    } catch (error) { if (version === readVersion.current) setReadError(error.message) }
    finally { if (version === readVersion.current) setReading(false) }
  }
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1

  return <>
    <div className="op-note-panel op-private-notice"><ShieldCheck size={18} /><div><b>受控查阅 · 访问留痕</b><p>会话列表不展示正文。查阅时填写原因，每次读取的会话、消息范围和管理员身份均记录到操作审计。</p></div></div>
    <section className="op-panel op-table-panel">
      <div className="op-panel-head op-table-toolbar"><div><h2>私聊会话</h2><p className="op-panel-description">按参与人的昵称、账号、用户 ID 或会话 ID 检索。</p></div><form className="op-search" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(query.trim()) }}><input aria-label="检索私聊会话" placeholder="搜索用户或会话" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={80} /><button type="submit">搜索</button></form></div>
      {loadError ? <div className="op-private-empty"><p role="alert">{loadError}</p><Button variant="outline" onClick={load}>重新加载</Button></div> : !data ? <div className="op-loading">正在加载私聊会话…</div> : data.conversations.length ? <div className="op-table-scroll"><Table className="op-table"><TableHeader><TableRow><TableHead>私聊参与人</TableHead><TableHead>会话 ID</TableHead><TableHead>消息数量</TableHead><TableHead>最近消息时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{data.conversations.map((conversation) => <TableRow key={conversation.id}><TableCell><div className="op-private-participants">{conversation.participants.map((person) => <div key={person.id} className="op-user-cell"><span className="op-avatar">{(person.nickname || person.username || '?').slice(0, 1)}</span><span><b>{person.nickname || person.username}</b><small>@{person.username} · ID {person.id}</small></span></div>)}{!conversation.participants.length && <span>参与人已不存在</span>}</div></TableCell><TableCell>#{conversation.id}</TableCell><TableCell>{conversation.messageCount}</TableCell><TableCell>{time(conversation.lastMessageAt)}</TableCell><TableCell><Button variant="outline" size="sm" onClick={() => open(conversation)}><FileSearch size={14} />查阅正文</Button></TableCell></TableRow>)}</TableBody></Table></div> : <div className="op-private-empty"><Users size={32} strokeWidth={1.5} /><h3>没有找到私聊会话</h3><p>调整搜索条件后重试。</p></div>}
      {data && <div className="op-pager"><span>共 {data.total} 个会话 · 第 {page} / {pages} 页</span><div><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</Button><Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</Button></div></div>}
    </section>
    <Dialog open={!!selection} onOpenChange={(value) => { if (!value) close() }}>
      <DialogContent className={`op-private-dialog${access ? ' is-reading' : ''}`}>
        <div className="op-dialog-heading"><span><MessageSquare size={22} /></span><div><DialogTitle>私聊正文 · 会话 #{selection?.id}</DialogTitle><DialogDescription>{selection?.participants.map((person) => person.nickname || person.username).join(' / ') || '私聊会话'}</DialogDescription></div></div>
        {!access ? <form className="op-credential-form" onSubmit={(event) => { event.preventDefault(); void read() }}><label htmlFor="private-read-reason">查阅原因<textarea id="private-read-reason" className="op-private-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：核查用户举报，工单 #123" minLength={2} maxLength={300} required /></label><p className="op-field-help">读取不会修改用户已读状态。已撤回正文及已到期的阅后即焚内容不会返回。</p>{readError && <p className="op-error" role="alert">{readError}</p>}<div className="op-dialog-footer"><Button type="button" variant="outline" onClick={close}>取消</Button><Button type="submit" loading={reading} disabled={[...reason.trim()].length < 2}>{reading ? '正在读取…' : '开始查阅'}</Button></div></form> : <>
          <div className="op-private-access"><ShieldCheck size={16} /><div><b>查阅已记录</b><span>{access.reason} · {time(access.readAt)}</span></div></div>
          {readError && <p className="op-error" role="alert">{readError}</p>}
          <div className="op-private-history" ref={scrollRef} tabIndex={0} aria-label="私聊正文记录">
            {hasMore && <div className="op-private-older"><Button variant="outline" size="sm" loading={reading} onClick={() => read(true)}>读取更早消息</Button></div>}
            {messages.length ? messages.map((message) => <article className="op-private-message" key={message.id}><header><strong>{message.sender.nickname || message.sender.username || '已删除用户'}</strong><span>@{message.sender.username || '—'}</span><time>{time(message.createdAt)}</time><small>#{message.id}</small></header>{message.status === 'revoked' ? <p className="is-unavailable">消息已撤回</p> : message.status === 'encrypted_unavailable' ? <p className="is-unavailable"><LockKeyhole size={14} />加密消息暂不可读取，请检查服务端消息密钥。</p> : message.text != null ? <p>{message.text || '（空文本）'}</p> : <p className="is-unavailable">[{kinds[message.kind] || message.kind}]{message.file?.name ? ` ${message.file.name}` : ''}</p>}{message.encrypted && message.status === 'available' && <small className="op-private-encrypted"><LockKeyhole size={12} />服务端加密存储</small>}</article>) : <div className="op-private-empty"><p>当前没有可读取的消息。</p></div>}
          </div>
          <div className="op-private-reader-foot"><span>已读取 {messages.length} 条 · 正文不支持附件下载</span><Button variant="outline" size="sm" onClick={close}>关闭查阅</Button></div>
        </>}
      </DialogContent>
    </Dialog>
  </>
}
