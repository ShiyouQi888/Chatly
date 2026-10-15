import React, { useState, useEffect } from 'react'
import { IconBack } from '../components/Icon.jsx'
import { applyFontSize } from '../utils/theme.js'
import './me-tab.css'

/* ===== 通用设置 =====
 * 所有设置项持久化到 localStorage
 * 字体大小通过 CSS 变量 --font-scale 应用到全局
 *
 * 这一页最要紧的是**每个开关都得有代码读它**，否则关掉它什么都不会发生。
 * 逐项核对：
 *   · 聊天列表左滑删除 → ChatTab 读 `chatly-swipe-delete`
 *   · 回车键发送       → ChatRoom 读 `chatly-enter-to-send`
 *   · 自动下载图片     → ChatRoom 的图片气泡读 `chatly-auto-download`
 *   · 字体大小         → tokens.css 的 --fs-* 都乘 --font-scale
 */
export default function GeneralSettings({ onBack, showToast }) {
  const [fontSize, setFontSize] = useState(() => {
    return localStorage.getItem('chatly-font-size') || 'standard'
  })
  const [swipeDelete, setSwipeDelete] = useState(() => {
    return localStorage.getItem('chatly-swipe-delete') !== 'false'
  })
  const [enterToSend, setEnterToSend] = useState(() => {
    return localStorage.getItem('chatly-enter-to-send') !== 'false'
  })
  const [autoDownload, setAutoDownload] = useState(() => {
    return localStorage.getItem('chatly-auto-download') !== 'false'
  })
  const [cacheSize, setCacheSize] = useState('0 MB')

  useEffect(() => {
    /* 复用 utils/theme.js 的 applyFontSize，不在这里再抄一份倍率表 ——
       两份 map 迟早会漂（改了 1.15 只改一处，另一个入口还是 1.1）。 */
    applyFontSize(fontSize)
    localStorage.setItem('chatly-font-size', fontSize)
  }, [fontSize])

  useEffect(() => {
    localStorage.setItem('chatly-swipe-delete', swipeDelete)
  }, [swipeDelete])

  useEffect(() => {
    localStorage.setItem('chatly-enter-to-send', enterToSend)
  }, [enterToSend])

  useEffect(() => {
    localStorage.setItem('chatly-auto-download', autoDownload)
  }, [autoDownload])

  // 计算缓存大小（简化版，实际应该扫描 IndexedDB / localStorage）
  useEffect(() => {
    const calculateCache = () => {
      let total = 0
      for (let key in localStorage) {
        if (localStorage.hasOwnProperty(key)) {
          total += localStorage[key].length * 2 // UTF-16
        }
      }
      setCacheSize(`${(total / 1024 / 1024).toFixed(2)} MB`)
    }
    calculateCache()
  }, [])

  const clearCache = () => {
    // 清除缓存（保留登录状态和设置）。
    // ⚠️ token 的真实 key 是 'chatly.token'（见 api/client.js 的 TOKEN_KEY），
    // 以前这里写的是 'chatly-token'，对不上 —— 点「清除缓存」会把人直接登出。
    const keysToKeep = [
      'chatly.token',
      'chatly-font-size',
      'chatly-swipe-delete',
      'chatly-enter-to-send',
      'chatly-auto-download',
      'chatly-theme',
    ]
    const keysToRemove = []
    for (let key in localStorage) {
      if (localStorage.hasOwnProperty(key) && !keysToKeep.includes(key)) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key))
    setCacheSize('0.00 MB')
    showToast('缓存已清除')
  }

  const fontSizes = [
    { value: 'small', label: '小' },
    { value: 'standard', label: '标准' },
    { value: 'large', label: '大' },
    { value: 'xlarge', label: '超大' },
  ]

  return (
    <div className="sub-page">
      <div className="sub-head">
        <button type="button" className="sub-back" onClick={onBack}>
          <IconBack size={20} />
        </button>
        <h2>通用设置</h2>
      </div>

      <div className="sub-scroll">
        {/* 字体大小 */}
        <div className="settings-section">
          <h3>字体大小</h3>
          <div className="font-size-selector">
            {fontSizes.map((size) => (
              <button
                key={size.value}
                type="button"
                className={`font-size-btn ${fontSize === size.value ? 'active' : ''}`}
                onClick={() => setFontSize(size.value)}
              >
                {size.label}
              </button>
            ))}
          </div>
        </div>

        {/* 语言 */}
        <div className="settings-section">
          <h3>语言</h3>
          <div className="settings-item">
            <span className="settings-label">简体中文</span>
            <span className="settings-hint">其他语言即将上线</span>
          </div>
        </div>

        {/* 聊天设置 */}
        <div className="settings-section">
          <h3>聊天</h3>
          <div className="settings-list">
            <div className="settings-item">
              <span className="settings-label">聊天列表左滑删除</span>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={swipeDelete}
                  onChange={(e) => setSwipeDelete(e.target.checked)}
                />
                <span className="settings-switch-slider"></span>
              </label>
            </div>
            <div className="settings-item">
              {/* ⚠️ 这一项的标签原来写的是「发送键回车换行」，而 `chatly-enter-to-send`
                  为 true（默认）时回车是**发送**。也就是说标签的字面意思和实际行为是反的：
                  想要「回车即发送」的人会以为要关掉它，一关反而变成回车换行。
                  标签必须写成它真的做的事。 */}
              <span className="settings-label">回车键发送</span>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={enterToSend}
                  onChange={(e) => setEnterToSend(e.target.checked)}
                />
                <span className="settings-switch-slider"></span>
              </label>
            </div>
            <div className="settings-item">
              <span className="settings-label">自动下载图片</span>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={autoDownload}
                  onChange={(e) => setAutoDownload(e.target.checked)}
                />
                <span className="settings-switch-slider"></span>
              </label>
            </div>
          </div>
          <p className="settings-hint">
            关掉「回车键发送」后回车是换行，发送请点输入框右侧的按钮。
            关掉「自动下载图片」后，聊天里的图片会先显示为「点击加载」。
          </p>
        </div>

        {/* 清除缓存 */}
        <div className="settings-section">
          <h3>存储空间</h3>
          <div className="settings-item">
            <span className="settings-label">缓存大小</span>
            <span className="settings-value">{cacheSize}</span>
          </div>
          <button type="button" className="clear-cache-btn" onClick={clearCache}>
            清除缓存
          </button>
        </div>
      </div>
    </div>
  )
}
