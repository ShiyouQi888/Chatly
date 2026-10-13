import React, { useState, useEffect } from 'react'
import { IconBack, IconChevron } from '../components/Icon.jsx'
import './me-tab.css'

/* ===== 通用设置 =====
 * 所有设置项持久化到 localStorage
 * 字体大小通过 CSS 变量 --font-scale 应用到全局 */
export default function GeneralSettings({ onBack, showToast }) {
  const [fontSize, setFontSize] = useState(() => {
    return localStorage.getItem('chatly-font-size') || 'standard'
  })
  const [language] = useState('zh-CN')
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
    // 应用字体大小到全局
    const scaleMap = {
      small: '0.9',
      standard: '1',
      large: '1.1',
      xlarge: '1.2',
    }
    document.documentElement.style.setProperty('--font-scale', scaleMap[fontSize] || '1')
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
    // 清除缓存（保留登录状态和设置）
    const keysToKeep = [
      'chatly-token',
      'chatly-user',
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
              <span className="settings-label">发送键回车换行</span>
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
