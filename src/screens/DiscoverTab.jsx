/**
 * 发现页：真实数据（推荐用户 / 附近的人 / 兴趣标签 / 可加入的兴趣群 / 热门动态）
 *
 * 上一版这一页每一块都是 `mock.js` 里的写死数据，每个点击都是一句 toast ——
 * 「热门动态」点了弹「打开：xxx」、活动报名点了弹「已报名：xxx」、附近的人「打招呼」
 * 弹「向 X 打招呼」。那是**假功能**：界面看着热闹，一样都不落地。
 *
 * 这一版按「库里有什么就做什么」重做：
 *   - 推荐用户 / 附近的人 —— 真实用户，关注是**真的写进 follows 表**
 *     （动态的「仅好友可见」就是按它判的，所以这不是一个孤立的小按钮）
 *   - 热门动态 —— 复用动态的接口（`scope=hot`），点开是同一个详情页
 *   - 兴趣标签 —— 从所有用户填过的标签**聚合**出来（不是写死那 10 个），点了真的筛选
 *   - 兴趣群 —— 真实群，加入真的写进 `conversation_members`
 *   - 活动和报名 —— 复用动态活动卡片与报名记录，展示有权限查看的未开始活动
 *   - 热门话题 —— 只聚合公开动态，按内容量和去重后的打开行为排序
 *
 * ⚠️ 附近的人的**距离必须有坐标支撑**：
 *    双方都主动授权并保存了行政区划中心点 → 才给「约 X km」（依据写在界面上）；
 *    否则退回按资料里的地区文字匹配，显示「同城 / 同省 / 地区名」。
 *    **没有坐标时一个数都不出** —— 「附近 2.3 km」这种编出来的数字比不显示更糟。
 */
import React, { useState } from 'react'
import { api } from '../api/client.js'
import { useApp } from '../store/AppContext.jsx'
import { useAuth } from '../store/AuthContext.jsx'
import { useChat } from '../store/ChatStore.jsx'
import { useDiscover } from '../store/DiscoverStore.jsx'
import { shapeMoment } from '../store/MomentStore.jsx'
import { Avatar, Chip, SectionTitle, Empty } from '../components/ui.jsx'
import {
  IconSearch,
  IconFire,
  IconTarget,
  IconUser,
  IconLocate,
  IconChat,
  IconEye,
  IconTag,
  IconCalendar,
  IconPlus,
} from '../components/Icon.jsx'
import UserProfile from './UserProfile.jsx'
import MomentDetail from './MomentDetail.jsx'
import './discover-tab.css'

const SECTIONS = [
  { key: 'recommend', label: '推荐' },
  { key: 'nearby', label: '附近' },
  { key: 'activities', label: '活动' },
  { key: 'topics', label: '话题' },
  { key: 'groups', label: '群组' },
  { key: 'users', label: '用户' },
]

const friendActionLabel = (status) => ({
  outgoing: '等待验证', incoming: '收到申请', friends: '已添加',
}[status] || '加好友')

/* ===== 推荐用户行 ===== */
function UserRow({ u, onFollow, onOpen }) {
  return (
    /* data-id 给自检用：按姓名或序号定位都会错（排序会变），按 id 才是稳的 */
    <div className="rc-row" data-id={u.id}>
      <button type="button" className="rc-avatar" onClick={() => onOpen(u)} aria-label={`查看 ${u.nickname} 的主页`}>
        <Avatar src={u.src} name={u.nickname} size={46} radius={15} online={u.online} />
      </button>
      <button type="button" className="rc-meta" onClick={() => onOpen(u)}>
        <b>
          {u.nickname}
          {u.friendStatus && u.friendStatus !== 'none' && <i className="rc-badge">{friendActionLabel(u.friendStatus)}</i>}
        </b>
        {/* 推荐理由只显示后端算得出来的（共同群聊 / 共同兴趣 / 同城），算不出就不显示 ——
            不要写「可能认识」这种无法证伪的话 */}
        {u.reason ? <em>{u.reason}</em> : <em>{u.bio || '这个人还没写签名'}</em>}
        <div className="rc-tags">
          {(u.tags || []).slice(0, 3).map((t) => (
            <span key={t}>{t}</span>
          ))}
          {u.mutualGroups > 0 && <i>{u.mutualGroups} 个共同群聊</i>}
        </div>
      </button>
      <button
        type="button"
        className={`rc-follow ${u.friendStatus !== 'none' ? 'is-on' : ''}`}
        onClick={() => onFollow(u)}
        disabled={u.friendStatus !== 'none'}
        aria-pressed={u.friendStatus === 'friends'}
        aria-label={`${friendActionLabel(u.friendStatus)} ${u.nickname}`}
      >
        {friendActionLabel(u.friendStatus)}
      </button>
    </div>
  )
}

