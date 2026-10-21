import React, { useRef, useState } from 'react'
import { IconBack, IconSend, IconImage, IconChevron } from '../components/Icon.jsx'
import { api } from '../api/client.js'
import './me-tab.css'

/* ===== 帮助与反馈 =====
 * 上半部分：FAQ 折叠列表
 * 下半部分：反馈表单（问题类型 + 描述 + 截图上传 + 联系方式）
 *
 * ## FAQ 的每一条都**必须能在本产品里照着做出来**
 * FAQ 是「指引」，和别的文案不一样：写错一句，用户就会照着一个不存在的入口找半天，
 * 最后得出「这 App 坏了」的结论。所以这一页的条目逐条核对过实现：
 *   · 撤回：服务端 `revokeMessage()` **没有时间窗**，之前这里写「仅支持 2 分钟内」是编的；
 *   · 转发 / 翻译：长按菜单里确实是禁用态，就不能教人「长按 → 转发」；
 *   · 消息加密：本项目没有端到端加密，不能再写「开启后新会话将使用端到端加密」；
 *   · 改密码 / 换手机号：接口不存在、库里也没有手机号字段；
 *   · 发布动态的「+」在**右上角**（`.moment-head` 是 space-between 布局），不是右下角。
 * 不确定的功能一律写「未接入」并说明，宁可少写一条指引，也不误导一次。
 *
 * ## 提交反馈
 * 以前这里调的是 `api.uploadFeedbackScreenshot` / `api.submitFeedback`，
 * 而那两个方法**根本不存在** —— 点提交只会弹一句「... is not a function」。
 * 现在服务端 `/api/v1/feedback` 已经接上（见 server/src/routes/feedback.js）。
 */
export default function HelpPage({ onBack, showToast }) {
  const [expandedFaq, setExpandedFaq] = useState(null)
  const [feedbackType, setFeedbackType] = useState('bug')
  const [description, setDescription] = useState('')
  const [contact, setContact] = useState('')
  const [screenshot, setScreenshot] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const fileRef = useRef(null)

  const faqGroups = [
    {
      title: '账号问题',
      items: [
        {
          q: '如何修改密码？',
          a: '进入「我」→「账号与安全」→「密码」，填当前密码和新密码即可。修改后当前设备仍然登录，其它设备不会被强制退出，直到它们的登录过期。',
        },
        {
          q: '如何更换手机号？',
          a: '手机号在「我」→ 编辑资料里填写或修改（11 位中国大陆号码）。它只用于让别人按号码搜到你，登录仍然用用户名（在「我」页昵称下方能看到）。',
        },
        {
          q: '账号被盗怎么办？',
          a: '进入「我」→「账号与安全」：先把可疑设备在「登录设备」里远程退出，再在「密码」里改一次密码。',
        },
      ],
    },
    {
      title: '聊天功能',
      items: [
        {
          q: '如何撤回消息？',
          a: '长按自己发送的消息 →「撤回」。没有时间限制，撤回后对方看到的是「消息已撤回」。',
        },
        {
          q: '如何引用回复？',
          a: '长按消息 →「回复」，输入框上方会出现一条引用条；点引用块可以直接跳回原消息。',
        },
        {
          q: '如何收藏消息？',
          a: '长按消息 →「收藏」，之后在「我」→「收藏」里查看。收藏存的是快照，原消息撤回后内容仍在。',
        },
        {
          q: '如何转发消息？',
          a: '长按消息选择「转发」，或进入多选后批量转发；一次最多 20 条。投票和已撤回消息不可转发。',
        },
        {
          q: '群投票怎么发起？',
          a: '群聊中点击「+」→「投票」，填写题目和选项即可。投票只在群聊里有，单聊的加号面板里没有这一项。',
        },
      ],
    },
    {
      title: '动态功能',
      items: [
        {
          q: '如何发布动态？',
          a: '进入「动态」Tab → 点右上角的「+」→ 选图片或视频 → 填写文案 → 发布。图片最多 9 张，或换成 1 个视频（二者不能混发）。',
        },
        {
          q: '如何设置动态可见范围？',
          a: '发布时可选「公开」「仅好友」「仅自己」。默认值在「我」→「隐私设置」→「动态可见范围」里改。',
        },
        {
          q: '如何给动态加上位置？',
          a: '发布动态时点「定位」，可以选附近的地点，也可以直接输入地点名。输入的地点名没有坐标，卡片上会写明。',
        },
        {
          q: '如何删除动态？',
          a: '在「动态」Tab 点自己动态右上角的「⋯」→「删除」。「我」→「我的动态」是只读的一览，那里没有编辑 / 删除入口。',
        },
      ],
    },
    {
      title: '隐私设置',
      items: [
        {
          q: '哪些隐私开关是真的生效的？',
          a: '动态可见范围、添加好友权限、在线状态、文字消息存储加密、已读回执和阅后即焚已接入。截屏提醒未接入；消息加密由服务端持有密钥，不是端到端加密。',
        },
        {
          q: '消息是端到端加密的吗？',
          a: '隐私设置里的「文字消息加密存储」会用 AES-256-GCM 加密数据库里的新文字消息。服务端仍能解密，因此这不是端到端加密；启用前需要管理员配置 MESSAGE_ENCRYPTION_KEY。',
        },
        {
          q: '如何设置谁可以加我？',
          a: '可以通过搜索或扫一扫发送好友申请；对方同意后才会加入通讯录。申请入口会按对方的隐私设置校验。',
        },
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
      /* 超限要清掉 input 的值：不清的话用户再选**同一个文件**不会触发 change，
         看起来像「点了没反应」。 */
      e.target.value = ''
      return
    }
    setScreenshot(file)
  }

  const clearScreenshot = () => {
    setScreenshot(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const handleSubmit = async () => {
    if (!description.trim() || submitting) return

    setSubmitting(true)
    try {
      // 先上传截图（如果有）
      let screenshotUrl = null
      if (screenshot) {
        const formData = new FormData()
        formData.append('file', screenshot, screenshot.name || 'screenshot.png')
        const uploadRes = await api.uploadFeedbackScreenshot(formData)
        screenshotUrl = uploadRes.url
      }

      await api.submitFeedback({
        type: feedbackType,
        description: description.trim(),
        contact: contact.trim(),
        screenshotUrl,
      })

      setSent(true)
      showToast('反馈提交成功，感谢你的反馈！')
      setDescription('')
      setContact('')
      clearScreenshot()
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
                        aria-expanded={isExpanded}
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
                    aria-pressed={feedbackType === type.value}
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
              {screenshot ? (
                /* 已选中：给一个**真的能撤销**的状态，而不是只显示文件名 ——
                   选错图却只能重新选一遍是很烦的。 */
                <div className="upload-area is-picked">
                  <div className="upload-preview">
                    <IconImage size={24} />
                    <span>{screenshot.name}</span>
                  </div>
                  <button type="button" className="upload-clear" onClick={clearScreenshot}>
                    移除
                  </button>
                </div>
              ) : (
                <label className="screenshot-upload">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    onChange={handleScreenshotChange}
                    style={{ display: 'none' }}
                  />
                  <div className="upload-area">
                    <IconImage size={24} />
                    <span>点击上传截图（PNG / JPG / GIF / WebP，最大 5MB）</span>
                  </div>
                </label>
              )}
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

            {/* 提交成功后如实说明落到哪儿去了 —— 这个项目是本机服务端，
                含糊地说「我们会尽快处理」等于没反馈。 */}
            {sent && (
              <p className="form-hint is-ok">
                已保存到本机服务端的 feedbacks 表。截图若已上传，会一并记录在该条反馈上。
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
