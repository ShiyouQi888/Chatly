/**
 * 动态详情（整屏层）：完整内容 + 点赞的人 + 评论（含回复）
 *
 * 为什么单独一屏而不是在列表里展开：
 * 评论要能翻、能回复某一条、能删，塞在卡片里会变成一个越撑越长的卡片，
 * 列表滚动位置也会乱跳。列表上的「评论」只切一个输入框，深度互动在详情页做。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { api, formatAgo, formatDayLabel } from '../api/client.js'
import { useMoments } from '../store/MomentStore.jsx'
import { avatarOf } from '../store/ChatStore.jsx'
import { useApp } from '../store/AppContext.jsx'
import { Avatar, AvatarStack, Empty } from '../components/ui.jsx'
import MediaViewer from '../components/MediaViewer.jsx'
import MomentMedia from '../components/MomentMedia.jsx'
import MapView from '../components/MapView.jsx'
import { LocationViewer } from '../components/LocationView.jsx'
import {
  IconBack,
  IconHeart,
  IconComment,
  IconSend,
  IconTrash,
  IconLocate,
  IconMusic,
  IconPlay,
  IconLock,
  IconEye,
} from '../components/Icon.jsx'
import './moment-detail.css'

const VIS_LABEL = { public: '公开', friends: '仅好友可见', private: '仅自己可见' }

/** 动态媒体项 → 查看器需要的形状（查看器按消息字段写的：fileUrl / kind） */
function toViewer(it) {
  return {
    id: it?.id,
    kind: it?.kind === 'video' ? 'video' : 'image',
    fileUrl: it?.url,
    fileName: it?.fileName,
    fileSize: it?.fileSize,
  }
}

