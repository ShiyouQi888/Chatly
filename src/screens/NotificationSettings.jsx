import React, { useEffect, useState } from 'react'
import { useNotifications } from '../store/NotificationStore.jsx'
import { inDnd } from '../utils/notifyAlert.js'
import { IconBack } from '../components/Icon.jsx'
import { Row, Group, Switch } from '../components/ui.jsx'
import './me-tab.css'

/* ===== 消息通知设置 =====
 *
 * 这一页以前**整页禁用**，理由是「没有通知可开」—— 那个判断在当时是对的：
 * 通知中心读的是原型数据，也没有任何代码记录「谁赞了我」。
 * 现在补上了那一环：服务端有一张真实落库的 notifications 表，
 * 点赞 / 评论 / 关注 / 群公告 / @我 / 私聊消息都会往里写一行，
 * 而**这些开关判定的就是「要不要产生那一行」**（见 server/src/notification.js）。
 *
 * ## 两类开关，生效位置不一样，界面上必须说清
 *
 * ① 类型开关（新消息 / @我 / 点赞 / 评论 / 新关注 / 群通知）
 *    生效在**服务端写入时**：关掉 → 这类事件不再产生通知行。
 *    ⚠️ 重新打开**不会**补回关掉期间发生的事 —— 这点必须在页面上写明，
 *    否则用户会以为「我只是关了一会儿，回来应该还能看到」。
 *
 * ② 提醒方式（声音 / 震动 / 免打扰时段）
 *    生效在**客户端收到时**：通知行照样产生，只是到了之后不吵你。
 *    免打扰用的是**这台设备的本地时间**（所以只能在客户端判）。
 *
 * ## 为什么没有「系统通知」开关
 * `notifications.kind` 里有 'system' 这个取值，但服务端**没有任何产生方**
 * （没有运营推送、没有公告频道）。留一个能拨、拨了永远不会有变化的开关，
 * 比少一行更糟 —— 所以它标「未接入」并禁用，而不是假装能管。
 */
