import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import { AuthProvider } from './store/AuthContext.jsx'
import { AppProvider } from './store/AppContext.jsx'
import { ChatProvider } from './store/ChatStore.jsx'
import { MomentProvider } from './store/MomentStore.jsx'
import { DiscoverProvider } from './store/DiscoverStore.jsx'
import { FavoriteProvider } from './store/FavoriteStore.jsx'
import { WatchLaterProvider } from './store/WatchLaterStore.jsx'
import { NotificationProvider } from './store/NotificationStore.jsx'
import Phone from './components/Phone.jsx'
import AdminConsole from './screens/AdminConsole.jsx'
import { applySavedAppearance, applySavedTheme } from './utils/theme.js'
import { THEMES } from './data/themes.js'

/* 整站入口恢复外观：字体 + 主题。
 * 不能只靠 MeTab 里的恢复 —— 用户可能一次都不进「我」页，
 * 那样刷新后首页还是默认紫，主题开关就是点了没反应。 */
applySavedAppearance()
applySavedTheme(THEMES)

/*
 * Provider 顺序：
 *   AuthProvider   —— 提供 user / token，其余各层都依赖它
 *   AppProvider    —— 原型通知与 Tab；状态由 StatusStories 走后端 API
 *   ChatProvider   —— 真实聊天数据（依赖 token 才能连 WS）
 *   MomentProvider —— 真实动态数据（依赖 user 才知道「哪些是我的」）
 *   DiscoverProvider —— 真实发现页数据（推荐 / 附近 / 标签 / 群；依赖 user 才算得出「共同」）
 *   FavoriteProvider —— 消息收藏（聊天页与我页共用；依赖 user 才有「我的收藏」）
 *   WatchLaterProvider —— 稍后看（聊天页长按菜单添加，我页查看列表）
 *   NotificationProvider —— 互动通知（通知中心 / 消息通知设置 / WS 推送与提醒；依赖 user 才知道给谁）
 */
const pathname = window.location.pathname.replace(/\/+$/, '') || '/'
const isAdmin = pathname === '/qishiyou' || pathname === '/admin'
document.documentElement.dataset.app = isAdmin ? 'admin' : 'chat'
if (pathname === '/admin') window.history.replaceState(null, '', '/qishiyou')
if (isAdmin) document.title = 'Chatly · 运营管理后台'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isAdmin ? <AdminConsole /> : <AuthProvider>
      <AppProvider>
        <ChatProvider>
          <MomentProvider>
            <DiscoverProvider>
              <FavoriteProvider>
                <WatchLaterProvider>
                  <NotificationProvider>
                    <Phone />
                  </NotificationProvider>
                </WatchLaterProvider>
              </FavoriteProvider>
            </DiscoverProvider>
          </MomentProvider>
        </ChatProvider>
      </AppProvider>
    </AuthProvider>}
  </React.StrictMode>
)
