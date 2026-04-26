# PrismFlow M1 部署操作手册（Neon Free + R2 Free + DO API）

这份手册是当前 M1 阶段默认落地方案：

- API 运行环境：DigitalOcean（目标约 `$5/月`）
- 数据库：Neon Free
- 对象存储：Cloudflare R2 Free

目标：在尽量低成本的前提下，保留当前 M1 功能闭环。

## 1) 何为“部署完成”

当以下条件都满足，可认为本阶段完成：

1. API `GET /ready` 返回 `ok: true`
2. `appStore.provider = postgres`
3. `favorites.provider = postgres`
4. 对象存储可用（`s3`）
5. 收藏封面 URL 可在浏览器直接访问

## 2) 创建 Neon Free（PostgreSQL）

1. 在 Neon 控制台创建项目。
2. 复制连接串（小规模服务优先用 pooled URL）。
3. 在 API 环境变量中填写：

```env
APP_STORE_PROVIDER=postgres
FAVORITES_PROVIDER=postgres
POSTGRES_URL=postgres://<user>:<pass>@<host>/<db>?sslmode=require
POSTGRES_SSL=true
POSTGRES_AUTO_MIGRATE=true
```

说明：

- 托管 PostgreSQL 基本都要求 `POSTGRES_SSL=true`。
- 免费层空闲后会休眠，首次访问出现冷启动延迟是预期行为。

## 3) 创建 Cloudflare R2 Free

1. 创建 R2 Bucket（默认私有）。
2. 创建对该 Bucket 有读写权限的 API Token。
3. 获取 S3 Endpoint：`https://<account_id>.r2.cloudflarestorage.com`
4. 配置封面图公网访问：
   - 最快方式：开启 `r2.dev` 公共域名
   - 更推荐：绑定自定义域名
5. 在 API 环境变量中填写：

```env
OBJECT_STORAGE_PROVIDER=s3
S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=<bucket_name>
S3_ACCESS_KEY_ID=<r2_access_key_id>
S3_SECRET_ACCESS_KEY=<r2_secret_access_key>
S3_PUBLIC_BASE_URL=https://<public-r2-domain>
S3_FORCE_PATH_STYLE=true
S3_KEY_PREFIX=prismflow
```

重要提示：

- 如果 `S3_PUBLIC_BASE_URL` 为空，生成出来的封面 URL 可能无法被前端公网访问。

## 4) 本地预检（上线前必须通过）

在仓库根目录执行：

```bash
npm --workspace @shader-mvp/api run doctor:cloud
```

可选：执行 R2 写入烟雾测试（上传并删除一个临时对象）：

```bash
node apps/api/scripts/doctor-cloud.mjs --strict-online --write-smoke
```

## 5) 上线后运行态检查

部署后先验证：

```bash
curl -s https://<api-domain>/health
curl -s https://<api-domain>/ready
```

`/ready` 里所有依赖应为 `ok: true`。

然后跑一轮业务烟雾流程：

1. 创建 session
2. 发送一条生成消息
3. 创建一条 favorite
4. 在网页打开收藏列表和详情页确认可读

## 6) 现有 DO 服务器可用性评估（2026-04-25 审计结果）

已检查服务器：

- IP：`146.190.104.148`
- 系统：Ubuntu 24.04
- 规格：`1GB RAM`、`8GB Disk`
- 当前状态：网络可达、SSH 可登录、Docker 已安装、`prismflow-api` 容器运行中（仅本机 `127.0.0.1:8788`）

建议：

1. `1GB` 可以先稳定跑 M1；如果后续并发和 ffmpeg 任务增多，优先升级到 `2GB`。
2. 保持容器化部署（Docker），便于版本回滚和快速迭代。
3. 若希望运维更省心，后续可迁移 DigitalOcean App Platform。

补充说明：

- 目前这台机可直接用于前端联调和小规模对外测试。
- 已接入 Caddy + Let's Encrypt，公网 HTTPS 地址为：`https://prismflow.duckdns.org`

## 7) 后续接管清单（给 Codex 运维前）

在让我接手持续运维前，请先保证：

1. 生产平台里的 API 环境变量已完整配置。
2. 本地用同一组配置跑过 `doctor:cloud` 并通过。
3. 部署分支策略固定（`dev -> staging`，`main -> production`）。
4. 回滚路径明确（上一版镜像 tag 或上一次成功部署版本）。

## 8) 新手直连步骤（前端连接线上 API）

在本地仓库根目录执行：

```bash
npm run dev:web:online
```

看到 `Local: http://localhost:5174` 后，在浏览器打开该地址即可。

说明：

1. 这条命令会把前端请求目标固定为线上 HTTPS API：`https://prismflow.duckdns.org`。
2. 你本地不需要再手动启动 API，也不会影响你原来的本地自用版本。

如果只想验证能否打包成功，执行：

```bash
npm run build:web:online
```

## 9) 日常巡检（服务器是否还活着）

```bash
ssh root@146.190.104.148 'docker ps --filter name=prismflow-api'
ssh root@146.190.104.148 'docker logs --tail 100 prismflow-api'
```

命令含义：

1. 第一条看容器是否在跑（看到 `Up ...` 就是活着）。
2. 第二条看最近 100 行日志（用于定位报错）。

## 10) 当前公网入口（可直接发给测试用户）

1. 网站首页：`https://prismflow.duckdns.org`
2. API 健康检查：`https://prismflow.duckdns.org/health`
3. API 就绪检查：`https://prismflow.duckdns.org/ready`

## 11) M4 安全与稳定收口（已落地）

当前默认策略（可在 `apps/api/.env` 调整）：

1. CORS 白名单：只允许指定来源跨域访问。
2. 请求频控：
   - 生成接口（`/v1/sessions/:id/messages`）默认 `10 秒最多 10 次`，且 `60 秒最多 30 次`（用于并行抽卡）。
   - 其他重接口（优化/需求提炼/收藏创建）默认 `10 秒最多 2 次`，且 `60 秒最多 6 次`。
   - 轻接口（列表/详情/状态查询）默认 `60 秒最多 120 次`。
   - 收藏页手动发布（`/favorites/new` 与收藏详情页“保存”）默认 `1 小时最多 5 次`。
   - 超限返回 `429`，并带 `Retry-After`。
3. 同会话并发保护：
   - 同一个 `session` 默认只允许 1 个重任务同时执行（优化/需求提炼等）。
   - 生成接口可单独并发，默认同一 `session` 允许并发 10 个生成请求。
   - 并发触发会返回 `409`（提示当前 session 正在处理中）。
4. 重复内容防刷：
   - 同一客户端在去重窗口内重复发布相同 GLSL 代码会返回 `409`。
5. 慢请求日志：
   - 默认 `>3000ms` 记录 `Slow request detected`。
6. 日志脱敏：
   - `Authorization`、`Cookie`、`x-api-key`、`set-cookie` 已做脱敏。

快速验收命令（本地或线上都可）：

```bash
# 1) CORS（白名单来源应看到 access-control-allow-origin）
curl -i https://prismflow.duckdns.org/health \
  -H 'Origin: https://prismflow.duckdns.org'

# 2) CORS（非白名单来源不应返回 access-control-allow-origin）
curl -i https://prismflow.duckdns.org/health \
  -H 'Origin: https://evil.example.com'
```
