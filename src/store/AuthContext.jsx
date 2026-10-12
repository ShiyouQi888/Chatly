/**
 * 认证状态：登录 / 注册 / 登出 / 启动时用已存 token 恢复会话
 *
 * 注意：token 同时供 REST（Authorization 头）与 WS（query 参数）使用，
 * 因此登录成功后必须先写入 localStorage，再置 user —— 否则 ChatProvider
 * 拿到 user 去连 WS 时读不到 token。
 */
import React, { createContext, useContext, useCallback, useEffect, useMemo, useState } from 'react'
import { api, tokenStore } from '../api/client.js'

const AuthCtx = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(() => tokenStore.get())
  const [ready, setReady] = useState(false)

  /* 启动：有 token 就换取当前用户，失效则清掉 */
  useEffect(() => {
    let alive = true
    const t = tokenStore.get()
    if (!t) {
      setReady(true)
      return
    }
    api
      .me()
      .then(({ user: u }) => {
        if (!alive) return
        setUser(u)
        setToken(t)
      })
      .catch(() => {
        if (!alive) return
        tokenStore.clear()
        setToken(null)
      })
      .finally(() => alive && setReady(true))

    return () => {
      alive = false
    }
  }, [])

  const login = useCallback(async ({ type = 'login', username, password, nickname } = {}) => {
    const out =
      type === 'register'
        ? await api.register(username, password, nickname)
        : await api.login(username, password)

    if (!out?.token) throw new Error('服务端未返回 token')
    tokenStore.set(out.token)
    setToken(out.token)
    setUser(out.user)
    return out.user
  }, [])

  const logout = useCallback(() => {
    tokenStore.clear()
    setToken(null)
    setUser(null)
  }, [])

  /* ---------- 资料 ---------- */
  /* 都以后端返回的 user 为准回写本地，不在前端拼结果 ——
     否则「前端乐观更新 + 后端做了裁剪/归一化」会让两边长期不一致 */
  const updateProfile = useCallback(async (fields) => {
    const { user: u } = await api.updateProfile(fields)
    setUser(u)
    return u
  }, [])

  const uploadAvatar = useCallback(async (file) => {
    const { user: u, url } = await api.uploadAvatar(file)
    setUser(u)
    return { user: u, url }
  }, [])

  /** 让别处（如 WS 推来的资料变更）也能刷新当前用户 */
  const applyUser = useCallback((u) => {
    if (u?.id) setUser((prev) => (prev && prev.id === u.id ? { ...prev, ...u } : prev))
  }, [])

  const value = useMemo(
    () => ({ user, token, ready, login, logout, updateProfile, uploadAvatar, applyUser }),
    [user, token, ready, login, logout, updateProfile, uploadAvatar, applyUser]
  )

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
