/**
 * 他人资料页（覆盖在聊天室之上的整屏层）
 *
 * 入口只有一处：私聊页顶部头像 / 会话设置的资料卡头像。
 * 既然入口一定在私聊里，就一定已经存在会话 —— 所以「发消息」只是收起这一页回到聊天。
 */
import React, { useEffect, useState } from 'react'
import { api, mediaUrl } from '../api/client.js'
import { avatarOf } from '../store/ChatStore.jsx'
import { Avatar, Chip, Empty } from '../components/ui.jsx'
import {
  IconBack,
  IconCalendar,
  IconChat,
  IconLocate,
  IconTag,
  IconUser,
} from '../components/Icon.jsx'
import './user-profile.css'

const GENDER_LABEL = { male: '男', female: '女', other: '其他' }

export default function UserProfile({ userId, onBack, onMessage }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  /* 对方背景图挂了（文件被清理 / 网络失败）→ 退回默认渐变。
     和「我」页同一个原则：坏图不能留一片空白，但也不用 toast 打扰 ——
     这是在看别人的资料，不是自己操作失败。 */
  const [coverBroken, setCoverBroken] = useState(false)

  useEffect(() => {
    let alive = true
    setData(null)
    setErr('')
    setCoverBroken(false)
    api
      .userProfile(userId)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(e.message || '加载失败'))
    return () => {
      alive = false
    }
  }, [userId])

  const u = data?.user

  return (
    <div className="up-root">
      <header className="up-head">
        <button type="button" className="up-back" onClick={onBack} aria-label="返回">
          <IconBack size={21} />
        </button>
        <h2>资料</h2>
        <span className="up-spacer" />
      </header>

      {err ? (
        <div className="up-scroll no-scrollbar">
          <Empty icon={<IconUser size={26} />} title="打不开这份资料" desc={err} />
        </div>
      ) : !u ? (
        <div className="up-scroll no-scrollbar">
          <p className="up-loading">正在加载…</p>
        </div>
      ) : (
        <>
          <div className="up-scroll no-scrollbar">
            <div className="up-hero">
              <div className={`up-cover ${u.profileCover && !coverBroken ? 'has-image' : ''}`} aria-hidden="true">
                {/* 对方设过背景就显示他的背景；没设或挂了就是他自己的渐变（和「我」页同一套兜底）。 */}
                {u.profileCover && !coverBroken && (
                  <img className="up-cover-img" src={mediaUrl(u.profileCover)} alt="" onError={() => setCoverBroken(true)} />
                )}
                {(!u.profileCover || coverBroken) && (
                  <>
                    <span className="up-cover-a" />
                    <span className="up-cover-b" />
                  </>
                )}
              </div>
              <div className="up-idcard">
                <Avatar src={avatarOf(u)} name={u.nickname} size={82} radius={26} online={data.online} />
                <h3>{u.nickname}</h3>
                <p className="up-uid">
                  @{u.username}
                  <i className={data.online ? 'is-on' : ''}>{data.online ? '在线' : '离线'}</i>
                </p>
                <p className="up-bio">{u.bio || '这个人很神秘，什么都没写'}</p>
              </div>
            </div>

            {(u.gender || u.birthday || u.region) && (
              <div className="up-card">
                {u.gender && (
                  <div className="up-row">
                    <span className="up-row-ic">
                      <IconUser size={17} />
                    </span>
                    <em>性别</em>
                    <b>{GENDER_LABEL[u.gender] || u.gender}</b>
                  </div>
                )}
                {u.birthday && (
                  <div className="up-row">
                    <span className="up-row-ic">
                      <IconCalendar size={17} />
                    </span>
                    <em>生日</em>
                    <b>
                      {u.birthday}
                      {u.age != null && <i>{u.age} 岁</i>}
                    </b>
                  </div>
                )}
                {u.region && (
                  <div className="up-row">
                    <span className="up-row-ic">
                      <IconLocate size={17} />
                    </span>
                    <em>地区</em>
                    <b>{u.region}</b>
                  </div>
                )}
              </div>
            )}

            {!!u.tags?.length && (
              <div className="up-card is-block">
                <h4 className="up-card-title">
                  <IconTag size={15} /> 兴趣标签
                </h4>
                <div className="up-tags">
                  {u.tags.map((t) => (
                    <Chip key={t} size="sm" active>
                      {t}
                    </Chip>
                  ))}
                </div>
              </div>
            )}

            <div className="up-stats">
              <div>
                <b>{u.sharedGroups ?? 0}</b>
                <em>共同群聊</em>
              </div>
              <span className="up-stat-div" />
              <div>
                <b>{data.conversationId ? '已建立' : '未建立'}</b>
                <em>私聊会话</em>
              </div>
            </div>

            <p className="up-foot">资料由对方自行填写，均为演示数据。</p>
          </div>

          <div className="up-acts">
            <button type="button" className="up-msg" onClick={onMessage}>
              <IconChat size={18} /> 发消息
            </button>
          </div>
        </>
      )}
    </div>
  )
}
