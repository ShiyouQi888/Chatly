import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import { AuthProvider } from './store/AuthContext.jsx'
import { AppProvider } from './store/AppContext.jsx'
import { ChatProvider } from './store/ChatStore.jsx'
import { VoiceCallProvider } from './store/VoiceCallStore.jsx'
import { MomentProvider } from './store/MomentStore.jsx'
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
 *   FavoriteProvider —— 消息收藏（聊天页与我页共用；依赖 user 才有「我的收藏」）
 *   WatchLaterProvider —— 稍后看（聊天页长按菜单添加，我页查看列表）
 *   NotificationProvider —— 互动通知（通知中心 / 消息通知设置 / WS 推送与提醒；依赖 user 才知道给谁）
 */
const rawPathname = window.location.pathname
const pathname = rawPathname.replace(/(?:%60|`)+$/gi, '').replace(/\/+$/, '') || '/'
const isAdmin = pathname === '/qishiyou' || pathname === '/admin'
document.documentElement.dataset.app = isAdmin ? 'admin' : 'chat'
if (isAdmin && rawPathname !== pathname) window.history.replaceState(null, '', `${pathname}${window.location.search}${window.location.hash}`)
if (pathname === '/admin') window.history.replaceState(null, '', '/qishiyou')
if (isAdmin) document.title = 'Chatly · 运营管理后台'

/* Service Worker 必须在**启动时**注册，不能等用户点进「消息通知」才注册 ——
   注册本身不申请任何权限，但没注册就收不到来电与新消息的 Web Push。
   以前只在通知设置页里注册，结果是「没打开过那一页的用户永远收不到推送」。

   不挂 `load` 事件：模块脚本本身就在 load 之前执行，挂上去只是多一层时序依赖；
   注册是异步的，不会拖慢首屏。失败要打出来 —— 静默 catch 会让「为什么没有通知」
   变成一个查不到原因的问题。 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
    console.warn('[sw] 注册失败（推送与离线通知不可用）：', error?.message || error)
  })
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isAdmin ? <AdminConsole /> : <AuthProvider>
      <AppProvider>
        <ChatProvider>
          <VoiceCallProvider>
            <MomentProvider>
              <FavoriteProvider>
                <WatchLaterProvider>
                  <NotificationProvider>
                    <Phone />
                  </NotificationProvider>
                </WatchLaterProvider>
              </FavoriteProvider>
            </MomentProvider>
          </VoiceCallProvider>
        </ChatProvider>
      </AppProvider>
    </AuthProvider>}
  </React.StrictMode>
)
