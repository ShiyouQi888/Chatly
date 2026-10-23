/**
 * 编辑资料面板：头像 / 昵称 / 个性签名 / 性别 / 生日 / 所在地区 / 兴趣标签
 *
 * 保存顺序是「先存文本字段，再传头像」——
 * 反过来的话，文本校验一旦失败，服务器上就留下一个没人引用的头像文件。
 * 这个顺序最坏情况只是「文字存了、头像没换成」，且会明确提示，用户可以重试。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, presetAvatar } from '../api/client.js'
import { avatarOf } from '../store/ChatStore.jsx'
import { useAuth } from '../store/AuthContext.jsx'
import { Avatar, Sheet } from './ui.jsx'
import AvatarPicker from './AvatarPicker.jsx'
import { IconCamera, IconClose, IconLocate, IconPlus } from './Icon.jsx'
import { canLocate, geoReason, getMyLocation } from '../lib/geo.js'
import './profile-editor.css'

const MAX_TAGS = 8
const GENDERS = [
  { v: 'male', label: '男' },
  { v: 'female', label: '女' },
  { v: 'other', label: '其他' },
]

/** 草稿头像（可能还没保存）渲染成可直接塞进 <img> 的地址 */
function draftAvatarSrc(draft, user) {
  if (draft?.kind === 'preset') return presetAvatar(draft.n)
  if (draft?.kind === 'file') return draft.url
  return avatarOf(user)
}

