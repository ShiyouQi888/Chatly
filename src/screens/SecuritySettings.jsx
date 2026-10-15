import React, { useState, useEffect } from 'react'
import { api } from '../api/client.js'
import { useAuth } from '../store/AuthContext.jsx'
import { IconBack, IconUser, IconShield, IconLock, IconInfo, IconLogout } from '../components/Icon.jsx'
import { Row, Group, Switch, ActionMenu } from '../components/ui.jsx'
import PasswordModal from '../components/PasswordModal.jsx'
import './me-tab.css'

/* ===== 账号与安全 =====
 * 登录方式、安全设置、设备管理
 *
 * ## 这一页有一条不能破的规矩
 * 「安全」类设置**宁可少一项，也不能让用户以为自己被保护了**。
 * 所以这里每一项都必须是三者之一：
 *   ① 真的生效（设备列表：真读后端、真远程退出；修改密码：真校验旧密码、真写库）；
 *   ② 真的存在但这一页改不了（手机号：库里真有，但编辑入口在「编辑资料」）；
 *   ③ 根本不存在 → **禁用并写明原因**（邮箱 / 生物识别 / 二次验证）。
 * 以前这里踩过两个坑，都写在 LESSONS 里：
 *   - 硬编码了一个手机号 `138****6721`（当时库里确实没有这个字段）；
 *   - 「退出登录」只弹了个 `已退出登录 · 原型演示` 的 toast，人根本没退出去。
 */
export default function SecuritySettings({ onBack, showToast, user }) {
  const { logout } = useAuth()
  const [devices, setDevices] = useState([])
  const [securitySettings, setSecuritySettings] = useState({
    biometric: false,
    twoFactor: false,
  })
  const [loading, setLoading] = useState(true)
  /* 要退出的设备（原先是原生 confirm()，全项目就这一处 —— 统一改成自家的菜单） */
  const [askDevice, setAskDevice] = useState(null)
  /* 修改密码弹层：password_hash 在库里真实存在、登录真实校验，
     所以这一项从「未接入」升级成了真功能（接口见 routes/auth.js 的 /me/password） */
  const [pwOpen, setPwOpen] = useState(false)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      const [devicesRes, settingsRes] = await Promise.all([api.getDevices(), api.getSecuritySettings()])
      setDevices(devicesRes)
      setSecuritySettings(settingsRes)
    } catch (err) {
      console.error('加载安全数据失败:', err)
    } finally {
      setLoading(false)
    }
  }

  const removeDevice = async (deviceId) => {
    try {
      await api.removeDevice(deviceId)
      setDevices((prev) => prev.filter((d) => d.id !== deviceId))
      showToast('已退出设备')
    } catch (err) {
      showToast('操作失败: ' + err.message)
    }
  }

  const formatTime = (timestamp) => {
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes} 分钟前`
    if (hours < 24) return `${hours} 小时前`
    if (days < 30) return `${days} 天前`
    return new Date(timestamp).toLocaleDateString('zh-CN')
  }

  /* 手机号脱敏：selfUser 回的是完整号码，安全页只展示 138****6721 这种形态。
     没填就明确写「未填写」，而不是像以前那样凭空编一个号出来。 */
  const maskPhone = (p) => {
    const s = String(p || '')
    if (s.length !== 11) return s || null
    return s.slice(0, 3) + '****' + s.slice(7)
  }

  const body = (
    <div className="sub-scroll">
      {/* 登录方式：只列**库里真的有的**东西。 */}
      <Group title="登录方式">
        <Row icon={<IconUser size={19} />} label="用户名" value={user?.username || '—'} />
        {/* 密码：接口已接通（POST /auth/me/password 真校验旧密码、真写新哈希）。
            点这一行打开弹层，不是摆设。 */}
        <Row
          icon={<IconLock size={19} />}
          label="密码"
          value="已设置"
          onClick={() => setPwOpen(true)}
        />
        {/* 手机号：库里现在真有 phone 字段，编辑资料页也真保存它 ——
            所以这里如实显示（脱敏），改的话引导去「编辑资料」，而不是谎称「没有该字段」。 */}
        <Row
          icon={<IconInfo size={19} />}
          label="手机号"
          value={maskPhone(user?.phone) || '未填写'}
          sub={user?.phone ? '在「编辑资料」里修改' : '在「编辑资料」里填写，供他人按号找到你'}
          last
        />
      </Group>

      <Group title="未接入" footer="邮箱在数据库里没有对应字段，列出来只会让人以为自己绑过。">
        <Row
          label="邮箱"
          sub="数据库中没有邮箱字段"
          right={<span className="tag-off">未接入</span>}
          last
        />
      </Group>

      {/* 安全设置：开关**存得进后端**（user_settings 表里确实有这两行），
          但全项目没有任何代码读它 —— 打开「二次验证」并不会让下次登录多一步验证。
          对一个安全开关来说，这比一个死按钮更糟：它给人一个虚假的安心。
          所以禁用 + 写明，而不是让它照样能拨。 */}
      <Group
        title="安全设置"
        footer="这两项底层还没接通：开关状态能存下来，但不会改变登录方式，所以先禁用。"
      >
        <Row
          icon={<IconShield size={19} />}
          label="生物识别"
          sub="未接入：没有指纹 / 面容校验"
          right={<Switch on={false} disabled />}
        />
        <Row
          icon={<IconLock size={19} />}
          label="二次验证"
          sub="未接入：登录流程没有第二步"
          right={<Switch on={false} disabled />}
          last
        />
      </Group>

      <Group title="登录设备">
        {devices.length === 0 && <Row label="没有其它登录设备" chevron={false} last />}
        {devices.map((d, i) => (
          <Row
            key={d.id}
            icon={<IconInfo size={19} />}
            label={d.name}
            sub={`${formatTime(d.lastActive)} · ${d.type}`}
            right={d.isCurrent ? <span className="tag-now">当前</span> : null}
            chevron={!d.isCurrent}
            onClick={d.isCurrent ? undefined : () => setAskDevice(d)}
            last={i === devices.length - 1}
          />
        ))}
      </Group>

      <Group>
        <Row
          icon={<IconLogout size={19} />}
          label="退出登录"
          danger
          onClick={() => logout()}
          last
        />
      </Group>
    </div>
  )

  if (loading) {
    return (
      <div className="sub-page">
        <div className="sub-head">
          <button type="button" className="sub-back" onClick={onBack}>
            <IconBack size={20} />
          </button>
          <h2>账号与安全</h2>
        </div>
        <div className="sub-scroll">
          <p className="sub-note">加载中...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="sub-page">
      <div className="sub-head">
        <button type="button" className="sub-back" onClick={onBack}>
          <IconBack size={20} />
        </button>
        <h2>账号与安全</h2>
      </div>

      {body}

      {/* 远程退出确认：用自家菜单，不用原生 confirm() */}
      <ActionMenu
        open={!!askDevice}
        onClose={() => setAskDevice(null)}
        title={`退出「${askDevice?.name || ''}」？`}
        items={[
          {
            label: '退出该设备',
            icon: <IconLogout size={19} />,
            danger: true,
            onClick: () => removeDevice(askDevice.id),
          },
        ]}
      />

      {/* 修改密码：真接口（POST /auth/me/password），成功后旧密码立即失效 */}
      <PasswordModal open={pwOpen} onClose={() => setPwOpen(false)} showToast={showToast} />
    </div>
  )
}
