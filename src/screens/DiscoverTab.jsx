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
 *   - 附近活动 —— 库里没有活动这张表，**不做**，明确标未接入并禁用
 *
 * ⚠️ 附近的人的**距离必须有坐标支撑**：
 *    双方都存了行政区划中心点、且对方开了公开开关 → 才给「约 X km」（依据写在界面上）；
 *    否则退回按资料里的地区文字匹配，显示「同城 / 同省 / 地区名」。
 *    **没有坐标时一个数都不出** —— 「附近 2.3 km」这种编出来的数字比不显示更糟。
 */
import React, { useState } from 'react'
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
  IconLock,
} from '../components/Icon.jsx'
import UserProfile from './UserProfile.jsx'
import MomentDetail from './MomentDetail.jsx'
import './discover-tab.css'

const SECTIONS = [
  { key: 'recommend', label: '推荐' },
  { key: 'nearby', label: '附近' },
  { key: 'groups', label: '群组' },
  { key: 'users', label: '用户' },
]

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
          {u.following && <i className="rc-badge">已关注</i>}
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
        className={`rc-follow ${u.following ? 'is-on' : ''}`}
        onClick={() => onFollow(u)}
        aria-pressed={!!u.following}
        aria-label={u.following ? `取消关注 ${u.nickname}` : `关注 ${u.nickname}`}
      >
        {u.following ? '已关注' : '关注'}
      </button>
    </div>
  )
}

/* ===== 附近的人卡片 ===== */
function NearbyCard({ p, onSay, onOpen, onFollow }) {
  return (
    <div className="nb-card" data-id={p.id}>
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
          className={`rc-follow ${p.following ? 'is-on' : ''}`}
          onClick={() => onFollow(p)}
          aria-label={p.following ? `取消关注 ${p.nickname}` : `关注 ${p.nickname}`}
        >
          {p.following ? '已关注' : '关注'}
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

/* ===== 未接入：一律禁用并写明 ===== */
function PendingBlock() {
  const items = [
    { icon: <IconCalendar size={16} />, label: '附近活动', why: '需要活动与报名表，后端暂无' },
    { icon: <IconFire size={16} />, label: '热门话题榜', why: '需要话题聚合与浏览行为' },
    { icon: <IconTarget size={16} />, label: '精准定位附近', why: '默认关闭，且不采集位置' },
  ]
  return (
    <section className="disc-block">
      <SectionTitle>
        <span className="st-ic">
          <IconLock size={15} /> 尚未接入
        </span>
      </SectionTitle>
      <div className="dg-pending">
        {items.map((it) => (
          <div key={it.label} className="dg-pending-item">
            <span className="dg-pending-ic">{it.icon}</span>
            <span className="dg-pending-body">
              <b>{it.label}</b>
              <em>{it.why}</em>
            </span>
            <i className="dg-pending-tag">未接入</i>
          </div>
        ))}
      </div>
    </section>
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

            <PendingBlock />
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
                <IconEye size={13} /> 你已开启城市位置（{myGeo.city || myRegion}）。带「约 X km」的按<b>两地行政区划中心点</b>估算，
                只到城市量级，不是谁的真实位置；其余人没开启，仍按资料地区匹配
              </p>
            ) : (
              <p className="disc-hint">
                <IconEye size={13} /> 未开启定位；按资料里填的地区匹配，只显示同城 / 同省，不显示公里数
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
