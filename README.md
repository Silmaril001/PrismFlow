# PrismFlow (M1)

> Formerly: AI Shader Tool (local prototype codename)

M1 目标：先上线 `Shader` 模式最小闭环，同时保留 `PBR` 管线扩展位。

版本策略：M0-M5 全程按 `0.1.x` 维护（仅递增 patch 版本）。

## 一键启动（推荐）

### 方式 A：终端一条命令

```bash
npm run start:oneclick
```

### 方式 B：macOS 双击启动

双击项目根目录里的 `start.command` 即可。

启动后地址：

- Web: `http://localhost:5174`
- API: `http://localhost:8788`

> 首次启动会自动安装依赖，并自动创建 `apps/api/.env`（如果不存在）。
> 不填 `OPENAI_API_KEY` 也能跑，会使用本地 fallback shader。

Right Codes 渠道建议配置：

- `OPENAI_BASE_URL=https://www.right.codes/codex/v1`
- `OPENAI_MODEL=gpt-5.5`
- `OPENAI_TIMEOUT_MS=90000`
- `OPENAI_MAX_TOKENS=900`（限制单次生成长度，降低延迟抖动）
- `OPENAI_DEBUG_MODEL=gpt-5.4-mini`（代码debug专用）
- `OPENAI_DEBUG_BASE_URL=https://www.right.codes/codex/v1`（代码debug专用）

OpenRouter 渠道建议配置：

- `OPENROUTER_API_KEY=...`（也兼容小写 `openrouter_api_key`）
- `OPENROUTER_BASE_URL=https://openrouter.ai/api/v1`
- `OPENROUTER_MODEL=claude-opus-4.6`
- `OPENROUTER_HTTP_REFERER=http://localhost:5174`（可选）
- `OPENROUTER_APP_NAME=AI Shader Tool`（可选）
- `USE_MACOS_SYSTEM_PROXY=true`（默认开启：当环境变量未设置代理时，自动读取 macOS 系统代理并用于 API 请求）
- `PROMPT_TEMPLATES_DIR=`（可选；默认 `apps/api/prompts`，用于覆盖系统提示词模板目录）
- `IDEATION_ASSET_DIR=`（可选；默认 `apps/api/storage/ideation`，用于存放需求提炼上传素材）

Gemini（需求提炼弹窗）建议配置：

- `GEMINI_API_KEY=`（可留空，默认复用 `OPENAI_API_KEY`）
- `GEMINI_BASE_URL=https://www.right.codes/gemini/codex/v1`
- `GEMINI_MODEL=gemini-3-pro-preview`
- `GEMINI_FALLBACK_MODEL=gemini-3-flash-preview`
- `GEMINI_VIDEO_MODEL=gemini-3-flash-preview`（上传视频时默认优先使用）
- `GEMINI_VIDEO_FALLBACK_MODEL=`（可选；不填则视频只走 `GEMINI_VIDEO_MODEL`）
- `GEMINI_VIDEO_FRAME_FPS=1`（视频转帧采样率）
- `GEMINI_VIDEO_FRAME_MAX_COUNT=6`（最多提交多少帧）
- `GEMINI_VIDEO_FRAME_WIDTH=960`（转帧宽度）
- `FFMPEG_BIN=ffmpeg`
- `GEMINI_TIMEOUT_MS=0`（`0` 表示不启用本地超时，等待渠道网关返回）
- `GEMINI_FALLBACK_TIMEOUT_MS=0`
- `GEMINI_MAX_OUTPUT_TOKENS=0`（`0` 表示不限制输出长度，不传 `maxOutputTokens`）
- `GEMINI_OPTIMIZE_BASE_URL=https://www.right.codes/gemini/codex/v1`（一键优化评估链路）
- `GEMINI_OPTIMIZE_MODEL=gemini-3-pro-preview`
- `GEMINI_OPTIMIZE_FALLBACK_MODEL=gemini-3-flash-preview`
- `GEMINI_OPTIMIZE_TIMEOUT_MS=0`
- `GEMINI_OPTIMIZE_FALLBACK_TIMEOUT_MS=0`
- `FAVORITES_DIR=`（可选；默认 `apps/api/storage/favorites`，用于收藏结果落盘）
- `FAVORITE_NAMER_API_KEY=`（收藏命名专用，建议填 DeepSeek Key）
- `FAVORITE_NAMER_BASE_URL=https://api.deepseek.com/v1`
- `FAVORITE_NAMER_MODEL=deepseek-chat`
- `FAVORITE_NAMER_FALLBACK_MODEL=`（可选）
- `FAVORITE_NAMER_TIMEOUT_MS=20000`
- `FAVORITE_NAMER_FALLBACK_TIMEOUT_MS=20000`

M1 线上部署骨架配置：

