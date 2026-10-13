import React, { useState } from 'react'
import { IconBack, IconSend, IconImage, IconChevron } from '../components/Icon.jsx'
import { api } from '../api/client.js'
import './me-tab.css'

/* ===== 帮助与反馈 =====
 * 上半部分：FAQ 折叠列表
 * 下半部分：反馈表单（问题类型 + 描述 + 截图上传 + 联系方式） */
export default function HelpPage({ onBack, showToast }) {
  const [expandedFaq, setExpandedFaq] = useState(null)
  const [feedbackType, setFeedbackType] = useState('bug')
  const [description, setDescription] = useState('')
  const [contact, setContact] = useState('')
  const [screenshot, setScreenshot] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const faqGroups = [
    {
      title: '账号问题',
      items: [
        { q: '如何修改密码？', a: '进入「我」→「账号与安全」→「密码」，按提示操作即可。' },
        { q: '如何更换手机号？', a: '进入「我」→「账号与安全」→「手机号」，验证原手机号后可更换。' },
        { q: '账号被盗怎么办？', a: '立即修改密码，并在「账号与安全」→「登录设备」中退出可疑设备。' },
      ],
    },
    {
      title: '聊天功能',
      items: [
        { q: '如何撤回消息？', a: '长按消息 →「撤回」，仅支持 2 分钟内发送的消息。' },
        { q: '如何转发消息？', a: '长按消息 →「转发」，或进入多选模式批量转发。' },
        { q: '如何引用回复？', a: '长按消息 →「回复」，输入区上方会出现引用条。' },
        { q: '群投票怎么发起？', a: '群聊中点击「+」→「投票」，填写题目和选项即可。' },
      ],
    },
    {
      title: '动态功能',
      items: [
        { q: '如何发布动态？', a: '进入「动态」Tab → 点击右下角「+」→ 选择图片或视频 → 填写文案 → 发布。' },
        { q: '如何设置动态可见范围？', a: '发布动态时可选择「公开」「仅好友」「仅自己」。' },
        { q: '如何删除动态？', a: '进入「我」→「我的动态」→ 点击动态右上角「…」→「删除」。' },
      ],
    },
    {
      title: '隐私设置',
      items: [
        { q: '如何隐藏在线状态？', a: '进入「我」→「隐私设置」→ 关闭「显示在线状态」。' },
        { q: '如何设置谁可以加我？', a: '进入「我」→「隐私设置」→「谁可以加我」，可选择「所有人」「好友的好友」「仅好友」。' },
        { q: '如何开启消息加密？', a: '进入「我」→「隐私设置」→「消息加密」，开启后新会话将使用端到端加密。' },
      ],
    },
  ]

  const toggleFaq = (index) => {
    setExpandedFaq(expandedFaq === index ? null : index)
  }

  const handleScreenshotChange = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      showToast('截图不能超过 5MB')
      return
    }
    setScreenshot(file)
  }

  const handleSubmit = async () => {
    if (!description.trim()) {
      showToast('请填写问题描述')
      return
    }

    setSubmitting(true)
    try {
      // 先上传截图（如果有）
      let screenshotUrl = null
      if (screenshot) {
        const formData = new FormData()
        formData.append('file', screenshot)
        const uploadRes = await api.uploadFeedbackScreenshot(formData)
        screenshotUrl = uploadRes.url
      }

      // 提交反馈
      await api.submitFeedback({
        type: feedbackType,
        description: description.trim(),
        contact: contact.trim(),
        screenshotUrl,
      })

      showToast('反馈提交成功，感谢你的反馈！')
      setDescription('')
      setContact('')
      setScreenshot(null)
    } catch (err) {
      showToast(err.message || '提交失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="sub-page">
      <div className="sub-head">
        <button type="button" className="sub-back" onClick={onBack}>
          <IconBack size={20} />
        </button>
        <h2>帮助与反馈</h2>
      </div>

      <div className="sub-scroll">
        {/* FAQ 折叠列表 */}
        <div className="help-section">
          <h3>常见问题</h3>
          <div className="faq-list">
            {faqGroups.map((group, gi) => (
              <div key={gi} className="faq-group">
                <h4 className="faq-group-title">{group.title}</h4>
                {group.items.map((item, ii) => {
                  const idx = `${gi}-${ii}`
                  const isExpanded = expandedFaq === idx
                  return (
                    <div key={ii} className="faq-item">
                      <button
                        type="button"
                        className="faq-question"
                        onClick={() => toggleFaq(idx)}
                      >
                        <span>{item.q}</span>
                        <IconChevron
                          size={16}
                          className={`faq-chevron ${isExpanded ? 'expanded' : ''}`}
                        />
                      </button>
                      {isExpanded && <div className="faq-answer">{item.a}</div>}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>

        {/* 反馈表单 */}
        <div className="help-section">
          <h3>提交反馈</h3>
          <div className="feedback-form">
            {/* 问题类型 */}
            <div className="form-group">
              <label className="form-label">问题类型</label>
              <div className="feedback-type-selector">
                {[
                  { value: 'bug', label: 'Bug 反馈' },
                  { value: 'feature', label: '功能建议' },
                  { value: 'ui', label: '界面优化' },
                  { value: 'other', label: '其他' },
                ].map((type) => (
                  <button
                    key={type.value}
                    type="button"
                    className={`type-btn ${feedbackType === type.value ? 'active' : ''}`}
                    onClick={() => setFeedbackType(type.value)}
                  >
                    {type.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 问题描述 */}
            <div className="form-group">
              <label className="form-label">问题描述</label>
              <textarea
                className="form-textarea"
                placeholder="请详细描述你遇到的问题或建议..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                maxLength={1000}
              />
              <span className="form-hint">{description.length} / 1000</span>
            </div>

            {/* 截图上传 */}
            <div className="form-group">
              <label className="form-label">截图（可选）</label>
              <label className="screenshot-upload">
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleScreenshotChange}
                  style={{ display: 'none' }}
                />
                <div className="upload-area">
                  {screenshot ? (
                    <div className="upload-preview">
                      <IconImage size={24} />
                      <span>{screenshot.name}</span>
                    </div>
                  ) : (
                    <>
                      <IconImage size={24} />
                      <span>点击上传截图（最大 5MB）</span>
                    </>
                  )}
                </div>
              </label>
            </div>

            {/* 联系方式 */}
            <div className="form-group">
              <label className="form-label">联系方式（可选）</label>
              <input
                type="text"
                className="form-input"
                placeholder="邮箱或手机号，方便我们联系你"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                maxLength={100}
              />
            </div>

            {/* 提交按钮 */}
            <button
              type="button"
              className="submit-btn"
              onClick={handleSubmit}
              disabled={submitting || !description.trim()}
            >
              <IconSend size={16} />
              {submitting ? '提交中...' : '提交反馈'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