/* ===== 附近的人卡片 ===== */
function NearbyCard({ p, onSay, onOpen, onFollow }) {
  return (
    <div className="nb-card" data-id={p.id} data-distance-basis={p.distanceBasis}>
      <div className="nb-top">
        <button type="button" className="rc-avatar" onClick={() => onOpen(p)} aria-label={`查看 ${p.nickname} 的主页`}>
          <Avatar src={p.src} name={p.nickname} size={52} radius={17} online={p.online} />
        </button>
        <div className="nb-meta">
          <b>{p.nickname}</b>
          <em>{p.bio || '这个人还没写签名'}</em>
          <span className={`nb-dist ${p.near === 2 ? 'is-same' : ''}`}>
            <IconLocate size={11} /> {p.distanceLabel}
          </span>
        </div>
        <button
          type="button"
          className={`rc-follow ${p.friendStatus !== 'none' ? 'is-on' : ''}`}
          onClick={() => onFollow(p)}
          disabled={p.friendStatus !== 'none'}
          aria-label={`${friendActionLabel(p.friendStatus)} ${p.nickname}`}
        >
          {friendActionLabel(p.friendStatus)}
        </button>
      </div>

      {(p.tags || []).length > 0 && (
        <div className="nb-tags">
          {p.tags.map((t) => (
            <span key={t} className="nb-tag">
              {t}
            </span>
          ))}
        </div>
      )}

      {p.mutualTags > 0 && <p className="nb-common">你们有 {p.mutualTags} 个共同兴趣</p>}
      {p.mutualGroups > 0 && <p className="nb-common">你们在 {p.mutualGroups} 个共同的群里</p>}

      <div className="nb-acts">
        <button type="button" className="nb-btn" onClick={() => onOpen(p)}>
          查看主页
        </button>
        <button type="button" className="nb-btn nb-btn--primary" onClick={() => onSay(p)}>
          <IconChat size={15} /> 打招呼
        </button>
      </div>
    </div>
  )
}

/* ===== 兴趣群卡片 ===== */
function GroupCard({ g, onJoin, busy }) {
  return (
    <div className="ig-card" data-id={g.id}>
      <Avatar src={g.avatar} name={g.title} size={46} radius={15} />
      <div className="ig-body">
        <b>{g.title}</b>
        <em>
          {g.memberCount} 位成员{g.ownerNickname ? ` · 群主 ${g.ownerNickname}` : ''}
        </em>
      </div>
      <button type="button" className="ig-join" onClick={() => onJoin(g)} disabled={busy}>
        <IconPlus size={14} sw={2.2} /> 加入
      </button>
    </div>
  )
}

function ActivityCard({ moment, onRsvp, busy }) {
  const event = moment.card.data
  const startsAt = new Date(event.startsAt)
  const dateLabel = Number.isNaN(startsAt.getTime())
    ? '时间待确认'
    : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(startsAt)
  return (
    <article className="da-card" data-id={moment.id}>
      <div className="da-author">
        <Avatar src={moment.src} name={moment.authorName} size={34} radius={11} />
        <b>{moment.authorName}</b>
      <span>活动</span>
      </div>
      <h3>{event.title}</h3>
      {event.description && <p className="da-description">{event.description}</p>}
      <div className="da-meta"><IconCalendar size={14} /> {dateLabel}</div>
      <div className="da-meta"><IconTarget size={14} /> {event.location || '地点待填写'}</div>
      <div className="da-counts">{moment.card.going || 0} 人参加 · {moment.card.interested || 0} 人感兴趣</div>
      <div className="da-actions">
        <button type="button" className={moment.card.myStatus === 'interested' ? 'is-selected' : ''} disabled={busy} onClick={() => onRsvp(moment, moment.card.myStatus === 'interested' ? null : 'interested')}>
          感兴趣
        </button>
        <button type="button" className={moment.card.myStatus === 'going' ? 'is-selected' : 'is-primary'} disabled={busy} onClick={() => onRsvp(moment, moment.card.myStatus === 'going' ? null : 'going')}>
          {moment.card.myStatus === 'going' ? '已报名 · 取消' : '我要参加'}
        </button>
      </div>
    </article>
  )
}

