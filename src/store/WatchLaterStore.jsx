import React, { createContext, useContext, useReducer, useCallback } from 'react'
import { api } from '../api/client.js'

const WatchLaterContext = createContext(null)

const initialState = {
  list: [],
  loading: false,
  error: '',
  hasMore: true,
}

function reducer(state, action) {
  switch (action.type) {
    case 'LOADING':
      return { ...state, loading: true, error: '' }
    case 'LOADED':
      return {
        ...state,
        loading: false,
        list: action.list,
        hasMore: action.hasMore,
      }
    case 'APPEND':
      return {
        ...state,
        loading: false,
        list: [...state.list, ...action.list],
        hasMore: action.hasMore,
      }
    case 'ADDED':
      return { ...state, list: [action.item, ...state.list] }
    case 'REMOVED':
      return { ...state, list: state.list.filter((x) => x.id !== action.id) }
    case 'ERROR':
      return { ...state, loading: false, error: action.error }
    case 'CLEAR':
      return initialState
    default:
      return state
  }
}

export function WatchLaterProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState)

  const loadWatchLater = useCallback(async ({ append = false } = {}) => {
    dispatch({ type: 'LOADING' })
    try {
      const beforeId = append && state.list.length ? state.list[state.list.length - 1].id : undefined
      const data = await api.watchLater({ beforeId, limit: 20 })
      dispatch({
        type: append ? 'APPEND' : 'LOADED',
        list: data.items || [],
        hasMore: data.hasMore,
      })
    } catch (err) {
      dispatch({ type: 'ERROR', error: err.message })
    }
  }, [state.list])

  const addToWatchLater = useCallback(async (messageId, conversationId) => {
    try {
      const data = await api.addToWatchLater(messageId, conversationId)
      if (data.created) {
        dispatch({
          type: 'ADDED',
          item: {
            id: data.id,
            messageId,
            conversationId,
            createdAt: Date.now(),
          },
        })
      }
      return data
    } catch (err) {
      throw err
    }
  }, [])

  const removeFromWatchLater = useCallback(async (id) => {
    try {
      await api.removeFromWatchLater(id)
      dispatch({ type: 'REMOVED', id })
    } catch (err) {
      throw err
    }
  }, [])

  const removeByMessage = useCallback(async (messageId) => {
    try {
      await api.removeByMessageFromWatchLater(messageId)
      dispatch({ type: 'REMOVED', id: messageId })
    } catch (err) {
      throw err
    }
  }, [])

  const clearWatchLater = useCallback(() => {
    dispatch({ type: 'CLEAR' })
  }, [])

  return (
    <WatchLaterContext.Provider
      value={{
        ...state,
        loadWatchLater,
        addToWatchLater,
        removeFromWatchLater,
        removeByMessage,
        clearWatchLater,
      }}
    >
      {children}
    </WatchLaterContext.Provider>
  )
}

export function useWatchLater() {
  const ctx = useContext(WatchLaterContext)
  if (!ctx) throw new Error('useWatchLater must be used within WatchLaterProvider')
  return ctx
}
