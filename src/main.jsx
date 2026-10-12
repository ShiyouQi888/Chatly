import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import { AuthProvider } from './store/AuthContext.jsx'
import { AppProvider } from './store/AppContext.jsx'
import { ChatProvider } from './store/ChatStore.jsx'
import { MomentProvider } from './store/MomentStore.jsx'
import { DiscoverProvider } from './store/DiscoverStore.jsx'
import { FavoriteProvider } from './store/FavoriteStore.jsx'
import Phone from './components/Phone.jsx'

/*
 * Provider 顺序：
 *   AuthProvider   —— 提供 user / token，其余各层都依赖它
 *   AppProvider    —— 原型数据（通知 / 状态 / Tab）
 *   ChatProvider   —— 真实聊天数据（依赖 token 才能连 WS）
 *   MomentProvider —— 真实动态数据（依赖 user 才知道「哪些是我的」）
 *   DiscoverProvider —— 真实发现页数据（推荐 / 附近 / 标签 / 群；依赖 user 才算得出「共同」）
 *   FavoriteProvider —— 消息收藏（聊天页与我页共用；依赖 user 才有「我的收藏」）
 */
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AppProvider>
        <ChatProvider>
          <MomentProvider>
            <DiscoverProvider>
              <FavoriteProvider>
                <Phone />
              </FavoriteProvider>
            </DiscoverProvider>
          </MomentProvider>
        </ChatProvider>
      </AppProvider>
    </AuthProvider>
  </React.StrictMode>
)
