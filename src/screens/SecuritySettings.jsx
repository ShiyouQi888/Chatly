import React, { useState, useEffect } from 'react'
import { api } from '../api/client.js'
import { IconBack, IconUser, IconShield, IconLock, IconInfo, IconLogout } from '../components/Icon.jsx'
import { Row, Group, Switch } from '../components/ui.jsx'
import './me-tab.css'

/* ===== 账号与安全 =====
 * 登录方式、安全设置、设备管理
 * 安全设置持久化到后端，设备列表从后端获取 */
export default function SecuritySettings({ onBack, showToast, user }) {
  const [devices, setDevices] = useState([])
  const [securitySettings, setSecuritySettings] = useState({
    biometric: false,
    twoFactor: false
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      const [devicesRes, settingsRes] = await Promise.all([
        api.getDevices(),
        api.getSecuritySettings()
      ])
      setDevices(devicesRes)
      setSecuritySettings(settingsRes)
    } catch (err) {
      console.error('加载安全数据失败:', err)
    } finally {
      setLoading(false)
    }
  }

  const toggleSecuritySetting = async (key) => {
    const newValue = !securitySettings[key]
    setSecuritySettings(prev => ({ ...prev, [key]: newValue }))
    
    try {
      await api.updateSecuritySettings({ [key]: newValue })
    } catch (err) {
      showToast('保存失败')
      setSecuritySettings(prev => ({ ...prev, [key]: !newValue }))
    }
  }

  const removeDevice = async (deviceId, deviceName) => {
    if (!confirm(`确定要远程退出 "${deviceName}" 吗？`)) return
    
    try {
      await api.removeDevice(deviceId)
      setDevices(prev => prev.filter(d => d.id !== deviceId))
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

      <div className="sub-scroll">
        <Group title="登录方式">
          <Row icon={<IconUser size={19} />} label="手机号" value="138****6721" onClick={() => showToast('更换手机号')} />
          <Row icon={<IconShield size={19} />} label="邮箱" value="已绑定" onClick={() => showToast('更换邮箱')} />
          <Row icon={<IconLock size={19} />} label="密码" value="已设置" onClick={() => showToast('修改密码')} last />
        </Group>

        <Group title="安全设置" footer="开启二次验证后，在新设备登录需额外验证。">
          <Row icon={<IconShield size={19} />} label="生物识别" right={<Switch on={securitySettings.biometric} onChange={() => toggleSecuritySetting('biometric')} />} />
          <Row icon={<IconLock size={19} />} label="二次验证" right={<Switch on={securitySettings.twoFactor} onChange={() => toggleSecuritySetting('twoFactor')} />} last />
        </Group>

        <Group title="登录设备">
          {devices.map((d, i) => (
            <Row
              key={d.id}
              icon={<IconInfo size={19} />}
              label={d.name}
              sub={`${formatTime(d.lastActive)} · ${d.type}`}
              right={d.isCurrent ? <span className="tag-now">当前</span> : null}
              chevron={!d.isCurrent}
              onClick={d.isCurrent ? undefined : () => removeDevice(d.id, d.name)}
              last={i === devices.length - 1}
            />
          ))}
        </Group>

        <Group>
          <Row icon={<IconLogout size={19} />} label="退出登录" danger onClick={() => showToast('已退出登录 · 原型演示')} last />
        </Group>
      </div>
    </div>
  )
}
