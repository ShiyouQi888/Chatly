import React, { useState } from 'react'
import { IconChat, IconUser, IconLock, IconCheck, IconChevron } from '../components/Icon.jsx'
import './login.css'

const DEMO = [
  { username: 'chenmo', label: '陈墨' },
  { username: 'linxiaoxia', label: '林小夏' },
  { username: 'ajie', label: '阿杰' },
]

export default function LoginScreen({ onLogin, error: externalError }) {
  const [mode, setMode] = useState('login') // login | register
  const [username, setUsername] = useState('chenmo')
  const [password, setPassword] = useState('chatly123')
  const [nickname, setNickname] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e?.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (mode === 'register') {
        await onLogin({ type: 'register', username, password, nickname })
      } else {
        await onLogin({ type: 'login', username, password })
      }
    } catch (err) {
      setError(err.message || '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const quick = async (u) => {
    setUsername(u)
    setPassword('chatly123')
    setError('')
    setBusy(true)
    try {
      await onLogin({ type: 'login', username: u, password: 'chatly123' })
    } catch (err) {
      setError(err.message || '登录失败')
    } finally {
      setBusy(false)
    }
  }

  const shown = error || externalError

  return (
    <div className="login">
      <div className="lg-hero">
        <span className="lg-logo">
          <IconChat size={30} />
        </span>
        <h1>Chatly</h1>
        <p>连接更有趣的人</p>
      </div>

      <form className="lg-card" onSubmit={submit}>
        <div className="lg-seg">
          <button
            type="button"
            className={mode === 'login' ? 'is-on' : ''}
            onClick={() => {
              setMode('login')
              setError('')
            }}
          >
            登录
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'is-on' : ''}
            onClick={() => {
              setMode('register')
              setError('')
            }}
          >
            注册
          </button>
        </div>

        <label className="lg-field">
          <IconUser size={17} />
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名"
            autoComplete="username"
          />
        </label>

        <label className="lg-field">
          <IconLock size={17} />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>

        {mode === 'register' && (
          <label className="lg-field">
            <IconUser size={17} />
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="昵称（可留空）" />
          </label>
        )}

        {shown && <p className="lg-error">{shown}</p>}

        <button type="submit" className="lg-submit" disabled={busy}>
          {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>

        <div className="lg-demo">
          <span className="lg-demo-title">演示账号 · 一键登录</span>
          <div className="lg-demo-list">
            {DEMO.map((d) => (
              <button key={d.username} type="button" onClick={() => quick(d.username)} disabled={busy}>
                <IconCheck size={13} />
                {d.label}
              </button>
            ))}
          </div>
          <p className="lg-demo-hint">密码统一为 chatly123。多开一个浏览器用另一账号登录，可实时互发消息。</p>
        </div>
      </form>

      <p className="lg-foot">
        数据由本地独立后端提供 <span>Express 5 · SQLite · WebSocket</span>
      </p>
    </div>
  )
}