- `APP_STORE_PROVIDER=memory|postgres`（默认 `memory`）
- `FAVORITES_PROVIDER=local|postgres`（默认 `local`）
- `POSTGRES_URL=`（当 `APP_STORE_PROVIDER=postgres` 或 `FAVORITES_PROVIDER=postgres` 时必填）
- `POSTGRES_SSL=false|true`
- `POSTGRES_AUTO_MIGRATE=true|false`
- `OBJECT_STORAGE_PROVIDER=none|s3`（默认 `none`）
- `S3_ENDPOINT=`
- `S3_REGION=auto`
- `S3_BUCKET=`
- `S3_ACCESS_KEY_ID=`
- `S3_SECRET_ACCESS_KEY=`
- `S3_PUBLIC_BASE_URL=`
- `S3_FORCE_PATH_STYLE=true|false`
- `S3_KEY_PREFIX=prismflow`

M4 安全与稳定（默认已开启）：

- `TRUST_PROXY=true`（在反向代理/网关后识别真实客户端 IP）
- `CORS_ALLOW_ORIGINS=...`（逗号分隔白名单，默认已含本地与 `prismflow.duckdns.org`）
- `SLOW_REQUEST_THRESHOLD_MS=3000`（超过阈值输出慢请求日志）
- `RATE_LIMIT_ENABLED=true`
- `RATE_LIMIT_HEAVY_BURST_WINDOW_SEC=10`
- `RATE_LIMIT_HEAVY_BURST_MAX=2`
- `RATE_LIMIT_HEAVY_WINDOW_SEC=60`
- `RATE_LIMIT_HEAVY_MAX=6`
- `RATE_LIMIT_LIGHT_WINDOW_SEC=60`
- `RATE_LIMIT_LIGHT_MAX=120`
- `RATE_LIMIT_FAVORITES_MANUAL_WINDOW_SEC=3600`（收藏页手动发布窗口，默认 1 小时）
- `RATE_LIMIT_FAVORITES_MANUAL_MAX=5`（收藏页手动发布上限，默认每小时 5 次）
- `FAVORITES_DUPLICATE_WINDOW_SEC=3600`（相同代码去重窗口，默认 1 小时）
- `SESSION_CONCURRENCY_MAX=1`（同一个 session 的重任务串行执行；并发请求返回 `409`）

M1 云接入预检（Neon/R2）：

- `npm --workspace @shader-mvp/api run doctor:cloud`
- 可选写入烟雾测试：`node apps/api/scripts/doctor-cloud.mjs --strict-online --write-smoke`

M1 前端直连线上 API（当前 DO 测试环境）：

- 开发调试：`npm run dev:web:online`
- 生产构建：`npm run build:web:online`
- 浏览器打开：`http://localhost:5174`
- 公网访问地址：`https://prismflow.duckdns.org`
- 线上 API 健康检查（health）：`curl -s https://prismflow.duckdns.org/health`
- 线上 API 健康检查（ready）：`curl -s https://prismflow.duckdns.org/ready`

提示词模板（Markdown，可直接编辑）：

- `apps/api/prompts/shader.system.md`（Shader 生成主系统提示词）
- `apps/api/prompts/shader.system.debug.md`（代码 debug 模式附加系统提示词）
- `apps/api/prompts/ideation.system.md`（需求提炼弹窗系统提示词）
- `apps/api/prompts/optimize.system.md`（一键优化评估系统提示词）
- `apps/api/prompts/favorite.namer.system.md`（收藏命名与提示词摘要系统提示词）

## 当前能力