export default function ProfileEditor({ open, onClose, onSaved, showToast }) {
  const { user, updateProfile, uploadAvatar } = useAuth()

  const [nickname, setNickname] = useState('')
  const [username, setUsername] = useState('')
  const [bio, setBio] = useState('')
  const [gender, setGender] = useState(null)
  const [birthday, setBirthday] = useState('')
  const [phone, setPhone] = useState('')
  const [region, setRegion] = useState('')
  const [tags, setTags] = useState([])
  const [tagInput, setTagInput] = useState('')
  const [avatarDraft, setAvatarDraft] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  /* ---- 位置 ----
     `cityGeo` 是**行政区划中心点**（后端 /geo/locate 返回的 city.lat/lng），
     不是用户站在哪 —— 传给我们自己的坐标从不落库，只有这个中心点会被保存。 */
  const [city, setCity] = useState(null)
  const [cityGeo, setCityGeo] = useState(null)
  const [cityPublic, setCityPublic] = useState(false)
  const [locating, setLocating] = useState(false)
  const [locNote, setLocNote] = useState('')

  const draftUrlRef = useRef(null)

  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const locateSupported = useMemo(() => canLocate(), [])

  /* 每次打开都从服务端的 user 重新起草，避免上次未保存的残留 */
  useEffect(() => {
    if (!open || !user) return
    setNickname(user.nickname || '')
    setUsername(user.username || '')
    setBio(user.bio || '')
    setGender(user.gender || null)
    setBirthday(user.birthday || '')
    /* `user` 里有没有 phone 取决于服务端的塑形：`/auth/me` 走的是 selfUser（含手机号），
       而别人看到的资料走 publicUser（**不含**）。所以这里 `?? ''` 兜底而不是当成错误。 */
    setPhone(user.phone || '')
    setRegion(user.region || '')
    setTags(Array.isArray(user.tags) ? user.tags : [])
    setTagInput('')
    setAvatarDraft(null)
    setPickerOpen(false)
    setCity(user.city || null)
    /* user 上只有 cityPublic 为真时才有坐标（后端做的闸门），所以这里跟着走 */
    setCityGeo(
      Number.isFinite(user.cityLat) && Number.isFinite(user.cityLng)
        ? { lat: user.cityLat, lng: user.cityLng }
        : null
    )
    setCityPublic(!!user.cityPublic)
    setLocNote('')
  }, [open, user])

  /* 草稿里的 object URL 要自己回收（换成预设或关闭面板时） */
  const dropDraftUrl = useCallback(() => {
    if (draftUrlRef.current) {
      URL.revokeObjectURL(draftUrlRef.current)
      draftUrlRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!open) {
      dropDraftUrl()
      setAvatarDraft(null)
    }
  }, [open, dropDraftUrl])

  const applyAvatar = (v) => {
    dropDraftUrl()
    if (v.kind === 'file') {
      const url = URL.createObjectURL(v.file)
      draftUrlRef.current = url
      setAvatarDraft({ kind: 'file', file: v.file, url })
    } else {
      setAvatarDraft({ kind: 'preset', n: v.n })
    }
    setPickerOpen(false)
  }

  const addTag = () => {
    const t = tagInput.trim().slice(0, 8)
    if (!t) return
    if (tags.includes(t)) {
      setTagInput('')
      return
    }
    if (tags.length >= MAX_TAGS) {
      showToast(`兴趣标签最多 ${MAX_TAGS} 个`)
      return
    }
    setTags([...tags, t])
    setTagInput('')
  }

  /**
   * 「使用当前位置」——定位 → 逆地址解析 → 回填地区。
   *
   * 三步里任何一步失败都要**说清是哪一步**：
   * 没权限 / 定位超时 是用户能自己解决的问题，位置服务没配 key 则是我们这边的事，
   * 都报「定位失败」的话用户只能反复点。
   *
   * ⚠️ 失败后**不清空手输内容** —— 定位是加速手段，不是必经之路。
   */
  const useCurrentLocation = async () => {
    if (!cityPublic) {
      setLocNote('附近分享默认关闭。先勾选下方授权，再手动定位；不勾选时不会请求设备位置。')
      return
    }
    setLocating(true)
    setLocNote('')
    try {
      const me = await getMyLocation()
      const res = await api.locate(me.lat, me.lng, { pois: false })

      if (!res?.configured) {
        setLocNote('服务端还没配置位置服务（TENCENT_MAP_KEY），解析不出城市名 —— 可以先手动填')
        return
      }

      const label = res.city?.region || res.address?.city || ''
      if (label) setRegion(label)

      if (res.city && Number.isFinite(res.city.lat) && Number.isFinite(res.city.lng)) {
        setCity(res.city.name || label || null)
        setCityGeo({ lat: res.city.lat, lng: res.city.lng })
        setLocNote(`已定位到「${res.city.name || label}」。保存后只保留城市中心点，不保留实时坐标。`)
      } else {
        setLocNote(`已定位到「${label || '当前位置'}」，但没有拿到行政区划中心点`)
      }
    } catch (e) {
      /* getMyLocation 失败给的是 GeolocationPositionError；locate 失败给的是接口错误 */
      const isGeoErr = typeof e?.code === 'number' || e?.name === 'NotSupportedError'
      setLocNote(isGeoErr ? geoReason(e) : `位置服务出错：${e.message}`)
    } finally {
      setLocating(false)
    }
  }

  const dirty =
    !!avatarDraft ||
    username !== (user?.username || '') ||
    nickname.trim() !== (user?.nickname || '') ||
    bio.trim() !== (user?.bio || '') ||
    (gender || null) !== (user?.gender || null) ||
    (birthday || '') !== (user?.birthday || '') ||
    phone.trim() !== (user?.phone || '') ||
    region.trim() !== (user?.region || '') ||
    (city || null) !== (user?.city || null) ||
    (cityGeo?.lat ?? null) !== (user?.cityLat ?? null) ||
    (cityGeo?.lng ?? null) !== (user?.cityLng ?? null) ||
    cityPublic !== !!user?.cityPublic ||
    tags.join(',') !== (Array.isArray(user?.tags) ? user.tags : []).join(',')

  const save = async () => {
    if (!/^[a-z0-9]{2,24}$/.test(username)) {
      showToast('用户 ID 需为 2–24 位英文字母或数字，不能包含空格和符号')
      return
    }
    const name = nickname.trim()
    if (!name) {
      showToast('昵称不能为空')
      return
    }
    if (cityPublic && !cityGeo) {
      showToast('请先手动定位城市，或关闭附近分享')
      return
    }
    setSaving(true)
    try {
      const fields = {
        ...(username !== user.username ? { username } : {}),
        nickname: name,
        bio: bio.trim(),
        gender: gender || null,
        birthday: birthday || null,
        phone: phone.trim() || null,
        region: region.trim(),
        tags,
        /* 位置只在用户明确开启「参与附近」时提交城市中心点；关闭后清空，
           不保留未授权的位置数据。浏览器定位仍只由用户点按钮触发。 */
        city,
        cityLat: cityPublic ? cityGeo?.lat ?? null : null,
        cityLng: cityPublic ? cityGeo?.lng ?? null : null,
        cityPublic,
      }
      // 预设头像就是一个字符串，跟其它字段一起提交；旧的上传头像会由后端顺手删掉
      if (avatarDraft?.kind === 'preset') fields.avatar = `preset:${avatarDraft.n}`
      await updateProfile(fields)

      if (avatarDraft?.kind === 'file') {
        try {
          await uploadAvatar(avatarDraft.file)
        } catch (e) {
          showToast(`资料已保存，但头像上传失败：${e.message}`)
          onSaved?.()
          return
        }
      }

      showToast('资料已保存')
      onSaved?.()
    } catch (e) {
      showToast(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title="编辑资料"
        footer={
          <button type="button" className="pe-save" onClick={save} disabled={saving || !dirty}>
            {saving ? '保存中…' : '保存'}
          </button>
        }
      >
        <div className="pe-avatar">
          <button type="button" className="pe-avatar-btn" onClick={() => setPickerOpen(true)}>
            <Avatar src={draftAvatarSrc(avatarDraft, user)} name={user?.nickname || ''} size={78} radius={26} />
            <span className="pe-avatar-cam">
              <IconCamera size={14} />
            </span>
          </button>
          <button type="button" className="pe-avatar-text" onClick={() => setPickerOpen(true)}>
            更换头像
          </button>
        </div>

        <div className="pe-field pe-user-id">
          <label htmlFor="pe-id">用户 ID</label>
          <input id="pe-id" value={username} maxLength={24} autoCapitalize="none" autoCorrect="off" spellCheck={false}
            onChange={(e) => setUsername(e.target.value.toLowerCase())} aria-describedby="pe-id-help" disabled={saving} />
          <small id="pe-id-help">2–24 位英文字母或数字，大写自动转小写；好友关系和聊天记录不受影响。</small>
        </div>

        <div className="pe-field">
          <label htmlFor="pe-nick">昵称</label>
          <input
            id="pe-nick"
            value={nickname}
            maxLength={20}
            placeholder="取一个名字"
            onChange={(e) => setNickname(e.target.value)}
          />
          <em>{[...nickname].length}/20</em>
        </div>

        <div className="pe-field">
          <label htmlFor="pe-bio">个性签名</label>
          <input
            id="pe-bio"
            value={bio}
            maxLength={60}
            placeholder="说点什么，让别人记住你"
            onChange={(e) => setBio(e.target.value)}
          />
          <em>{[...bio].length}/60</em>
        </div>

        <div className="pe-field is-block">
          <label>性别</label>
          <div className="pe-chips">
            {GENDERS.map((g) => (
              <button
                key={g.v}
                type="button"
                className={`pe-chip ${gender === g.v ? 'is-on' : ''}`}
                onClick={() => setGender(gender === g.v ? null : g.v)}
                aria-pressed={gender === g.v}
              >
                {g.label}
              </button>
            ))}
            <span className="pe-chip-note">{gender ? '再点一次可取消' : '不填则不展示'}</span>
          </div>
        </div>

        <div className="pe-field">
          <label htmlFor="pe-birth">生日</label>
          <input
            id="pe-birth"
            type="date"
            value={birthday}
            max={today}
            onChange={(e) => setBirthday(e.target.value)}
          />
          {birthday && (
            <button type="button" className="pe-clear" onClick={() => setBirthday('')} aria-label="清除生日">
              <IconClose size={14} />
            </button>
          )}
        </div>

        <div className="pe-field is-block">
          <label htmlFor="pe-phone">手机号</label>
          <input
            id="pe-phone"
            type="tel"
            inputMode="numeric"
            value={phone}
            maxLength={11}
            placeholder="11 位手机号（选填）"
            onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, ''))}
          />
          <p className="pe-note">
            只用于「被别人按手机号搜到」和隐私设置里的「通过手机号添加」。
            <br />
            它<b>不能用来登录</b>，也不参与验证码校验 —— 本项目没有短信通道。
            其他人看不到你的手机号。
          </p>
        </div>

        <div className="pe-field is-block">
          <label htmlFor="pe-region">所在地区</label>
          <div className="pe-region-row">
            <input
              id="pe-region"
              value={region}
              maxLength={20}
              placeholder="如：广东 · 深圳"
              onChange={(e) => setRegion(e.target.value)}
            />
            <button
              type="button"
              className="pe-locate"
              onClick={useCurrentLocation}
              disabled={locating || !locateSupported || !cityPublic}
              data-testid="use-location"
              title={!cityPublic ? '先明确授权参与附近后再定位' : locateSupported ? '使用当前位置解析城市中心点' : '这个浏览器不支持定位'}
            >
              <IconLocate size={15} sw={2.1} />
              {locating ? '定位中…' : '定位'}
            </button>
          </div>
          {locNote && <p className="pe-note pe-loc-note">{locNote}</p>}
          <label className="pe-switch">
            <input
              type="checkbox"
              checked={cityPublic}
              onChange={(e) => setCityPublic(e.target.checked)}
              data-testid="city-public"
            />
            <span>
              授权城市级附近分享（默认关闭）
              <em>
                只有勾选后手动点击「定位」才会请求设备位置；服务端只保存行政区划中心点{city ? `（${city}）` : ''}。关闭后立即清除坐标。
              </em>
            </span>
          </label>
        </div>

        <div className="pe-field is-block">
          <label>兴趣标签</label>
          <div className="pe-tags">
            {tags.map((t) => (
              <span key={t} className="pe-tag">
                {t}
                <button type="button" onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`移除 ${t}`}>
                  <IconClose size={12} sw={2.6} />
                </button>
              </span>
            ))}
            {tags.length < MAX_TAGS && (
              <span className="pe-tag-add">
                <input
                  value={tagInput}
                  maxLength={8}
                  placeholder="添加"
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addTag()
                    }
                  }}
                />
                <button type="button" onClick={addTag} aria-label="添加标签" disabled={!tagInput.trim()}>
                  <IconPlus size={13} sw={2.6} />
                </button>
              </span>
            )}
          </div>
          <p className="pe-note">最多 {MAX_TAGS} 个，每个 8 字以内</p>
        </div>

        <p className="pe-foot">资料会展示给你的聊天对象，修改后对方会实时看到。</p>
      </Sheet>

      <AvatarPicker
        open={pickerOpen}
        name={user?.nickname || ''}
        current={
          avatarDraft?.kind === 'preset'
            ? `preset:${avatarDraft.n}`
            : avatarDraft?.kind === 'file'
              ? null
              : user?.avatar
        }
        previewSrc={avatarDraft?.kind === 'file' ? avatarDraft.url : undefined}
        onApply={applyAvatar}
        onClose={() => setPickerOpen(false)}
      />
    </>
  )
}
