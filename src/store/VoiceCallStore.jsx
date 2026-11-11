import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { Avatar } from '../components/ui.jsx'
import { IconClose, IconMic, IconPhone, IconSwitchCamera, IconVideo, IconVideoOff } from '../components/Icon.jsx'
import { useChatSocket, sendChatSocketEvent } from '../hooks/useChatSocket.js'
import { useApp } from './AppContext.jsx'
import { useAuth } from './AuthContext.jsx'
import { callMediaLabel } from '../lib/call.js'
import './voice-call.css'

const VoiceCallContext = createContext(null)
const IDLE_CALL = { status: 'idle' }
const RING_TIMEOUT_MS = 95_000

function displayName(peer) {
  return peer?.nickname || peer?.name || peer?.username || '联系人'
}

function elapsedLabel(seconds) {
  const s = Math.max(0, Number(seconds) || 0)
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

function dismissCallNotification(callId) {
  if (!callId || !('serviceWorker' in navigator)) return
  const close = (registration) => registration?.active?.postMessage({ type: 'call.dismiss', payload: { callId } })
  if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'call.dismiss', payload: { callId } })
  else void navigator.serviceWorker.ready.then(close).catch(() => {})
}

/**
 * 媒体权限失败要**说清是哪一种**。
 * 全是「打开麦克风失败」的话，用户既不知道能不能自救，也不知道该改哪。
 */
function mediaErrorText(error, media) {
  const device = media === 'video' ? '摄像头或麦克风' : '麦克风'
  switch (error?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return `${device}权限未开启，请在浏览器地址栏的权限设置里允许后重试`
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return `没有找到可用的${device}`
    case 'NotReadableError':
    case 'TrackStartError':
      return `${device}被其他程序占用（会议软件 / 相机），关掉后再试`
    case 'OverconstrainedError':
      return '摄像头不支持当前分辨率，已无法建立视频通话'
    default:
      return error?.message || `无法使用${device}`
  }
}

/** 视频通话的约束：720p 即可，再高只会让弱网更卡 */
function mediaConstraints(media, facing = 'user') {
  if (media !== 'video') return { audio: true, video: false }
  return {
    audio: true,
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
  }
}