function CommentRow({ c, kids, meId, canModerate, onReply, onDelete }) {
  return (
    <div className="mdc-group">
      <div className="mdc">
        <Avatar src={avatarOf(c.author)} name={c.author.nickname} size={30} radius={10} />
        <div className="mdc-body">
          <div className="mdc-top">
            <b>{c.author.nickname}</b>
            <em>{formatAgo(c.createdAt)}</em>
          </div>
          <p>
            {c.replyTo && <i className="mdc-reply">回复 {c.replyTo.nickname}：</i>}
            {c.content}
          </p>
        </div>
        <div className="mdc-acts">
          <button type="button" onClick={() => onReply(c)}>
            回复
          </button>
          {(c.author.id === meId || canModerate) && (
            <button type="button" className="is-danger" onClick={() => onDelete(c)}>
              <IconTrash size={13} />
            </button>
          )}
        </div>
      </div>
      {!!kids.length && (
        <div className="mdc-kids">
          {kids.map((k) => (
            <CommentRow
              key={k.id}
              c={k}
              kids={[]}
              meId={meId}
              canModerate={canModerate}
              onReply={onReply}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function MomentDetail({ moment, onBack }) {
  const { me, toggleLike, commentsOf, loadComments, addComment, deleteComment } = useMoments()
  const { showToast } = useApp()

  const [likes, setLikes] = useState([])
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [busy, setBusy] = useState(false)
  const [viewer, setViewer] = useState(null)
  const [locFull, setLocFull] = useState(false)

  const id = moment?.id

  useEffect(() => {
    if (!id) return
    loadComments(id).catch(() => {})
    api
      .momentLikes(id)
      .then((d) => setLikes(d.likes || []))
      .catch(() => setLikes([]))
  }, [id, loadComments])

  const comments = commentsOf(id) || []
  const tops = useMemo(() => comments.filter((c) => !c.parentId), [comments])
  const kidsOf = (pid) => comments.filter((c) => c.parentId === pid)

  if (!moment) return null

  /* 坐标必须成对才画地图 —— 只有地名的动态（老数据 / 手输）不画，
     绝不用 0 兜底（(0,0) 是几内亚湾，画出来是个错的位置）。 */
  const hasLocCoords = Number.isFinite(moment.locationLat) && Number.isFinite(moment.locationLng)

  const submit = async () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      await addComment(id, t, replyTo?.id || null)
      setText('')
      setReplyTo(null)
    } catch (e) {
      showToast(e.message || '评论失败')
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (c) => {
    try {
      await deleteComment(id, c.id)
      showToast('评论已删除')
    } catch (e) {
      showToast(e.message || '删除失败')
    }
  }

  return (
    <div className="md-root cover-tabbar">
      <header className="md-head">
        <button type="button" className="md-back" onClick={onBack} aria-label="返回">
          <IconBack size={21} />
        </button>
        <h2>动态详情</h2>
        <span className="md-spacer" />
      </header>

      <div className="md-scroll no-scrollbar">
        <div className="md-card">
          <div className="md-author">
            <Avatar src={moment.src} name={moment.authorName} size={44} radius={15} />
            <div className="md-author-body">
              <b>{moment.authorName}</b>
              <em>
                {formatAgo(moment.time)}
                {moment.location && (
                  <>
                    <i>·</i>
                    <IconLocate size={11} /> {moment.location}
                  </>
                )}
              </em>
            </div>
            <span className="md-vis">
              {moment.visibility === 'private' ? <IconLock size={13} /> : <IconEye size={13} />}
              {VIS_LABEL[moment.visibility]}
            </span>
          </div>

          {moment.topic && <span className="md-topic">{moment.topic}</span>}

          {/* 定位：只有在**坐标成对**时才画地图。
              老动态 / 用户手输的地点名只有名字 —— 那种情况上面那行已经显示了名字，
              这里不能拿 0 兜底画一张假地图（0,0 是几内亚湾）。
              外壳用 div + role 而不是 button：MapView 失败态里自带一个「重新加载」按钮。 */}
          {moment.location && hasLocCoords && (
            <div
              className="md-map"
              role="button"
              tabIndex={0}
              aria-label={`位置：${moment.location}，点开看地图`}
              data-testid="md-map"
              onClick={() => setLocFull(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setLocFull(true)
                }
              }}
            >
              <MapView
                lat={moment.locationLat}
                lng={moment.locationLng}
                height={132}
                interactive={false}
                compact
                title={moment.location}
              />
              <span className="md-map-tip">
                <IconLocate size={12} /> {moment.location}
              </span>
            </div>
          )}

          {moment.content && <p className="md-text">{moment.content}</p>}

          {/* 和列表卡片共用同一个组件，只有 CSS 前缀不同 */}
          {moment.media?.length > 0 && (
            <MomentMedia media={moment.media} prefix="mdgrid" onOpen={(it) => setViewer(toViewer(it))} />
          )}

          {moment.music && (
            <div className="md-music">
              <span className="md-music-ic">
                <IconMusic size={18} />
              </span>
              <span className="md-music-body">
                <b>{moment.music.title}</b>
                <em>{moment.music.artist}</em>
              </span>
              {/* 播放是未接入的：按钮禁用并写明，不做「点一下图标换一个」的假播放 */}
              <button type="button" className="md-music-play" disabled>
                <IconPlay size={14} /> 未接入
              </button>
            </div>
          )}

          <p className="md-time">
            {formatDayLabel(moment.time)}
            {moment.editedAt && <i>· 已编辑</i>}
          </p>

          <div className="md-likes">
            {likes.length > 0 ? (
              <>
                <IconHeart size={14} sw={0} />
                <AvatarStack
                  items={likes.slice(0, 6).map((l) => ({ src: avatarOf(l.user), name: l.user.nickname }))}
                  size={24}
                  max={6}
                />
                <em>{moment.likeCount} 人赞过</em>
              </>
            ) : (
              <em className="is-empty">还没有人点赞</em>
            )}
          </div>

          <div className="md-acts">
            <button
              type="button"
              className={`md-act ${moment.liked ? 'is-on' : ''}`}
              onClick={() => toggleLike(id, moment).catch((e) => showToast(e.message))}
            >
              <IconHeart size={18} sw={moment.liked ? 0 : 1.8} />
              <span>{moment.liked ? '已赞' : '点赞'}</span>
            </button>
            <button
              type="button"
              className="md-act"
              onClick={() => document.querySelector('.md-input input')?.focus()}
            >
              <IconComment size={18} />
              <span>评论 {moment.commentCount}</span>
            </button>
          </div>
        </div>

        <h3 className="md-sec-title">评论 {comments.length}</h3>

        {comments.length === 0 ? (
          <Empty icon={<IconComment size={24} />} title="还没有评论" desc="说点什么吧" />
        ) : (
          <div className="md-comments">
            {tops.map((c) => (
              <CommentRow
                key={c.id}
                c={c}
                kids={kidsOf(c.id)}
                meId={me?.id}
                canModerate={!!moment.mine}
                onReply={(x) => {
                  setReplyTo(x)
                  document.querySelector('.md-input input')?.focus()
                }}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </div>

      <div className="md-input">
        {replyTo && (
          <div className="md-reply">
            <span>回复 {replyTo.author.nickname}</span>
            <button type="button" onClick={() => setReplyTo(null)} aria-label="取消回复">
              取消
            </button>
          </div>
        )}
        <input
          value={text}
          placeholder={replyTo ? `回复 ${replyTo.author.nickname}…` : '写评论…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button type="button" onClick={submit} disabled={!text.trim() || busy} aria-label="发送评论">
          <IconSend size={17} />
        </button>
      </div>

      {viewer && <MediaViewer m={viewer} onClose={() => setViewer(null)} />}

      {/* 定位全屏：用的是位置消息那套查看器（同一份地图 + 名称/地址/坐标呈现）。
          动态没有「谁发的地址」这一说，address 留空 —— 服务端也只存名字 + 坐标。 */}
      {locFull && (
        <LocationViewer
          m={{ geo: { name: moment.location, address: '', lat: moment.locationLat, lng: moment.locationLng } }}
          onClose={() => setLocFull(false)}
        />
      )}
    </div>
  )
}
