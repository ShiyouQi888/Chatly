# Chatly

> 连接更有趣的人 —— 移动端聊天通讯 App

基于《移动端聊天通讯软件功能书》（47 节 PRD）实现。覆盖 **聊天 / 动态 / 发现 / 我** 四大板块，
其中**聊天 / 动态 / 发现 / 位置 / 群文件 / 群公告与通知 / 群投票 / 消息收藏 / 引用回复 / 消息转发 / 隐私门控 / 在线状态**已接通独立后端
（REST + WebSocket + JWT，数据层**双驱动**：本地 SQLite / 线上 PostgreSQL；在线状态可选接入 Redis），
通知中心、状态和稍后看也已接入后端。项目仍是功能原型，通话和正式生产运维保障尚未完成；具体边界见下方功能状态。

> 每一页都遵守同一条底线：**界面上的每个数字、每句话、每次点击都要能追到库里的一行数据**。
> 追不到的，就标「未接入」并禁用 —— 不做一个点了弹 toast 假装成功的假按钮。

---

## 目录

- [快速开始](#快速开始)
- [运营管理后台](#运营管理后台)
- [功能概览](#功能概览)
- [技术选型](#技术选型)
- [目录结构](#目录结构)
- [后端](#后端)
  - [数据库：本地 SQLite / 线上 PostgreSQL](#数据库本地-sqlite--线上-postgresql)
  - [在线状态与跨实例广播（Redis，可选）](#在线状态与跨实例广播redis可选)
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
- [部署与运维](docs/OPERATIONS.md)
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

打开 <http://127.0.0.1:5198>，使用已注册的账号登录，或通过邮箱验证码注册。

生产构建：

```bash
npm run build && npm run preview
```

### Docker 完整部署

仓库提供完整前后端容器编排。先复制 `.env.docker.example` 为项目根目录 `.env`，将三个必填秘密替换为独立强随机值（可用 `openssl rand -hex 32` 生成），然后运行：

```bash
docker compose -f docker-compose.app.yml up --build -d
```

默认通过部署主机本机的 `http://localhost:8080` 访问。前端 Nginx 会把 `/api`、`/uploads`、`/health` 和 `/ws` 转发给后端；PostgreSQL、Redis 及公开/私有上传文件使用命名卷持久化。Web 默认仅绑定宿主机回环地址，数据库、Redis 和后端只在 Docker 内网可访问。生产环境应在前面配置 HTTPS 反向代理；需要直接对外发布 Web 时，将 `CHATLY_BIND_ADDRESS` 设为 `0.0.0.0` 并确保 TLS 与防火墙已配置。

查看容器状态和日志：

```bash
docker compose -f docker-compose.app.yml ps
docker compose -f docker-compose.app.yml logs -f server web
```

停止容器但保留数据：

```bash
docker compose -f docker-compose.app.yml down
```

`down -v` 会删除数据库、Redis 和上传文件卷，请勿用于日常停机。

> 前端端口固定 `127.0.0.1:5198`（`strictPort`），后端固定 `127.0.0.1:3002`。
> Vite 已把 `/api`、`/uploads`、`/ws` 代理到后端，前端代码里不需要写后端地址。

## 运营管理后台

后台地址为 <http://127.0.0.1:5198/qishiyou>。在 `server/.env` 或 Docker 根目录 `.env` 配置一个固定管理员账号：

```dotenv
ADMIN_ACCOUNT=chenmo
```

用户 ID 可在 SQLite 数据库中通过 `SELECT id, username FROM users;` 查询。更改配置后重启后端。后台 API 会在服务端逐次校验管理员名单；群主或群管理员权限不会自动获得运营后台权限。

`ADMIN_ACCOUNT` 可填写用户名或用户 ID，仅第一个配置账号拥有超级管理员权限；后台运营成员仍可由超级管理员按角色授权。停用账号会撤销其所有登录设备。后台不开放手机号、精确位置或私聊正文读取。集中日志、历史监控告警和自动备份/恢复仍需接入独立运维与备份服务，健康页会明确显示当前能力边界。

---

## 功能概览

| 板块 | 功能 | 后端接入 |
| --- | --- | :---: |
| **聊天** | 私聊 / 群聊 / 文字 / 语音消息 / 图片 / 文件 / 位置 / 表情 / 视频消息 / 已读回执 / 撤回 / 引用回复 / 消息转发 / 全文搜索 / 群投票 / 群文件 / 群公告及成员提醒 / 消息收藏 / 稍后看 / 长按手势 / 禁言锁定 | ✅ |
| **通讯录** | 互关联系人列表 / 姓名与账号搜索 / 联系人菜单 / 查看资料 / 发消息 / 单个或批量删除 / 群聊列表与创建 | ✅ |
| **群管理** | 群资料 / 群公告 / 成员管理 / 权限三档 / 全员禁言 / 仅管理员发言 | ✅ |
| **动态** | 图文 / 视频 / 发布 / 编辑 / 点赞 / 评论 / 可见范围（公开 / 仅好友 / 仅自己） | ✅ |
| **发现** | 推荐用户 / 附近 / 公开群 / 活动报名 / 热门话题榜 / 关注 / 标签筛选 | ✅ |
| **我** | 资料编辑 / 头像裁剪 / 我的动态 / 我的收藏 / 二维码 / 扫一扫 / 关于我们 / 帮助与反馈 / 通用设置 / 主题外观 / 稍后看 / 最近文件 / 消息通知 / 隐私设置 / 账号与安全 | ✅ |
| **扫一扫** | 摄像头扫码 / 相册选图 / 手输 ID / 加好友 / 发消息 | ✅ |
| **表情** | 386 彩色 SVG + 30 动画 GIF / 9 分组 / 搜索 / 大表情直发 | ✅ |
| **二维码** | 零依赖编解码 / 我的二维码 / 扫一扫 | ✅ |

**部分实现或尚未接入**：

- 未接入：语音与视频通话、群主转让。
- 部分实现：全文消息搜索最多扫描最近 5,000 条文字消息，图片 / 文件内容不可检索；语音消息录制受浏览器麦克风能力限制；消息加密是服务端存储加密，不是端到端加密。
- 动态视频可上传、列表预览并在动态详情中播放；视频通话与实时媒体服务未接入。
- 群文件、群公告发布/推送和通知中心已接入，不再属于占位功能。

---

## 技术选型

| 项       | 说明                                                                                 |
| ------- | ---------------------------------------------------------------------------------- |
| 前端      | React 18 + Vite 5                                                                  |
| 前端运行时依赖 | React 18、Radix UI 原语、shadcn 风格后台组件与 Lucide 图标                                      |
| 图标      | 客户端常用图标由 `src/components/Icon.jsx` 绘制；运营后台使用 Lucide                             |
| 表情      | Microsoft Fluent Emoji（MIT），386 个彩色 SVG 落在 `public/emoji/`，清单见 `src/data/emoji.js` |
| 图像      | 头像由 data-URI SVG 生成；聊天图片走真实上传                                                      |
| 样式      | 每屏独立 CSS + `tokens.css` 设计令牌                                                       |
| 状态      | `useReducer` + Context（Auth / App / Chat / Favorite 四层）                                       |
| 后端      | Express 5 + `ws` + `jsonwebtoken` + `multer`                                         |
| 数据库     | **双驱动**：本地 `node:sqlite`（零依赖）/ 线上 PostgreSQL（`pg`，靠 `DB_DRIVER` 切换）           |
| 在线状态    | 进程内内存表；配 `REDIS_URL` 后升级为 **Redis 跨实例**（可选、连不上自动降级）                        |

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
│   ├── LoginScreen.jsx    登录 / 注册（用户名登录、邮箱验证注册）
│   ├── ChatTab.jsx        聊天首页（真实状态 + 会话列表 + 建群/私聊）
│   ├── ChatRoom.jsx       私聊 / 群聊（真实收发 + 已读回执到人 + 撤回 + 引用回复 + 转发 + 长按菜单 + 禁言锁定）
│   ├── UserProfile.jsx    他人资料页（整屏覆盖层，从聊天顶部头像 / 会话设置进入）
│   ├── GroupSettings.jsx  群设置页（整屏覆盖层：群头像 / 群名 / 公告 / 成员管理 / 群开关 / 群投票列表 / 退出）
│   ├── MomentTab.jsx      动态内容流（朋友 / 我的 / 热门 + 点赞 + 管理入口）
│   ├── MomentDetail.jsx   动态详情（整屏覆盖层：正文 / 点赞的人 / 评论树 / 回复）
│   ├── DiscoverTab.jsx    发现（推荐 / 附近 / 活动 / 话题 / 群组 / 用户）
│   ├── MeTab.jsx          我（个人空间 + 设置子页 + 收藏 + 退出登录）
│   ├── MyQrPage.jsx       我的二维码（子页：码 + 头像昵称 + 保存卡片图 + 复制 ID）
│   ├── ScanPage.jsx       扫一扫（整屏层：摄像头 / 相册 / 手动 ID + 四种结果卡）
│   ├── NoticeCenter.jsx   通知中心
│   ── SearchPanel.jsx    全局搜索
├── lib/
│   ├── qr.js              零依赖二维码编解码（编码给「我的二维码」/ 解码给「扫一扫」）
│   └── qrPayload.js       chatly:// 负载的生成与解析（群码 / 动态码留了扩展位）
├── store/
│   ├── AuthContext.jsx    用户 / token / 登录登出
│   ├── AppContext.jsx     Tab / Toast 等全局 UI 状态
│   ├── ChatStore.jsx      真实会话与消息（REST + WS）+ 投票详情缓存
│   ├── MomentStore.jsx    真实动态（列表 / 发布 / 编辑 / 删除 / 点赞 / 评论）
│   ├── DiscoverStore.jsx  发现页数据（推荐 / 附近 / 活动 / 话题 / 标签 / 群组 / 热门）
│   └── FavoriteStore.jsx  消息收藏（列表 / 收藏 / 取消 / 批量 + 「这条收藏了没」的 Set）
├── data/
│   ├── themes.js          主题配置
│   ├── emoji.js           表情清单（码点 / 分组 / 中文名 / 大表情精选）—— 由脚本生成，勿手改
│   └── emoji-anim.js      动画大表情地址表（30 条 .gif）—— 由脚本生成，勿手改
└── styles/                tokens.css + global.css（含整屏层补底的 .cover-tabbar）

public/emoji/              386 个彩色 SVG（Microsoft Fluent Emoji，MIT）+ LICENSE.txt
public/emoji-anim/         30 个动画大表情 GIF（fluentui-emoji-animated，MIT）+ LICENSE.txt
scripts/
├── verify.mjs               统一快速 / 完整回归入口
├── check-core-flows.mjs     登录 / 公告 / 搜索 / 上传 / 权限核心链路
├── check-parse.mjs          JSX / import 解析与路径检查
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
├── check-privacy.mjs         隐私门控专项自检（添加好友三开关 + 在线状态可见 + 手机号不泄露）
├── check-presence.mjs        在线状态专项自检（本地推送 / Redis 跨实例 / 无 Redis 降级）
├── check-driver.mjs          ★ 数据层跨驱动契约自检（同一套用例 SQLite 与 PG 都要过）
├── check-emoji.mjs           表情面板专项自检
├── check-scroll.mjs          长会话可滚动性自检
├── check-align.mjs           布局回归自检
├── check-narrow.mjs          窄屏无横向溢出自检
── check-console.mjs         全界面 console 报错 / 非法 DOM 嵌套自检
├── audit-ui.mjs              全界面缺陷扫描（横向溢出 / 越界 / 文本截断 / 有效点击区）
├── e2e-realtime.mjs          双浏览器实时联调自检
├── lib/
│   ├── cdp.mjs               CDP 调试端口动态分配 + target 归属校验 + 浏览器启动（自检共用）
│   ├── debris.mjs            自检残留清理（按标题前缀 + 孤儿会话 + 孤儿上传文件）
│   ├── gif.mjs               GIF 封装解析 / 处置方式补丁 / 安全播放断言
│   ├── png.mjs               零依赖 PNG 编解码（自检用：把屏幕上的码当图片读回来）
│   └── qr-verify.mjs         二维码编解码交叉验证（与 npm 的 qrcode + jsqr 对拍，69 项）
── fetch-emoji.mjs           抓取 / 生成静态素材与清单
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
│   └── routes/            auth / conversations / messages / users / moments / discover / geo / polls / favorites / files / notifications / statuses
├── test/e2e.mjs           后端端到端测试
── data/                  SQLite 库（运行时生成，不入库）
└── uploads/               上传文件（运行时生成，不入库）
```

---

## 后端

独立进程。数据层是**门面 + 双驱动**：`server/src/db.js` 是门面，`server/src/db/` 下是
`sqlite.js`（`node:sqlite`，本地开发与全部自检的默认值，零外部依赖）与 `postgres.js`（线上）。
靠 `DB_DRIVER` 切换，业务代码只认门面导出的 `q` / `tx`，**看不到驱动差异**。

| 能力 | 实现                                                                                                                 |
| -- | ------------------------------------------------------------------------------------------------------------------ |
| 认证 | JWT（7 天），REST 用 `Authorization: Bearer`，WebSocket 用 `?token=`                                                      |
| 密码 | `node:crypto` scrypt（`scrypt$salt$hash`），不引 bcrypt                                                                 |
| 实时 | `ws` —— `hello` / `message.new` / `message.revoked` / `conversation.read` / `typing` / `presence` / `user.updated` / `conversation.updated` / `poll.updated` |
| 存储 | 双驱动：SQLite（WAL）/ PostgreSQL。17 张表：`users` / `conversations` / `conversation_members` / `messages` / `moments` / `moment_media` / `moment_likes` / `moment_comments` / `follows` / `polls` / `poll_options` / `poll_votes` / `poll_replies` / `favorites` |
| 在线状态 | 进程内内存表；配了 `REDIS_URL` 则升级为 **Redis**（按用户的 ZSET，见下）——**可选、可降级** |
| 资料 | 扩展字段 `gender` / `birthday` / `region` / `tags` / `phone`，用幂等迁移（SQLite 没有 `ADD COLUMN IF NOT EXISTS`）          |
| 上传 | multer → `server/uploads/`；附件 20MB、头像 5MB；扩展名与 MIME 双重校验                                                           |

发消息走 REST（便于落库并拿到消息 id），WebSocket 只负责下行推送与 `typing` 上行。

> `users` 表结构变更一律走驱动的 `addColumnIfMissing()`（PG 侧是 schema 里的 `ALTER TABLE … ADD COLUMN IF NOT EXISTS` +
> `BACKFILL_COLUMNS`），不要让人去跑 `npm run reset` —— reset 会连会话和消息一起清掉。
> `seed.js` 的 `backfillProfiles()` / `backfillPhones()` 只补空字段，老库直接启动即可。

```bash
cd server
npm run dev      # node --watch src/index.js
npm run reset    # 清空并重建演示数据
node test/e2e.mjs   # 后端端到端测试（70 项断言）
```

### 数据库：本地 SQLite / 线上 PostgreSQL

一次只用一种，由 `DB_DRIVER` 决定（默认 `sqlite`）。**两种驱动跑同一套自检**，
`DB_DRIVER=postgres node scripts/check-privacy.mjs` 能原样再跑一遍 —— 这就是「双驱动不是两套代码」的证据。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DB_DRIVER` | `sqlite` | `sqlite` 或 `postgres` |
| `DATABASE_URL` | — | 仅 PG 需要，如 `postgres://chatly:chatly_dev_pw@127.0.0.1:55433/chatly` |
| `PG_POOL_MAX` | `10` | 连接池上限（进程数 × 这个值别超过 PG 的 `max_connections`） |
| `DB_PATH` | `./data/chatly.db` | 仅 SQLite |

本机没有 PostgreSQL / Redis 时，仓库根的 `docker-compose.yml` 一条命令起两个容器：

```bash
docker compose up -d          # postgres:16-alpine → 55433:5432，redis:7-alpine → 6380:6379
docker compose ps             # 等 healthcheck 变 healthy
```

> 端口**故意错开**：本机 5432 / 6379 常有真的服务在跑，容器映射到 55433 / 6380，互不打架。
> 两个容器都有 healthcheck（`pg_isready` / `redis-cli ping`），业务进程不用自己轮询等待。

### 在线状态与跨实例广播（Redis，可选）

**不配 `REDIS_URL` 也能完整运行** —— 在线状态退回「单进程内存表」，广播退回「进程内直发」。
配了之后：

- **在线表用「按用户的 ZSET」**，member = 实例 id，score = 该实例的过期时刻。
  为什么不直接 `SET presence:<uid> 1 EX 45`：一个用户可能同时连着实例 A 和 B，
  A 断开时直接 `DEL` 会把 B 上活着的连接**误判下线**。判在线 = 有没有 `score > now` 的成员；
  断开只 `ZREM` 自己那一条；陈旧成员在**读取时**顺带 `ZREMRANGEBYSCORE` 清掉。
- **广播走 pub/sub**（`chatly:events`），事件带 `origin`（实例 id），订阅端跳过自己发的 ——
  本地投递由 `broadcastToUsers` 立即完成，不走回环，否则会重复推送。
- **心跳**按 `PRESENCE_TTL / 3` 自动续期（默认 TTL 45s → 每 15s 一次），
  进程被 `kill -9` 收不到 `close` 时靠 TTL 自己过期。

| 状态 | 含义 | 行为 |
| --- | --- | --- |
| `on` | 连上了 | 在线状态与广播跨实例生效 |
| `degraded` | 配了但连不上 | 退回单进程，**一条警告**，不刷屏、不阻塞启动 |
| `off` | 没配 | 单进程内存模式（本地开发 / 自检就是这样） |

`/health` 会回报当前状态：`{"redis":{"state":"on","configured":true,"url":"…","ttlSec":45,"instanceId":"…"}}`。

> 与数据层的失败策略**相反**：数据库连不上要「早失败」（启动即报错），
> Redis 连不上要「晚降级」（照常启动，只是退回单进程）—— 前者错了整站没数据，后者错了只是广播范围小一点。

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

- 登录 / 注册 / JWT 会话保持（刷新不丢登录态）；用户名密码登录兼容旧账号，新账号可独立选择手机号短信验证码注册或邮箱验证码注册，手机号与邮箱均可用于密码登录
- 会话列表：真实未读计数、最后一条消息预览、在线状态、置顶、免打扰
- 私聊与群聊：建群选人、发起私聊
- **群聊管理与群公告**：群头像 / 群名 / 群公告、邀请与移出成员、设 / 撤管理员、
  全员禁言与仅管理员发言、退出群聊，权限按群主 / 管理员 / 成员三档收敛
- 文字消息：发送（乐观更新）、实时收发、撤回（2 分钟内、仅本人）
- 语音消息：点击麦克风录制（最长 2 分钟），停止后上传并作为会话成员可访问的消息播放；需要 HTTPS 或 localhost 麦克风权限
- 全文搜索：检索用户可访问的最近 5,000 条文字消息，结果可跳转至原会话消息
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

**尚未接入：** 语音与视频通话、群主转让。

**部分实现：** 全文搜索扫描最近 5,000 条文字消息，不检索图片 / 文件内容；语音录制取决于浏览器的 MediaRecorder 和麦克风权限。消息加密是服务端存储加密，不是端到端加密。
群文件、公告推送、稍后看、最近文件和通知中心均使用服务端数据。

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

- ★ **点文字气泡不再挂引用。** 原来 `.bubble` 上挂了 `onClick={() => onReply(m)}`，真机上想复制 / 选中文字时一点就进引用态，只能去输入区按 ，这是误触。现在引用**只从长按菜单的「回复」进**。
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
- ️ **`speakGate` 和 `pollGate` 是同一个对象的别名**（`const pollGate = speakGate`），改一处两处一起变 —— 两处各写一份判据迟早走岔。

---

## 24 小时状态

聊天页状态栏读取真实数据。每人同时保留一条状态，发布新状态会替换旧状态；状态仅对互相关注的好友可见，24 小时后过期。浏览状态会记录查看人，发布者可以查看浏览列表。

```
GET    /api/v1/statuses             当前用户与好友的有效状态
POST   /api/v1/statuses             发布状态（content、mood）
POST   /api/v1/statuses/:id/view    记录查看
DELETE /api/v1/statuses/:id         删除自己的状态
```

状态目前为文字和心情图标，不包含图片或视频。

## 动态

动态（PRD §16「轻量内容流」）的数据全部来自后端，五个表：
`moments` / `moment_media` / `moment_likes` / `moment_comments` / `follows`。

```
GET    /api/v1/moments?scope=friends|mine|hot&beforeId=&limit=   列表
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
- **文本长度按码点算**（`[...s].length`）：`''.length === 2`。
- **视频与图片互斥**：一条动态要么图文、要么 1 个视频。
- **视频要验文件头魔数**（`looksLikeVideo()`）。扩展名和 MIME 都是客户端给的。
- **自建播放器**（`VideoPlayer.jsx`，不用原生 `controls`）：原生控件会带出「画中画 / 下载」这些没接的按钮。

---

## 发现

```
GET    /api/v1/discover/recommend?tag=&limit=&offset=   推荐用户（带理由 / 排序）
GET    /api/v1/discover/nearby?limit=                   附近的人（默认按地区；双方授权后按城市中心点估算）
GET    /api/v1/discover/tags                            兴趣标签聚合
GET    /api/v1/discover/groups                          可加入的公开兴趣群
POST   /api/v1/discover/groups/:id/join                 加入公开群
GET    /api/v1/discover/activities                      当前用户有权查看的未开始活动
GET    /api/v1/discover/topics                          近 30 天公开动态话题榜（合并近 7 天去重浏览）
POST   /api/v1/discover/topics/:topic/view              记录用户打开话题（每人每话题去重）
GET    /api/v1/discover/topics/:topic/moments           查看该话题下有权访问的动态
```

### 三条硬规矩

1. **推荐理由必须可解释。** 只能由「共同群聊 / 共同兴趣标签 / 同城」算出来，算不出就给 `null`。
2. **附近分享默认关闭。** 发现页不主动定位；用户需在资料页明确授权并手动点击定位。服务端只保存城市中心点，关闭授权会清除坐标。
3. **距离不冒充实时距离。** 只有双方都授权时才显示城市中心点间的估算；否则按资料地区匹配，不显示公里数。
4. **话题榜有边界。** 榜单只统计近 30 天公开动态；打开话题按用户去重计入近 7 天浏览热度；详情只返回当前用户有权限查看的动态。

---

## 我

- 个人空间：封面 + 上浮头像卡、会话 / 动态 / 收藏统计（**都是真实数据**）、性别 / 地区 / 兴趣标签回显、退出登录
- 四宫格：我的动态 / 收藏 / 稍后看 / 最近文件
- **收藏**：读真实后端，五种消息形态（文字 / 图片 / 文件 / 位置 / 投票）各画各的卡片
- **稍后看**：长按菜单标记消息，与收藏的区别是引用而非快照（消息撤回后条目消失）
- **最近文件**：扫描所有会话中的文件消息，按类型筛选（文档 / 图片 / 视频 / 压缩包 / 其他）
- 设置列表七行（账号与安全 / 隐私设置 / 通用设置 / 主题外观 / 消息通知 / 帮助与反馈 / 关于我们）——
  **逐项标注真实生效范围**，见下面的「设置列表七行：哪些是真的」
- 编辑资料：**真实读写后端** —— 昵称、个性签名、性别、生日、所在地区、兴趣标签，以及头像

> ⚠️ 这一页曾经有一批「不会报错、也不会有反应」的缺陷，读下面这张表之前先看这里：
> `general` / `help` / `about` 三行**当时根本没有渲染分支** —— 组件 import 了、
> 列表里也写着 `setPage('general')`，但下面没有对应的 `if`，`page` 变了却匹配不上任何分支，
> 于是直接落到主页面的 `return`：**点了什么都不发生**。
> 同时七个设置子页的根节点类名是 `.sub-page`，而 CSS 里只定义了 `.subpage`
> —— 于是没有 `position:absolute; inset:0`、没有 flex 纵向排布、没有补底，
> 标题栏不跟着固定、正文被底部导航栏压住。
> 这两类问题都不报错，只能靠「点开之后页面必须真的离开主页面」+ 几何量去证。

### 设置列表七行：哪些是真的

| 入口 | 点开后 | 真的生效的东西 | 明确不做的东西 |
| --- | --- | --- | --- |
| 账号与安全 | ✅ | 退出登录（真调 `logout()`）、设备列表 / 远程退出（真读写 `user_devices`） | 手机号 / 邮箱 / 改密码（没有这些字段）；生物识别、二次验证 —— 开关 `disabled` 并写明原因 |
| 隐私设置 | ✅ | 动态默认可见范围、添加好友、在线状态、文字消息加密存储、已读回执、阅后即焚 | 截屏提醒未接入；消息加密是服务端存储加密，不是端到端加密 |
| 通用设置 | ✅ | 字体大小（真写 `--font-scale`）、聊天列表左滑删除、回车键发送、自动下载图片 | 语言（只有中文） |
| 主题外观 | ✅ | 5 套主题（真写 `--brand-*`）、**动效开关**（真挂 `.no-motion`，和 `prefers-reduced-motion` 同一套规则）、当前字体大小只读回显 | 聊天背景 / 气泡颜色 / 强调色 —— 标 `未接入` |
| 消息通知 | ✅ | 通知中心 / 偏好设置 / WebSocket 在线提醒 | 系统运营通知尚无产生方；提醒方式受浏览器权限与当前页面状态限制 |
| 帮助与反馈 | ✅ | FAQ（逐条对齐真实实现）、**反馈真的落库**到 `feedbacks` 表 + 截图真的上传到磁盘 | — |
| 关于我们 | ✅ | 版本号 / 关于信息 | 纯静态页 |

**「消息加密」是服务端存储加密**：开启后新文字消息使用 AES-256-GCM 加密存入数据库；
服务端持有密钥并会解密消息，所以这不构成端到端加密。

同类问题还有一处：通用设置里的标签原本写「发送键回车换行」，
而 `chatly-enter-to-send` 为 `true` 时回车是**发送** —— 字面意思和实际行为正好相反，已改为「回车键发送」。


### 我页面功能详情

#### 关于我们

展示应用信息、版本历史、开源许可。纯静态页面，数据硬编码在组件内。

```
src/screens/AboutPage.jsx
```

#### 帮助与反馈

常见问题按分组展示（账号 / 聊天 / 动态 / 隐私 / 安全），**单开手风琴**（展开一条会收起上一条）。
FAQ 文案逐条对齐真实实现 —— 不再谎称「撤回仅支持 2 分钟内」（服务端**没有时间窗**）、
不再谎称「开启后新会话将使用端到端加密」、不再教人「长按 → 转发」（转发是禁用态）、
不再说发布按钮在右下角（实际在**右上角**）、不再教人换手机号（**没有这个字段**）。

反馈表单：类型 / 描述（必填，按码点限 1000 字）/ 截图 / 联系方式。

```
POST /api/v1/feedback/screenshot   上传截图（复用 uploadImage：扩展名 + MIME 双校验，5MB）
POST /api/v1/feedback              提交反馈
```

服务端落库规则：描述必填、`type` 走白名单且未知值回落 `other`、
`screenshotUrl` **必须过 `isStaticAssetUrl`**（外链一律丢弃存 `NULL`，不让库里出现任意外链）。

> ⚠️ `feedbacks.screenshot_url` 是那个文件**唯一**的引用者（提交时复制的地址，
> 原上传记录不指向它），所以 `purgeOrphanUploads()` 必须扫这张表 ——
> 漏了不是「少清一个文件」，而是**把还在用的截图当孤儿挪走**，反馈里的图集体变破图。

#### 通用设置

| 设置项 | 持久化方式 | 说明 |
| --- | --- | --- |
| 字体大小 | localStorage + CSS 变量 `--font-scale` | 小 / 标准 / 大 / 超大，**改的是全站根变量** |
| 语言 | localStorage | 当前仅中文，其他语言「即将上线」 |
| 聊天列表左滑删除 | localStorage | 开关 |
| **回车键发送** | localStorage `chatly-enter-to-send` | ⚠️ 旧标签写的是「发送键回车换行」，而它在 `true` 时回车是**发送** —— 语义正好相反，已改 |
| 自动下载图片 | localStorage `chatly-auto-download` | `false` 时聊天里的图片显示为「点击加载图片」占位，**点一下才去请求**（真的没挂 `<img>`） |
| 缓存大小 | 计算 localStorage 体积 | 清除缓存保留登录状态 |

#### 主题外观

5 套主题，切换时写入 CSS 变量到 `:root`，同时持久化到 localStorage：

| 主题 | 渐变 |
| --- | --- |
| 极光 | `#8b7cf6 → #6d5cf6` |
| 薄荷 | `#34d3a6 → #2bb595` |
| 蜜桃 | `#f97ca8 → #e86a96` |
| 琥珀 | `#ffb43f → #f5a028` |
| 石墨 | `#4a4a5a → #3a3a4a` |

CSS 变量：`--primary`、`--primary-end`、`--accent`。

#### 稍后看

与收藏的区别：

| | 收藏 | 稍后看 |
| --- | --- | --- |
| 存储方式 | 快照（内容复制到 `favorites` 表） | 引用（`watch_later` 表指向 `messages.id`） |
| 消息撤回后 | 收藏仍在（`ON DELETE SET NULL`） | 条目消失（`ON DELETE CASCADE`） |
| 用途 | 重要内容存档 | 待办事项 |

```
GET    /api/v1/watch-later              稍后看列表（beforeId 游标 + limit）
POST   /api/v1/watch-later              添加到稍后看（幂等）
DELETE /api/v1/watch-later/:id          移除
DELETE /api/v1/watch-later/message/:id  按消息 ID 移除
```

长按菜单集成：在聊天室长按消息 → 菜单中出现「稍后看」/「移除稍后看」（根据当前状态切换）。

#### 最近文件

扫描所有会话中的文件消息（`kind IN ('file', 'image', 'video')` 且 `file_url IS NOT NULL`），按时间倒序返回。

```
GET /api/v1/files?limit=20&beforeId=&type=all
```

| type 参数 | 筛选条件 |
| --- | --- |
| `all` | 全部文件 |
| `document` | `kind = 'file'` |
| `image` | `kind = 'image'` |
| `video` | `kind = 'video'` |
| `archive` | `kind = 'file'` 且文件名以 `.zip/.rar/.7z` 结尾 |
| `other` | `kind = 'file'` 且排除压缩包 |

前端支持分页加载（`loadMore` 按钮）和类型筛选。

#### 消息通知

通知中心数据保存在 `notifications` 表，通过 REST 加载，并通过 WebSocket 接收新通知；
通知偏好保存在 `user_settings`。点赞、评论、关注、@提及和群公告等通知已有产生方。
系统运营通知暂时没有产生方；浏览器声音/震动受设备权限和页面状态限制。

#### 隐私设置

**隐私设置的有效项**包括动态默认可见范围、添加好友三开关、在线状态可见、文字消息加密、已读回执和阅后即焚。判据不是「开关拨得动、存得进、刷新还在」——
那只能证明 `user_settings` 写进去了 —— 而是**站在另一个账号的视角**看行为有没有变。

| 设置项 | key | 默认值 | 状态 |
| --- | --- | --- | --- |
| 动态默认可见范围 | `moment_visibility` | `'public'` | ✅ **真的生效**：发布动态时被 `MomentComposer` 读走当初始可见范围 |
| 通过手机号添加好友 | `add_friend_by_phone` | `true` | ✅ **真的生效**：关掉后手机号搜索直接查不到我 |
| 通过二维码添加好友 | `add_friend_by_qr` | `true` | ✅ **真的生效**：关掉后扫码结果卡显示「无法加为好友」 |
| 通过搜索添加好友 | `add_friend_by_search` | `true` | ✅ **真的生效**：关掉后按 ID / 昵称搜不到我 |
| 在线状态可见 | `online_status_visible` | `true` | ✅ **真的生效**：关掉后别人看不到我在线（配 Redis presence） |
| 文字消息加密存储 | `message_encryption` | `false` | ✅ 需配置 `MESSAGE_ENCRYPTION_KEY`；服务端 AES-256-GCM，不是端到端加密 |
| 已读回执 | `read_receipts` | `true` | ✅ 关闭后不向会话成员披露该用户的已读游标 |
| 阅后即焚 | `burn_after_read` | `false` | ✅ 读取文字消息 30 秒后全会话销毁 |
| 截屏提醒 | `screenshot_notify` | `true` | `disabled` + 原因（浏览器拿不到截屏事件） |

**六个闸门开关中有三项是「绑定渠道」的** —— 语义是「别人能不能通过这个渠道**找到我**」，
不是「已经认识我的人能不能加我」。所以只有**明确声明渠道**的请求才会被拦：

| 入口 | 渠道 | 命中闸门时 |
| --- | --- | --- |
| `GET /users/search?q=` | 手机号形态 → `phone`，其余 → `search` | 命中的人**直接不返回**（搜不到） |
| `GET /users/by-username/:username?from=qr\|search` | `?from=` | 资料**照常返回**，但 `addable.allowed=false` + 原因 |
| `POST /users/:id/follow` 带 `body.source` | `source` | **403** + `code:'privacy_blocked'` |

**不带渠道一律放行**：群成员列表点「关注」、发现页推荐里点「关注」都不带 source ——
那些人本来就在你眼前（同一个群 / 公开推荐），不存在「被找到」的问题，拦下来只会让人困惑。
这就是「**查得到 ≠ 加得上**」：命中闸门时资料照常返回（你知道这是谁），只是加不上。

**在线状态可见**的语义是「所有对外出口都不再回答他在不在线」：
`GET /users`、`GET /users/:id`、发现页里的人 `online` 恒为 `false`；
WS 的 `presence` 上下线广播**直接不发**（不是发 `online:false` —— 「一直显示离线」和
「对方关了在线状态」在界面上是一回事，没必要泄露前者）。而且只推给 `peersOf(userId)`
（有共同会话的人），不再广播给所有在线连接。

> ⚠️ 拨动「在线状态可见」要**立即同步**，且两个方向不一样：
> 关掉 → 必须 `force` 纠正一次已披露的状态（不 force 会被自己的检查挡掉，于是「关了还显示在线」）；
> 打开 → **不能**无条件宣布「在线」，要报**此刻真实的状态**（`isOnlineAnywhere`），
> 否则会给朋友留一个假的在线圆点，比「没反应」更糟。

**联系方式字段的塑形纪律**：`publicUser()` **故意不含 `phone` 和 `email`**，另有 `selfUser()` = publicUser + 仅本人可见的联系方式。
分两个名字而不是加 `isSelf` 开关的理由：加开关时任何调用点传错参数就是一次**静默**泄露。
出口只有登录响应与 `/auth/me`（含 PATCH 回包）；推给别人的 `user.updated` 用 `publicUser`。
手机号和邮箱用于身份验证与登录，不会通过公开用户资料或他人资料查询返回。

手机号与邮箱注册是两个独立流程，分别使用短信验证码和邮件验证码。服务端需配置 `AUTH_OTP_SECRET`、Twilio 短信参数与 Resend 邮件参数；未配置对应通道时，验证码接口会明确返回通道未配置，不会生成或展示演示验证码。注册接口：`POST /api/v1/auth/register/phone/code`、`POST /api/v1/auth/register/phone`、`POST /api/v1/auth/register/email/code`、`POST /api/v1/auth/register/email`。

**消息加密是服务端存储加密**：启用后新文字消息以 AES-256-GCM 密文写入数据库，服务端解密后再发给会话成员。它不保护消息传输，也不是端到端加密。配置 `MESSAGE_ENCRYPTION_KEY` 后才能开启；丢失密钥会导致加密消息无法读取。

#### 账号与安全

- **登录方式**：用户名、已验证手机号或邮箱 + 密码；安全设置资料中手机号和邮箱仅本人可见
- **安全设置**：生物识别 / 二次验证 —— `disabled` + 原因（没有真实校验，开了也只是存个值）
- **设备管理**：从 `user_devices` 表读取登录设备列表，支持远程退出
- **退出登录**：调 `logout()` —— 原来是只弹一句 toast，现在真的退出

```
GET    /api/v1/devices              获取设备列表
DELETE /api/v1/devices/:id          远程退出设备
GET    /api/v1/devices/settings     获取安全设置
PUT    /api/v1/devices/settings     更新安全设置
```

设备列表显示：设备名称、最后活跃时间（相对时间）、设备类型、当前设备标记。当前设备不可远程退出。

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

## 位置服务

四个落地场景：我页「所在地区」手动授权后解析城市中心点、动态发布选附近 POI、发现页「附近」城市中心点估算距离、聊天里发位置消息。发现页不会自动请求设备定位；未授权时不保留城市坐标。

### 三套坐标系，别混用

| 来源 | 坐标系 | 说明 |
| --- | --- | --- |
| `navigator.geolocation` | **WGS-84** | 浏览器给的原始值 |
| 腾讯位置服务（逆地址解析 / POI 搜索） | **GCJ-02** | 国测局加密坐标 |

直接拿 WGS-84 去问腾讯，结果会**偏 265~621 m** —— 不是「差不多」，是会指到隔壁街上。
换算数学放在 `shared/geo-math.mjs`，**前后端共用同一份**（`src/lib/geo.js` 只是转出），
避免两边各写一遍然后慢慢漂移。

### 无 key 不是错误

```
TENCENT_MAP_KEY    →  只在服务端用（逆地址解析、POI 搜索都走后端）
VITE_TMAP_KEY      →  前端地图渲染用，放 .env.local
```

没有 key 时接口**不报错、也不返回 500**，而是 `200 + { configured: false, reason }`。
前端据此显示一块**自画的坐标网格**，并**直说「这不是地图」** ——
画得像地图最糟：用户会以为那就是他所在的位置。

### 隐私三道闸

1. `cityPublic = 0` 时，`publicUser()` **连坐标字段都不返回**（不是返回空串，是根本不带这个 key）；
2. 「我的位置」只写 **localStorage**，**不上传**；
3. 库里只存**行政区划中心点**，不存用户的精确经纬度。

### 距离必须有坐标支撑

- 没有坐标 → **一个距离数字都不出**（不猜、不按城市名估算）；
- 两点落在同一中心点 → 显示「**同城**」，**不显示「0 km」**（0 km 会被读成「就在隔壁」）；
- 排序键**必须是同一量纲**，三层依次比：有无距离 → 距离 / `-rank` → `-共同群聊数`。

### 其他几个坑

- 地图 SDK **按需加载**，不在地图页就不加载；
- SDK 单例初始化**失败要清空**，否则重试永远无效（拿着一个坏实例）；
- **不传 `mapStyleId`**（自定义样式会让 SDK 报错）；
- 容器**必须有固定高度**，否则地图高度塌成 0；
- ⛔ 地图底图只允许腾讯 / 高德 / 百度 / 天地图。

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

统一回归入口要求后端已在 `3002` 启动；完整回归还需要前端在 `5198` 启动。建议先跑快速回归，再跑全量专项：

```bash
npm run verify:quick  # 解析、生产构建、登录/公告/上传/权限核心链路、后端 E2E
npm run verify        # 快速回归 + 浏览器与 UI 专项
```

完整回归会启动浏览器并写入专用自检数据，脚本会清理自己的会话和临时上传。生产备份、恢复、部署边界见[部署与运维说明](docs/OPERATIONS.md)。

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

# 群投票专项（129 项断言）
node scripts/check-poll.mjs

# 消息收藏专项（85 项断言）
node scripts/check-favorite.mjs

# 长按手势专项（14 项断言）
node scripts/check-longpress.mjs

# 隐私门控专项（55 项断言）：添加好友三开关 / 扫码被拦 / 手机号不泄露 / 在线状态可见
node scripts/check-privacy.mjs

# 在线状态专项（25 项断言）：本地上下线推送 / 会话行圆点 / Redis 跨实例读写 / 无 Redis 降级
node scripts/check-presence.mjs

# ★ 数据层跨驱动契约（21 项断言）：主键类型 / camelCase 别名 / 占位符 / 事务 /
#   命名参数 / LIKE 语义 / listMembers 与 listConversations 的出参形状
#   跑两遍 —— SQLite 一遍、PG 一遍，两边都必须绿。
node scripts/check-driver.mjs

# 「我」页设置专项（143 项断言）：7 个入口 / 版面几何 / 真假开关 / 反馈落库
node scripts/check-me.mjs

# 全界面 console 报错 / 非法 DOM 嵌套自检
node scripts/check-console.mjs

# ⭐ 源码解析自检（~1 秒，不是浏览器自检）—— 改完 jsx 先跑这个
node scripts/check-parse.mjs
```

### 为什么单独有 `check-parse`

一行写错的 JSX（例如在 `return (` 的括号里、元素**之前**放一个 `{/* 注释 */}`）
是**致命**的：Babel 解析失败 → Vite 对该模块返回 500 → **整个应用白屏**。
它的暴露路径特别绕：

- `node --check` 查不出来（`.jsx` 根本不是合法 JS，会报另一个毫不相干的错）；
- `vite build` 能查出来，但要几十秒；
- 靠浏览器自检去撞，症状是「**所有选择器一律返回 null**」——
  极容易被误读成「数据库空了 / 后端挂了 / 代理拦了」，实测就绕了一大圈
  （查完数据、查完端口、查完 watcher 进程，最后才看到 Vite 页面上那个 500）。

`check-parse.mjs` 用项目里已有的 esbuild（vite 的依赖，不新增依赖）把
`src/` 与 `server/src/` 下每个文件 transform 一遍，顺便校验**相对 import 是否落在真实文件上**，
1 秒内指出「哪个文件第几行语法错」。**改完 jsx 先跑它。**

### 两种数据库跑同一套自检

`check-driver` / `check-privacy` / `check-presence` 回库核对走的是**异步** `q`（不是 SQLite 专有的 `qSync`），
所以同一套用例两种驱动都能跑。换库后重跑一遍，是「双驱动不是两套代码」的实证：

```bash
# 1) 起容器（见「后端 → 数据库」一节）
docker compose up -d

# 2) 灌演示数据（PG 库是空的；这一步是幂等的）
cd server && DB_DRIVER=postgres \
  DATABASE_URL=postgres://chatly:chatly_dev_pw@127.0.0.1:55433/chatly node src/seed.js && cd ..

# 3) 让后端跑在 PG 上（改 server/.env 或临时覆盖环境变量都行）
DB_DRIVER=postgres DATABASE_URL=postgres://chatly:chatly_dev_pw@127.0.0.1:55433/chatly \
  node server/src/index.js

# 4) 同一套用例原样再跑（**自检脚本自己也要带同一组环境变量** ——
#    它回库核对用的是同一个门面，不带就变成「后端连 PG、自检连 SQLite」）
DB_DRIVER=postgres DATABASE_URL=postgres://chatly:chatly_dev_pw@127.0.0.1:55433/chatly \
  node scripts/check-driver.mjs
DB_DRIVER=postgres DATABASE_URL=postgres://chatly:chatly_dev_pw@127.0.0.1:55433/chatly \
  node scripts/check-privacy.mjs
DB_DRIVER=postgres DATABASE_URL=postgres://chatly:chatly_dev_pw@127.0.0.1:55433/chatly \
  node scripts/check-presence.mjs
```

> ⚠️ 忘了给自检带环境变量时的症状**极易误判**：断言报的是
> 「回库确认 follows 里真的多了一行」这类**业务**错误，
> 看着像后端没写库，其实是自检读错了数据库。见 `LESSONS.md`。
>
> ⚠️⚠️ **`server/uploads/` 是两种数据库共用的一个目录，孤儿文件回收是「全局动作」。**
> `purgeOrphanUploads()` 只按**当前驱动**的引用表判断谁是孤儿 ——
> 两个库同时在用时跑它，会把「只有另一个库引用」的文件当成孤儿挪进 `.tmp/orphan-uploads/`，
> 那个库的界面立刻一片 404。**规矩：回收必须在和后端同一个驱动下跑；两个库同时活着时谁也别跑。**
> 好在是「挪走」不是「删掉」，`mv .tmp/orphan-uploads/<file> server/uploads/` 即可恢复。

### 哪些自检能在 PG 下跑

| 类别 | 脚本 | 说明 |
| --- | --- | --- |
| **两种驱动都跑** | `check-driver` / `check-privacy` / `check-presence` + 全部纯浏览器脚本（`check-group` / `check-video` / `check-media` / `check-console` / `check-readreceipt` / `check-scroll` / `check-emoji` / `check-align` / `check-narrow` / `e2e-realtime` / `audit-ui`） | 回库核对走异步 `q`；纯浏览器脚本只走 HTTP + CDP |
| **仅 SQLite** | `check-favorite` / `check-poll` / `check-me` / `check-moment` / `check-geo` / `check-discover` / `check-qr` / `check-reply-forward` / `check-longpress` | 用了 SQLite 专有的 `db` / `qSync` / `insertSync`（同步直连） |

> `scripts/lib/debris.mjs`（自检残留清理）**已经是驱动无关的**（异步 `q` + `tx`）。
> 它原先用 SQLite 裸句柄，后果不是「这个库不能用」，而是**任何 import 它的脚本都跑不了 PG** ——
> 于是纯浏览器脚本被打上了「只能在 SQLite 下验」的隐形烙印，
> 实测就因此漏掉一个「发现页 500」。共用工具库要按**最严格的调用方**来写。

每个自检脚本都是**自包含**的：自己建临时群、自己发探针消息、自己清理残留。
跑完数据库回到基线，不会污染下一个自检。

---

## 说明

- 所有演示数据（用户、头像、动态、位置）均为**虚构**，不含任何真实用户信息。
- 上传文件与 SQLite 库存放在 `server/data/` 与 `server/uploads/`，已在 `.gitignore` 中排除。
- 第三方素材只有两处，且都是 Microsoft Fluent Emoji（**MIT**，免署名）：
  - `public/emoji/` 的 386 个静态表情 —— 上游文件的原样拷贝，仅重命名为 Unicode 码点，
    许可证原文见 `public/emoji/LICENSE.txt`。
  - `public/emoji-anim/` 的 30 个动画大表情 —— 来自**另一个仓库** `fluentui-emoji-animated`，
    上游是 APNG，本项目用 ffmpeg **转码为 GIF**（改了尺寸 / 帧率 / 调色板 / 编码格式，未做其它修改），
    许可证原文见 `public/emoji-anim/LICENSE.txt`。
- 其余图形（图标、预设头像、封面）全部是项目内手写生成，无第三方依赖。
