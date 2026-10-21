# 部署与运维说明

仓库提供前端、后端和 PostgreSQL/Redis 的 Docker 编排与健康检查；仍不包含自动备份、集中日志平台或告警配置。生产环境需由部署平台补齐这些运维能力。

## Docker 整栈部署

根目录 `Dockerfile` 构建 Vite 前端并用 Nginx 提供静态文件与同源 API/WebSocket 反向代理；`server/Dockerfile` 以非 root 用户运行 Node 后端。独立的 `docker-compose.app.yml` 会启动前端、后端、PostgreSQL 和 Redis：

1. 将 `.env.docker.example` 复制为项目根目录 `.env`，为 `POSTGRES_PASSWORD`、`JWT_SECRET` 和 `AUTH_OTP_SECRET` 配置独立强随机值。`JWT_SECRET` 与 `AUTH_OTP_SECRET` 至少 32 字节；生产环境由密钥管理服务注入，不要把真实密钥提交到 Git。
2. 启动整栈：

   ```bash
   docker compose -f docker-compose.app.yml up --build -d
   ```

3. 在部署主机访问 `http://localhost:8080`。HTTPS 应由外部负载均衡器或反向代理终止，再转发到前端容器端口。默认 Web 端口只绑定宿主机回环地址；可用 `CHATLY_HTTP_PORT` 修改端口。若需要直接从公网访问容器，需将 `CHATLY_BIND_ADDRESS` 设为 `0.0.0.0`，并自行配置 TLS 与防火墙。

Compose 会等待 PostgreSQL、Redis 和后端健康检查通过再启动依赖服务。后端只加入 Compose 内部网络，不发布宿主机端口；PostgreSQL/Redis 的调试端口只绑定 `127.0.0.1`。数据库、Redis、公开上传和私有聊天附件分别由命名卷持久化。`docker compose ... down` 保留卷，`down -v` 会永久删除这些数据。

可用 `openssl rand -hex 32` 为三个必填秘密生成 URL 安全的 32 字节值。Compose 设置单层可信代理，反向代理后的登录/注册限流仍会按真实客户端 IP 区分。

地图浏览器密钥可通过 `VITE_TMAP_KEY` 在前端构建时注入；该密钥会进入浏览器产物，应配置域名/来源限制。其余地图、邮箱、短信、后台管理员和消息静态加密配置通过 `.env` 注入后端。首次上线不会自动灌入演示账号；注册首个用户后，将其用户 ID 配入 `ADMIN_USER_IDS` 并重启后端以授予后台权限。

## 环境配置

从 `server/.env.example` 创建 `server/.env`，生产密钥通过部署平台的 Secret 管理注入，不要提交到 Git：

- 设置 `DB_DRIVER=postgres` 和生产 `DATABASE_URL`；开发用的 `docker-compose.yml` 密码是固定演示值，不可用于公网。
- 设置至少 32 字节随机 `JWT_SECRET`。不要沿用本地默认密钥。
- 如启用消息存储加密，设置 32 字节 `MESSAGE_ENCRYPTION_KEY`，并把密钥备份到独立密钥管理系统。消息加密目前是服务端 AES-256-GCM 静态加密，不是端到端加密。
- 多实例运行时配置 `REDIS_URL`，用于在线状态和跨实例事件；没有 Redis 时应用会降级为进程内状态，不能视作多实例实时能力正常。
- 地图服务 `TENCENT_MAP_KEY` 按需设置。`PORT`、`HOST` 可由服务管理器覆盖。

不使用 Docker 时，前端执行 `npm ci && npm run build`，部署 `dist/` 到 HTTPS 站点；后端在 `server/` 执行 `npm ci` 后以进程管理器启动 `node src/index.js`。反向代理需转发 `/api`、`/uploads` 和 WebSocket `/ws`，并正确传递升级头。公网部署应限制后端端口，仅允许反向代理访问。

## 备份与恢复

备份数据库和上传目录时保持同一时间点的一致性。临时停止写入或进入维护模式，然后同时备份：

- PostgreSQL 数据库（包括会话、消息、通知、设置和文件索引）。
- `server/uploads/` 与 `server/private-uploads/`。私有聊天附件也要纳入备份。
- `JWT_SECRET` 与 `MESSAGE_ENCRYPTION_KEY` 的受控密钥备份。密钥和数据库备份不要放在同一权限域。

PostgreSQL 可用 `pg_dump -Fc "$DATABASE_URL" > chatly.dump` 备份，用 `pg_restore` 恢复到维护中的目标数据库。上传目录需从同一备份点恢复；只恢复数据库或只恢复文件都会留下失效附件或孤儿文件。

SQLite 仅建议本地开发使用。备份前停止后端进程，再复制 `server/data/` 数据库文件及其旁路文件；生产部署请改用 PostgreSQL。恢复后启动应用并核对 `/health`、登录、消息读取和附件访问。

恢复演练应定期在隔离环境进行，并记录数据库、文件、加密密钥三者是否能共同恢复。仓库目前没有自动轮转、异地复制或一键恢复脚本。

## 健康检查与日志

- `GET /health` 返回进程存活、数据库驱动信息和 Redis 状态。监控端应检查 HTTP 状态码及 `db`/`redis` 字段，而非只检查端口可连接。
- 后端当前使用标准输出日志和错误日志；部署环境应采集、保留并限制访问这些日志。应用尚未提供结构化日志、指标导出或内建告警。
- 监控进程重启、数据库连接失败、磁盘空间、上传目录容量、Redis 降级、备份任务结果以及连续健康检查失败。
- 日志与告警不得记录访问令牌、密码、完整私聊正文或加密密钥。

## 上线前安全核对

- 确认 HTTPS、HSTS、WebSocket TLS 和反向代理头配置正确，后端不可绕过代理公网直连。
- 删除演示用户与演示口令，关闭或限制公开注册，并确认种子脚本不会在部署启动时运行。
- 检查依赖漏洞、上传大小限制、数据库最小权限、备份访问权限、密钥轮换与恢复流程。
- 当前消息搜索仅返回用户有权访问的文字消息，且只扫描最近 5,000 条候选记录；消息加密可搜索性取决于服务端能否解密。
- 当前尚未接入通话、端到端加密、集中审计日志、生产级限流/告警和自动备份编排；上线评审需按实际风险制定补齐计划。
