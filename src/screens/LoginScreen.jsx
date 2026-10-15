import React, { useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { IconChat, IconUser, IconLock, IconCheck, IconPhone, IconMail } from '../components/Icon.jsx'
import './login.css'

const DEMO = [
  { username: 'chenmo', label: '陈墨' },
  { username: 'linxiaoxia', label: '林小夏' },
  { username: 'ajie', label: '阿杰' },
]

export default function LoginScreen({ onLogin, error: externalError }) {
  const [mode, setMode] = useState('login')
  const [registerMethod, setRegisterMethod] = useState('phone')
  const [identifier, setIdentifier] = useState('chenmo')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [phoneCode, setPhoneCode] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [phoneCountdown, setPhoneCountdown] = useState(0)
  const [emailCountdown, setEmailCountdown] = useState(0)
  const [password, setPassword] = useState('chatly123')
  const [nickname, setNickname] = useState('')
  const [busy, setBusy] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (phoneCountdown <= 0) return undefined
    const timer = window.setTimeout(() => setPhoneCountdown((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [phoneCountdown])
  useEffect(() => {
    if (emailCountdown <= 0) return undefined
    const timer = window.setTimeout(() => setEmailCountdown((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [emailCountdown])

  const submit = async (event) => {
    event?.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (mode === 'login') {
        await onLogin({ type: 'login', username: identifier.trim(), password })
      } else if (registerMethod === 'phone') {
        await onLogin({ type: 'registerPhone', phone: phone.trim(), code: phoneCode.trim(), password, nickname })
      } else {
        await onLogin({ type: 'registerEmail', email: email.trim(), code: emailCode.trim(), password, nickname })
      }
    } catch (err) {
      setError(err.message || '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const sendCode = async (method) => {
    setError('')
    setSendingCode(true)
    try {
      if (method === 'phone') {
        await api.sendPhoneRegistrationCode(phone.trim())
        setPhoneCountdown(60)
      } else {
        await api.sendEmailRegistrationCode(email.trim())
        setEmailCountdown(60)
      }
    } catch (err) {
      setError(err.message || '验证码发送失败')
    } finally {
      setSendingCode(false)
    }
  }

  const quick = async (username) => {
    setIdentifier(username)
    setPassword('chatly123')
    setError('')
    setBusy(true)
    try {
      await onLogin({ type: 'login', username, password: 'chatly123' })
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
        <span className="lg-logo"><IconChat size={30} /></span>
        <h1>Chatly</h1>
        <p>连接更有趣的人</p>
      </div>

      <form className="lg-card" onSubmit={submit}>
        <div className="lg-seg" role="tablist" aria-label="账号入口">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'is-on' : ''} onClick={() => { setMode('login'); setError('') }}>登录</button>
          <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'is-on' : ''} onClick={() => { setMode('register'); setError('') }}>注册</button>
        </div>

        {mode === 'login' ? <>
          <label className="lg-field"><IconUser size={17} /><input value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="用户名 / 手机号 / 邮箱" autoComplete="username" required /></label>
          <label className="lg-field"><IconLock size={17} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码" autoComplete="current-password" required /></label>
        </> : <>
          <div className="lg-method-seg" role="tablist" aria-label="选择注册方式">
            <button type="button" role="tab" aria-selected={registerMethod === 'phone'} className={registerMethod === 'phone' ? 'is-on' : ''} onClick={() => { setRegisterMethod('phone'); setError('') }}><IconPhone size={15} />手机号注册</button>
            <button type="button" role="tab" aria-selected={registerMethod === 'email'} className={registerMethod === 'email' ? 'is-on' : ''} onClick={() => { setRegisterMethod('email'); setError('') }}><IconMail size={15} />邮箱注册</button>
          </div>
          {registerMethod === 'phone' ? <>
            <label className="lg-field"><IconPhone size={17} /><input type="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="手机号，如 +86 138 0000 0000" autoComplete="tel" required /></label>
            <div className="lg-code-row"><label className="lg-field"><IconLock size={17} /><input value={phoneCode} onChange={(event) => setPhoneCode(event.target.value)} placeholder="短信验证码" inputMode="numeric" autoComplete="one-time-code" required /></label><button className="lg-code-button" type="button" disabled={sendingCode || phoneCountdown > 0 || !phone.trim()} onClick={() => sendCode('phone')}>{sendingCode ? '发送中…' : phoneCountdown ? `${phoneCountdown}s 后重发` : '获取验证码'}</button></div>
          </> : <>
            <label className="lg-field"><IconMail size={17} /><input type="email" inputMode="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="邮箱地址" autoComplete="email" required /></label>
            <div className="lg-code-row"><label className="lg-field"><IconLock size={17} /><input value={emailCode} onChange={(event) => setEmailCode(event.target.value)} placeholder="邮件验证码" inputMode="numeric" autoComplete="one-time-code" required /></label><button className="lg-code-button" type="button" disabled={sendingCode || emailCountdown > 0 || !email.trim()} onClick={() => sendCode('email')}>{sendingCode ? '发送中…' : emailCountdown ? `${emailCountdown}s 后重发` : '获取验证码'}</button></div>
          </>}
          <label className="lg-field"><IconLock size={17} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="设置密码（至少 8 位）" autoComplete="new-password" minLength={8} required /></label>
          <label className="lg-field"><IconUser size={17} /><input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="昵称（可留空）" autoComplete="nickname" /></label>
          <p className="lg-method-hint">{registerMethod === 'phone' ? '手机号会作为独立登录凭证，不会公开展示。' : '邮箱会作为独立登录凭证，不会公开展示。'}</p>
        </>}

        {shown && <p className="lg-error" role="alert">{shown}</p>}
        <button type="submit" className="lg-submit" disabled={busy}>{busy ? '处理中…' : mode === 'login' ? '登录' : registerMethod === 'phone' ? '手机号注册并登录' : '邮箱注册并登录'}</button>

        {mode === 'login' && <div className="lg-demo"><span className="lg-demo-title">演示账号 · 一键登录</span><div className="lg-demo-list">{DEMO.map((item) => <button key={item.username} type="button" onClick={() => quick(item.username)} disabled={busy}><IconCheck size={13} />{item.label}</button>)}</div><p className="lg-demo-hint">密码统一为 chatly123。多开一个浏览器用另一账号登录，可实时互发消息。</p></div>}
      </form>

      <p className="lg-foot">数据由本地独立后端提供 <span>Express 5 · SQLite · WebSocket</span></p>
    </div>
  )
}
