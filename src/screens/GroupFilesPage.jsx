import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, formatRelative, mediaUrl } from '../api/client.js'
import { useApp } from '../store/AppContext.jsx'
import { IconBack, IconFile, IconFolder, IconImage, IconPlus, IconVideo } from '../components/Icon.jsx'

const CATEGORIES = [
  { id: 'all', label: '全部', icon: IconFolder },
  { id: 'image', label: '图片', icon: IconImage },
  { id: 'video', label: '视频', icon: IconVideo },
  { id: 'document', label: '文档', icon: IconFile },
  { id: 'archive', label: '压缩包', icon: IconFolder },
  { id: 'other', label: '其他', icon: IconFile },
]

function formatSize(raw) {
  const size = Number(raw) || 0
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}

export default function GroupFilesPage({ chat, sendMessage, onBack }) {
  const { showToast } = useApp()
  const [category, setCategory] = useState('all')
  const [files, setFiles] = useState([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef(null)

  const loadFiles = useCallback(async ({ append = false, beforeId = null } = {}) => {
    setLoading(true)
    setError('')
    try {
      const out = await api.groupFiles(chat.id, { type: category, limit: 30, beforeId: append ? beforeId : null })
      setFiles((current) => append
        ? [...current, ...(out.files || []).filter((file) => !current.some((item) => item.id === file.id))]
        : (out.files || []))
      setTotal(Number(out.total) || 0)
      setHasMore(!!out.hasMore)
    } catch (e) {
      setError(e.message || '群文件加载失败')
    } finally {
      setLoading(false)
    }
  }, [chat.id, category])

  useEffect(() => {
    setFiles([])
    loadFiles()
  }, [loadFiles])

  const uploadFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      const uploaded = await api.upload(file)
      const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file'
      await sendMessage({
        conversationId: chat.id,
        kind,
        fileUrl: uploaded.url,
        fileName: uploaded.fileName || file.name,
        fileSize: uploaded.fileSize || file.size,
      })
      showToast('文件已分享到群聊')
      if (category === 'all') await loadFiles()
      else setCategory('all')
    } catch (e) {
      showToast(e.message || '文件上传失败')
    } finally {
      setUploading(false)
    }
  }

  const openFile = (file) => {
    window.open(mediaUrl(file.file_url), '_blank', 'noopener,noreferrer')
  }

  return (
    <section className="gfiles-page" aria-label={`${chat.name} 群文件`}>
      <header className="gfiles-head">
        <button type="button" className="gfiles-back" onClick={onBack} aria-label="返回群设置">
          <IconBack size={21} />
        </button>
        <div className="gfiles-heading">
          <h2>群文件</h2>
          <span>{chat.name}</span>
        </div>
        <button type="button" className="gfiles-upload" onClick={() => inputRef.current?.click()} disabled={uploading} aria-label="上传群文件">
          <IconPlus size={20} />
        </button>
        <input ref={inputRef} type="file" hidden onChange={uploadFile} />
      </header>

      <nav className="gfiles-categories" aria-label="群文件分类">
        {CATEGORIES.map(({ id, label, icon: CategoryIcon }) => (
          <button key={id} type="button" className={`gfiles-category ${category === id ? 'is-active' : ''}`} onClick={() => setCategory(id)} aria-pressed={category === id}>
            <CategoryIcon size={15} /> {label}
          </button>
        ))}
      </nav>

      <div className="gfiles-body">
        <div className="gfiles-summary">
          <span>{category === 'all' ? '群内共享文件' : `${CATEGORIES.find((item) => item.id === category)?.label}文件`}</span>
          <span>{loading && !files.length ? '加载中…' : `${total} 项`}</span>
        </div>

        {error ? (
          <div className="gfiles-state is-error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => loadFiles()}>重新加载</button>
          </div>
        ) : files.length === 0 && loading ? (
          <p className="gfiles-state">正在加载群文件…</p>
        ) : files.length === 0 ? (
          <div className="gfiles-state is-empty">
            <IconFolder size={30} />
            <b>这个分类还没有文件</b>
            <span>上传后会自动分享到群聊</span>
          </div>
        ) : (
          <div className="gfiles-list">
            {files.map((file) => {
              const Icon = file.kind === 'image' ? IconImage : file.kind === 'video' ? IconVideo : IconFile
              return (
                <button type="button" className="gfiles-item" key={file.id} onClick={() => openFile(file)}>
                  <span className={`gfiles-file-icon is-${file.kind}`}><Icon size={19} /></span>
                  <span className="gfiles-file-meta">
                    <b>{file.file_name || file.content || '未命名文件'}</b>
                    <em>{file.sender_name || '群成员'} · {formatRelative(Number(file.created_at))}</em>
                  </span>
                  <span className="gfiles-size">{formatSize(file.file_size)}</span>
                </button>
              )
            })}
          </div>
        )}

        {loading && files.length > 0 && <p className="gfiles-more-state">正在加载…</p>}
        {!loading && hasMore && files.length > 0 && (
          <button type="button" className="gfiles-more" onClick={() => loadFiles({ append: true, beforeId: files[files.length - 1]?.id })}>加载更多</button>
        )}
      </div>
      {uploading && <div className="gfiles-upload-status" role="status">正在上传并分享到群聊…</div>}
    </section>
  )
}
