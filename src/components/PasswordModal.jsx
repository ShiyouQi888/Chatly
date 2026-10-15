import React, { useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { Sheet } from './ui.jsx'

/* ===== 修改密码弹层 =====
 * 为什么现在能做：`password_hash` 是库里真有的字段，登录也确实校验它
 * —— 之前只是没补这条接口，不是「做不了」（那是生物识别那种没校验通道的情况）。
 * 现在补上了，这一页就该是真的：旧密码校验、新密码写库、失败如实报错。
 *
 * ⚠️ 改完**不会**把其它设备踢下线（JWT 无状态，见后端注释与这里的提示）。
 *   界面上要讲明白 —— 不然用户会以为「改了密码别人就进不来了」。 */
export default function PasswordModal({ open, onClose, showToast }) {
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  /* 每次打开都清空 —— 密码这种东西不该残留在上一次没提交的草稿里 */
  useEffect(() => {
    if (open) {
      setOldPw('')
      setNewPw('')
      setConfirmPw('')
      setErr('')
      setBusy(false)
    }
  }, [open])

  const submit = async () => {
    setErr('')
    if (!oldPw || !newPw || !confirmPw) {
      setErr('三项都要填')
      return
    }
    if (newPw.length < 6) {
      setErr('新密码至少 6 位')
      return
    }
    if (newPw !== confirmPw) {
      setErr('两次输入的新密码不一致')
      return
    }
    setBusy(true)
    try {
      await api.changePassword(oldPw, newPw)
      showToast('密码已修改')
      onClose()
    } catch (e) {
      setErr(e.message || '修改失败')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <Sheet open={open} onClose={busy ? () => {} : onClose} title="修改密码">
      <div className="pw-form">
        <div className="pw-field">
          <label htmlFor="pw-old">当前密码</label>
          <input
            id="pw-old"
            className="form-input"
            type="password"
            autoComplete="current-password"
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="pw-field">
          <label htmlFor="pw-new">新密码</label>
          <input
            id="pw-new"
            className="form-input"
            type="password"
            autoComplete="new-password"
            placeholder="至少 6 位"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="pw-field">
          <label htmlFor="pw-confirm">确认新密码</label>
          <input
            id="pw-confirm"
            className="form-input"
            type="password"
            autoComplete="new-password"
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            disabled={busy}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>

        {err && <p className="pw-err">{err}</p>}

        <p className="pw-note">
          修改后当前设备仍然登录；其它设备不会被强制退出，直到它们的登录过期。
        </p>

        <button type="button" className="pw-submit" onClick={submit} disabled={busy}>
          {busy ? '提交中…' : '确认修改'}
        </button>
      </div>
    </Sheet>
  )
}