export default function DiscoverTab({ nav }) {
  const { showToast } = useApp()
  const { user } = useAuth()
  const { createPrivateChat } = useChat()
  const {
    users,
    usersHasMore,
    nearby,
    myRegion,
    myGeo,
    tags,
    groups,
    hot,
    activities,
    topics,
    loading,
    loadingMore,
    error,
    refresh,
    setTag,
    loadMoreUsers,
    follow,
    joinGroup,
  } = useDiscover()

  const [section, setSection] = useState('recommend')
  const [tag, setTagState] = useState('')
  const [profileId, setProfileId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [eventBusyId, setEventBusyId] = useState(null)
  const [topicBusy, setTopicBusy] = useState(false)
  const [selectedTopic, setSelectedTopic] = useState('')
  const [topicMoments, setTopicMoments] = useState([])

  const onFollow = async (u) => {
    try {
      await follow(u.id)
    } catch (e) {
      showToast(e.message)
    }
  }

  /** 打招呼：建/开私聊并进会话。
      不自动发一句「你好」—— 那句话是我们替用户编的，
      真发出去就成了「我没说过的话出现在我的聊天记录里」。跳进房间让他自己打第一句。 */
  const onSay = async (u) => {
    try {
      const convId = await createPrivateChat(u.id)
      nav.openChat({ id: convId })
      showToast(`已打开与 ${u.nickname} 的私聊`)
    } catch (e) {
      showToast(e.message || '打开私聊失败')
    }
  }

  const onJoin = async (g) => {
    setBusyId(g.id)
    try {
      const out = await joinGroup(g.id)
      showToast(out?.joined ? `已加入「${g.title}」` : `你已经在「${g.title}」里了`)
      nav.openChat({ id: g.id })
    } catch (e) {
      showToast(e.message || '加入失败')
    } finally {
      setBusyId(null)
    }
  }

  const pickTag = (t) => {
    const next = tag === t ? '' : t
    setTagState(next)
    setTag(next)
    setSection('users')
  }

  const respondToActivity = async (moment, status) => {
    setEventBusyId(moment.id)
    try {
      await api.respondMomentActivity(moment.id, status)
      await refresh()
      showToast(status === 'going' ? '报名成功' : status === 'interested' ? '已标记感兴趣' : '已取消报名')
    } catch (e) {
      showToast(e.message || '活动报名失败')
    } finally {
      setEventBusyId(null)
    }
  }

  const openTopic = async (topic) => {
    if (topicBusy) return
    setSection('topics')
    setTopicBusy(true)
    setSelectedTopic(topic)
    setTopicMoments([])
    try {
      await api.viewDiscoverTopic(topic)
      const out = await api.discoverTopicMoments(topic)
      setTopicMoments((out.moments || []).map((m) => shapeMoment(m, user?.id)))
    } catch (e) {
      setSelectedTopic('')
      showToast(e.message || '话题加载失败')
    } finally {
      setTopicBusy(false)
    }
  }

  const hotShaped = hot.map((m) => shapeMoment(m, user?.id))

  return (
    <div className="tabpane">
      <header className="ph-head">
        <h1 className="ph-title">发现</h1>
        <button type="button" className="icon-btn" onClick={nav.openSearch} aria-label="搜索">
          <IconSearch size={20} />
        </button>
      </header>

      <div className="disc-scroll no-scrollbar">
        <div className="disc-segs">
          {SECTIONS.map((s) => (
            <Chip key={s.key} active={section === s.key} onClick={() => setSection(s.key)}>
              {s.label}
            </Chip>
          ))}
        </div>

        {error && (
          <div className="dg-error">
            <span>{error}</span>
            <button type="button" onClick={refresh}>
              重试
            </button>
          </div>
        )}

        {/* ===== 推荐：兴趣标签 + 热门动态 ===== */}
        {section === 'recommend' && (
          <>
            <section className="disc-block">
              <SectionTitle action="换一批" onAction={refresh}>
                <span className="st-ic">
                  <IconTag size={15} /> 兴趣标签
                </span>
              </SectionTitle>
              <p className="disc-hint">
                <IconEye size={13} /> 按大家填过的兴趣聚合，点一个去找同类
              </p>
              <div className="tag-cloud">
                {tags.length === 0 && !loading ? (
                  <p className="dg-muted">还没有人填过兴趣标签</p>
                ) : (
                  tags.map((t) => (
                    <Chip key={t.tag} size="sm" active={tag === t.tag} onClick={() => pickTag(t.tag)}>
                      {t.tag} {t.count}
                    </Chip>
                  ))
                )}
              </div>
            </section>

            <section className="disc-block">
              <SectionTitle>
                <span className="st-ic">
                  <IconFire size={15} /> 热门动态
                </span>
              </SectionTitle>
              {hotShaped.length === 0 ? (
                loading ? (
                  <p className="dg-muted">加载中…</p>
                ) : (
                  <Empty icon={<IconFire size={24} />} title="还没有热门动态" desc="去发一条，让更多人看到" />
                )
              ) : (
                <div className="hot-list">
                  {hotShaped.map((m, i) => (
                    <button
                      key={m.id}
                      type="button"
                      className="hot-row"
                      onClick={() => setDetail(m)}
                      aria-label={`打开：${m.content || m.authorName}`}
                    >
                      <span className={`hot-rank ${i < 3 ? 'is-top' : ''}`}>{i + 1}</span>
                      <span className="hot-body">
                        <b>{m.content || (m.media?.length ? '[图片]' : '[动态]')}</b>
                        <em>
                          {m.authorName}
                          {m.topic ? ` · ${m.topic}` : ''}
                        </em>
                      </span>
                      <span className="hot-heat">{m.likeCount || 0} 赞</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="disc-block">
              <SectionTitle action="查看全部" onAction={() => setSection('topics')}>
                <span className="st-ic"><IconFire size={15} /> 热门话题榜</span>
              </SectionTitle>
              <p className="disc-hint">按近 30 天公开动态数量与近 7 天独立浏览人数排序</p>
              {!topics.length ? (
                <Empty icon={<IconFire size={23} />} title="暂时没有热门话题" desc="公开动态添加话题后会出现在这里" />
              ) : (
                <div className="dt-list">
                  {topics.slice(0, 5).map((item, i) => (
                    <button key={item.topic} type="button" className="dt-row" onClick={() => openTopic(item.topic)}>
                      <b className={i < 3 ? 'is-top' : ''}>{i + 1}</b>
                      <span><strong>#{item.topic}</strong><em>{item.momentCount} 条动态 · {item.viewerCount} 人浏览</em></span>
                      <i>查看</i>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {/* ===== 附近的人 ===== */}
        {section === 'nearby' && (
          <section className="disc-block">
            <SectionTitle action={myRegion ? myRegion : '未设置'} onAction={refresh}>
              <span className="st-ic">
                <IconTarget size={15} /> 附近的人
              </span>
            </SectionTitle>
            {/* 把依据写出来 —— 距离从哪来的必须交代清楚，否则「约 104 km」会被当成精确位置。
                两种依据分开说：有坐标的是**行政区划中心点**之间的距离，
                没坐标的退回按资料里的地区文字匹配。 */}
            {myGeo ? (
              <p className="disc-hint">
                <IconEye size={13} /> 你已主动开启城市级附近分享（{myGeo.city || myRegion}）。距离按<b>两地行政区划中心点</b>估算，
                不使用实时位置；关闭后会清除保存的城市坐标
              </p>
            ) : (
              <p className="disc-hint">
                <IconEye size={13} /> 附近分享默认关闭。发现页不会请求设备定位；当前只按资料地区匹配，不显示公里数。可在「我 → 编辑资料」主动定位并勾选参与附近
              </p>
            )}
            {nearby.length === 0 ? (
              loading ? (
                <p className="dg-muted">加载中…</p>
              ) : (
                <Empty icon={<IconTarget size={24} />} title="附近还没有人" desc="先在资料里填一下地区" />
              )
            ) : (
              <div className="nb-list">
                {nearby.map((p) => (
                  <NearbyCard
                    key={p.id}
                    p={p}
                    onSay={onSay}
                    onOpen={(x) => setProfileId(x.id)}
                    onFollow={onFollow}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {section === 'activities' && (
          <section className="disc-block">
            <SectionTitle action="刷新" onAction={refresh}>
              <span className="st-ic"><IconCalendar size={15} /> 即将开始的活动</span>
            </SectionTitle>
            <p className="disc-hint">展示你有权查看且尚未开始的活动动态；发现页不读取设备位置。</p>
            {!activities.length ? (
              loading ? <p className="dg-muted">加载中…</p> : <Empty icon={<IconCalendar size={24} />} title="暂时没有即将开始的活动" desc="发布动态时添加活动卡片，其他人就能在这里报名" />
            ) : (
              <div className="da-list">
                {activities.map((m) => <ActivityCard key={m.id} moment={shapeMoment(m, user?.id)} onRsvp={respondToActivity} busy={eventBusyId === m.id} />)}
              </div>
            )}
          </section>
        )}

        {section === 'topics' && (
          <section className="disc-block">
            {selectedTopic ? (
              <>
                <SectionTitle action="返回榜单" onAction={() => setSelectedTopic('')}>
                  <span className="st-ic"><IconFire size={15} /> #{selectedTopic}</span>
                </SectionTitle>
                {topicBusy ? <p className="dg-muted">加载话题动态…</p> : !topicMoments.length ? <Empty icon={<IconFire size={24} />} title="暂时没有可查看的动态" desc="该话题下没有你有权限查看的公开或好友动态" /> : (
                  <div className="dt-moments">
                    {topicMoments.map((m) => <button type="button" className="dt-moment" key={m.id} onClick={() => setDetail(m)}><b>{m.content || (m.media?.length ? '[媒体动态]' : '[活动动态]')}</b><em>{m.authorName} · {m.likeCount || 0} 赞 · {m.commentCount || 0} 评论</em></button>)}
                  </div>
                )}
              </>
            ) : (
              <>
                <SectionTitle action="刷新" onAction={refresh}><span className="st-ic"><IconFire size={15} /> 热门话题榜</span></SectionTitle>
                <p className="disc-hint">榜单只统计公开动态；浏览人数按用户去重，近 7 天内打开话题会参与排序。</p>
                {!topics.length ? <Empty icon={<IconFire size={24} />} title="暂时没有热门话题" desc="公开动态添加话题后会出现在这里" /> : (
                  <div className="dt-list">
                    {topics.map((item, i) => <button key={item.topic} type="button" className="dt-row" disabled={topicBusy} onClick={() => openTopic(item.topic)}><b className={i < 3 ? 'is-top' : ''}>{i + 1}</b><span><strong>#{item.topic}</strong><em>{item.momentCount} 条动态 · {item.viewerCount} 人浏览</em></span><i>{topicBusy ? '打开中' : '查看'}</i></button>)}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {/* ===== 兴趣群 ===== */}
        {section === 'groups' && (
          <section className="disc-block">
            <SectionTitle action="刷新" onAction={refresh}>
              <span className="st-ic">
                <IconUser size={15} /> 可加入的兴趣群
              </span>
            </SectionTitle>
            <p className="disc-hint">
              <IconEye size={13} /> 只列出公开的兴趣群；工作群和私人群需要群里的人邀请
            </p>
            {groups.length === 0 ? (
              loading ? (
                <p className="dg-muted">加载中…</p>
              ) : (
                <Empty icon={<IconUser size={24} />} title="暂时没有可加入的群" desc="公开的兴趣群会出现在这里" />
              )
            ) : (
              <div className="ig-list">
                {groups.map((g) => (
                  <GroupCard key={g.id} g={g} onJoin={onJoin} busy={busyId === g.id} />
                ))}
              </div>
            )}
          </section>
        )}

        {/* ===== 推荐用户 ===== */}
        {section === 'users' && (
          <section className="disc-block">
            <SectionTitle action="换一批" onAction={refresh}>
              <span className="st-ic">
                <IconUser size={15} /> 你可能认识
              </span>
            </SectionTitle>
            <p className="disc-hint">
              <IconTarget size={13} /> 先按共同群聊，再按共同兴趣，最后按同城
              {tag ? ` · 已按「${tag}」筛选` : ''}
            </p>
            {tag && (
              <div className="dg-filter">
                <Chip size="sm" active onClick={() => pickTag(tag)}>
                  {tag} ✕
                </Chip>
              </div>
            )}

            {users.length === 0 ? (
              loading ? (
                <p className="dg-muted">加载中…</p>
              ) : (
                <Empty
                  icon={<IconUser size={24} />}
                  title={tag ? `没有带「${tag}」标签的人` : '暂时没有可推荐的人'}
                  desc={tag ? '换个标签试试' : '多关注几个人，推荐会更准'}
                />
              )
            ) : (
              <div className="rc-list">
                {users.map((u) => (
                  <UserRow key={u.id} u={u} onFollow={onFollow} onOpen={(x) => setProfileId(x.id)} />
                ))}
              </div>
            )}

            {usersHasMore && (
              <button type="button" className="dg-more" onClick={loadMoreUsers} disabled={loadingMore}>
                {loadingMore ? '加载中…' : '加载更多'}
              </button>
            )}
          </section>
        )}

        {loading && !users.length && !nearby.length && !groups.length && <p className="dg-muted">加载中…</p>}
        <p className="chat-foot">探索更多 · 连接有趣的人</p>
      </div>

      {profileId && (
        <UserProfile
          userId={profileId}
          onBack={() => setProfileId(null)}
          onMessage={async () => {
            const u = [...users, ...nearby].find((x) => x.id === profileId)
            setProfileId(null)
            if (u) await onSay(u)
          }}
        />
      )}

      {detail && <MomentDetail moment={detail} onBack={() => setDetail(null)} />}
    </div>
  )
}
