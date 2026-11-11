# Chatly · 多端一体化架构规划

> 目标：**一套核心代码，四种运行外壳**（Web/PWA、iOS、Android、桌面端），
> 同一账号在任意端登录，消息、已读、通话、推送状态全局一致。
>
> 本文是对 2026-11-11 项目现状审计后的规划结论，**不含已实施的代码改动**，
> 每一条待办都标了它在现有代码里的确切落点。

---

## 目录

- [一、现状审计：已经有什么、缺什么](#一现状审计已经有什么缺什么)
- [二、核心结论：为什么是「共享核心 + 外壳」](#二核心结论为什么是共享核心--外壳)
- [三、四端外壳选型](#三四端外壳选型)
- [四、平台适配层：需要抽出的接口清单](#四平台适配层需要抽出的接口清单)
- [五、后端需补的多端能力](#五后端需补的多端能力)
- [六、分阶段路线图](#六分阶段路线图)
- [七、风险与红线](#七风险与红线)
- [八、本机工具链现状](#八本机工具链现状)

---

## 一、现状审计：已经有什么、缺什么

### 1.1 代码规模（实测）

| 层 | 规模 | 位置 |
|---|---|---|
| 前端业务 JSX/JS | 18,170 行 / 76 个文件 | `src/screens` `src/components` `src/store` `src/hooks` `src/lib` |
| CSS | 12,556 行 | `src/screens/*.css` `src/components/*.css` `src/styles/*.css` |
| 后端 | 11,199 行 | `server/src` |

**关键结构特征：**

- **纯 JS + JSX，零 TypeScript**（`jsconfig.json` 而非 `tsconfig.json`）
- **业务页几乎不用 Tailwind utility**——实测 `src/screens` + `src/components` 里匹配
  `flex|text-|bg-|p-[0-9]` 的 className 数量为 **0**；
  Tailwind 只在运营后台（`admin-tailwind.css`）启用。
  真正的样式系统是 **12.5k 行手写 CSS + `tokens.css` 变量**。
- **无路由库**（未装 react-router）。导航靠 `AppContext` 的 `tab` 状态 +
  `Phone.jsx` 里的 `openChatId / openNotice / openSearch / openScan` 四个布尔量。
- **UI 外壳是「舞台 + 手机」结构**：`phone.css` 里 `.stage` 居中 + `.phone` 固定 390px，
  `@media (max-width: 440px)` 才铺满。**桌面端看到的是一个居中的手机模型**，不是多栏布局。

### 1.2 已经具备的多端友好资产

这些**不需要重做**，是规划能成立的基础：

| 资产 | 证据 | 多端价值 |
|---|---|---|
| 设备表 | `user_devices(user_id, device_name, device_type, session_id, last_active)` | 多端登录的基础，已有远程踢出（`revokeDeviceSockets`） |
| 设备类型识别 | `routes/auth.js:191` 按 UA 判 `mobile`/`desktop` | 桌面端上报 `device_type='desktop'` 已通 |
| WS 按设备绑定 | `ws.js` 里 `ws.deviceId = session.id` | 一台设备一连接，天然支持多端并行在线 |
| 多端在线状态 | `online` 是 `Map<userId, Set<ws>>`——**一个用户多个连接** | 多端同时在线已支持，不用改结构 |
| 广播到全部连接 | `broadcastToUser` 遍历该用户所有 ws | 消息能同时落到手机和电脑 |
| Web Push | VAPID + `web_push_subscriptions` | Web/PWA 端推送已通，是原生推送的对照实现 |
| 无状态设计令牌 | `tokens.css` 全部 CSS 变量 | 换壳不换皮，四端视觉零漂移 |
| 双驱动数据层 | `q` / `tx` 门面 + SQLite/PG | 多实例部署时切 PG 即可 |
| Redis 跨实例广播 | `publishTo` + origin 去重 | 多后端实例下多端同步已就绪 |

### 1.3 缺口清单（按阻断程度排序）

| # | 缺口 | 现状证据 | 阻断哪一端 |
|---|---|---|---|
| **G1** | **推送订阅未绑定设备** | `push.js` 的 `web_push_subscriptions` 无 `device_id`；`message-push.js:117` 用 `isOnlineAnywhere(userId)` 一刀切 | 多端推送必错：任一端在线 → 其它端全不推 |
| **G2** | **API base 是相对路径** | `client.js:7` `const BASE = '/api/v1'` | 原生壳内 `/api/v1` 指向本地文件，必须改绝对地址 |
| **G3** | **无本地持久化** | 全项目零 `indexedDB`；`GeneralSettings.jsx:51` 的「缓存大小」是简化注释 | 原生端每次冷启动全部重拉；无离线消息 |
| **G4** | **上传落本地磁盘** | `upload.js:20` `path.join(__dirname, '..', 'uploads')` | 多实例部署时 A 传的图 B 拿不到；需对象存储 |
| **G5** | **无路由/深链** | 无 react-router，导航是组件内布尔状态 | 原生壳无法被系统通知/分享/深链直接唤起到某会话 |
| **G6** | **浏览器 API 硬依赖** | `navigator.mediaDevices`（`ChatRoom.jsx:1627`）、`navigator.clipboard`、`navigator.geolocation`（`lib/geo.js`）、`navigator.serviceWorker`（`main.jsx:48`） | 原生壳需逐个换实现或做桥接 |
| **G7** | **UI 是单栏手机模型** | `phone.css` 固定 390px 居中 | 桌面端需三栏（会话列表 / 聊天 / 侧栏），需重做布局壳 |
| **G8** | **无端侧消息序号** | `messages.id` 是全局自增，跨会话混编；`listMessages` 只支持 `beforeId` 向前翻 | 多端增量同步缺「取回 id > N」的入口 |
| **G9** | **已读状态是会话级** | `conversation_members.last_read_message_id` | A 端读了，B 端立刻变已读——多端语义需明确（见 5.3） |
| **G10** | **无端到端加密** | `message-crypto.js` 是**服务端全局密钥** AES-256-GCM | 多端共享密钥可接受；但不是真 E2EE，密钥下发是单点 |
| **G11** | **通话仅 1v1 且信令绑单连接** | `ws.js` 的 `call.*` 走当前 socket | 多端同时在线时，来电该响铃哪端未定 |

---

## 二、核心结论：为什么是「共享核心 + 外壳」

### 2.1 三条路线的对比

| 路线 | 做法 | 现有代码复用 | 代价 | 结论 |
|---|---|---|---|---|
| **A. 共享核心 + 外壳** | 抽适配层，Web/PWA + Capacitor + Tauri 各包一层壳 | **~90%** | 需重构浏览器 API 调用点 | ✅ **采纳** |
| **B. 全量重写 React Native** | RN 重写 18k 行 JSX + 12.5k 行 CSS | ~15% | CSS 全部作废重写 | ❌ 成本失控 |
| **C. 每端独立开发** | iOS 写 Swift、Android 写 Kotlin、桌面写 Electron | ~0% | 三倍维护、三套 UI 不一致 | ❌ 就是已删掉的 `ChatlyApp` 走的路 |

**B/C 已被历史验证失败**：仓库里的 `ChatlyApp`（Kotlin + Jetpack Compose）就是路线 C 的产物——
它把「发现页」「聊天列表」等页面重写了一遍，最终因与 Web 端 UI/逻辑双轨、无法同步维护而被整体删除。
**这个教训直接决定了本规划的核心判断：Chatly 的多端化必须是「一次编写」，不能是「多次实现」。**

### 2.2 分层架构

```
┌─ 外壳层 Shell ────────────────────────────────────────────┐
│  Web/PWA          iOS(Capacitor)      Android(Capacitor)   桌面(Tauri) │
│  现有 dist        原生壳 + 插件        原生壳 + 插件        系统 WebView │
└───────────────────────────┬───────────────────────────────┘
                            │  只依赖下面这一层
┌─ 适配层 Adapter ──────────────────────────────────────────┐
│  storage · push · media · clipboard · geo · haptics        │
│  share · deepLink · camera · network · secureStore        │
│  每项：web 实现 / native 实现，接口一致                    │
└───────────────────────────┬───────────────────────────────┘
                            │
┌─ 共享核心 Shared Core ────────────────────────────────────┐
│  18k 行 JSX + 12.5k 行 CSS + tokens.css + 8 个 Store       │
│  API Client · WS 单例 · 业务规则 · 消息分组算法 · 通话文案   │
└───────────────────────────┬───────────────────────────────┘
                            │
┌─ 服务端 Server ───────────────────────────────────────────┐
│  Express 5 + ws · SQLite/PG 双驱动 · Redis · Web Push      │
│  【需补】设备级推送路由 · 增量同步 · 对象存储 · 深链路由    │
└───────────────────────────────────────────────────────────┘
```

**为什么适配层是整件事的成败关键**：现有代码里浏览器 API 是**散点直调**的
（`navigator.mediaDevices` 在 `ChatRoom.jsx`、`navigator.clipboard` 在 `ChatRoom.jsx` 与 `MyQrPage.jsx`、
`navigator.geolocation` 在 `lib/geo.js`、`localStorage` 在 `client.js` 与 `theme.js`）。
如果不先收口成适配层，外壳每加一个就要去 30+ 个文件里找 `navigator.` 打补丁——那就不是「一次编写」了。

---

## 三、四端外壳选型

### 3.1 结论

| 端 | 外壳 | 版本 | 理由 |
|---|---|---|---|
| **Web / PWA** | 现有 Vite 5 | — | 已可用，PWA 安装 + Web Push 已通，零改造 |
| **iOS** | **Capacitor 8** | `@capacitor/core@^8.5.3` | 复用同一份 `dist/`，WKWebView；官方 Push/Camera/Geolocation 插件齐全 |
| **Android** | **Capacitor 8** | `@capacitor/android@^8.5.3` | 同上；**本机已有 JDK 21 + Android SDK，可直接出 APK** |
| **桌面** | **Tauri 2** | `tauri@^2.11` | 复用同一份 `dist/`，复用系统 WebView（不打包 Chromium），安装包个位数 MB；**本机已有 Rust 1.91** |

### 3.2 为什么是 Capacitor 而不是 React Native

| 维度 | Capacitor 8 | React Native / Expo |
|---|---|---|
| 现有 12.5k 行 CSS 复用 | **100%**（WebView 直接跑） | ~0%（CSS 全部作废，需 StyleSheet 重写） |
| 现有 18k 行 JSX 复用 | **~95%** | 需换组件体系（DOM → Native） |
| 官方推送插件 | `@capacitor/push-notifications`（APNs/FCM） | Expo Notifications（也支持，但需重写 UI） |
| 相机/相册/剪贴板/定位 | 官方插件齐备 | 需 expo-* 第三方包 |
| 安装包体积 | 约 10–20 MB（+系统 WebView） | 约 30–60 MB |
| 学习/迁移成本 | **低**（就是写 Web） | 高（两套 UI 范式） |

**判据**：Chatly 的界面是「重排版、重手势、轻原生控件」的形态（聊天气泡、表情面板、消息分组、拖拽滚动），
这类 UI 在 WebView 里表现良好；而「相机扫码」「推送」这类原生能力用插件解决即可。
选 RN 要付出的是**把 12.5k 行精心调过的 CSS 全部推倒**，收益只是「更原生」，不划算。

### 3.3 为什么桌面端是 Tauri 而不是 Electron

- 复用系统 WebView（Windows 用 WebView2，macOS 用 WKWebView），不打包 Chromium → 安装包 ~5 MB vs Electron ~100 MB
- 内存占用 30–100 MB vs 150–400 MB
- 前端零改动：Electron 的 `ipcMain` / `webFrame` 换成 Tauri 的 `invoke` / `listen` 即可

⚠️ **代价必须说清**：Tauri 三端是**三种不同 WebView 引擎**（Chromium / WebKit / WebKitGTK），
CSS 兼容性坑比 Electron 多。Chatly 现在用了大量 `backdrop-filter`、`dvh`、`env(safe-area-inset-*)`，
这些在 WebKitGTK 上表现可能与 Chromium 不一致。**缓解措施**：桌面端外壳先只发 Windows + macOS，
Linux 延后；并在 `check-align` / `check-narrow` 之外补一条 WebKit 兼容性清单。

---

## 四、平台适配层：需要抽出的接口清单

### 4.1 接口总表

新目录 `src/platform/`，每项导出统一接口，`index.js` 按运行环境自动选择实现：

```js
// src/platform/index.js —— 运行时探测，选实现
import { isNative, isIOS, isAndroid, isDesktop } from './env.js'
export * from './storage.js'
export * from './push.js'
export * from './media.js'
export * from './clipboard.js'
export * from './geo.js'
export * from './haptics.js'
export * from './share.js'
export * from './deepLink.js'
```

### 4.2 逐项接口与现有调用点

| 接口 | web 实现 | native 实现 | 现有调用点（需改造） |
|---|---|---|---|
| `storage` | `localStorage` | `@capacitor/preferences`（敏感项用 SecureStorage） | `client.js:10-21`、`theme.js` |
| `push` | Service Worker + VAPID | `@capacitor/push-notifications`（APNs/FCM） | `NotificationSettings.jsx:63`、`main.jsx:48`、`public/sw.js` |
| `media` | `navigator.mediaDevices` + `MediaRecorder` | 同（Capacitor WebView 已支持）+ 权限插件 | `ChatRoom.jsx:1627-1633` |
| `clipboard` | `navigator.clipboard` | `@capacitor/clipboard` | `ChatRoom.jsx:1797`、`MyQrPage.jsx:194` |
| `geo` | `navigator.geolocation` | `@capacitor/geolocation` | `lib/geo.js:99-122` |
| `haptics` | `navigator.vibrate` | `@capacitor/haptics` | `useLongPress.js:76` |
| `share` | `navigator.share` | `@capacitor/share` | 新增（分享聊天记录） |
| `deepLink` | `?conv=` URL 参数（现有） | `app://` 协议 + `App.addListener('appUrlOpen')` | `Phone.jsx:103`（已有雏形） |
| `filePick` | `<input type=file>` | `@capacitor/camera` / 文件选择器 | 聊天图片/视频选择处 |

### 4.3 API base 的多端解析（对应 G2）

```js
// src/api/client.js
const BASE = resolveApiBase()

function resolveApiBase() {
  // ① 运行时注入（原生壳与部署时写入 window.__CHATLY_CONFIG__）
  const injected = window.__CHATLY_CONFIG__?.apiBase
  if (injected) return injected
  // ② 构建期环境变量（Docker 部署时用 VITE_API_BASE 覆盖）
  const env = import.meta.env?.VITE_API_BASE
  if (env) return env
  // ③ 默认走同源代理（本地开发 / Web 部署）
  return '/api/v1'
}
```

配套：`vite.config.js` 现有代理在原生壳里无效（壳内没有 dev server），
需在 `capacitor.config.ts` 里把 `server.url` 指向真实后端，且**生产必须用 HTTPS**
（`getUserMedia` 与 `Push API` 都要求安全上下文）。

### 4.4 UI 外壳的多形态化（对应 G7）

现有 `.stage > .phone` 单栏模型要拆成三套：

| 形态 | 断点 | 布局 |
|---|---|---|
| 移动竖屏 | `< 640px` | 现状（单栏 + 底部 Tab） |
| 平板 | `640–1024px` | 双栏：会话列表 \| 聊天区 |
| 桌面 | `> 1024px` | 三栏：侧导航 \| 会话列表 \| 聊天区 + 右侧详情 |

**这是纯 CSS + 少量 JS 结构改动**，不动业务组件。
关键点：`Phone.jsx` 现在是「所有页面渲染在一个 390px 容器里」，
需要把外层容器抽成 `AppShell.jsx`，按断点切换栅格；`Phone` 组件内的 `tab` / `openChatId` 状态机不变。

---

## 五、后端需补的多端能力

### 5.1 设备级推送路由（对应 G1）—— **最高优先级**

**现状缺陷**：`message-push.js:117`
```js
if (await isOnlineAnywhere(userId)) return   // 任一端在线 → 所有端都不推
```
用户在电脑上挂着窗口，手机就收不到推送——这在多端场景是**错误行为**。

**正确语义**（WhatsApp/Signal 的做法）：
> 对用户 N 的每个已注册推送订阅 S：
> 若 **S 所属设备当前无活跃 WS 连接** → 推给 S；
> 若 S 所属设备在线 → 不推给 S（它自己会收到 WS 实时消息）。

**改动清单：**

1. `web_push_subscriptions` 加 `device_id INTEGER REFERENCES user_devices(id) ON DELETE CASCADE`
   （SQLite/PG 双驱动都要走 `addColumnIfMissing` 模式）
2. 订阅时带上 `deviceId`（`req.deviceId` 已在 `authRequired` 中解析出）
3. 新增 `push_targets(user_id, device_id, endpoint, provider, platform, created_at)`
   —— `provider` 区分 `web` / `apns` / `fcm`，为原生推送留位
4. `isOnlineAnywhere(userId)` → `onlineDeviceIds(userId)`：返回该用户**在线设备 id 集合**
   （`online` map 里每个 ws 都带 `deviceId`，直接聚合即可，**数据结构不用改**）
5. 推送循环改为逐订阅判定

**注意**：`ws.js` 里 `online` 是 `Map<userId, Set<ws>>`，ws 上有 `ws.deviceId`，
所以「哪些设备在线」这个信息**现在就有**，只是没被推送逻辑用上。改动比想象中小。

### 5.2 多端增量同步（对应 G8）

**现状**：`listMessages` 只支持 `beforeId`（向前翻历史），没有「取回 id > N」的入口。
多端场景需要：新设备登录后、或长时间断网重连后，快速拉取「我错过的那几条」。

**方案**：给消息接口加 `afterId`（与 `beforeId` 对称）
```
GET /api/v1/conversations/:id/messages?afterId=1234&limit=50
```
因为 `messages.id` 是全局自增主键，`id > afterId` 天然有序且不漏。
双端同框时可用 `id` 做幂等键（前端已有「按 id 替换」的乐观发送去重逻辑，见 LESSONS 第 10 条）。

**WS 侧补一条**：`message.new` 广播时携带完整消息对象（目前需查证是否已带 `id`；
`listConversations` 的 `lastMessage` 已带 `id`，说明服务端有该字段）。

### 5.3 已读语义的多端定义（对应 G9）

现状 `conversation_members.last_read_message_id` 是**账号级**：A 端读完，B 端立刻显示已读。

**建议保持账号级**（与微信/WhatsApp 一致），理由：
- 用户心智是「我读过了」，不是「这台设备读过了」
- 账号级实现简单，多端不会出现「我明明读了却还显示未读」的困惑

**唯一需要补的**：桌面端这种大屏，用户可能「打开了会话但没细看」，
建议在桌面端把「已读」改为**窗口失焦后才上报**，避免误标。
这是一条**纯前端策略**，服务端不动。

### 5.4 对象存储（对应 G4）

`upload.js` 目前写本地磁盘。生产多实例部署时必须换成对象存储（S3 / 腾讯云 COS）。

**建议**：引入存储抽象
```js
// server/src/storage/index.js
export async function putObject(key, buffer, contentType) → { url, size, mimeType }
export async function getObject(key) → Buffer
export async function removeObject(key) → void
```
- 本地驱动：`server/src/storage/local.js`（现状行为，零回归）
- S3/COS 驱动：`server/src/storage/s3.js`（用 AWS SDK v3）
- `upload.js` 与 `routes/files.js` 只依赖抽象接口

⚠️ **私有文件鉴权**：`files/private/:filename` 现在靠 `authRequired` + `mediaUrl()` 在 URL 上拼
`?token=`（`client.js:23-28`）。原生壳的 `<img src>` 同样走不了 Header，
**这个设计天然跨端，保留**。但对象存储的签名 URL 有效期要 ≥ 客户端缓存策略。

### 5.5 深链路由（对应 G5）

统一协议：`chatly://conversation/{id}` / `chatly://user/{id}`

| 端 | 入口 |
|---|---|
| Web | `/?conv=123`（现状 `Phone.jsx:103` 已有） |
| iOS | `CFBundleURLTypes` + `appUrlOpen` 事件 |
| Android | `intent-filter` + `appUrlOpen` 事件 |
| 桌面 | Tauri 深链插件 + `tauri://` |

原生壳启动时的处理顺序：**先等 `appUrlOpen` 事件，再走正常冷启动流程**——
否则会先渲染首页再跳会话，出现「闪一下」。

---

## 六、分阶段路线图

每个阶段结束时**必须全绿**：`npm run verify`（32 个自检套件）
+ `npm run build` + 对应新增专项自检。

### P0 · 解耦：抽出平台适配层（不动业务行为）

| 任务 | 落点 | 验收 |
|---|---|---|
| 建 `src/platform/`，含 `env.js` 运行时探测 | 新目录 | `npm run build` 通过 |
| 抽 `storage` / `clipboard` / `haptics` / `geo` / `media` 五个接口 | `client.js` `theme.js` `ChatRoom.jsx` `MyQrPage.jsx` `useLongPress.js` `lib/geo.js` | 全项目 `navigator.` 直调数 → 0（除 `src/platform/` 内） |
| 抽 `resolveApiBase()` | `client.js:7` | Web 端行为零变化 |
| 新增 `check-platform.mjs` 自检 | `scripts/` | 断言适配层接口齐全、Web 实现可跑 |

**关键风险**：改造过程中极易引入行为回归。**每改一个调用点就跑一次 `check-console` + `check-core-flows`**。

### P1 · 服务端多端化

| 任务 | 落点 | 验收 |
|---|---|---|
| `web_push_subscriptions` 加 `device_id` | `push.js:11` | `check-driver.mjs` 双驱动通过 |
| `push_targets` 表 + 设备级路由 | `push.js` `message-push.js:117` | `check-push.mjs` 扩项：**A 端在线时 B 端仍收到推送** |
| `onlineDeviceIds(userId)` | `ws.js` | 与 `isOnlineAnywhere` 共存，不破坏现有调用点 |
| 消息接口加 `afterId` | `routes/conversations.js` `chat.js:632` | 新增自检断言 `afterId` 拉取不漏不重 |
| 会话列表返回 `lastMessage.id` | 已有 | 确认无需改动 |

### P2 · UI 外壳多形态

| 任务 | 落点 | 验收 |
|---|---|---|
| 抽 `AppShell.jsx`，按断点三套布局 | `Phone.jsx` `phone.css` | 390 / 768 / 1440 三档截图 |
| 平板双栏 + 桌面三栏 | `phone.css` | 新增 `check-responsive.mjs` |
| 桌面端「失焦才报已读」 | `ChatRoom.jsx` | `check-readreceipt.mjs` 扩项 |

### P3 · 移动端壳（Capacitor）

| 任务 | 说明 |
|---|---|
| `npx cap init` + `cap add android` / `cap add ios` | 产出 `android/` `ios/` 原生工程 |
| 接入 `@capacitor/push-notifications` | 原生推送（APNs/FCM），需服务端加 provider 分支 |
| 接入 Camera / Geolocation / Clipboard / Haptics / Share 插件 | 对应 P0 的适配层 native 实现 |
| 原生推送的服务端 provider 分流 | `push.js`：web 走 VAPID，native 走 FCM/APNs |
| iOS 构建 | **需 macOS 或 GitHub Actions `macos-latest`**（本机 Windows 出不了 ipa） |
| Android 构建 | 本机 JDK 21 + Android SDK 已就绪，可直接出 APK |

### P4 · 桌面端壳（Tauri）

| 任务 | 说明 |
|---|---|
| `npm create tauri-app` 接入现有 Vite | `src-tauri/` 目录 |
| 系统托盘 + 最小化到托盘 | Tauri tray 插件 |
| 原生通知（替代 Web Push） | Tauri notification 插件 |
| 深链 `chatly://` | Tauri deep-link 插件 |
| 自动更新 | `tauri-plugin-updater` + GitHub Releases |
| **WebKit 兼容性清单** | `backdrop-filter` / `dvh` / `safe-area-inset` 三项重点验 |

### P5 · 生产化

| 任务 | 说明 |
|---|---|
| 对象存储（S3/COS） | `server/src/storage/` 抽象 + 双驱动 |
| 离线消息（IndexedDB / SQLite） | 消除 G3；原生端可用 `@capacitor-community/sqlite` |
| 多实例部署 | PG + Redis + 对象存储 + 负载均衡 |
| CI/CD | GitHub Actions：Windows(桌面) / macOS(iOS) / Linux / Android 四条流水线 |
| 端到端加密（可选） | 现在是服务端全局密钥；若要真 E2EE 需引入 X3DH/Double Ratchet，**建议独立立项** |

---

## 七、风险与红线

### 7.1 技术风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| **WebView 与浏览器的行为差异** | 高 | iOS 16.4+ 才支持 PWA 推送；原生推送走 APNs/FCM 不依赖 WebView |
| **Tauri 三引擎 CSS 不一致** | 中 | 先只发 Win/macOS；建兼容性清单 |
| **单会话 WS 与多端在线的交互** | 中 | 现结构已支持；但「来电响铃哪端」需产品定策略（见下） |
| **改造 30+ 处浏览器调用引入回归** | 中 | P0 严格逐点改造，每点跑自检；不改业务逻辑只改调用形式 |
| **iOS 构建链不在本机** | 低 | GitHub Actions `macos-latest` |
| **对象存储改造影响现有上传链路** | 中 | 抽象接口 + 本地驱动零回归切换 |

### 7.2 产品决策点（需用户拍板）

1. **来电响铃策略**：多端同时在线时，电响铃在哪端？
   - 全部响铃（像 Zoom，多端一起响）
   - 只在最「活跃」的端响（需定义活跃度）
   - 手机优先响铃，电脑静音（像微信/WhatsApp 的手机端优先）
   → **建议：手机优先**，其余端只在通话页显示「对方已在呼叫」

2. **端到端加密是否立项**：现有是服务端全局密钥加密（服务端可解密）。
   真 E2EE 需要密钥协商 + 设备配对 UI，工作量约等于再造一遍核心链路。**建议独立立项，不塞进本路线。**

3. **是否保留 PWA**：保留（PWA 是最快的分发通道，也是 Capacitor Web 端的天然形态）。

### 7.3 红线（沿用项目既有铁律）

- **不做假功能**：未接入的一律 `disabled` + 写明原因，不弹 toast 假装成功
- **不改业务逻辑只为「像原生」**：适配层只做「同一语义、两种实现」，不改行为
- **每阶段必须自检全绿**：不带着红灯进下一阶段
- **DB 改动走 `addColumnIfMissing`**，不要求用户跑 `npm run reset`
- **双驱动自检必须 `DB_DRIVER=postgres` 原样再跑一遍**

---

## 八、本机工具链现状

| 工具 | 状态 | 用途 |
|---|---|---|
| Node | ✅ v22.22.2 | 现有前后端（`engines` 要求 `>=22.5.0`，满足） |
| Rust | ✅ 1.91.0 | Tauri 桌面端必需 |
| JDK | ✅ 21.0.12 LTS | Capacitor Android 构建必需 |
| Android SDK | ✅ `ANDROID_HOME` 已设 | Capacitor Android 构建必需 |
| Xcode | ❌ 本机 Windows 无 | **iOS 构建需 macOS 或 GitHub Actions `macos-latest`** |
| GitHub CLI | ✅ 2.96.0 | 推送 / CI 触发 |

**结论**：**Android APK 可以本机直接出；iOS 必须走 CI；桌面端本机可出。**

---

## 附：规划与历史的对应关系

| 规划条目 | 历史依据 |
|---|---|
| 共享核心而非多端重写 | `ChatlyApp`（Kotlin/Compose）因双轨维护被整体删除 |
| 沿用 `tokens.css` 变量 | 零硬编码色值是项目铁律，换壳不换皮 |
| 保留 `?token=` 私有文件鉴权 | 原生 `<img>` 同样无法带 Header，此设计天然跨端 |
| 推送订阅绑设备 | `message-push.js` 注释里已自陈「按设备精确判定需要把订阅和 WS 连接绑定，当前两套表没打通」 |
| 已读保持账号级 | 与微信/WhatsApp 心智一致 |
| 适配层优先于外壳 | 浏览器 API 是散点直调，不收口就谈不上「一次编写」 |
