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
  const [bio, setBio] = useState('')
  const [gender, setGender] = useState(null)
  const [birthday, setBirthday] = useState('')
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
    setBio(user.bio || '')
    setGender(user.gender || null)
    setBirthday(user.birthday || '')
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
        setLocNote(`已定位到「${res.city.name || label}」，可勾选参与「附近」`)
      } else {
        setLocNote(`已定位到「${label || '当前位置'}」，但没有拿到行政区划中心点`)
      }
      setLocating(false)
    } catch (e) {
      /* getMyLocation 失败给的是 GeolocationPositionError；locate 失败给的是接口错误 */
      const isGeoErr = typeof e?.code === 'number' || e?.name === 'NotSupportedError'
      setLocNote(isGeoErr ? geoReason(e) : `位置服务出错：${e.message}`)
      setLocating(false)
    }
  }

  const dirty =
    !!avatarDraft ||
    nickname.trim() !== (user?.nickname || '') ||
    bio.trim() !== (user?.bio || '') ||
    (gender || null) !== (user?.gender || null) ||
    (birthday || '') !== (user?.birthday || '') ||
    region.trim() !== (user?.region || '') ||
    (city || null) !== (user?.city || null) ||
    (cityGeo?.lat ?? null) !== (user?.cityLat ?? null) ||
    (cityGeo?.lng ?? null) !== (user?.cityLng ?? null) ||
    cityPublic !== !!user?.cityPublic ||
    tags.join(',') !== (Array.isArray(user?.tags) ? user.tags : []).join(',')

  const save = async () => {
    const name = nickname.trim()
    if (!name) {
      showToast('昵称不能为空')
      return
    }
    setSaving(true)
    try {
      const fields = {
        nickname: name,
        bio: bio.trim(),
        gender: gender || null,
        birthday: birthday || null,
        region: region.trim(),
        tags,
        /* 位置：三个字段一起提交。
           ⚠️ 没开「参与附近」时**照样把坐标存下来**（只是 cityPublic=0），
           这样用户以后想开就不用重新定位；而对外一个字节都不会露出去（后端 publicUser 做的闸门）。 */
        city,
        cityLat: cityGeo?.lat ?? null,
        cityLng: cityGeo?.lng ?? null,
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
              disabled={locating || !locateSupported}
              data-testid="use-location"
              title={locateSupported ? '使用当前位置' : '这个浏览器不支持定位'}
            >
              <IconLocate size={15} sw={2.1} />
              {locating ? '定位中…' : '定位'}
            </button>
          </div>
          {locNote && <p className="pe-note pe-loc-note">{locNote}</p>}
          {!!cityGeo && (
            <label className="pe-switch">
              <input
                type="checkbox"
                checked={cityPublic}
                onChange={(e) => setCityPublic(e.target.checked)}
                data-testid="city-public"
              />
              <span>
                在「发现 · 附近」里显示我的城市距离
                <em>
                  只上传<b>行政区划中心点</b>（{city || '城市'}），不是你的实时位置；关掉就不对外显示
                </em>
              </span>
            </label>
          )}
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
