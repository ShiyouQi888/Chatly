import React, { useState, useEffect } from 'react'
import { api } from '../api/client.js'
import { IconBack } from '../components/Icon.jsx'
import { Row, Group, Switch } from '../components/ui.jsx'
import './me-tab.css'

/* ===== 消息通知设置 =====
 * 所有设置持久化到后端 user_settings 表
 * 通知类型：新消息、@我、点赞、评论、新关注
 * 群与系统：群通知、系统通知
 * 提醒方式：声音、震动、免打扰时段 */
export default function NotificationSettings({ onBack, showToast }) {
  const [settings, setSettings] = useState({
    notify_message: true,
    notify_mention: true,
    notify_like: true,
    notify_comment: true,
    notify_follow: true,
    notify_group: true,
    notify_system: true,
    notify_sound: true,
    notify_vibrate: true,
    dnd_enabled: false,
    dnd_start: '23:00',
    dnd_end: '08:00',
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
      console.error('加载通知设置失败:', err)
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

  if (loading) {
    return (
      <div className="sub-page">
        <div className="sub-head">
          <button type="button" className="sub-back" onClick={onBack}>
            <IconBack size={20} />
          </button>
          <h2>消息通知</h2>
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
        <h2>消息通知</h2>
      </div>

      <div className="sub-scroll">
        <Group title="通知类型">
          <Row label="新消息" right={<Switch on={settings.notify_message} onChange={() => toggleSetting('notify_message')} />} />
          <Row label="@ 我" right={<Switch on={settings.notify_mention} onChange={() => toggleSetting('notify_mention')} />} />
          <Row label="点赞" right={<Switch on={settings.notify_like} onChange={() => toggleSetting('notify_like')} />} />
          <Row label="评论" right={<Switch on={settings.notify_comment} onChange={() => toggleSetting('notify_comment')} />} />
          <Row label="新关注" right={<Switch on={settings.notify_follow} onChange={() => toggleSetting('notify_follow')} />} last />
        </Group>

        <Group title="群与系统">
          <Row label="群通知" right={<Switch on={settings.notify_group} onChange={() => toggleSetting('notify_group')} />} />
          <Row label="系统通知" right={<Switch on={settings.notify_system} onChange={() => toggleSetting('notify_system')} />} last />
        </Group>

        <Group title="提醒方式">
          <Row label="声音" right={<Switch on={settings.notify_sound} onChange={() => toggleSetting('notify_sound')} />} />
          <Row label="震动" right={<Switch on={settings.notify_vibrate} onChange={() => toggleSetting('notify_vibrate')} />} />
          <Row
            label="免打扰时段"
            value={settings.dnd_enabled ? `${settings.dnd_start} - ${settings.dnd_end}` : '未开启'}
            onClick={() => {
              const newDnd = !settings.dnd_enabled
              updateSetting('dnd_enabled', newDnd)
              if (newDnd) {
                showToast(`免打扰已开启：${settings.dnd_start} - ${settings.dnd_end}`)
              } else {
                showToast('免打扰已关闭')
              }
            }}
            last
          />
        </Group>

        {settings.dnd_enabled && (
          <div className="settings-section">
            <h3>免打扰时段</h3>
            <div className="settings-item">
              <span className="settings-label">开始时间</span>
              <input
                type="time"
                className="form-input"
                value={settings.dnd_start}
                onChange={(e) => updateSetting('dnd_start', e.target.value)}
                style={{ width: '120px' }}
              />
            </div>
            <div className="settings-item">
              <span className="settings-label">结束时间</span>
              <input
                type="time"
                className="form-input"
                value={settings.dnd_end}
                onChange={(e) => updateSetting('dnd_end', e.target.value)}
                style={{ width: '120px' }}
              />
            </div>
          </div>
        )}

        <p className="sub-note">支持按联系人单独设置通知级别。</p>
      </div>
    </div>
  )
}