export default function NotificationSettings({ onBack }) {
  const { prefs, prefsLoading, prefsError, loadPrefs, savePref, savePrefs } = useNotifications()
  /* 免打扰时段先作为本地草稿编辑，点击保存后再提交。 */
  const [start, setStart] = useState('23:00')
  const [end, setEnd] = useState('08:00')
  const [saving, setSaving] = useState({})
  const [saveMessage, setSaveMessage] = useState('')

  useEffect(() => {
    if (!prefs) loadPrefs()
  }, [prefs, loadPrefs])

  /* 从后端读回来后同步进输入框（只在有值时覆盖，避免闪回默认值） */
  useEffect(() => {
    if (prefs?.dnd_start) setStart(prefs.dnd_start)
    if (prefs?.dnd_end) setEnd(prefs.dnd_end)
  }, [prefs?.dnd_start, prefs?.dnd_end])

  const toggle = (key) => async (v) => {
    setSaving((state) => ({ ...state, [key]: true }))
    setSaveMessage('')
    try {
      await savePref(key, v)
      setSaveMessage('设置已保存')
    } catch {
      setSaveMessage('保存失败，已恢复原设置，请重试')
      console.warn('[notify] 保存偏好失败：', key)
    } finally {
      setSaving((state) => ({ ...state, [key]: false }))
    }
  }

  const saveTimes = async () => {
    if (start === end) {
      setSaveMessage('开始和结束时间不能相同，请设置一个有效时段')
      return
    }
    setSaving((state) => ({ ...state, times: true }))
    setSaveMessage('')
    try {
      await savePrefs({ dnd_start: start, dnd_end: end })
      setSaveMessage('免打扰时段已保存')
    } catch {
      setSaveMessage('保存失败，时段未生效，请重试')
      console.warn('[notify] 保存免打扰时段失败')
    } finally {
      setSaving((state) => ({ ...state, times: false }))
    }
  }

  const dndOn = !!prefs?.dnd_enabled
  return (
    <div className="sub-page">
      <div className="sub-head">
        <button type="button" className="sub-back" onClick={onBack}>
          <IconBack size={20} />
        </button>
        <h2>消息通知</h2>
      </div>

      <div className="sub-scroll">
        {!prefs && prefsLoading ? (
          <p className="sub-note">正在读取通知设置…</p>
        ) : !prefs && prefsError ? (
          <div className="sub-note is-warn" role="alert">
            <p>{prefsError}</p>
            <button type="button" className="dnd-save" onClick={loadPrefs}>重新加载</button>
          </div>
        ) : !prefs ? (
          <p className="sub-note">等待登录后读取通知设置…</p>
        ) : (
          <>
            <Group
              title="通知类型"
              footer="有人对你做这些事时会产生一条通知。关闭期间发生的事不会在重新开启后补回来。"
            >
              <Row
                label="新消息"
                sub="有人给我发私聊消息（群消息看未读，不占通知）"
                right={<Switch on={prefs?.message !== false} onChange={toggle('notify_message')} disabled={saving.notify_message} />}
              />
              <Row
                label="@ 我"
                sub="群里有人 @ 我或 @ 全体成员"
                right={<Switch on={prefs?.mention !== false} onChange={toggle('notify_mention')} disabled={saving.notify_mention} />}
              />
              <Row
                label="点赞"
                sub="有人赞我发布的动态"
                right={<Switch on={prefs?.like !== false} onChange={toggle('notify_like')} disabled={saving.notify_like} />}
              />
              <Row
                label="评论"
                sub="有人评论我的动态，或回复我的评论"
                right={<Switch on={prefs?.comment !== false} onChange={toggle('notify_comment')} disabled={saving.notify_comment} />}
              />
              <Row
                label="好友申请"
                sub="收到好友申请或申请处理结果"
                right={<Switch on={prefs?.follow !== false} onChange={toggle('notify_follow')} disabled={saving.notify_follow} />}
              />
              <Row
                label="群通知"
                sub="我所在的群更新了群公告"
                right={<Switch on={prefs?.group !== false} onChange={toggle('notify_group')} disabled={saving.notify_group} />}
                last
              />
            </Group>

            <Group
              title="提醒方式"
              footer="这三项管的是「通知到了之后怎么吵你」：通知照样会产生，只是安静地躺在通知中心里。免打扰按这台设备的本地时间判。"
            >
              <Row
                label="声音"
                sub={prefs?.sound === false ? '已关闭：新通知不再响铃' : '新通知到达时响一声'}
                right={<Switch on={prefs?.sound !== false} onChange={toggle('sound')} disabled={saving.sound} />}
              />
              <Row
                label="震动"
                sub="由浏览器决定这台设备能不能震（桌面浏览器通常不会）"
                right={<Switch on={prefs?.vibrate !== false} onChange={toggle('vibrate')} disabled={saving.vibrate} />}
                last
              />
            </Group>

            <Group
              title="免打扰时段"
              footer={
                dndOn
                  ? `现在${inDnd() ? '正处在' : '不在'}免打扰时段内 —— 时段内的通知只进通知中心，不响铃、不震动。`
                  : '开启后，指定时段内的通知不响铃、不震动（仍然会产生，进通知中心）。'
              }
            >
              <Row
                label="开启免打扰"
                right={<Switch on={dndOn} onChange={toggle('dnd_enabled')} disabled={saving.dnd_enabled} />}
              />
              {/* 仅开启免打扰后显示时段编辑器。 */}
              {dndOn && (
                <div className="dnd-times">
                  <label className="dnd-field">
                    <span>开始</span>
                    <input
                      type="time"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                      disabled={saving.times}
                    />
                  </label>
                  <label className="dnd-field">
                    <span>结束</span>
                    <input
                      type="time"
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                      disabled={saving.times}
                    />
                  </label>
                  <button type="button" className="dnd-save" onClick={saveTimes} disabled={saving.times}>
                    {saving.times ? '保存中…' : '保存时段'}
                  </button>
                </div>
              )}
              <Row
                label="系统通知"
                sub="未接入：服务端没有任何系统消息的产生方（没有运营推送 / 公告频道）"
                right={<span className="tag-off">未接入</span>}
                last
              />
            </Group>

            {saveMessage && <p className="sub-note" role="status" aria-live="polite">{saveMessage}</p>}

            <p className="sub-note">
              通知按类型产生，都落在服务端的通知表里 —— 关掉某个开关等于对服务端说「这类别记」。
              界面上每一行都能真的改变结果，改不动的那一项已写明原因。
            </p>
          </>
        )}
      </div>
    </div>
  )
}
