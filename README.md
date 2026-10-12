# Chatly

> 连接更有趣的人 —— 移动端聊天通讯 App

基于《移动端聊天通讯软件功能书》（47 节 PRD）实现。覆盖 **聊天 / 动态 / 发现 / 我** 四大板块，  
其中**聊天 / 动态 / 发现 / 位置 / 群投票 / 消息收藏 / 引用回复 / 消息转发**已接通独立后端（REST + WebSocket + SQLite + JWT），
通知 / 在线状态等仍为原型数据。

> 每一页都遵守同一条底线：**界面上的每个数字、每句话、每次点击都要能追到库里的一行数据**。  
> 追不到的，就标「未接入」并禁用 —— 不做一个点了弹 toast 假装成功的假按钮。

---

## 目录

- [快速开始](#快速开始)
- [功能概览](#功能概览)
- [技术选型](#技术选型)
- [目录结构](#目录结构)
- [后端](#后端)
- [布局形态](#布局形态)
- [聊天](#聊天)
  - [群聊管理](#群聊管理)
  - [群投票](#群投票)
  - [消息收藏](#消息收藏)
  - [引用回复](#引用回复)
  - [消息转发](#消息转发)
  - [长按手势](#长按手势)
- [动态](#动态)
- [发现](#发现)
- [我](#我)
- [用户资料与头像](#用户资料与头像)
- [媒体查看器](#媒体查看器)
- [扫一扫 / 我的二维码](#扫一扫--我的二维码)
- [表情面板](#表情面板)
- [设计规范](#设计规范)
- [验证与自检](#验证与自检)
- [说明](#说明)

---

## 快速开始

需要 **两个进程**（前端 5198、后端 3002）。先装依赖并灌入演示数据：

```bash
# 1) 后端
cd server
npm install
npm run seed     # 首次：写入 12 个演示用户 + 会话 + 消息（幂等）

npm run dev      # http://127.0.0.1:3002  （node --watch，改代码自动重载）

# 2) 前端（另开一个终端，回到项目根目录）
npm install
npm run dev      # http://127.0.0.1:5198
```

打开 <http://127.0.0.1:5198> ，用**演示账号一键登录**即可开始聊天。

| 用户名          | 昵称  | 密码          |
| ------------ | --- | ----------- |
| `chenmo`     | 陈墨  | `chatly123` |
| `linxiaoxia` | 林小夏 | `chatly123` |
| `ajie`       | 阿杰  | `chatly123` |
| `xiaolu`     | 小鹿  | `chatly123` |
| `chenyu`     | 陈宇  | `chatly123` |
| `xiatian`    | 夏天  | `chatly123` |

> **想看实时效果**：用两个不同的浏览器 profile（或一个正常窗口 + 一个无痕窗口）分别登录两个账号。  
> 同一个浏览器的两个标签页共享 localStorage，只能登录一个账号。

生产构建：

```bash
npm run build && npm run preview
```

> 前端端口固定 `127.0.0.1:5198`（`strictPort`），后端固定 `127.0.0.1:3002`。  
> Vite 已把 `/api`、`/uploads`、`/ws` 代理到后端，前端代码里不需要写后端地址。

---

## 功能概览

| 板块 | 功能 | 后端接入 |
| --- | --- | :---: |
| **聊天** | 私聊 / 群聊 / 文字 / 图片 / 文件 / 位置 / 表情 / 视频消息 / 已读回执 / 撤回 / 引用回复 / 消息转发 / 群投票 / 消息收藏 / 长按手势 / 禁言锁定 | ✅ |
| **群管理** | 群资料 / 群公告 / 成员管理 / 权限三档 / 全员禁言 / 仅管理员发言 | ✅ |
| **动态** | 图文 / 视频 / 发布 / 编辑 / 点赞 / 评论 / 可见范围（公开 / 仅好友 / 仅自己） | ✅ |
| **发现** | 推荐用户 / 附近（按地区） / 公开群 / 关注 / 标签筛选 | ✅ |
| **我** | 资料编辑 / 头像裁剪 / 我的动态 / 我的收藏 / 二维码 / 扫一扫 | ✅ |
| **扫一扫** | 摄像头扫码 / 相册选图 / 手输 ID / 加好友 / 发消息 | ✅ |
| **表情** | 386 彩色 SVG + 30 动画 GIF / 9 分组 / 搜索 / 大表情直发 | ✅ |
| **二维码** | 零依赖编解码 / 我的二维码 / 扫一扫 | ✅ |

**尚未接入**（界面上明确标注为「未接入 / 即将上线」，不做假按钮）：  
语音与视频通话、语音消息、群文件、群公告置顶推送、群主转让、通讯录 / 好友列表、稍后看、最近文件。

---

## 技术选型

| 项       | 说明                                                                                 |
| ------- | ---------------------------------------------------------------------------------- |
| 前端      | React 18 + Vite 5                                                                  |
| 前端运行时依赖 | **零**（不含图标库 / UI 框架 / 日期库 / socket.io / axios / 表情库）                               |
| 图标      | `src/components/Icon.jsx`，50+ 个手写内联 SVG，统一 24×24 stroke 风格                          |
| 表情      | Microsoft Fluent Emoji（MIT），386 个彩色 SVG 落在 `public/emoji/`，清单见 `src/data/emoji.js` |
| 图像      | 头像由 data-URI SVG 生成；聊天图片走真实上传                                                      |
| 样式      | 每屏独立 CSS + `tokens.css` 设计令牌                                                       |
| 状态      | `useReducer` + Context（Auth / App / Chat / Favorite 四层）                                       |
| 后端      | Express 5 + `ws` + `node:sqlite` + `jsonwebtoken` + `multer`                       |

---

## 目录结构

```
src/
├── api/client.js        REST 客户端 + token 存取 + 时间格式化
├── hooks/
│   ├── useChatSocket.js 单例 WebSocket（订阅表 + 指数退避重连）
│   └── useLongPress.js  长按手势 hook（480ms 触发 + 10px 容差 + 振动反馈 + 点击抑制）
├── components/
│   ├── Icon.jsx         图标库（内联 SVG）
│   ├── ui.jsx           UI 原语：Avatar/Badge/Chip/Row/Group/Switch/Sheet/ActionMenu/Toast…
│   ├── ProfileEditor.jsx  编辑资料面板（文本字段 + 头像，先存文字再传图）
│   ├── AvatarPicker.jsx   头像选择器（上传 + canvas 裁剪 + 12 个预设）
│   ├── EmojiPanel.jsx     表情面板（9 个分组 + 大表情直发 + 最近使用 + 搜索）
│   ├── MediaViewer.jsx    图片 / 视频查看器（关闭 / 保存 / 播放）+ 视频消息气泡
│   ├── VideoPlayer.jsx    自建播放器（横竖屏自适应 + 自己的控制条，不用原生 controls）
│   ├── MomentMedia.jsx    动态媒体（图片走九宫格 / 视频走播放器，列表与详情共用）
│   ├── MomentComposer.jsx 动态发布 / 编辑（整屏层：文案 + 9 图 或 1 视频 + 话题 + 定位 + 可见范围）
│   ├── LocationPicker.jsx 选位置面板（聊天发位置 / 动态定位共用）
│   ├── PollBubble.jsx     群投票（发起面板 + 消息气泡 + 详情层，三合一）
│   └── ForwardSheet.jsx   转发目标选择器（整屏层：会话列表 + 搜索 + 确认发送）
├── screens/
│   ├── LoginScreen.jsx    登录 / 注册（含演示账号一键登录）
│   ├── ChatTab.jsx        聊天首页（状态 Stories + 真实会话列表 + 建群/私聊）
│   ├── ChatRoom.jsx       私聊 / 群聊（真实收发 + 已读回执到人 + 撤回 + 引用回复 + 转发 + 长按菜单 + 禁言锁定）
│   ├── UserProfile.jsx    他人资料页（整屏覆盖层，从聊天顶部头像 / 会话设置进入）
│   ├── GroupSettings.jsx  群设置页（整屏覆盖层：群头像 / 群名 / 公告 / 成员管理 / 群开关 / 群投票列表 / 退出）
│   ├── MomentTab.jsx      动态内容流（朋友 / 我的 / 热门 + 点赞 + 管理入口）
│   ├── MomentDetail.jsx   动态详情（整屏覆盖层：正文 / 点赞的人 / 评论树 / 回复）
│   ├── DiscoverTab.jsx    发现（推荐 / 附近 / 群组 / 用户，全部读真实数据）
│   ├── MeTab.jsx          我（个人空间 + 设置子页 + 收藏 + 退出登录）
│   ├── MyQrPage.jsx       我的二维码（子页：码 + 头像昵称 + 保存卡片图 + 复制 ID）
│   ├── ScanPage.jsx       扫一扫（整屏层：摄像头 / 相册 / 手动 ID + 四种结果卡）
│   ├── NoticeCenter.jsx   通知中心
│   └── SearchPanel.jsx    全局搜索
├── lib/
│   ├── qr.js              零依赖二维码编解码（编码给「我的二维码」/ 解码给「扫一扫」）
│   └── qrPayload.js       chatly:// 负载的生成与解析（群码 / 动态码留了扩展位）
├── store/
│   ├── AuthContext.jsx    用户 / token / 登录登出
│   ├── AppContext.jsx     原型数据（通知 / 状态）+ Tab 切换
│   ├── ChatStore.jsx      真实会话与消息（REST + WS）+ 投票详情缓存
│   ├── MomentStore.jsx    真实动态（列表 / 发布 / 编辑 / 删除 / 点赞 / 评论）
│   ├── DiscoverStore.jsx  发现页数据（推荐 / 附近 / 标签 / 可加入群 / 热门，关注乐观更新）
│   └── FavoriteStore.jsx  消息收藏（列表 / 收藏 / 取消 / 批量 + 「这条收藏了没」的 Set）
├── data/
│   ├── mock.js            原型演示数据
│   ├── emoji.js           表情清单（码点 / 分组 / 中文名 / 大表情精选）—— 由脚本生成，勿手改
│   └── emoji-anim.js      动画大表情地址表（30 条 .gif）—— 由脚本生成，勿手改
└── styles/                tokens.css + global.css（含整屏层补底的 .cover-tabbar）

public/emoji/              386 个彩色 SVG（Microsoft Fluent Emoji，MIT）+ LICENSE.txt
public/emoji-anim/         30 个动画大表情 GIF（fluentui-emoji-animated，MIT）+ LICENSE.txt
scripts/
├── check-reply-forward.mjs   引用回复 + 消息转发专项自检（45 项断言）
├── check-longpress.mjs       长按手势专项自检（14 项断言）
├── check-poll.mjs            群投票专项自检（129 项断言）
├── check-favorite.mjs        消息收藏专项自检（85 项断言）
├── check-moment.mjs          动态专项自检
├── check-video.mjs           视频动态专项自检
├── check-discover.mjs        发现页专项自检
├── check-qr.mjs              扫一扫 / 我的二维码专项自检
├── check-group.mjs           群聊专项自检
├── check-profile.mjs         用户资料与头像专项自检
├── check-readreceipt.mjs     已读回执专项自检
├── check-media.mjs           图片 / 视频查看器专项自检
├── check-emoji.mjs           表情面板专项自检
├── check-scroll.mjs          长会话可滚动性自检
├── check-align.mjs           布局回归自检
├── check-narrow.mjs          窄屏无横向溢出自检
├── check-console.mjs         全界面 console 报错 / 非法 DOM 嵌套自检
├── audit-ui.mjs              全界面缺陷扫描（横向溢出 / 越界 / 文本截断 / 有效点击区）
├── e2e-realtime.mjs          双浏览器实时联调自检
├── lib/
│   ├── cdp.mjs               CDP 调试端口动态分配 + target 归属校验 + 浏览器启动（自检共用）
│   ├── debris.mjs            自检残留清理（按标题前缀 + 孤儿会话 + 孤儿上传文件）
│   ├── gif.mjs               GIF 封装解析 / 处置方式补丁 / 安全播放断言
│   ├── png.mjs               零依赖 PNG 编解码（自检用：把屏幕上的码当图片读回来）
│   └── qr-verify.mjs         二维码编解码交叉验证（与 npm 的 qrcode + jsqr 对拍，69 项）
├── fetch-emoji.mjs           抓取 / 生成静态素材与清单
├── fetch-emoji-anim.mjs      抓取 APNG 并转码为 GIF
├── shoot.mjs / shoot2.mjs    渲染截图

server/
├── src/
│   ├── db.js              node:sqlite 建表与查询助手（含幂等 ALTER TABLE 迁移）
│   ├── auth.js            scrypt 密码 + JWT + 鉴权中间件 + USER_COLS
│   ├── chat.js            会话 / 消息 / 已读 / 撤回 / 群资料与成员业务逻辑 + canSpeak() + assertReplyTo() + forwardMessages()
│   ├── moment.js          动态业务逻辑（可见性判定 / 列表 / 增删改 / 点赞 / 评论 / 关注）
│   ├── discover.js        发现页业务逻辑（推荐排序 / 地区匹配 / 标签聚合 / 公开群与加入）
│   ├── poll.js            群投票业务逻辑（创建 / 票数统计 / 匿名出参 / 结束判定）
│   ├── favorite.js        消息收藏业务逻辑（快照抄写 / 列表 / 批量 / 权限判定）
│   ├── profile.js         资料校验 / 更新 / 他人资料（生日打码、共同群聊数）
│   ├── upload.js          multer 工厂（附件 20MB / 头像 5MB / 动态图 12MB / 动态视频 80MB + 视频魔数校验）
│   ├── ws.js              WebSocket 网关（在线表 + 心跳 + 推送）
│   ├── index.js           Express 入口
│   ├── seed.js            演示数据（含只补空字段的资料回填 + 投票 / 收藏种子）
│   └── routes/            auth / conversations / messages / users / moments / discover / geo / polls / favorites
├── test/e2e.mjs           后端端到端测试
├── data/                  SQLite 库（运行时生成，不入库）
└── uploads/               上传文件（运行时生成，不入库）
```

---

## 后端

独立进程，**零外部数据库依赖**（用 Node 内置 `node:sqlite`，需 Node ≥ 22.5）。

| 能力 | 实现                                                                                                                 |
| -- | ------------------------------------------------------------------------------------------------------------------ |
| 认证 | JWT（7 天），REST 用 `Authorization: Bearer`，WebSocket 用 `?token=`                                                      |
| 密码 | `node:crypto` scrypt（`scrypt$salt$hash`），不引 bcrypt                                                                 |
| 实时 | `ws` —— `hello` / `message.new` / `message.revoked` / `conversation.read` / `typing` / `presence` / `user.updated` / `conversation.updated` / `poll.updated` |
| 存储 | SQLite（WAL），17 张表：`users` / `conversations` / `conversation_members` / `messages` / `moments` / `moment_media` / `moment_likes` / `moment_comments` / `follows` / `polls` / `poll_options` / `poll_votes` / `poll_replies` / `favorites` |
| 资料 | 扩展字段 `gender` / `birthday` / `region` / `tags`，用幂等 `ALTER TABLE` 迁移（SQLite 没有 `ADD COLUMN IF NOT EXISTS`）          |
| 上传 | multer → `server/uploads/`；附件 20MB、头像 5MB；扩展名与 MIME 双重校验                                                           |

发消息走 REST（便于落库并拿到消息 id），WebSocket 只负责下行推送与 `typing` 上行。

> `users` 表结构变更一律走 `db.js` 里的 `addColumnIfMissing()`，不要让人去跑 `npm run reset` ——  
> reset 会连会话和消息一起清掉。`seed.js` 的 `backfillProfiles()` 只补空字段，老库直接启动即可。

```bash
cd server
npm run dev      # node --watch src/index.js
npm run reset    # 清空并重建演示数据
node test/e2e.mjs   # 后端端到端测试（70 项断言）
```

---

## 布局形态

**纯 H5 竖屏固定布局**，不含手机外壳（无刘海 / 无状态栏 / 无 Home Indicator）。

- 桌面预览：内容区固定 **390px 宽**，垂直居中，最大高度 `min(100dvh, 900px)`，两侧留中性浅底。
- 真机 / 窄屏（≤ 440px）：内容区**铺满整个视口**（`100dvh`），去掉圆角与阴影。
- 顶部留白由 `--safe-top` 统一控制（真机上由系统状态栏占位，桌面预览需显式留出）。
- 底部导航用 `env(safe-area-inset-bottom)` 适配全面屏手势区。

在浏览器 DevTools 里切到 iPhone / Android 设备模式即可看到真实效果，无需额外配置。

---

## 聊天

**真实可用：**

- 登录 / 注册 / JWT 会话保持（刷新不丢登录态）
- 会话列表：真实未读计数、最后一条消息预览、在线状态、置顶、免打扰
- 私聊与群聊：建群选人、发起私聊
- **群聊管理与群公告**：群头像 / 群名 / 群公告、邀请与移出成员、设 / 撤管理员、
  全员禁言与仅管理员发言、退出群聊，权限按群主 / 管理员 / 成员三档收敛
- 文字消息：发送（乐观更新）、实时收发、撤回（2 分钟内、仅本人）
- **引用回复**：长按菜单「回复」→ 输入区上方出现引用条 → 发送带 `replyToId` 的消息 → 气泡上显示引用块 → 点引用块跳到被引用的消息并高亮
- **消息转发**：长按菜单「转发」或多选「转发」→ 整屏目标选择器 → 搜索 / 选择 → 逐条重发到目标会话
- **长按手势**：长按消息 480ms 弹出操作菜单（回复 / 复制 / 收藏 / 转发 / 翻译 / 多选 / 撤回），支持振动反馈
- **禁言锁定**：全员禁言 / 仅管理员发言时，输入区**整体替换**为提示条（「全员禁言中，暂不能发言」），加号面板的媒体入口同步锁定
- 图片消息：真实上传并渲染；文件消息：上传 / 下载
- **位置消息**：选地点（真实定位 / 搜索附近 POI / 手输地点名）→ 发一条位置消息
- **群投票**（PRD §14）：单选 / 多选 / 匿名 / 截止时间 + 发起人提前结束
- **消息收藏**（PRD §9）：长按收藏 / 多选批量收藏 / 我的收藏列表
- **图片 / 视频消息点开有「保存」和「关闭」**，视频在查看器里**真实播放**
- 表情：386 个彩色表情，9 个分组 + 搜索 + 最近使用；大表情直发
- 已读回执：**精确到人**。我方消息下方一行小头像簇，读过的人彩色排前面
- 正在输入：实时提示（含超时兜底）
- 历史消息：上翻分页加载
- 会话设置（置顶 / 免打扰）、删除会话

**尚未接入**（界面上明确标注为「未接入 / 即将上线」，不做假按钮）：  
语音与视频通话、语音消息、群文件、群公告置顶推送、群主转让、通讯录 / 好友列表。

**仍为原型数据：** 状态 Stories、聊天记录全文检索、稍后看、最近文件。

---

### 群聊管理

群聊的管理入口有两条，都通到同一个整屏层「群设置」：

- 聊天页**点顶部群头像 / 群名**
- 聊天页「⋯」→ 会话设置 → 「群设置」

会话设置（「⋯」）里仍然只有**个人偏好**（置顶 / 免打扰 / 删会话），群资料一律在群设置里改 ——
两处都能改群名的话，同一份状态就有两个写入点。

#### 权限

|            | 群主 owner | 管理员 admin | 成员 member |
| ---------- | --------- | ---------- | --------- |
| 改群名 / 群头像 / 发公告 | ✅ | ✅ | — |
| 全员禁言 / 仅管理员发言  | ✅ | ✅ | — |
| 发起投票 / 投票           | ✅ | ✅ | ✅（受禁言开关约束） |
| 提前结束**自己发起的**投票 | ✅ | ✅ | ✅ |
| 邀请成员                | ✅ | ✅ | ✅ |
| 移出**普通成员**        | ✅ | ✅ | — |
| 移出**管理员** / 设 · 撤管理员 | ✅ | — | — |
| 退出群聊                | —（需先转让群，未接入） | ✅ | ✅ |

规则在服务端 `chat.js` 的 `canManage` / `isOwner` / `removeMember` / `setMemberRole`，
前端只是**不显示**没权限的入口；真正的拦截始终在服务端。

#### 不显然的几个点

- **群公告要出现在聊天页顶部**，不能只躺在设置页里 —— 那等于没有。
  `.room-ann` 是顶栏与消息区之间的常驻条：默认压成两行，点一下展开全文。
- **群头像不能借用成员的头像。** 群没设头像时服务端返回 `null`，前端用群名生成稳定的渐变底图。
- **改群资料要推给所有成员**（`broadcastToUsers(memberIds(cid), 'conversation.updated', …)`）。
- **`PATCH /conversations/:id` 一个接口管两类字段**：个人偏好（`pinned` / `muted`）与群资料（`title` / `avatar` / `announcement` / `muteAll` / `adminOnly`）。
- **群主的「退出群聊」是禁用并说明原因的**，不是点了才报 403 —— 群里不能没有群主。

---

### 群投票

PRD §14「群内可以快速发起投票」，四种能力全都落地：**单选 / 多选 / 匿名 / 截止时间**，
另加了一个 PRD 没写但缺了就很难受的**「发起人提前结束」**。

两个入口，都通到同一份数据：

| 入口 | 位置 | 做什么 |
| --- | --- | --- |
| 发起 | 聊天页「+」→ 投票（**只在群聊出现**；私聊里这一项整个不存在） | 填题目 / 2~10 个选项 / 多选 / 匿名 / 截止时间 |
| 查看全部 | 群设置 → 群投票 | 该群历史投票列表，点一条**跳到聊天里那条消息**并高亮 |

#### 投票就是一条消息

投票在库里是 `messages.kind = 'poll'` + `poll_id` 指向 `polls` 行。
投票要出现在聊天记录里、要有已读回执、要能被撤回、要能被引用回复 —— 这些消息层已经全都做好了，另起一套就得各做一遍。

四张表：

```
polls          题目 / 单选多选 / 匿名 / 截止时间 / 谁发起 / 何时手动结束
poll_options   选项（带 sort，顺序就是创建时的顺序）
poll_votes     一行 = 某人对某个选项的一票（多选 = 同一人多行）
poll_replies   「谁投过票」的名册（一个人一条，靠唯一索引去重）
```

**票数不存字段，一律 `COUNT` 出来。** 在 `poll_options` 上放一个 `count` 列看着省事，
但投票 / 改票 / 取消投票三处都要记得加减一，漏一处就是一个永远对不上、而界面上看不出来的数字。

#### 权限与可见性

| 操作 | 谁能做 |
| --- | --- |
| 发起 | **只有群聊有入口**（单聊面板里不存在这一项）；群内任何成员，但受「全员禁言 / 仅管理员发言」约束 |
| 投票 / 改票 / 取消 | 群里任何成员，且投票未结束 |
| 提前结束 | **只有发起人**（服务端 403，前端只是不显示入口） |
| 看列表 / 看详情 | 群成员；**群外人拿 404 而不是 403** |

#### 不显然的几个点

- ★★ **单聊里不是「禁用投票」，而是没有这一项。** 投票在两个人之间没有语义，界面上不该出现一个用户永远用不到的东西。
- ★ **匿名是在服务端就不返回。** 匿名时**整个 `voters` 字段都不出现**，不是空数组。
- ★ **多选要「确认」才提交，单选点一下就投。** 多选如果在点第一下就提交，用户还没来得及选第二项。
- ★ **提交的是「投票后的完整状态」，不是「增量」。** 传空数组 = 取消投票。
- ⚠️ **撤回投票消息不删投票行。** 撤回的语义是「这条消息不作数了」，不是「投票的历史被抹掉」。
- ⚠️ **过期 ≠ 手动结束。** `closed` 是两者合成的判定，但 `closed_at` 只在手动结束时才写。
- ⚠️ **题目在 `messages.content` 里存了一份副本**，只给会话列表的预览用。投票发布后题目不可编辑，所以不会漂移。

#### 接口

```
GET    /api/v1/polls?ids=1,2,3            批量取详情
GET    /api/v1/polls/of/:conversationId   某群的投票列表
POST   /api/v1/polls                      发起（同时建一条 kind='poll' 的消息）
POST   /api/v1/polls/:id/vote             投票 / 改票 / 取消（optionIds = 完整状态）
POST   /api/v1/polls/:id/close            发起人提前结束
WS     poll.updated                       有人投票 / 结束，推送整份投票
```

---

### 消息收藏

PRD §9「长按消息 → 收藏」与「消息多选批量 → 收藏」。三个入口：

| 入口 | 位置 | 做什么 |
| --- | --- | --- |
| 收藏 / 取消收藏 | **长按一条消息** → 菜单 | 单项开关，已收藏时菜单显示「取消收藏」 |
| 批量收藏 | 长按 → 菜单 →「多选」→ 底部工具栏「收藏」 | PRD §9 的「消息多选批量」 |
| 我的收藏 | 我页统计条 / 四宫格「收藏」 | 列表 + 「在聊天中查看」跳转 + 移除 |

#### 收藏是**快照**，不是引用

收藏下来的内容**不跟着原消息走**：

- 对方**撤回**消息 → 收藏里的正文与文件地址**仍然完整**
- 消息被清理 / 会话被删 → 收藏还在，只是「在聊天中查看」跳不过去了

做成「指向 messages 的一行引用」的话，对方一撤回你的收藏就变成一条空记录 —— 那不叫收藏。

```
favorites   user_id / message_id / conversation_id / sender_id
            kind / content / file_url / file_name / file_size      ← 快照
            geo_* / poll_id                                          ← 快照
```

由此带来**一个必须一起处理的副作用**：快照的 `file_url` 是那个文件**最后的引用者**，
所以 `purgeOrphanUploads()` 必须把它算作引用方 —— 漏掉不是「少清理一个文件」，而是**把还在用的文件当孤儿挪走**。
引用方清单现在有**五处**：`users.avatar`、`messages.file_url`、`conversations.avatar`、`moment_media.url`、`favorites.file_url`。

#### 不显然的几个点

- ★ **`message_id` 用 `ON DELETE SET NULL`，不是 CASCADE。** 消息被物理删掉时收藏要**活着**。
- ★ **发送者的昵称与头像不抄快照，只存 `sender_id`，渲染时现查。**
- ★ **「已经收藏过」必须排在「已撤回」前面判断。**
- ⚠️ **批量收藏里混着一条已撤回的，只跳过它、其余照收**，并把 `skipped` 一起返回。
- ⚠️ **收藏是私人的**：每条 SQL 都带 `user_id = ?`。
- ⚠️ **前端判断「收藏了没」用的是 FavoriteStore 里那个 Set，不是从收藏列表反推。**

#### 接口

```
GET    /api/v1/favorites                  我的收藏（beforeId 游标 + limit + total）
POST   /api/v1/favorites                  收藏一条（幂等：重复收藏 → created:false）
POST   /api/v1/favorites/batch            批量收藏（返回 added / skipped，逐条判定）
DELETE /api/v1/favorites?messageId=N      按消息取消
DELETE /api/v1/favorites/:id              按收藏 id 取消
POST   /api/v1/favorites/unbatch          批量取消
```

---

### 引用回复

PRD §6「引用回复消息」。长按菜单「回复」→ 输入区上方出现引用条 → 发送带 `replyToId` 的消息。

#### 三个入口

| 入口 | 位置 | 做什么 |
| --- | --- | --- |
| 长按菜单「回复」 | 长按一条消息 → 菜单第一项 | 输入区上方出现引用条，显示原文摘要 |
| 点引用块跳转 | 消息气泡上的引用块（`data-testid="quote-jump"`） | 跳到被引用的消息并高亮闪烁 |
| 取消引用 | 引用条右侧 ✕ 按钮 | 清掉待发引用 |

#### 后端校验

`assertReplyTo()` 在 `chat.js` 里统一做四件事：

1. **存在性**：被引用的消息必须存在（`404 被引用的消息不存在或不在本会话`）
2. **同会话**：被引用的消息必须在当前会话里（`404`）—— 禁私聊外泄
3. **未撤回**：被引用的消息不能已撤回（`400 被引用的消息已被撤回`）
4. **id 合法**：`replyToId` 必须是正整数（`400`）

校验失败直接 throw `{ status, message }`，路由层统一 catch 并返回对应状态码。

#### 前端行为

- **引用条显示原文摘要**：`回复 <发送者>：<原文前 20 字>`
- **气泡上的引用块**：带左侧色条 + 发送者名 + 原文摘要
- **点引用块跳转**：`jumpToMessage(replyToId, toast)` —— 如果消息不在当前加载的记录里，翻到对应页并滚动 + 高亮闪烁 1.5 秒
- **引用块只在有 `replyToId` 时可点击**：被撤回的消息 quote 是空的，没有 id 就只是静态 div

#### 不显然的几个点

- ★ **点文字气泡不再挂引用。** 原来 `.bubble` 上挂了 `onClick={() => onReply(m)}`，真机上想复制 / 选中文字时一点就进引用态，只能去输入区按 ✕，这是误触。现在引用**只从长按菜单的「回复」进**。
- ★ **`jumpToMessage` 必须通过 props 传给 Message 子组件。** 它是主组件的函数，子组件里直接调会 `ReferenceError`。第一版踩了这个坑：console 里报 `jumpToMessage is not defined`，但只在点击引用块时才暴露（自检的 console 监听抓到了）。
- ⚠️ **引用条的判据是 `[data-testid="composer-quote"]`**（输入区上方那条），不是 `.quote-bar` —— 后者是「消息气泡里已发出的引用块」，两回事。

---

### 消息转发

PRD §7「转发消息」。长按菜单「转发」或多选「转发」→ 整屏目标选择器 → 搜索 / 选择 → 逐条重发。

#### 两个入口

| 入口 | 位置 | 做什么 |
| --- | --- | --- |
| 长按菜单「转发」 | 长按一条消息 → 菜单 | 打开目标选择器，预载这一条 |
| 多选「转发」 | 长按 → 多选 → 底部工具栏「转发」 | 打开目标选择器，预载已选的 N 条 |

#### 转发是**复制**，不是移动

- 新消息的 `sender_id` = 转发人（不是原作者）
- 新消息的 `created_at` = 转发时间（不是原时间）
- 新消息的 `conversation_id` = 目标会话
- **引用被剥离**：跨会话的引用没有意义（被引用的消息在目标会话里不存在）
- **投票不可转**：票数绑原会话，复制过去数字就乱了
- **撤回不可转**：已撤回的消息没有内容可转
- **上限 20 条**：超过返回 `400`

#### 后端 `forwardMessages()`

```js
// chat.js
async function forwardMessages({ targetConversationId, messageIds, senderId }) {
  // 1. 校验目标会话存在 + senderId 是成员
  // 2. 校验 canSpeak()（目标会话禁言则 403）
  // 3. 逐条处理：
  //    - 已撤回 → skip（reason: '该消息已被撤回'）
  //    - kind === 'poll' → skip（reason: '该类型消息不支持转发（poll）'）
  //    - 其它 → createMessage() 到目标会话，replyToId 置 null
  // 4. 返回 { forwarded: N, skipped: [{ messageId, reason }] }
}
```

#### 前端 ForwardSheet

整屏覆盖层，和 `LocationPicker` 同一个布局模式（`z-index: 160`）：

- **会话列表**：真实数据，显示头像 + 名称 + 最后一条预览
- **搜索**：按会话名过滤，实时
- **选中态**：点一行高亮，底部「发送」按钮可用
- **确认发送**：调 `POST /messages/forward`，成功后关闭面板 + toast「已转发 N 条」
- **失败处理**：面板不关，如实报错（目标会话禁言 → 「群已开启全员禁言」）

#### 不显然的几个点

- ★ **转发按钮的 disabled 不看当前会话的 `speakGate`。** 转发是发到**目标会话**，不是当前会话 —— 从禁言群里把消息转发到别的群是完全合法的。目标会话禁不禁言，在 ForwardSheet 选目标时才知道，那里由服务端 403 兜底。
- ★ **多选模式下的「已选」状态绑在会话上**：切会话时要一起清掉，否则底部「已选 3 条」指的是上一个房间里的消息。
- ⚠️ **`forwarded` 和 `skipped` 是逐条判定的结果**，不是「整批成功 / 整批失败」。混着一条已撤回的，其余照发。

#### 接口

```
POST   /api/v1/messages/forward    { targetConversationId, messageIds[] }
                                   → 201 { forwarded, skipped, messages[] }
```

---

### 长按手势

消息的回复、复制、收藏、转发等操作统一走**长按手势**（手机上没有右键菜单）。

#### `useLongPress` hook

```js
const pressHandlers = useLongPress({
  onLongPress: (m, canRevoke) => setMenuState({ m, canRevoke }),
  delay: 480,        // 长按触发时间
  moveTolerance: 10, // 手指移动超过此距离取消（防滚动误触）
  suppressMs: 800,   // 长按后抑制 click 的时间窗口
})
```

挂在**整行消息**上（不是只挂文字气泡），于是图片 / 视频 / 文件 / 位置 / 投票消息都能长按。

#### 菜单项

| 菜单项 | 条件 | 做什么 |
| --- | --- | --- |
| 回复 | 始终 | 输入区挂引用条 |
| 复制 | `kind === 'text'` | 复制到剪贴板 + toast |
| 收藏 | 非投票 | 收藏 / 取消收藏（已收藏时显示「取消收藏」） |
| 转发 | 非投票 | 打开 ForwardSheet |
| 翻译 | — | disabled + 「翻译 · 未接入」 |
| 多选 | 始终 | 进入多选模式 |
| 撤回 | `mine && !pending && !failed && 2 分钟内` | 撤回消息 |

#### 不显然的几个点

- ★ **`onContextMenu` 在手机上不触发。** 手机没有右键，所以必须用 pointer events 自己实现长按。`useLongPress` 同时支持鼠标（桌面调试）和触摸（真机）。
- ★ **ActionMenu 有 450ms 点击守卫。** 长按触发后 `touchEnd` 会补发一个合成 click，如果不挡，这个 click 会直接命中菜单项（「收藏」变「取消收藏」，或者更糟 —— 直接执行了「撤回」）。守卫逻辑：`openedAt` 记录菜单打开时间，450ms 内的 click 一律忽略。
- ★ **振动反馈要判 `navigator.userActivation?.isActive`。** 无头浏览器里没有 user activation，直接调 `navigator.vibrate()` 会报 console error。
- ★ **短按文字气泡什么都不发生。** 这是配合引用链修掉的旧行为 —— 以前点一下文字就挂上引用，真机上想复制文字时一点就进引用态。现在引用只从长按菜单进。

---

### 禁言输入锁定

当群聊开启「全员禁言」或「仅管理员发言」时，非特权用户的输入区**整体替换**为提示条。

#### 前端 `speakGate`

```js
const speakGate = useMemo(() => {
  if (chat.type !== 'group') return { ok: true, reason: '' }
  const myRole = chat.myRole || (chat.ownerId === me?.id ? 'owner' : 'member')
  const privileged = myRole === 'owner' || myRole === 'admin'
  if (chat.muteAll && !privileged) return { ok: false, reason: '全员禁言中' }
  if (chat.adminOnly && !privileged) return { ok: false, reason: '仅管理员可发言' }
  return { ok: true, reason: '' }
}, [chat.type, chat.myRole, chat.ownerId, chat.muteAll, chat.adminOnly, me?.id])
```

#### 三层锁定

1. **输入区替换**：`!speakGate.ok` 时渲染 `<div className="muted-bar">` 而不是 `<Composer>`，用户根本打不了字
2. **加号面板锁定**：`PlusSheet` 的媒体入口（图片 / 视频 / 文件 / 位置）在禁言时全部 `disabled`，防止绕过输入区直接发图
3. **服务端 `canSpeak()`**：真正的拦截，REST 发消息 / 发投票都走它，返回 `403`

#### 不显然的几个点

- ★ **投票入口和输入区共用同一个 `speakGate`。** 投票在聊天里表现为一条消息，禁言却能发起投票就等于绕过了群治理。
- ★ **转发按钮的 disabled 不看 `speakGate`。** 转发是发到目标会话，不是当前会话（见「消息转发」一节）。
- ⚠️ **`speakGate` 和 `pollGate` 是同一个对象的别名**（`const pollGate = speakGate`），改一处两处一起变 —— 两处各写一份判据迟早走岔。

---

## 动态

动态（PRD §16「轻量内容流」）的数据全部来自后端，五个表：
`moments` / `moment_media` / `moment_likes` / `moment_comments` / `follows`。

```
GET    /api/v1/moments?scope=friends|mine|hot&beforeId=&limit=
POST   /api/v1/moments                      发布
GET    /api/v1/moments/:id                  详情
PATCH  /api/v1/moments/:id                  编辑（仅作者）
DELETE /api/v1/moments/:id                  删除（仅作者）
POST   /api/v1/moments/:id/like             点赞 / 取消（同一接口来回切）
GET    /api/v1/moments/:id/likes            点赞的人
GET    /api/v1/moments/:id/comments         评论列表（扁平，靠 parentId 组树）
POST   /api/v1/moments/:id/comments         发评论 / 回复（带 parentId）
DELETE /api/v1/moments/:id/comments/:commentId
POST   /api/v1/moments/upload?kind=image|video    媒体上传（kind 在 query 上）
POST   /api/v1/users/:id/follow  ·  DELETE 同路径   关注 / 取关
```

### 可见范围是真的在拦

| 取值 | 谁能看 |
| --- | --- |
| `public` | 所有人 |
| `friends` | 作者 + **与作者互相关注**的人 |
| `private` | 只有作者 |

判定只有一处：`moment.js` 的 `visibleTo()`，列表与详情共用。
详情对看不见的人返回 **404 而不是 403** —— 与「不存在」同码，不泄漏「这条其实存在，只是你看不到」。

### 不显然的几个点

- **图片 / 视频选中即上传**，不是「先本地预览、发布时才传」。
- **编辑是「媒体整体替换」**：传 `media` 就整套换掉，不传就不动。
- **文本长度按码点算**（`[...s].length`）：`'😂'.length === 2`。
- **视频与图片互斥**：一条动态要么图文、要么 1 个视频。
- **视频要验文件头魔数**（`looksLikeVideo()`）。扩展名和 MIME 都是客户端给的。
- **自建播放器**（`VideoPlayer.jsx`，不用原生 `controls`）：原生控件会带出「画中画 / 下载」这些没接的按钮。

---

## 发现

```
GET    /api/v1/discover/recommend?tag=&limit=&offset=   推荐用户（带理由 / 排序）
GET    /api/v1/discover/nearby?limit=                   附近的人（按资料地区，无公里数）
GET    /api/v1/discover/tags                            兴趣标签聚合
GET    /api/v1/discover/groups                          可加入的公开兴趣群
POST   /api/v1/discover/groups/:id/join                 加入公开群
```

### 三条硬规矩

1. **推荐理由必须可解释。** 只能由「共同群聊 / 共同兴趣标签 / 同城」算出来，算不出就给 `null`。
2. **距离不编公里数。** 库里没有经纬度。附近的人按资料里的**地区**匹配。
3. **没有数据源的板块不做。** 活动、热门话题榜、精准定位附近都没有对应的表 —— 前端渲染成禁用项并写明原因。

---

## 我

- 个人空间：封面 + 上浮头像卡、会话 / 动态 / 收藏统计（**都是真实数据**）、性别 / 地区 / 兴趣标签回显、退出登录
- 四宫格：我的动态 / 收藏 / 稍后看 / 最近文件
- **收藏**：读真实后端，五种消息形态（文字 / 图片 / 文件 / 位置 / 投票）各画各的卡片
- 账号与安全、隐私设置、消息通知、主题外观
- 编辑资料：**真实读写后端** —— 昵称、个性签名、性别、生日、所在地区、兴趣标签，以及头像

---

## 用户资料与头像

- **编辑资料**：昵称 / 签名 / 性别 / 生日 / 地区 / 兴趣标签，逐项做服务端校验
- **头像三种来源**：上传（canvas 裁剪）、预设（12 个内置插画）、未设置（按 id 生成彩色首字）
- **他人资料页**：展示昵称、`@账号`、在线态、签名、性别、生日、地区、兴趣标签，以及共同群聊数
- 生日只给「月-日 + 年龄」、**不暴露出生年**
- 资料变更通过 WebSocket `user.updated` 广播

---

## 媒体查看器

点开一条**图片**或**视频**消息，会全屏打开查看器：

|      | 行为                                    |
| ---- | ------------------------------------- |
| 关闭   | 左上角「关闭」按钮 / 点空白处 / `Esc`               |
| 保存   | 右上角「保存」按钮（真实下载到本地）              |
| 图片   | 等比缩放居中显示                              |
| 视频   | 自己的播放器（`VideoPlayer`，`mode="full"`）—— 静音起播 |
| 底部   | 文件名 · 体积 · 视频时长                        |

### 不显然的几个点

- **视频有两种来源，都要认。** `kind === 'video'` 和 `kind === 'file'`（扩展名是视频）都走播放器。
- **查看器用未夹取的真实比例**：比例夹取是为了信息流卡片，查看器已经有 `max-height:100%` 兜底。
- **控制条 5 秒没用会自动收起**，暂停 / 播完 / 指针移入 / 点画面立刻回来。

---

## 扫一扫 / 我的二维码

两个入口、三条路径、四种结果，**全部是真实动作**：

| 码里是什么 | 界面做什么 |
| --- | --- |
| `chatly://user/<ID>` | 资料卡 → **加好友** + **发消息** |
| 自己的码 | 标「这是你自己的码」，不给加好友按钮 |
| `chatly://group/<id>` · `chatly://moment/<id>` | 认得出类型，写明「会在后续版本加入」 |
| `http(s)://…` · 纯文本 | 原样展示 + 复制 |

### 为什么编解码都是自己写的

桌面 Chrome **没有 `BarcodeDetector`**，项目又硬约束零运行时依赖。所以 `src/lib/qr.js` 从 GF(256) 到仿射采样全部自己实现。

---

## 表情面板

输入框右侧的表情按钮打开面板，分「表情」与「大表情」两档。

|     | 表情                                                    | 大表情               |
| --- | ----------------------------------------------------- | ----------------- |
| 点一下 | 在输入框**光标处**插入一个真实 Unicode 字符                          | 直接发一条贴纸式大图消息      |
| 候选  | 9 个分组 + 搜索 | 47 个精选 |
| 渲染  | 跟随系统字体，与文字一起排，可复制                                     | 96×96，无气泡无边框      |

**素材与授权**：386 个素材全部是 [Microsoft Fluent Emoji](https://github.com/microsoft/fluentui-emoji) 的 **Color** 风格彩色 SVG，授权 **MIT**。

---

## 设计规范

- **主色**：紫蓝渐变 `#9b8cfb → #7b5cf6 → #5b6ef5`
- **强调色**：荧光蓝 `#39c9f5` / 薄荷绿 `#34d3a6` / 粉 `#f97ca8` / 琥珀 `#ffb43f`
- **背景**：暖白 `#f7f7fb`
- **特征**：大圆角、卡片式内容、轻阴影、半透明层、柔和渐变、大留白、细腻微动效
- **字体**：Noto Sans SC / 思源黑体，正文 weight 450+
- 全量令牌见 `src/styles/tokens.css`

---

## 验证与自检

```bash
# 后端接口 + WebSocket + 资料 / 头像上传 + 消息 fileUrl 白名单（70 项断言）
node server/test/e2e.mjs

# 双浏览器实时联调：两个账号互相收发（20 项断言）
node scripts/e2e-realtime.mjs

# 引用回复 + 消息转发专项（45 项断言）
# 覆盖：replyToId 校验（存在性 / 同会话 / 禁私聊外泄 / 未撤回 / id 合法）、
#       canSpeak 禁言门控（全员禁言 → 403、群主仍可发言、投票也受约束）、
#       转发逐条处理（撤回跳过 / 投票跳过 / 引用剥离 / 新 sender）、
#       浏览器（长按菜单回复 / 引用条 / 引用块跳转 / 转发选择器 / 搜索 / 发送 / 落库）
node scripts/check-reply-forward.mjs

# 长按手势专项（14 项断言）
# 覆盖：长按 480ms 弹菜单 / 短按不弹菜单 / 移动手指取消 / 菜单项正确 /
#       图片消息也能长按 / 控制台无报错
node scripts/check-longpress.mjs

# 群投票专项（129 项断言）
node scripts/check-poll.mjs

# 消息收藏专项（85 项断言）
node scripts/check-favorite.mjs

# 动态专项（51 项断言）
node scripts/check-moment.mjs

# 视频动态专项（71 项断言）
node scripts/check-video.mjs

# 发现页专项（88 项断言）
node scripts/check-discover.mjs

# 扫一扫 / 我的二维码专项（50 项断言）
node scripts/check-qr.mjs

# 群聊专项（34 项断言）
node scripts/check-group.mjs

# 用户资料与头像专项（72 项断言）
node scripts/check-profile.mjs

# 已读回执专项（38 项断言）
node scripts/check-readreceipt.mjs

# 图片 / 视频查看器专项
node scripts/check-media.mjs

# 表情面板专项
node scripts/check-emoji.mjs

# 长会话可滚动性 / 短会话贴底（15 项断言）
node scripts/check-scroll.mjs

# 布局回归
node scripts/check-align.mjs     # 头像贴外缘、气泡不同侧
node scripts/check-narrow.mjs    # 390×844 / 360×780 无横向溢出
node scripts/check-console.mjs   # 全界面 console 报错 / 非法 DOM 嵌套 / 资源 404
node scripts/audit-ui.mjs        # 全界面缺陷扫描（横向溢出 / 越界 / 文本截断 / 有效点击区）

# 渲染截图
node scripts/shoot.mjs && node scripts/shoot2.mjs
```

以上脚本都用 CDP 驱动本机已安装的 Chrome，需要前端（5198）与后端（3002）都在运行。

### 自检**不能假设演示库是干净的**

发现页上就有「关注 / 加入群」按钮，用户会在预览里随手点。自检如果写死前提，用户点两下之后就会崩。
所以每个脚本都要**自己造前提**，并在收尾还原。

判断依据很简单：**这个前提，用户能在界面上改掉吗？** 能，就必须自己造。

### 消息清理按「基线」而不是按「记住的 id」

开跑前记下 `maxMessageId()`，收尾 `purgeMessagesAfter(基线)`。
逐个收集 id 的做法一定会漏 —— **撤回测试最容易漏**：撤回不是删除，消息行还在。

### 上传文件由 `purgeOrphanUploads()` 统一回收

扫 `users.avatar` + `messages.file_url` + `conversations.avatar` + `moment_media.url` + `favorites.file_url` 五处引用，
没人指的**移到** `.tmp/orphan-uploads/`（不删，误判了还能捞回来）。
⚠️ 必须在清完消息之后再调 —— 反过来的话刚发的图还被消息指着，扫不到。

---

## 说明

- 所有演示数据（用户、头像、动态、位置）均为**虚构**，不含任何真实用户信息。
- 上传文件与 SQLite 库存放在 `server/data/` 与 `server/uploads/`，已在 `.gitignore` 中排除。
- 第三方素材只有两处，且都是 Microsoft Fluent Emoji（**MIT**，免署名）：
  - `public/emoji/` 的 386 个静态表情 —— 上游文件的原样拷贝，仅重命名为 Unicode 码点
  - `public/emoji-anim/` 的 30 个动画大表情 —— 来自**另一个仓库** `fluentui-emoji-animated`，上游是 APNG，本项目用 ffmpeg **转码为 GIF**
- 其余图形（图标、预设头像、封面）全部是项目内手写生成，无第三方依赖。

---

## License

MIT
