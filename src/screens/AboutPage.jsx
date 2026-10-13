import React from 'react'
import { IconBack, IconHeart } from '../components/Icon.jsx'
import './me-tab.css'

/* ===== 关于我们 =====
 * 纯展示页面，无交互。
 * 内容：App 简介、版本号、更新日志、开源许可、致谢。 */
export default function AboutPage({ onBack }) {
  return (
    <div className="sub-page">
      <div className="sub-head">
        <button type="button" className="sub-back" onClick={onBack}>
          <IconBack size={20} />
        </button>
        <h2>关于我们</h2>
      </div>

      <div className="sub-scroll">
        {/* App 简介 */}
        <div className="about-hero">
          <div className="about-logo">
            <svg width="64" height="64" viewBox="0 0 64 64">
              <defs>
                <linearGradient id="aboutG" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#9b8cfb" />
                  <stop offset="1" stopColor="#5b6ef5" />
                </linearGradient>
              </defs>
              <rect width="64" height="64" rx="16" fill="url(#aboutG)" />
              <path d="M20 32c0-6.6 5.4-12 12-12s12 5.4 12 12-5.4 12-12 12" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" />
              <circle cx="36" cy="32" r="3" fill="#fff" />
            </svg>
          </div>
          <h1 className="about-title">Chatly</h1>
          <p className="about-subtitle">连接更有趣的人</p>
          <p className="about-version">版本 1.0.0</p>
        </div>

        {/* 更新日志 */}
        <div className="about-section">
          <h3>更新日志</h3>
          <div className="about-changelog">
            <div className="changelog-item">
              <span className="changelog-version">v1.0.0</span>
              <span className="changelog-date">2026-10-12</span>
              <ul className="changelog-list">
                <li>聊天：文字 / 图片 / 文件 / 位置 / 视频消息</li>
                <li>群聊：群管理 / 群投票 / 禁言锁定</li>
                <li>消息：引用回复 / 消息转发 / 长按手势 / 消息收藏</li>
                <li>动态：图文 / 视频 / 点赞 / 评论 / 可见范围</li>
                <li>发现：推荐用户 / 附近的人 / 公开群</li>
                <li>我：资料编辑 / 头像裁剪 / 我的二维码 / 扫一扫</li>
                <li>表情：386 彩色 SVG + 30 动画 GIF</li>
              </ul>
            </div>
          </div>
        </div>

        {/* 开源许可 */}
        <div className="about-section">
          <h3>开源许可</h3>
          <div className="about-licenses">
            <div className="license-item">
              <b>Microsoft Fluent Emoji</b>
              <span className="license-type">MIT License</span>
              <p className="license-desc">
                386 个彩色 SVG 表情 + 30 个动画大表情（APNG 转 GIF）
              </p>
              <a
                href="https://github.com/microsoft/fluentui-emoji"
                target="_blank"
                rel="noopener noreferrer"
                className="license-link"
              >
                github.com/microsoft/fluentui-emoji
              </a>
            </div>
          </div>
        </div>

        {/* 致谢 */}
        <div className="about-section">
          <h3>致谢</h3>
          <p className="about-thanks">
            感谢所有为 Chatly 贡献代码、设计、测试的开发者与用户。
          </p>
          <p className="about-thanks">
            特别感谢 Microsoft Fluent Emoji 团队提供的精美表情素材。
          </p>
        </div>

        {/* 版权信息 */}
        <div className="about-footer">
          <p>© 2026 Chatly Team</p>
          <p className="about-made-with">
            Made with <IconHeart size={12} fill="#f97ca8" /> in China
          </p>
        </div>
      </div>
    </div>
  )
}
