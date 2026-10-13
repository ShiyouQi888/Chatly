import React, { useState, useEffect } from 'react'
import { api } from '../api/client.js'
import { IconBack } from '../components/Icon.jsx'
import { Row, Group, Switch } from '../components/ui.jsx'
import './me-tab.css'

/* ===== 隐私设置 =====
 * 所有设置持久化到后端 user_settings 表
 * 好友可见范围、动态可见范围、消息加密、阅后即焚等 */
export default function PrivacySettings({ onBack, showToast }) {
  const [settings, setSettings] = useState({
    // 好友相关
    add_friend_by_phone: true,      // 允许通过手机号添加好友
    add_friend_by_qr: true,         // 允许通过二维码添加好友
    add_friend_by_search: true,     // 允许通过搜索添加好友
    
    // 动态可见范围
    moment_visibility: 'public',    // public / friends / private
    
    // 消息相关
    message_encryption: true,       // 消息加密（端到端加密）
    read_receipts: true,            // 已读回执
    burn_after_read: false,         // 阅后即焚
    
    // 其他
    screenshot_notify: true,        // 截屏提醒
    online_status_visible: true,    // 在线状态可见
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const res = await api.getSettings()
      setSettings(prev => ({ ...prev, ...res }))
    } catch (err) {
      console.error('加载隐私设置失败:', err)
    } finally {
      setLoading(false)
    }
  }

  const updateSetting = async (key, value) => {
    const newSettings = { ...settings, [key]: value }
    setSettings(newSettings)
    
    try {
      await api.updateSetting(key, value)
    } catch (err) {
      showToast('保存失败')
      setSettings(settings) // 回滚
    }
  }

  const toggleSetting = (key) => {
    updateSetting(key, !settings[key])
  }

  const visibilityLabels = {
    public: '公开',
    friends: '仅好友',
    private: '仅自己',
  }

  const cycleVisibility = () => {
    const order = ['public', 'friends', 'private']
    const idx = order.indexOf(settings.moment_visibility)
    const next = order[(idx + 1) % order.length]
    updateSetting('moment_visibility', next)
    showToast(`动态可见范围：${visibilityLabels[next]}`)
  }

  if (loading) {
    return (
      <div className="sub-page">
        <div className="sub-head">
          <button type="button" className="sub-back" onClick={onBack}>
            <IconBack size={20} />
          </button>
          <h2>隐私设置</h2>
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
        <h2>隐私设置</h2>
      </div>

      <div className="sub-scroll">
        <Group title="添加好友">
          <Row
            label="通过手机号添加"
            right={<Switch on={settings.add_friend_by_phone} onChange={() => toggleSetting('add_friend_by_phone')} />}
          />
          <Row
            label="通过二维码添加"
            right={<Switch on={settings.add_friend_by_qr} onChange={() => toggleSetting('add_friend_by_qr')} />}
          />
          <Row
            label="通过搜索添加"
            right={<Switch on={settings.add_friend_by_search} onChange={() => toggleSetting('add_friend_by_search')} />}
            last
          />
        </Group>

        <Group title="动态可见范围">
          <Row
            label="默认范围"
            value={visibilityLabels[settings.moment_visibility]}
            onClick={cycleVisibility}
            last
          />
        </Group>

        <Group title="消息">
          <Row
            label="消息加密"
            value={settings.message_encryption ? '已开启' : '已关闭'}
            onClick={() => {
              toggleSetting('message_encryption')
              showToast(settings.message_encryption ? '已关闭消息加密' : '已开启消息加密')
            }}
          />
          <Row
            label="已读回执"
            right={<Switch on={settings.read_receipts} onChange={() => toggleSetting('read_receipts')} />}
          />
          <Row
            label="阅后即焚"
            right={<Switch on={settings.burn_after_read} onChange={() => toggleSetting('burn_after_read')} />}
            last
          />
        </Group>

        <Group title="其他">
          <Row
            label="截屏提醒"
            right={<Switch on={settings.screenshot_notify} onChange={() => toggleSetting('screenshot_notify')} />}
          />
          <Row
            label="在线状态可见"
            right={<Switch on={settings.online_status_visible} onChange={() => toggleSetting('online_status_visible')} />}
            last
          />
        </Group>

        <p className="sub-note">隐私设置会影响其他用户对你的可见范围。</p>
      </div>
    </div>
  )
}
