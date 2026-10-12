/**
 * 群设置页（盖在聊天室之上的整屏层）
 *
 * 只有群聊才进得来 —— 私聊没有「群公告 / 成员管理 / 群开关」这些概念，
 * 硬塞进同一个组件会让两边都长出一堆 `isGroup &&` 的分支。
 *
 * 权限模型（和服务端 chat.js 保持一致，前端只是**显示**层面的收敛，真正的拦截在服务端）：
 *   owner  群主    —— 改资料、发公告、开关群、设/撤管理员、移出任何人（除自己）
 *   admin  管理员  —— 改资料、发公告、开关群、邀请、移出普通成员
 *   member 成员    —— 只能看 + 邀请好友
 * 界面上不给的入口，服务端也一定挡得住；反过来服务端 403 的，界面上也不会让你点。
 */
import React, { useEffect, useState } from 'react'
import { api, formatRelative } from '../api/client.js'
import { useApp } from '../store/AppContext.jsx'
import { useChat, avatarOf } from '../store/ChatStore.jsx'
import { Avatar, ActionMenu, Sheet, Switch } from '../components/ui.jsx'
import AvatarPicker from '../components/AvatarPicker.jsx'
import {
  IconBack,
  IconEdit,
  IconInfo,
  IconUser,
  IconPlusCircle,
  IconShield,
  IconTrash,
  IconBellOff,
  IconLock,
  IconLogout,
  IconFolder,
  IconCheck,
  IconChevron,
} from '../components/Icon.jsx'
import './group-settings.css'

const ROLE_LABEL = { owner: '群主', admin: '管理员', member: '' }
const ROLE_ORDER = { owner: 0, admin: 1, member: 2 }

const ANNOUNCE_MAX = 500
const TITLE_MAX = 40

