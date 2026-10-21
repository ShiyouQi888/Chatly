import React, { useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { IconChat, IconUser, IconLock, IconPhone, IconMail } from '../components/Icon.jsx'
import './login.css'

export default function LoginScreen({ onLogin, error: externalError }) {
  const [mode, setMode] = useState('login')
  // 手机注册流程保留在下方，当前注册入口固定为邮箱验证。
  const registerMethod = 'email'
  const [identifier, setIdentifier] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [phoneCode, setPhoneCode] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [phoneCountdown, setPhoneCountdown] = useState(0)
  const [emailCountdown, setEmailCountdown] = useState(0)
  const [password, setPassword] = useState('')
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

  const shown = error || externalError

  return (
    <div className="login">
      <div className="lg-content">
        <header className="lg-hero">
          <div className="lg-brand">
            <span className="lg-logo"><IconChat size={23} /></span>
            <span>Chatly</span>
          </div>
          <p className="lg-eyebrow">KEEP CLOSE, EVERY DAY</p>
          <h1>把重要的人<br />聊在一起</h1>
          <p className="lg-tagline">分享日常，也分享心情。</p>
          <div className="lg-art" aria-hidden="true">
            <span className="lg-art-spark lg-art-spark-one">✦</span>
            <span className="lg-art-spark lg-art-spark-two">✧</span>
            <div className="lg-art-message lg-art-message-main">
              <span className="lg-art-avatar lg-art-avatar-a">A</span>
              <span className="lg-art-lines"><i /><i /></span>
              <span className="lg-art-bubble"><i /><i /><i /></span>
            </div>
            <div className="lg-art-message lg-art-message-small">
              <span className="lg-art-avatar lg-art-avatar-b">M</span>
              <span className="lg-art-lines"><i /><i /></span>
              <span className="lg-art-heart">♥</span>
            </div>
          </div>
        </header>

        <form className="lg-card" onSubmit={submit}>
        <div className="lg-seg" role="tablist" aria-label="账号入口">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'is-on' : ''} onClick={() => { setMode('login'); setError('') }}>登录</button>
          <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'is-on' : ''} onClick={() => { setMode('register'); setError('') }}>注册</button>
        </div>

        {mode === 'login' ? <>
          <label className="lg-field"><IconUser size={17} /><input value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="用户名 / 手机号 / 邮箱" autoComplete="username" required /></label>
          <label className="lg-field"><IconLock size={17} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码" autoComplete="current-password" required /></label>
        </> : <>
          {registerMethod === 'phone' ? <>
            <label className="lg-field"><IconPhone size={17} /><input type="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="手机号，如 +86 138 0000 0000" autoComplete="tel" required /></label>
            <div className="lg-code-row"><label className="lg-field"><IconLock size={17} /><input value={phoneCode} onChange={(event) => setPhoneCode(event.target.value)} placeholder="短信验证码" inputMode="numeric" autoComplete="one-time-code" required /></label><button className="lg-code-button" type="button" disabled={sendingCode || phoneCountdown > 0 || !phone.trim()} onClick={() => sendCode('phone')}>{sendingCode ? '发送中…' : phoneCountdown ? `${phoneCountdown}s 后重发` : '获取验证码'}</button></div>
          </> : <>
            <label className="lg-field"><IconMail size={17} /><input type="email" inputMode="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="邮箱地址" autoComplete="email" required /></label>
            <div className="lg-code-row"><label className="lg-field"><IconLock size={17} /><input value={emailCode} onChange={(event) => setEmailCode(event.target.value)} placeholder="邮箱验证码" inputMode="numeric" autoComplete="one-time-code" required /></label><button className="lg-code-button" type="button" disabled={sendingCode || emailCountdown > 0 || !email.trim()} onClick={() => sendCode('email')}>{sendingCode ? '发送中…' : emailCountdown ? `${emailCountdown}s 后重发` : '发送验证码'}</button></div>
          </>}
          <label className="lg-field"><IconLock size={17} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="设置密码（至少 8 位）" autoComplete="new-password" minLength={8} required /></label>
          <label className="lg-field"><IconUser size={17} /><input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="昵称（可留空）" autoComplete="nickname" /></label>
          <p className="lg-method-hint">验证码将发送到此邮箱；验证通过后即可完成注册。</p>
        </>}

        {shown && <p className="lg-error" role="alert">{shown}</p>}
        <button type="submit" className="lg-submit" disabled={busy}>{busy ? '处理中…' : mode === 'login' ? '登录' : registerMethod === 'phone' ? '手机号注册并登录' : '邮箱注册并登录'}</button>

        </form>
      </div>
    </div>
  )
}
