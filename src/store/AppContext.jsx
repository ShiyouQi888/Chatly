/** App-wide UI state. Server-backed domain data lives in its dedicated stores. */
import React, { createContext, useCallback, useContext, useMemo, useReducer, useState } from 'react'

const AppCtx = createContext(null)

function reducer(state, action) {
  if (action.type === 'SET_TAB') return { ...state, tab: action.tab }
  return state
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, { tab: 'chat' })
  const [toast, setToast] = useState('')

  const showToast = useCallback((text) => {
    setToast(text)
    window.clearTimeout(showToast._t)
    showToast._t = window.setTimeout(() => setToast(''), 1600)
  }, [])

  const value = useMemo(() => ({ ...state, dispatch, toast, showToast }), [state, toast, showToast])
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>
}

export function useApp() {
  const ctx = useContext(AppCtx)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
