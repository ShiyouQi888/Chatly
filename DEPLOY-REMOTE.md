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

## 首个管理员

注册首个用户后，查出其 ID：

```bash
docker compose -f docker-compose.app.yml exec postgres psql -U chatly -d chatly -c 'SELECT id, username FROM users;'
```

把对应 ID 写入 `.env` 的 `ADMIN_USER_IDS`，然后重建后端容器使变量生效：

```bash
docker compose -f docker-compose.app.yml up -d --force-recreate server
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
