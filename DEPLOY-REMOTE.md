# Chatly 远端 Docker 部署

本包适用于 Linux 主机上的 Docker Compose 部署。需要安装 Docker Engine 与 Compose 插件；生产密钥由部署主机本地 `.env` 提供，不放进压缩包。

## 首次部署

1. 上传并解压 `chatly-remote-deploy.zip`，进入解压后的 `chatly-remote-deploy` 目录。
2. 复制 `.env.docker.example` 为 `.env`。把 `POSTGRES_PASSWORD`、`JWT_SECRET`、`AUTH_OTP_SECRET` 换成不同的随机值，可用 `openssl rand -hex 32` 分别生成。按需设置后台管理员、地图、邮箱和短信配置。
3. 检查配置并启动：

   ```bash
   docker compose -f docker-compose.app.yml config
   docker compose -f docker-compose.app.yml up --build -d
   docker compose -f docker-compose.app.yml ps
   ```

4. 默认 Web 端口绑定到主机回环地址 `127.0.0.1:8080`。在同一主机配置 HTTPS 反向代理转发到该地址。若由云负载均衡器直连容器端口，把 `CHATLY_BIND_ADDRESS` 设为 `0.0.0.0`，并在负载均衡器终止 TLS、限制入站访问。

## 管理员账号

首次部署前，在 `.env` 中设置 `ADMIN_USERNAME` 和至少 12 位的 `ADMIN_PASSWORD`。首次启动会在独立的后台账号表中创建管理员。打开 `/qishiyou`，直接用这组后台凭据登录；账号可以使用邮箱格式，无需注册普通用户。普通用户和后台使用独立密码、会话与退出流程。初始化后可在 `/qishiyou` 的“服务状态”页面修改管理员账号和密码；只要环境变量值不变，后续重建容器就不会覆盖后台修改。若改了环境变量账号或密码，则会在下次启动时按新配置重置/接管管理员，适用于管理员账号配置错误时恢复访问。

从旧版本升级时，会自动复制已有后台管理员、运营成员的凭据与历史审计记录到独立后台数据表。现有普通用户资料和密码保持原样；普通用户的登录态不再授予后台访问权限。`ADMIN_ACCOUNT` 和用户 ID 不再用于后台登录或授权。后台成员通过管理台直接创建独立账号。

首次部署的环境变量修改后，使用以下命令启动或重建后端：

```bash
docker compose -f docker-compose.app.yml up --build -d
```

部署不会自动创建演示账号或演示数据。

## 更新与数据

上传新版包并在目录内替换应用文件，再运行：

```bash
docker compose -f docker-compose.app.yml up --build -d
docker compose -f docker-compose.app.yml logs -f server web
```

PostgreSQL、Redis、公开上传与私有上传保存在 Docker 命名卷中。普通停机使用 `docker compose -f docker-compose.app.yml down`，数据会保留。**不要使用 `down -v`，它会删除数据库和上传文件卷。**

本包不包含数据库备份、集中日志、告警或 TLS 证书管理；这些由远端部署环境负责。
