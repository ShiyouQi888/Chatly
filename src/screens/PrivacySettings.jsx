import React, { useState, useEffect } from 'react'
import { api } from '../api/client.js'
import { IconBack } from '../components/Icon.jsx'
import { Row, Group, Switch } from '../components/ui.jsx'
import './me-tab.css'

/* ===== 隐私设置 =====
 *
 * ## 这一页的判据（每次改动都按它过一遍）
 * `user_settings` 是一张「键值随便存」的表，所以**任何开关都存得进去** ——
 * 包括那些没有任何代码读的。所以每一项要么有**读取方**，要么 `disabled` + 写明原因。
 * 「能拨、存得进、刷新还在」不等于生效 —— 那是这一页以前最大的问题。
 *
 *   真生效：
 *     · 动态默认可见范围（发布面板的初始值读它）
 *     · 添加好友三项 —— `server/src/privacy.js` 是唯一读取方，
 *       搜索 / 扫码 / 手输 ID / 关注接口四处都过它
 *     · 在线状态可见 —— 资料页与列表页的 `online` 字段、WS 上下线推送，两处都过它
 *   消息隐私：数据库文字加密、已读回执控制和阅后即焚均已接入；截屏提醒受浏览器能力限制。
 * 消息加密是服务端存储加密，不能替代端到端加密。
 */
export default function PrivacySettings({ onBack, showToast }) {
  const [settings, setSettings] = useState({
    // 动态可见范围
    moment_visibility: 'public', // public / friends / private
    // 添加好友（真生效，见 server/src/privacy.js）
    add_friend_by_phone: true,
    add_friend_by_qr: true,
    add_friend_by_search: true,
    // 在线状态（真生效，配 Redis presence）
    online_status_visible: true,
    message_encryption: false,
    read_receipts: true,
    burn_after_read: false,
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const res = await api.getSettings()
      setSettings((prev) => ({ ...prev, ...res }))
    } catch (err) {
      console.error('加载隐私设置失败:', err)
    } finally {
      setLoading(false)
    }
  }

  const updateSetting = async (key, value) => {
    const prev = settings
    setSettings({ ...settings, [key]: value })
    try {
      await api.updateSetting(key, value)
    } catch (err) {
      showToast('保存失败')
      setSettings(prev) // 回滚
    }
  }

  /** 开关的通用入口：拨完给一句「现在是什么状态」，而不是笼统的「已保存」 */
  const toggle = (key) => async (next) => {
    const prev = settings
    setSettings({ ...settings, [key]: next })
    try {
      await api.updateSetting(key, next)
      showToast(next ? '已开启' : '已关闭')
    } catch (err) {
      showToast(err.message || '保存失败')
      setSettings(prev)
    }
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
    showToast(`动态默认可见范围：${visibilityLabels[next]}`)
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
        <Group title="动态可见范围" footer="发布动态时的默认值，发布面板里仍然可以临时改。">
          <Row
            label="默认范围"
            value={visibilityLabels[settings.moment_visibility]}
            onClick={cycleVisibility}
            last
          />
        </Group>

        <Group
          title="添加好友"
          footer={
            '管的是「别人能不能通过这个渠道找到我、加我」。关掉之后：搜索结果里不会再出现我；' +
            '扫码 / 手输 ID 仍然看得到我是谁（不会骗人说「查无此人」），但「加好友」会被服务端拦下。' +
            '已经在同一个群里、或已经有共同会话的人不受影响 —— 那不算「被找到」。'
          }
        >
          <Row
            label="通过手机号添加"
            sub="别人用我的手机号搜到我时能找到我（手机号在「编辑资料」里填）"
            right={<Switch on={!!settings.add_friend_by_phone} onChange={toggle('add_friend_by_phone')} />}
          />
          <Row
            label="通过二维码添加"
            sub="别人扫我的二维码之后能把我加为好友"
            right={<Switch on={!!settings.add_friend_by_qr} onChange={toggle('add_friend_by_qr')} />}
          />
          <Row
            label="通过搜索添加"
            sub="别人搜昵称 / ID 时能找到我（聊天顶栏的「搜索 → 找人」走这一条）"
            right={<Switch on={!!settings.add_friend_by_search} onChange={toggle('add_friend_by_search')} />}
            last
          />
        </Group>

        <Group title="消息" footer="开启后新发送的文字消息使用服务端 AES-256-GCM 加密后存入数据库；服务端仍可解密，不是端到端加密。阅后即焚在开启该设置的成员阅读文字消息后 30 秒，对会话所有成员销毁。">
          <Row
            label="文字消息加密存储"
            sub="保护数据库中的文字内容；服务端仍可读取"
            right={<Switch on={!!settings.message_encryption} onChange={toggle('message_encryption')} />}
          />
          <Row
            label="已读回执"
            sub="关闭后，其他成员看不到你的已读位置"
            right={<Switch on={settings.read_receipts !== false} onChange={toggle('read_receipts')} />}
          />
          <Row
            label="阅后即焚"
            sub="你阅读收到的文字消息后，30 秒后对所有成员销毁"
            right={<Switch on={!!settings.burn_after_read} onChange={toggle('burn_after_read')} />}
            last
          />
        </Group>

        <Group
          title="其他"
          footer="「在线状态可见」是唯一一项能立刻影响别人的设置：关掉后朋友那边的在线圆点马上变灰，不用等重连。截屏提醒仍然做不到 —— 网页端拿不到系统截屏事件。"
        >
          <Row
            label="截屏提醒"
            sub="未接入：网页端拿不到系统截屏事件"
            right={<Switch on={false} disabled />}
          />
          <Row
            label="在线状态可见"
            sub="关掉后别人看到的我始终是离线；我的上下线也不再推送给他们"
            right={<Switch on={!!settings.online_status_visible} onChange={toggle('online_status_visible')} />}
            last
          />
        </Group>

        <p className="sub-note">
          阅后即焚仅覆盖文字消息；截图提醒尚未接入。
        </p>
      </div>
    </div>
  )
}