export default function GroupSettings({ chat, onBack, onOpenProfile, onLeft, onOpenPoll }) {
  const { showToast } = useApp()
  const {
    me,
    loadGroupMembers,
    updateGroup,
    addGroupMembers,
    removeGroupMember,
    setGroupRole,
    leaveGroup,
    polls,
    loadConversationPolls,
  } = useChat()

  /* 进页面就拉一次权威值：列表里的 members 可能是几分钟前的快照，
     而「我是不是管理员」直接决定下面这些入口能不能点 —— 宁可多拉一次。 */
  useEffect(() => {
    loadGroupMembers(chat.id).catch(() => {})
  }, [chat.id, loadGroupMembers])

  /* 群投票列表：这里要的是「这个群一共发起过哪些投票」，
     光靠聊天记录里出现过的投票是不够的（很久以前的、还没翻到的那页都看不到）。
     拉回来的详情同时进了 store 的缓存，聊天页那边就不用再拉一遍。 */
  const [pollList, setPollList] = useState(null)
  const [pollErr, setPollErr] = useState('')
  useEffect(() => {
    let alive = true
    setPollList(null)
    setPollErr('')
    loadConversationPolls(chat.id)
      .then((list) => alive && setPollList(list))
      .catch((e) => alive && setPollErr(e.message || '投票列表加载失败'))
    return () => {
      alive = false
    }
  }, [chat.id, loadConversationPolls])

  const members = chat.members || []
  const sorted = [...members].sort(
    (a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.user.id - b.user.id
  )
  const canManage = chat.myRole === 'owner' || chat.myRole === 'admin'
  const isOwner = chat.myRole === 'owner'
  const owner = members.find((m) => m.role === 'owner')?.user

  /* ---- 弹层 ---- */
  const [menu, setMenu] = useState(null) // 成员操作
  const [invite, setInvite] = useState(false)
  const [editName, setEditName] = useState(false)
  const [editAnn, setEditAnn] = useState(false)
  const [askLeave, setAskLeave] = useState(false)
  const [picker, setPicker] = useState(false)
  const [nameText, setNameText] = useState(chat.name || '')
  const [annText, setAnnText] = useState(chat.announcement || '')
  const [candidates, setCandidates] = useState(null)
  const [picked, setPicked] = useState([])
  const [busy, setBusy] = useState(false)

  const openInvite = async () => {
    setInvite(true)
    setPicked([])
    try {
      const { users } = await api.users()
      const inGroup = new Set(members.map((m) => m.user.id))
      setCandidates(users.filter((u) => !inGroup.has(u.id)))
    } catch (e) {
      setCandidates([])
      showToast(e.message || '加载好友列表失败')
    }
  }

  /* ---- 改群资料 ---- */
  const save = async (fields, ok) => {
    setBusy(true)
    try {
      await updateGroup(chat.id, fields)
      ok?.()
    } catch (e) {
      showToast(e.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const onAvatarApplied = async (res) => {
    setPicker(false)
    if (res.kind === 'preset') {
      await save({ avatar: `preset:${res.n}` }, () => showToast('群头像已更新'))
      return
    }
    // 上传的图先走「文件」入口落盘，拿到 /uploads/... 再写进群资料。
    // 不这么做的话要给群头像单开一个上传接口，而它和用户头像的校验规则完全一样。
    try {
      const up = await api.upload(res.file)
      await updateGroup(chat.id, { avatar: up.url })
      showToast('群头像已更新')
    } catch (e) {
      showToast(e.message || '上传失败')
    }
  }

  /* ---- 成员操作 ---- */
  const itemsFor = (mb) => {
    const list = [
      {
        label: '查看资料',
        icon: <IconUser size={19} />,
        onClick: () => onOpenProfile?.(mb.user.id),
      },
    ]

    if (isOwner && mb.role === 'member') {
      list.push({
        label: '设为管理员',
        icon: <IconShield size={19} />,
        onClick: () =>
          setGroupRole(chat.id, mb.user.id, 'admin')
            .then(() => showToast(`已将 ${mb.user.nickname} 设为管理员`))
            .catch((e) => showToast(e.message || '设置失败')),
      })
    }
    if (isOwner && mb.role === 'admin') {
      list.push({
        label: '撤销管理员',
        icon: <IconShield size={19} />,
        onClick: () =>
          setGroupRole(chat.id, mb.user.id, 'member')
            .then(() => showToast(`已撤销 ${mb.user.nickname} 的管理员`))
            .catch((e) => showToast(e.message || '设置失败')),
      })
    }
    /* 移出：群里不能没有群主，所以群主这一项根本不给；
       管理员只能移普通成员 —— 移管理员是群主的权力（服务端同规则）。 */
    if (canManage && mb.role === 'member') {
      list.push({
        label: '移出群聊',
        icon: <IconTrash size={19} />,
        danger: true,
        onClick: () =>
          removeGroupMember(chat.id, mb.user.id)
            .then(() => showToast(`已移出 ${mb.user.nickname}`))
            .catch((e) => showToast(e.message || '移出失败')),
      })
    }
    if (isOwner && mb.role === 'admin') {
      list.push({
        label: '移出群聊',
        icon: <IconTrash size={19} />,
        danger: true,
        onClick: () =>
          removeGroupMember(chat.id, mb.user.id)
            .then(() => showToast(`已移出 ${mb.user.nickname}`))
            .catch((e) => showToast(e.message || '移出失败')),
      })
    }
    return list
  }

  const doInvite = async () => {
    if (!picked.length) return
    setBusy(true)
    try {
      const out = await addGroupMembers(chat.id, picked)
      showToast(picked.length > 1 ? `已邀请 ${picked.length} 位成员` : '已邀请新成员')
      setInvite(false)
      void out
    } catch (e) {
      showToast(e.message || '邀请失败')
    } finally {
      setBusy(false)
    }
  }

  const doLeave = async () => {
    setBusy(true)
    try {
      await leaveGroup(chat.id)
      setAskLeave(false)
      showToast('已退出群聊')
      onLeft?.()
    } catch (e) {
      showToast(e.message || '退出失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gs-root">
      <header className="gs-head">
        <button type="button" className="gs-back" onClick={onBack} aria-label="返回">
          <IconBack size={21} />
        </button>
        <h2>群设置</h2>
        <span className="gs-spacer" />
      </header>

      <div className="gs-scroll no-scrollbar">
        {/* ===== 群名片 ===== */}
        <section className="gs-card is-hero">
          {canManage ? (
            <button
              type="button"
              className="gs-av"
              onClick={() => setPicker(true)}
              aria-label="更换群头像"
            >
              <Avatar src={chat.src} name={chat.name} size={72} radius={22} />
              <i className="gs-av-edit">
                <IconEdit size={13} />
              </i>
            </button>
          ) : (
            <span className="gs-av is-static">
              <Avatar src={chat.src} name={chat.name} size={72} radius={22} />
            </span>
          )}

          <div className="gs-title-row">
            <b className="gs-name">{chat.name}</b>
            {canManage && (
              <button
                type="button"
                className="gs-edit"
                onClick={() => {
                  setNameText(chat.name || '')
                  setEditName(true)
                }}
                aria-label="修改群名称"
              >
                <IconEdit size={15} />
              </button>
            )}
          </div>
          <p className="gs-sub">
            {members.length} 位成员
            {owner && <i>群主 {owner.nickname}</i>}
            <i>我 · {ROLE_LABEL[chat.myRole] || '成员'}</i>
          </p>
        </section>

        {/* ===== 群公告 ===== */}
        <section className="gs-card">
          <h4 className="gs-card-title">
            <IconInfo size={15} /> 群公告
          </h4>
          {chat.announcement ? (
            <>
              <p className="gs-ann">{chat.announcement}</p>
              <p className="gs-ann-time">
                {chat.announcementAt ? formatRelative(chat.announcementAt) : ''} 更新
              </p>
            </>
          ) : (
            <p className="gs-ann is-empty">还没有群公告</p>
          )}
          {canManage && (
            <div className="gs-ann-acts">
              <button
                type="button"
                className="gs-link"
                onClick={() => {
                  setAnnText(chat.announcement || '')
                  setEditAnn(true)
                }}
              >
                {chat.announcement ? '编辑公告' : '写公告'}
              </button>
              {chat.announcement && (
                <button
                  type="button"
                  className="gs-link is-muted"
                  onClick={() =>
                    save({ announcement: '' }, () => showToast('群公告已清空'))
                  }
                >
                  清空
                </button>
              )}
            </div>
          )}
        </section>

        {/* ===== 成员 ===== */}
        <section className="gs-card">
          <h4 className="gs-card-title">
            <IconUser size={15} /> 群成员
            <i className="gs-count">{members.length}</i>
          </h4>
          <div className="gs-grid">
            {sorted.map((mb) => (
              <button
                key={mb.user.id}
                type="button"
                className="gs-member"
                onClick={() => setMenu(mb)}
                aria-label={`${mb.user.nickname} 的操作`}
              >
                <Avatar src={avatarOf(mb.user)} name={mb.user.nickname} size={46} radius={15} />
                <span className="gs-member-name">{mb.user.nickname}</span>
                {/* 角标放一行里：都挂在列方向容器上会各占一行，头像下面越长越乱 */}
                {(ROLE_LABEL[mb.role] || mb.user.id === me?.id) && (
                  <span className="gs-roles">
                    {ROLE_LABEL[mb.role] && <i className="gs-role">{ROLE_LABEL[mb.role]}</i>}
                    {mb.user.id === me?.id && <i className="gs-role is-me">我</i>}
                  </span>
                )}
              </button>
            ))}
            <button type="button" className="gs-member is-add" onClick={openInvite}>
              <span className="gs-add-ic">
                <IconPlusCircle size={20} />
              </span>
              <span className="gs-member-name">邀请</span>
            </button>
          </div>
        </section>

        {/* ===== 管理（只有群主 / 管理员看得见）===== */}
        {canManage && (
          <section className="gs-card">
            <h4 className="gs-card-title">
              <IconShield size={15} /> 群管理
            </h4>
            {/* 用 div 而不是 button：Switch 自身就是 button，
                button 套 button 是非法 DOM 嵌套（React 会告警，读屏也会错乱） */}
            <div className="gs-row is-static">
              <span className="gs-row-ic is-amber">
                <IconBellOff size={16} />
              </span>
              <span className="gs-row-body">
                <b>全员禁言</b>
                <em>开启后只有群主和管理员能发言</em>
              </span>
              <span className="gs-row-right">
                <Switch
                  on={!!chat.muteAll}
                  onChange={() => save({ muteAll: !chat.muteAll })}
                />
              </span>
            </div>
            <div className="gs-row is-static">
              <span className="gs-row-ic is-cyan">
                <IconLock size={16} />
              </span>
              <span className="gs-row-body">
                <b>仅管理员发言</b>
                <em>成员仍可查看消息，但不能发送</em>
              </span>
              <span className="gs-row-right">
                <Switch
                  on={!!chat.adminOnly}
                  onChange={() => save({ adminOnly: !chat.adminOnly })}
                />
              </span>
            </div>
          </section>
        )}

        {/* ===== 未接入 =====
             一律 disabled + 明确标注，不做「点了弹个 toast 假装成功」的假功能。 */}
        {/* ===== 群投票 =====
            这一块原来是「未接入」的禁用项。做成真的之后**两处入口都通**：
            聊天页加号面板发起，这里看全部历史（点了跳到聊天里那条消息）。 */}
        <section className="gs-card">
          <h4 className="gs-card-title">
            <IconCheck size={15} /> 群投票
            {pollList?.length ? <span className="gs-count">{pollList.length}</span> : null}
          </h4>

          {pollErr ? (
            <p className="gs-note is-warn">{pollErr}</p>
          ) : pollList === null ? (
            <p className="gs-note">加载中…</p>
          ) : pollList.length === 0 ? (
            <p className="gs-note" data-testid="gs-poll-empty">
              这个群还没有投票。在聊天页的「+」里发起，发起后这里能查到全部历史。
            </p>
          ) : (
            <div className="gs-rows">
              {pollList.map((p) => {
                /* 用 store 里的最新一份（别人刚投了票，列表上的数字要跟着动） */
                const live = polls[p.id] || p
                return (
                  <button
                    type="button"
                    className="gs-row is-poll"
                    key={p.id}
                    data-testid={`gs-poll-${p.id}`}
                    data-message-id={p.messageId}
                    onClick={() => onOpenPoll?.(p.messageId)}
                  >
                    <span className="gs-row-ic is-poll">
                      <IconCheck size={16} />
                    </span>
                    <span className="gs-row-body">
                      <b>{live.question}</b>
                      <em>
                        {live.multi ? '多选' : '单选'}
                        {live.anonymous ? ' · 匿名' : ''} · {live.voterCount} 人已投 ·{' '}
                        {live.closed ? '已结束' : formatRelative(live.createdAt)}
                      </em>                    </span>
                    <span className="gs-row-right">
                      {live.closed ? '已结束' : '进行中'}
                      <IconChevron size={14} />
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        <section className="gs-card">
          <h4 className="gs-card-title">
            <IconFolder size={15} /> 尚未接入
          </h4>
          <div className="gs-rows">
            <button type="button" className="gs-row is-pending" disabled>
              <span className="gs-row-ic">
                <IconFolder size={16} />
              </span>
              <span className="gs-row-body">
                <b>群文件</b>
              </span>
              <span className="gs-row-right">未接入</span>
            </button>
            <button type="button" className="gs-row is-pending" disabled>
              <span className="gs-row-ic">
                <IconChevron size={16} />
              </span>
              <span className="gs-row-body">
                <b>群公告置顶推送</b>
              </span>
              <span className="gs-row-right">未接入</span>
            </button>
          </div>
        </section>

        {/* ===== 退出群聊 ===== */}
        <section className="gs-card">
          {/* 群主不能退出 —— 服务端 removeMember 对 owner 直接 403，
              这里提前禁用并说明原因，比让人点了才报错好。转让群本次未做。 */}
          {isOwner ? (
            <div className="gs-row is-static is-disabled">
              <span className="gs-row-ic is-danger">
                <IconLogout size={16} />
              </span>
              <span className="gs-row-body">
                <b>退出群聊</b>
                <em>群主不能退出，需先转让群（未接入）</em>
              </span>
            </div>
          ) : (
            <button type="button" className="gs-row is-danger" onClick={() => setAskLeave(true)}>
              <span className="gs-row-ic is-danger">
                <IconLogout size={16} />
              </span>
              <span className="gs-row-body">
                <b>退出群聊</b>
                <em>退出后不会再收到这个群的消息</em>
              </span>
            </button>
          )}
        </section>

        <p className="gs-foot">群资料由群主和管理员维护，均为演示数据。</p>
      </div>

      {/* ===== 弹层 ===== */}
      <ActionMenu open={!!menu} onClose={() => setMenu(null)} title={menu?.user.nickname} items={menu ? itemsFor(menu) : []} />

      <Sheet
        open={editName}
        onClose={() => setEditName(false)}
        title="群名称"
        footer={
          <div className="gs-sheet-acts">
            <button type="button" className="gs-btn is-ghost" onClick={() => setEditName(false)}>
              取消
            </button>
            <button
              type="button"
              className="gs-btn is-primary"
              disabled={busy || !nameText.trim()}
              onClick={() =>
                save({ title: nameText.trim() }, () => {
                  setEditName(false)
                  showToast('群名称已更新')
                })
              }
            >
              保存
            </button>
          </div>
        }
      >
        <input
          className="gs-input"
          value={nameText}
          maxLength={TITLE_MAX}
          placeholder="给群起个名字"
          onChange={(e) => setNameText(e.target.value)}
        />
        <p className="gs-hint">{[...nameText].length}/{TITLE_MAX}</p>
      </Sheet>

      <Sheet
        open={editAnn}
        onClose={() => setEditAnn(false)}
        title="群公告"
        footer={
          <div className="gs-sheet-acts">
            <button type="button" className="gs-btn is-ghost" onClick={() => setEditAnn(false)}>
              取消
            </button>
            <button
              type="button"
              className="gs-btn is-primary"
              disabled={busy}
              onClick={() =>
                save({ announcement: annText.trim() }, () => {
                  setEditAnn(false)
                  showToast(annText.trim() ? '群公告已发布' : '群公告已清空')
                })
              }
            >
              发布
            </button>
          </div>
        }
      >
        <textarea
          className="gs-input is-area"
          value={annText}
          maxLength={ANNOUNCE_MAX}
          placeholder="写点什么让大家都知道，比如聚会时间、群规…"
          onChange={(e) => setAnnText(e.target.value)}
        />
        <p className="gs-hint">
          {[...annText].length}/{ANNOUNCE_MAX} · 公告会展示在聊天页顶部
        </p>
      </Sheet>

      <Sheet
        open={invite}
        onClose={() => setInvite(false)}
        title="邀请成员"
        footer={
          <div className="gs-sheet-acts">
            <button type="button" className="gs-btn is-ghost" onClick={() => setInvite(false)}>
              取消
            </button>
            <button
              type="button"
              className="gs-btn is-primary"
              disabled={busy || !picked.length}
              onClick={doInvite}
            >
              {picked.length ? `邀请 ${picked.length} 位` : '邀请'}
            </button>
          </div>
        }
      >
        {candidates === null ? (
          <p className="gs-loading">正在加载…</p>
        ) : candidates.length === 0 ? (
          <p className="gs-loading">所有好友都已经在群里了</p>
        ) : (
          <div className="gs-pick">
            {candidates.map((u) => {
              const on = picked.includes(u.id)
              return (
                <button
                  key={u.id}
                  type="button"
                  className={`gs-pick-row ${on ? 'is-on' : ''}`}
                  onClick={() =>
                    setPicked((p) => (p.includes(u.id) ? p.filter((x) => x !== u.id) : [...p, u.id]))
                  }
                  aria-pressed={on}
                >
                  <Avatar src={avatarOf(u)} name={u.nickname} size={38} radius={12} />
                  <span className="gs-pick-body">
                    <b>{u.nickname}</b>
                    <em>@{u.username}</em>
                  </span>
                  <span className="gs-pick-check">{on && <IconCheck size={16} sw={3} />}</span>
                </button>
              )
            })}
          </div>
        )}
      </Sheet>

      <Sheet
        open={askLeave}
        onClose={() => setAskLeave(false)}
        title="退出群聊"
        footer={
          <div className="gs-sheet-acts">
            <button type="button" className="gs-btn is-ghost" onClick={() => setAskLeave(false)}>
              再想想
            </button>
            <button type="button" className="gs-btn is-danger" disabled={busy} onClick={doLeave}>
              退出
            </button>
          </div>
        }
      >
        <p className="gs-note">退出后你将不再收到「{chat.name}」的消息，聊天记录也会从本地移除。</p>
      </Sheet>

      <AvatarPicker
        open={picker}
        name={chat.name}
        current={chat.avatar}
        onApply={onAvatarApplied}
        onClose={() => setPicker(false)}
      />
    </div>
  )
}
