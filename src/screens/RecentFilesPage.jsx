import React, { useState, useEffect } from 'react'
import { api, formatAgo } from '../api/client.js'
import { IconBack, IconFile, IconImage, IconVideo, IconFolder } from '../components/Icon.jsx'
import './me-tab.css'

/* ===== 最近文件页面 =====
 * 展示用户在所有会话中发送/接收的文件，按时间倒序
 * 支持按类型筛选：全部 / 文档 / 图片 / 视频 / 压缩包 / 其他 */
export default function RecentFilesPage({ onBack, showToast }) {
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    loadFiles(true)
  }, [filter])

  const loadFiles = async (reset = false) => {
    if (reset) {
      setLoading(true)
      setFiles([])
    } else {
      setLoadingMore(true)
    }

    try {
      const lastId = !reset && files.length > 0 ? files[files.length - 1].id : undefined
      const res = await api.recentFiles({ limit: 20, beforeId: lastId, type: filter })
      
      if (reset) {
        setFiles(res.files || [])
      } else {
        setFiles(prev => [...prev, ...(res.files || [])])
      }
      setHasMore(res.hasMore)
    } catch (err) {
      showToast('加载失败: ' + err.message)
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }

  const loadMore = () => {
    if (!loadingMore && hasMore) {
      loadFiles(false)
    }
  }

  const getFileIcon = (kind) => {
    switch (kind) {
      case 'image': return <IconImage size={20} />
      case 'video': return <IconVideo size={20} />
      default: return <IconFile size={20} />
    }
  }

  const getFileColor = (kind) => {
    switch (kind) {
      case 'image': return 'var(--accent-pink)'
      case 'video': return 'var(--accent-cyan)'
      default: return 'var(--primary)'
    }
  }

  const formatFileSize = (bytes) => {
    if (!bytes) return '未知大小'
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  }

  const filters = [
    { value: 'all', label: '全部' },
    { value: 'document', label: '文档' },
    { value: 'image', label: '图片' },
    { value: 'video', label: '视频' },
    { value: 'archive', label: '压缩包' },
    { value: 'other', label: '其他' },
  ]

  return (
    <div className="sub-page">
      <div className="sub-head">
        <button type="button" className="sub-back" onClick={onBack}>
          <IconBack size={20} />
        </button>
        <h2>最近文件</h2>
      </div>

      <div className="sub-scroll">
        {/* 筛选标签 */}
        <div className="files-filter">
          {filters.map(f => (
            <button
              key={f.value}
              className={`filter-tag ${filter === f.value ? 'active' : ''}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* 文件列表 */}
        {loading ? (
          <div className="empty-state">
            <p>加载中...</p>
          </div>
        ) : files.length === 0 ? (
          <div className="empty-state">
            <IconFolder size={48} />
            <p>暂无文件</p>
          </div>
        ) : (
          <div className="files-list">
            {files.map(file => (
              <div key={file.id} className="file-item">
                <div className="file-icon" style={{ color: getFileColor(file.kind) }}>
                  {getFileIcon(file.kind)}
                </div>
                <div className="file-info">
                  <div className="file-name">{file.file_name || file.content || '未命名文件'}</div>
                  <div className="file-meta">
                    <span>{formatFileSize(file.file_size)}</span>
                    <span>·</span>
                    <span>{file.sender_name}</span>
                    <span>·</span>
                    <span>{formatAgo(file.created_at)}</span>
                  </div>
                  <div className="file-source">
                    来自：{file.conversation_title || '私聊'}
                  </div>
                </div>
              </div>
            ))}

            {hasMore && (
              <button
                className="load-more-btn"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? '加载中...' : '加载更多'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