- UI 固定为 Shader（GLSL）模式，`PBR` 入口已从前端下沉
- Shader 会话创建
- 文本驱动 GLSL 生成与迭代
- Chat 输入框支持剪贴板粘贴参考图（最多 5 张），可与文本一起作为多模态输入
- 聊天支持“新 Shader”二次确认重置（下一条消息按全新需求处理）
- Shader 模式新增“需求提炼 Chat（Gemini）”弹窗，支持文本 + 1 张图片或 1 段视频
- 上传视频时，服务端会自动转为抽帧图片（默认 1 秒 1 帧）再提交 Gemini，多模态流程对前端透明
- 需求提炼弹窗上传的素材会联动到主 Chat 附图栏：图片直接联动，视频默认联动为抽帧图
- 需求提炼弹窗支持“确认并填入主描述”，可回填 GLSL 生成提示词到主输入框
- 需求提炼弹窗关闭后状态保留；点击“新 Shader”会同步重置弹窗聊天和已上传素材
- Revision 信息区支持“重新生成”二次确认（复用上一条生成指令快速抽卡）
- 前端不再暴露渠道 / 模型 / Base URL 切换，默认走 rightcode；当前模型默认 `gpt-5.5`（可在 API `.env` 改 `OPENAI_MODEL`）
- 发送时会把当前 GLSL 连同你的修改要求一起提交给模型
- UI 可查看模型调用信息：请求模型、实际模型、是否回退、LLM 延迟
- GLSL 区域可直接编辑，修改后与预览实时联动
- GLSL 标题右侧支持“代码debug”按钮（模型和 Base URL 由 API 的 `.env` 指定，不受 UI 设置影响）
- 预览分辨率固定为 `960x540`
- 支持并行生成（滑块 `1-10`，默认 `5`），并通过编号按钮切换每个结果
- “代码debug”仅作用当前编号结果
- 新增“一键优化”（二次确认）：自动抓取 t=2s 预览截图 + 绑定素材 + 当前 GLSL，先走 Gemini 评估；评估提示词可手动修改后再继续迭代当前编号
- GLSL 标题旁支持星标收藏，收藏会自动调用收藏命名模型并生成提示词摘要
- 当前编号支持“一键优化历史”回退/重做，可在任意历史版本继续触发一键优化
- 新增收藏页入口（主界面标题右侧）：`/favorites` 新标签页打开
- 收藏页作为公共广场展示全体作品，支持 4 列缩略图瀑布展示，默认静帧，悬停自动播放
- 收藏页支持“新建”入口：`/favorites/new`，可手动写 GLSL 并保存为新收藏
- 公共收藏为只读展示：不支持重命名和删除（后端接口已关闭）
- 收藏详情页支持临时代码编辑 + 编译运行 + 代码debug + 手动命名保存新副本（仅新增，不回写原收藏）
- 默认按 Shadertoy 约定生成（`mainImage`, `iTime`, `iResolution`）
- WebGL 实时预览使用 WebGL2 优先（`#version 300 es` 包装 + Shadertoy 变量兼容），不支持时回退 WebGL1
- Revision 版本记录（内存存储）
- M1 新增依赖就绪探针：`/ready`（包含 app store 与 favorites 存储健康检查）
- M4 新增可配置 CORS 白名单；非白名单跨域请求不会返回 `Access-Control-Allow-Origin`
- M4 新增请求频控：高频触发返回 `429`（含 `Retry-After`）
- M4 新增同会话并发保护：同一个 session 并行重任务返回 `409`
- M4 新增收藏手动发布限流：默认每小时最多 5 次（生成页星标不受此单独规则影响）
- M4 新增收藏重复代码防刷：同一客户端在去重窗口内重复发布相同代码会被拒绝
- M4 新增慢请求告警日志：超过阈值自动记录 `Slow request detected`
- `.glsl` 导出
- PBR 管线 stub（接口可用，执行返回未启用）

## 目录

- `apps/api`: Fastify API + pipeline orchestrator
- `apps/web`: React + Vite 前端预览

## 核心 API（M1）

- `GET /health`
- `GET /ready`
- `POST /v1/sessions`
- `POST /v1/sessions/:id/messages`
- `GET /v1/sessions/:id/ideation/state`
- `POST /v1/sessions/:id/ideation/messages`
- `POST /v1/sessions/:id/ideation/reset`
- `POST /v1/sessions/:id/optimize/suggest`
- `POST /v1/sessions/:id/optimize/apply`
- `POST /v1/sessions/:id/optimize-current`
- `GET /v1/favorites`
- `GET /v1/favorites/:id`
- `POST /v1/favorites`
- `POST /v1/favorites/:id/rename`（M3 起返回 `410`，公共收藏模式禁用）
- `POST /v1/favorites/:id/archive`（M3 起返回 `410`，公共收藏模式禁用）
- `GET /v1/sessions/:id/revisions/latest`
- `POST /v1/revisions/:id/export`

## 扩展位（为 M2/M3 预留）

- `Pipeline` 统一接口：`generate / iterate / export`
- `pbr_texture` 独立管线类已接入 orchestrator
- 数据模型预留 `albedo/normal/roughness/orm_zip` artifact kind

## 当前限制

- 默认使用内存存储；如需重启不丢失，请切换 PostgreSQL 持久化配置
- `APP_STORE_PROVIDER=memory` 时，会话与 revision/artifact/ideation 数据重启后会丢失
- `APP_STORE_PROVIDER=postgres` + `FAVORITES_PROVIDER=postgres` 时，核心链路可持久化（session/revision/artifact/ideation/favorite）
- Shader 校验为基础语义检查，不是完整 GPU 编译器级校验
- 多模态图片仅支持 `data:image/*` 形式（UI 粘贴自动处理），单张建议不超过约 `1.5MB`
- 需求提炼的视频会在服务端依赖 `ffmpeg` 做抽帧预处理
- PBR 仅 stub，尚未接入图像生成和 ComfyUI 工作流
- 服务端请求不再强制直连，会跟随系统代理/环境代理设置
- 若终端里没有 `HTTPS_PROXY` 但系统代理已开启（macOS Network Proxy），API 会自动桥接系统代理；如需禁用可设 `USE_MACOS_SYSTEM_PROXY=false`

## M1 部署文档

- `docs/M1_ONLINE_INFRA.md`
- `docs/M1_NEON_R2_DO_PLAYBOOK.md`