export function VoiceCallProvider({ children }) {
  const { token } = useAuth()
  const { showToast } = useApp()
  const [call, setCallState] = useState(IDLE_CALL)
  const callRef = useRef(IDLE_CALL)
  const localStreamRef = useRef(null)
  const peerConnectionRef = useRef(null)
  const audioRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const localVideoRef = useRef(null)
  const ringTimerRef = useRef(null)
  const reconnectTimerRef = useRef(null)
  const socketConnectedRef = useRef(false)
  const callAcceptedRef = useRef(false)
  const queuedLocalCandidatesRef = useRef([])
  const queuedRemoteCandidatesRef = useRef([])

  const setCall = useCallback((next) => {
    const value = typeof next === 'function' ? next(callRef.current) : next
    callRef.current = value
    setCallState(value)
  }, [])

  const clearCall = useCallback(() => {
    clearTimeout(ringTimerRef.current)
    clearTimeout(reconnectTimerRef.current)
    ringTimerRef.current = null
    reconnectTimerRef.current = null
    callAcceptedRef.current = false
    queuedLocalCandidatesRef.current = []
    queuedRemoteCandidatesRef.current = []
    const pc = peerConnectionRef.current
    peerConnectionRef.current = null
    if (pc) {
      pc.ontrack = null
      pc.onicecandidate = null
      pc.onconnectionstatechange = null
      try { pc.close() } catch { /* already closed */ }
    }
    const stream = localStreamRef.current
    localStreamRef.current = null
    stream?.getTracks().forEach((track) => track.stop())
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    if (localVideoRef.current) localVideoRef.current.srcObject = null
    if (audioRef.current) audioRef.current.srcObject = null
    setCall(IDLE_CALL)
  }, [setCall])

  const emitForCall = useCallback((callId, type, extra = {}) => {
    const current = callRef.current
    if (!callId || current.callId !== callId) return false
    return sendChatSocketEvent(type, {
      callId,
      conversationId: current.conversationId,
      ...extra,
    })
  }, [])

  const flushRemoteCandidates = useCallback(async (pc) => {
    const candidates = queuedRemoteCandidatesRef.current.splice(0)
    for (const candidate of candidates) {
      try { await pc.addIceCandidate(candidate) } catch { /* stale or duplicate ICE candidate */ }
    }
  }, [])

  const createPeerConnection = useCallback(async (callId, stream) => {
    if (peerConnectionRef.current && callRef.current.callId === callId) return peerConnectionRef.current
    const { iceServers = [] } = await api.voiceCallIceConfig()
    if (callRef.current.callId !== callId) return null

    const pc = new RTCPeerConnection({ iceServers })
    peerConnectionRef.current = pc
    stream.getTracks().forEach((track) => pc.addTrack(track, stream))

    pc.onicecandidate = (event) => {
      if (!event.candidate || callRef.current.callId !== callId) return
      const candidate = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate
      if (!callAcceptedRef.current) queuedLocalCandidatesRef.current.push(candidate)
      else emitForCall(callId, 'call.ice', { candidate })
    }
    pc.ontrack = (event) => {
      if (callRef.current.callId !== callId) return
      const remoteStream = event.streams?.[0] || new MediaStream([event.track])
      setCall((current) => current.callId === callId ? { ...current, remoteStream, audioBlocked: false } : current)
    }
    pc.onconnectionstatechange = () => {
      if (callRef.current.callId !== callId) return
      const status = pc.connectionState || pc.iceConnectionState
      if (status === 'connected') {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
        setCall((current) => current.callId === callId
          ? { ...current, status: 'connected', startedAt: current.startedAt || Date.now() }
          : current)
      } else if (status === 'disconnected' || status === 'failed') {
        setCall((current) => current.callId === callId ? { ...current, status: 'reconnecting' } : current)
        if (!reconnectTimerRef.current) {
          reconnectTimerRef.current = setTimeout(() => {
            if (callRef.current.callId === callId) {
              emitForCall(callId, 'call.end')
              clearCall()
              showToast('网络连接中断，通话已结束')
            }
          }, 12_000)
        }
      }
    }
    return pc
  }, [clearCall, emitForCall, setCall, showToast])

  const startCall = useCallback(async ({ conversationId, peerId, peerName, avatar, media = 'audio' }) => {
    const kind = media === 'video' ? 'video' : 'audio'
    if (callRef.current.status !== 'idle') {
      showToast('当前已有一通通话')
      return
    }
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
      showToast('通话需要 HTTPS 安全连接')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast('当前浏览器不支持通话')
      return
    }
    if (typeof RTCPeerConnection === 'undefined') {
      showToast('当前浏览器不支持实时音视频连接')
      return
    }
    if (!socketConnectedRef.current) {
      showToast('实时连接中，请稍后再呼叫')
      return
    }

    const callId = globalThis.crypto?.randomUUID?.() || `call_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
    callAcceptedRef.current = false
    setCall({
      status: 'requesting',
      direction: 'outgoing',
      callId,
      conversationId: Number(conversationId),
      peerId: Number(peerId),
      peer: { id: peerId, name: peerName, avatar },
      media: kind,
      muted: false,
      videoOn: kind === 'video',
      facing: 'user',
      elapsedSec: 0,
      inviteSent: false,
    })
    try {
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(kind))
      if (callRef.current.callId !== callId) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      localStreamRef.current = stream
      setCall((current) => current.callId === callId ? { ...current, status: 'outgoing', localStream: stream } : current)
      const sent = sendChatSocketEvent('call.invite', { callId, conversationId: Number(conversationId), media: kind })
      if (!sent) {
        clearCall()
        showToast('实时连接已断开，请重新呼叫')
        return
      }
      setCall((current) => current.callId === callId ? { ...current, inviteSent: true } : current)
      ringTimerRef.current = setTimeout(() => {
        if (callRef.current.callId === callId && callRef.current.direction === 'outgoing') {
          clearCall()
          showToast('暂时无人接听')
        }
      }, RING_TIMEOUT_MS)
    } catch (error) {
      clearCall()
      showToast(mediaErrorText(error, kind))
    }
  }, [clearCall, setCall, showToast])

  const acceptCall = useCallback(async () => {
    const current = callRef.current
    if (current.status !== 'incoming') return
    if (!socketConnectedRef.current) {
      showToast('实时连接中，请稍后再接听')
      return
    }
    try {
      /* 接听时才开摄像头：振铃期间就打开，等于对方还没同意就被看着。 */
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(current.media, 'user'))
      if (callRef.current.callId !== current.callId) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      localStreamRef.current = stream
      setCall((value) => value.callId === current.callId
        ? { ...value, status: 'connecting', localStream: stream, videoOn: value.media === 'video' }
        : value)
      await createPeerConnection(current.callId, stream)
      if (callRef.current.callId !== current.callId || !emitForCall(current.callId, 'call.accept')) {
        clearCall()
        showToast('实时连接已断开，无法接听')
      }
    } catch (error) {
      if (callRef.current.callId === current.callId) {
        emitForCall(current.callId, 'call.reject')
        clearCall()
      }
      showToast(mediaErrorText(error, current.media))
    }
  }, [clearCall, createPeerConnection, emitForCall, setCall, showToast])

  const rejectCall = useCallback(() => {
    const current = callRef.current
    if (current.callId) {
      emitForCall(current.callId, 'call.reject')
      dismissCallNotification(current.callId)
    }
    clearCall()
  }, [clearCall, emitForCall])

  const endCall = useCallback(() => {
    const current = callRef.current
    if (current.callId && current.inviteSent) {
      const type = callAcceptedRef.current
        ? 'call.end'
        : current.direction === 'incoming'
          ? 'call.reject'
          : 'call.cancel'
      emitForCall(current.callId, type)
      dismissCallNotification(current.callId)
    }
    clearCall()
  }, [clearCall, emitForCall])

  const toggleMute = useCallback(() => {
    const current = callRef.current
    if (!current.localStream) return
    const muted = !current.muted
    current.localStream.getAudioTracks().forEach((track) => { track.enabled = !muted })
    setCall((value) => ({ ...value, muted }))
  }, [setCall])

  /** 关摄像头 ≠ 挂断：只是把视频轨静音，音频继续。 */
  const toggleCamera = useCallback(() => {
    const current = callRef.current
    if (current.media !== 'video' || !current.localStream) return
    const videoOn = !current.videoOn
    current.localStream.getVideoTracks().forEach((track) => { track.enabled = videoOn })
    setCall((value) => ({ ...value, videoOn }))
  }, [setCall])

  /** 切换前后摄：换轨而不是重连，replaceTrack 不会重新协商 SDP。 */
  const switchCamera = useCallback(async () => {
    const current = callRef.current
    if (current.media !== 'video' || !current.localStream) return
    const facing = current.facing === 'user' ? 'environment' : 'user'
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      const track = fresh.getVideoTracks()[0]
      if (!track) return
      const sender = peerConnectionRef.current?.getSenders().find((s) => s.track?.kind === 'video')
      if (sender) await sender.replaceTrack(track)
      /* 旧视频轨必须停掉，否则摄像头指示灯一直亮着 */
      current.localStream.getVideoTracks().forEach((old) => {
        if (old !== track) {
          old.stop()
          current.localStream.removeTrack(old)
        }
      })
      current.localStream.addTrack(track)
      track.enabled = current.videoOn
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = current.localStream
        void localVideoRef.current.play().catch(() => {})
      }
      setCall((value) => ({ ...value, facing, localStream: current.localStream }))
    } catch (error) {
      showToast(mediaErrorText(error, 'video'))
    }
  }, [setCall, showToast])

  const handleEvent = useCallback((event) => {
    const payload = event.payload || {}
    const current = callRef.current

    if (event.type === 'call.incoming') {
      if (current.callId === payload.callId) return
      if (Number(payload.expiresAt) && Number(payload.expiresAt) <= Date.now()) return
      if (current.status !== 'idle') {
        sendChatSocketEvent('call.reject', { callId: payload.callId, conversationId: payload.conversationId })
        return
      }
      callAcceptedRef.current = false
      const caller = payload.caller || {}
      const media = payload.media === 'video' ? 'video' : 'audio'
      setCall({
        status: 'incoming',
        direction: 'incoming',
        callId: payload.callId,
        conversationId: Number(payload.conversationId),
        peerId: Number(caller.id),
        peer: {
          id: caller.id,
          name: displayName(caller),
          avatar: String(caller.avatar || '').startsWith('/uploads/') ? caller.avatar : null,
        },
        media,
        muted: false,
        videoOn: false,
        facing: 'user',
        elapsedSec: 0,
        inviteSent: true,
      })
      const remaining = Number(payload.expiresAt)
        ? Math.max(1000, Math.min(RING_TIMEOUT_MS, Number(payload.expiresAt) - Date.now()))
        : RING_TIMEOUT_MS
      ringTimerRef.current = setTimeout(() => {
        if (callRef.current.callId === payload.callId) clearCall()
      }, remaining)
      return
    }

    if (!payload.callId || payload.callId !== current.callId) return

    switch (event.type) {
      case 'call.ringing':
        setCall((value) => ({ ...value, status: 'outgoing-ringing' }))
        break
      case 'call.accepted': {
        clearTimeout(ringTimerRef.current)
        ringTimerRef.current = null
        dismissCallNotification(payload.callId)
        // If another signed-in device answered, dismiss this device's incoming sheet.
        if (current.direction === 'incoming' && current.status === 'incoming') {
          clearCall()
          break
        }
        callAcceptedRef.current = true
        const queued = queuedLocalCandidatesRef.current.splice(0)
        for (const candidate of queued) emitForCall(payload.callId, 'call.ice', { candidate })
        setCall((value) => ({ ...value, status: value.status === 'connected' ? value.status : 'connecting' }))
        if (current.direction === 'outgoing') {
          void (async () => {
            try {
              const pc = await createPeerConnection(payload.callId, localStreamRef.current)
              if (!pc || callRef.current.callId !== payload.callId) return
              const offer = await pc.createOffer()
              await pc.setLocalDescription(offer)
              if (!emitForCall(payload.callId, 'call.offer', { description: pc.localDescription.toJSON?.() || pc.localDescription })) {
                throw new Error('通话信令连接已断开')
              }
            } catch (error) {
              if (callRef.current.callId === payload.callId) {
                emitForCall(payload.callId, 'call.end')
                clearCall()
                showToast(error?.message || '无法建立通话连接')
              }
            }
          })()
        }
        break
      }
      case 'call.offer':
        void (async () => {
          try {
            const pc = peerConnectionRef.current
            if (!pc) throw new Error('本地媒体未准备好')
            if (pc.remoteDescription) return
            await pc.setRemoteDescription(payload.description)
            await flushRemoteCandidates(pc)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            if (!emitForCall(payload.callId, 'call.answer', { description: pc.localDescription.toJSON?.() || pc.localDescription })) {
              throw new Error('通话信令连接已断开')
            }
          } catch (error) {
            if (callRef.current.callId === payload.callId) {
              emitForCall(payload.callId, 'call.end')
              clearCall()
              showToast(error?.message || '无法接通通话')
            }
          }
        })()
        break
      case 'call.answer':
        void (async () => {
          try {
            const pc = peerConnectionRef.current
            if (!pc) return
            if (pc.remoteDescription) return
            await pc.setRemoteDescription(payload.description)
            await flushRemoteCandidates(pc)
          } catch (error) {
            if (callRef.current.callId === payload.callId) {
              emitForCall(payload.callId, 'call.end')
              clearCall()
              showToast(error?.message || '通话连接失败')
            }
          }
        })()
        break
      case 'call.ice': {
        const pc = peerConnectionRef.current
        if (!pc || !pc.remoteDescription) queuedRemoteCandidatesRef.current.push(payload.candidate)
        else void pc.addIceCandidate(payload.candidate).catch(() => {})
        break
      }
      case 'call.rejected':
        dismissCallNotification(payload.callId)
        clearCall()
        if (current.direction === 'outgoing') showToast('对方暂时无法接听')
        break
      case 'call.cancelled':
        dismissCallNotification(payload.callId)
        clearCall()
        break
      case 'call.timeout':
        dismissCallNotification(payload.callId)
        clearCall()
        showToast('暂时无人接听')
        break
      case 'call.unavailable':
      case 'call.busy':
      case 'call.error':
        dismissCallNotification(payload.callId)
        clearCall()
        showToast(payload.message || (event.type === 'call.busy' ? '对方正在通话中' : '无法发起通话'))
        break
      case 'call.ended':
        dismissCallNotification(payload.callId)
        clearCall()
        if (payload.reason === 'disconnect') showToast('对方已断开通话')
        break
      default:
        break
    }
  }, [clearCall, createPeerConnection, emitForCall, flushRemoteCandidates, setCall, showToast])

  const socketConnected = useChatSocket(token, handleEvent)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined
    const onMessage = (event) => {
      if (event.data?.type === 'call.incoming') {
        handleEvent({ type: 'call.incoming', payload: event.data.payload || {} })
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [handleEvent])

  useEffect(() => {
    socketConnectedRef.current = socketConnected
  }, [socketConnected])

  useEffect(() => {
    if (call.status !== 'connected' || !call.startedAt) return undefined
    const update = () => setCall((current) => current.status === 'connected'
      ? { ...current, elapsedSec: Math.floor((Date.now() - current.startedAt) / 1000) }
      : current)
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [call.status, call.startedAt, setCall])

  /* 远端声音 / 画面：视频走 <video>（自带音轨），音频走隐藏的 <audio>。
     两者**不能同时绑同一个流** —— 会双声道叠加，听起来像回声。 */
  useEffect(() => {
    const remoteStream = call.remoteStream
    const video = remoteVideoRef.current
    const audio = audioRef.current
    const isVideo = call.media === 'video' && call.status !== 'incoming'
    const play = (el) => {
      if (!el) return
      el.srcObject = remoteStream || null
      if (!remoteStream) return
      el.play().then(() => setCall((current) => current.remoteStream === remoteStream
        ? { ...current, audioBlocked: false }
        : current)).catch(() => {
        setCall((current) => current.remoteStream === remoteStream
          ? { ...current, audioBlocked: true }
          : current)
      })
    }
    if (isVideo) {
      if (audio) audio.srcObject = null
      play(video)
    } else {
      if (video) video.srcObject = null
      play(audio)
    }
  }, [call.remoteStream, call.media, call.status, setCall])

  /* 本地预览：只在视频通话里显示，并且必须 muted —— 否则会听到自己的回声 */
  useEffect(() => {
    const el = localVideoRef.current
    if (!el) return
    el.srcObject = call.localStream || null
    if (call.localStream) void el.play().catch(() => {})
  }, [call.localStream, call.status, call.media])

  useEffect(() => {
    if (token) return
    if (callRef.current.status !== 'idle') clearCall()
  }, [token, clearCall])

  useEffect(() => () => {
    clearTimeout(ringTimerRef.current)
    clearTimeout(reconnectTimerRef.current)
    const pc = peerConnectionRef.current
    try { pc?.close() } catch { /* already closed */ }
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  const unlockAudio = () => {
    const el = call.media === 'video' ? remoteVideoRef.current : audioRef.current
    if (!el) return
    void el.play().then(() => setCall((current) => current.remoteStream
      ? { ...current, audioBlocked: false }
      : current)).catch(() => {})
  }

  const value = { call, startCall, acceptCall, rejectCall, endCall, toggleMute, toggleCamera, switchCamera }
  return (
    <VoiceCallContext.Provider value={value}>
      {children}
      {call.status !== 'idle' && (
        <VoiceCallOverlay
          call={call}
          onAccept={acceptCall}
          onReject={rejectCall}
          onEnd={endCall}
          onMute={toggleMute}
          onToggleCamera={toggleCamera}
          onSwitchCamera={switchCamera}
          onUnlockAudio={unlockAudio}
          remoteVideoRef={remoteVideoRef}
          localVideoRef={localVideoRef}
        />
      )}
      <audio ref={audioRef} className="voice-call-audio" autoPlay playsInline />
    </VoiceCallContext.Provider>
  )
}

function callStatusLabel(call) {
  const label = callMediaLabel(call.media)
  if (call.status === 'requesting') return call.media === 'video' ? '正在申请摄像头权限…' : '正在申请麦克风权限…'
  if (call.status === 'outgoing') return '正在呼叫…'
  if (call.status === 'outgoing-ringing') return '等待对方接听'
  if (call.status === 'incoming') return `邀请你进行${label}`
  if (call.status === 'connecting') return '正在接通…'
  if (call.status === 'reconnecting') return '网络波动，正在重连…'
  if (call.status === 'connected') return `${label}中 · ${elapsedLabel(call.elapsedSec)}`
  return ''
}

function VoiceCallOverlay({ call, onAccept, onReject, onEnd, onMute, onToggleCamera, onSwitchCamera, onUnlockAudio, remoteVideoRef, localVideoRef }) {
  const incoming = call.status === 'incoming'
  const connected = call.status === 'connected' || call.status === 'reconnecting'
  const name = displayName(call.peer)
  const label = callMediaLabel(call.media)
  /* 视频层只在「已经接通等待媒体」或「通话中」出现。
     振铃阶段（尤其是来电）仍然用卡片：那时本地摄像头还没开，铺一块黑屏只会让人以为坏了。 */
  const videoMode = call.media === 'video' && !incoming && call.status !== 'requesting'

  if (videoMode) {
    return (
      <div className="voice-call-backdrop is-video" role="presentation">
        <section className="vc-video" role="dialog" aria-modal="true" aria-label={`${name}的${label}`}>
          <video ref={remoteVideoRef} className="vc-video-remote" autoPlay playsInline />
          <div className="vc-video-shade" aria-hidden="true" />

          <header className="vc-video-head">
            <b>{name}</b>
            <span aria-live="polite">{callStatusLabel(call)}</span>
          </header>

          {call.localStream && (
            <video
              ref={localVideoRef}
              className={`vc-video-local ${call.videoOn ? '' : 'is-off'}`}
              autoPlay
              muted
              playsInline
            />
          )}

          {!call.videoOn && (
            <span className="vc-video-cam-off"><IconVideoOff size={14} /> 摄像头已关闭</span>
          )}

          {call.audioBlocked && call.remoteStream && (
            <button type="button" className="voice-call-audio-unlock" onClick={onUnlockAudio}>点击开启通话声音</button>
          )}

          <div className="vc-video-actions">
            <button type="button" className={`voice-call-action is-mute ${call.muted ? 'is-muted' : ''}`} onClick={onMute} aria-label={call.muted ? '取消静音' : '静音麦克风'}><IconMic size={23} /></button>
            <button type="button" className={`voice-call-action is-mute ${call.videoOn ? '' : 'is-muted'}`} onClick={onToggleCamera} aria-label={call.videoOn ? '关闭摄像头' : '打开摄像头'}>
              {call.videoOn ? <IconVideo size={23} /> : <IconVideoOff size={23} />}
            </button>
            <button type="button" className="voice-call-action is-mute" onClick={onSwitchCamera} aria-label="切换前后摄像头"><IconSwitchCamera size={23} /></button>
            <button type="button" className="voice-call-action is-reject" onClick={onEnd} aria-label="结束通话"><IconPhone size={23} className="is-hangup" /></button>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="voice-call-backdrop" role="presentation">
      <section className={`voice-call-card ${incoming ? 'is-incoming' : ''} ${connected ? 'is-active' : ''}`} role="dialog" aria-modal="true" aria-label={`${name}的${label}`}>
        <div className="voice-call-wave" aria-hidden="true"><i /><i /><i /></div>
        <Avatar src={call.peer?.avatar} name={name} size={88} radius={30} />
        <h2>{name}</h2>
        <p className="voice-call-status" aria-live="polite">{callStatusLabel(call)}</p>
        {call.audioBlocked && call.remoteStream && (
          <button type="button" className="voice-call-audio-unlock" onClick={onUnlockAudio}>点击开启通话声音</button>
        )}
        {incoming ? (
          <div className="voice-call-actions">
            <button type="button" className="voice-call-action is-reject" onClick={onReject} aria-label="拒绝通话"><IconClose size={24} /></button>
            <button type="button" className="voice-call-action is-accept" onClick={onAccept} aria-label={`接听${label}`}>{call.media === 'video' ? <IconVideo size={23} /> : <IconPhone size={23} />}</button>
          </div>
        ) : connected ? (
          <div className="voice-call-actions">
            <button type="button" className={`voice-call-action is-mute ${call.muted ? 'is-muted' : ''}`} onClick={onMute} aria-label={call.muted ? '取消静音' : '静音麦克风'}><IconMic size={23} /></button>
            <button type="button" className="voice-call-action is-reject" onClick={onEnd} aria-label="结束通话"><IconPhone size={23} className="is-hangup" /></button>
          </div>
        ) : (
          <div className="voice-call-actions">
            <button type="button" className="voice-call-action is-reject" onClick={onEnd} aria-label="取消通话"><IconPhone size={23} className="is-hangup" /></button>
          </div>
        )}
      </section>
    </div>
  )
}

export function useVoiceCall() {
  const value = useContext(VoiceCallContext)
  if (!value) throw new Error('useVoiceCall must be used within VoiceCallProvider')
  return value
}
