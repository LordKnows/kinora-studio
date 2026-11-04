# 用 Cloudflare 网页端部署 Cinema Studio

目标：把 Studio 跑在 `studio.zyhu.dev` 上，媒体文件走同一个域名下的 `/media/*`
（Studio 通过 R2 binding 直接读桶，不需要给 R2 单独配域名）。全部在 Cloudflare
仪表盘里点出来；`wrangler.jsonc` 里的 D1 ID 和域名已经填好。

前提：你的域名已经托管在这个 Cloudflare 账号里（DNS 在 Cloudflare）。

---

## 1. 建数据库（D1）

Workers & Pages 左侧 **Storage & Databases → D1 SQL Database → Create**

- 名称：`studio`（已建，ID 已写入 `wrangler.jsonc`）。
- 初始化表结构：数据库页面 → **Console** 标签 → 把仓库里
  `migrations/0001_init.sql` 的全文粘进去 → Execute。看到 `schema_migrations`
  之外的 14 张表出现就行。

  > 如果 Console 对多条语句报错，用一次命令行：
  > `npx wrangler d1 migrations apply studio --remote`（需要 `npx wrangler login`）。

### 1b. 升级表结构（已有数据库时）

Pod 模式新增了 `gpu_pods` 表。D1 → `studio` → Console，把 `migrations/0002_gpu.sql`
的内容粘进去执行一次即可（语句是幂等的，重复执行无害）。

## 2. 建对象存储（R2）

**R2 Object Storage → Create bucket**

- 名称：`studio`，位置提示（Location hint）选你希望数据所在的区域。
- **不需要**给桶连自定义域：Studio 的 `/media/*` 路由通过 `wrangler.jsonc` 里的
  `TAKES` binding 读桶，公开地址就是 `https://studio.zyhu.dev/media/<key>`，
  `R2_PUBLIC_BASE_URL` 已设为 `https://studio.zyhu.dev/media`。
- **CORS**（浏览器直传需要）：进入桶 → **Settings → CORS policy → Add CORS policy**，
  粘贴：

  ```json
  [
    {
      "AllowedOrigins": ["https://studio.zyhu.dev"],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["content-type"],
      "MaxAgeSeconds": 3600
    }
  ]
  ```

- **R2 → Manage API tokens → Create API token**：权限 **Object Read & Write**，
  范围只勾 `studio` 这个桶。记下 **Access Key ID**、**Secret Access Key**，以及
  页面上的 **Account ID**（也可以在仪表盘右侧 Account ID 看到）。

## 3. 创建 Worker 并连上 GitHub（Workers Builds）

**Workers & Pages → Create → Workers → Import a repository**

- 授权 GitHub，选择仓库 `LordKnows/open-higgsfield-server`。
- **Project name**：`cinema-studio`（必须和 `wrangler.jsonc` 里的 `name` 一致）。
- **Production branch**：你要部署的分支（现在代码在 `claude/happy-ride-ui9t0n`；
  合并到 `main` 后改成 `main`）。
- **Build command**：`npx opennextjs-cloudflare build`
- **Deploy command**：`npx opennextjs-cloudflare deploy`
- Root directory 留空。保存并开始第一次构建。

第一次构建会读取仓库里的 `wrangler.jsonc`，自动绑定 D1（`DB`）和 R2（`TAKES`），
并写入 `vars` 里的非敏感变量。构建完成后 Worker 会有一个 `*.workers.dev` 地址。

## 4. 绑定你的子域名

Worker 页面 → **Settings → Domains & Routes → Add → Custom Domain**，填
`studio.zyhu.dev`。Cloudflare 自动建 DNS 和证书。

## 5. 填变量和密钥

Worker 页面 → **Settings → Variables and Secrets**。

非敏感变量（`wrangler.jsonc` 的 `vars` 是来源，改那里再提交；下面两条必须改成你的域）：

| 变量 | 值 |
|---|---|
| `STUDIO_PUBLIC_URL` | `https://studio.zyhu.dev` |
| `R2_PUBLIC_BASE_URL` | `https://studio.zyhu.dev/media`（已在配置里） |
| `STUDIO_DB` | `d1`（已在配置里） |
| `AUTH_MODE` | 先 `access`（第 6 步配好后）；想先看页面可暂时 `dev` |

密钥（在仪表盘里以 **Secret** 类型添加，不进仓库）：

| 密钥 | 从哪来 |
|---|---|
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | 第 2 步 |
| `R2_BUCKET` | `studio` |
| `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` | 第 6 步 |
| `RUNPOD_API_KEY` | RunPod → Settings → API Keys |
| `RUNPOD_POD_IMAGE` | 你的 ComfyUI 镜像（用 `workers/h3-runpod/Dockerfile.pod` 叠上作业服务） |
| `RUNPOD_NETWORK_VOLUME_ID` | 放 H3 权重的网络卷 ID |
| `STUDIO_WORKER_TOKEN` | 自己生成，Studio 和 Pod 内作业服务之间的共享密钥 |
| `RUNPOD_WEBHOOK_SECRET` | 自己生成一串随机字符（32 位以上） |

`RUNPOD_GPU_TYPES`（允许的 GPU 型号，逗号分隔）、`RUNPOD_DATACENTER_IDS`、
`RUNPOD_IDLE_STOP_MINUTES` 是普通变量，写在 `wrangler.jsonc` 的 `vars` 里。
型号 ID 可以在 Studio 的 Settings → GPU pod → "GPU types" 里查。
| `CRON_SECRET` | 自己生成，供定时 Worker 调用轮询 |
| `MCP_STATIC_TOKEN` | 可选，给 Claude Code 这类能发 header 的客户端 |

改完密钥要 **Deploy** 一次（Deployments → 最新一次 → Retry/Redeploy）才生效。

## 6. 网页登录：Cloudflare Access

**Zero Trust（左侧菜单）→ Access → Applications → Add an application → Self-hosted**

- Application name：`Cinema Studio`
- Application domain：`studio.zyhu.dev`
- Policy：Action **Allow**，Include → **Emails** → 填你的邮箱。保存。
- 保存后在应用的 **Overview** 复制 **Application Audience (AUD) Tag** → 就是
  `CF_ACCESS_AUD`。
- **Team domain**：Zero Trust → Settings → Custom Pages 里显示的
  `xxx.cloudflareaccess.com` → 就是 `CF_ACCESS_TEAM_DOMAIN`（不带 https://）。

再加一个 **Bypass** 应用，让机器调用的路径绕过登录（它们各自有自己的鉴权）：

- Add an application → Self-hosted，名称 `Cinema Studio machine paths`，
  在 Application domain 里逐条添加（同一个应用可以加多条域名 + 路径）：
  - `studio.example.com/mcp`
  - `studio.example.com/.well-known/*`
  - `studio.example.com/api/oauth/*`
  - `studio.example.com/api/runpod/hook`
  - `studio.example.com/api/assembler/hook`
  - `studio.example.com/api/cron/sweep`
- Policy：Action **Bypass**，Include → **Everyone**。
- 注意 `/oauth/authorize`（同意页）**不要**加进 bypass，它必须登录。

然后把 Worker 的 `AUTH_MODE` 设成 `access`，重新部署。打开
`https://studio.zyhu.dev` 会先看到 Access 的邮箱验证码登录。

## 7. 定时轮询（可选，但建议）

RunPod 的 webhook 是主路径；定时轮询只是兜底。

**Workers & Pages → Create → Workers → Create Worker**（名称 `cinema-studio-cron`）
→ 用在线编辑器把 `workers/cron/worker.js` 的内容粘进去 → Deploy。然后：

- Settings → Variables：`STUDIO_PUBLIC_URL` = `https://studio.zyhu.dev`，
  `CRON_SECRET` = 第 5 步同一个值（Secret 类型）。
- Settings → Triggers → **Cron Triggers → Add**：`* * * * *`。

## 8. 验证

1. `https://studio.zyhu.dev/api/me` → 登录后返回你的邮箱、`authMode: "access"`、
   `r2Configured: true`。
2. 首页建一个项目，Settings 页看三盏后端灯。
3. `https://studio.zyhu.dev/.well-known/oauth-authorization-server` 不登录也能打开。
4. 在 Claude 的 Settings → Connectors → Add custom connector 填
   `https://studio.zyhu.dev/mcp`，会跳到 Studio 的同意页；Grok 在
   grok.com → Connectors → New → Custom 同样操作。

## 常见问题

- **构建失败说找不到 `database_id`**：第 1 步的 ID 没填进 `wrangler.jsonc`。
- **页面能开但建项目报 `no DB binding`**：Worker 没绑定 D1，检查 `wrangler.jsonc`
  的 `d1_databases` 在部署时是否生效（Settings → Bindings 应能看到 `DB`）。
- **上传失败**：R2 的 API token 不对，或 `R2_ACCOUNT_ID` / `R2_BUCKET` 没填；浏览器控制台报 CORS，则是桶的 CORS policy 没加（第 2 步）。
- **媒体 404**：Worker 的 Settings → Bindings 里没有 `TAKES`，或对象不在 `uploads/` / `projects/` 前缀下。
- **MCP 连接器登录后 401**：`STUDIO_PUBLIC_URL` 和实际域名不一致，OAuth 元数据里
  的地址会指向错的主机。


## 9. RunPod Pod 模式

Studio 自己管理一台 Secure Cloud 的 Pod：第一次生成时创建，网页侧栏和 Settings
页可以 Start / Stop / Terminate，agent 有 `gpu_status` / `gpu_start` / `gpu_stop`
工具，空闲超过 `RUNPOD_IDLE_STOP_MINUTES` 自动关机。Stop 后再 Start 若拿不到
GPU，会自动终止旧 Pod 并在允许的型号里重新创建；都没货就显示"暂时没资源"，
稍后 Retry。

准备工作：

1. **镜像**：以你的 ComfyUI 镜像为基础构建 `workers/h3-runpod/Dockerfile.pod`
   （构建上下文是 `workers/` 目录：`docker build -f workers/h3-runpod/Dockerfile.pod
   --build-arg BASE_IMAGE=<你的镜像> -t <registry>/studio-h3:pod workers/`），推到
   Docker Hub 或 GHCR，把镜像名填进 `RUNPOD_POD_IMAGE`。镜像的 ComfyUI 启动命令若
   不是默认的 `/workspace/ComfyUI/main.py`，在 Pod 环境变量里设 `COMFY_CMD`。
2. **网络卷**：放 H3 权重，ID 填 `RUNPOD_NETWORK_VOLUME_ID`；`RUNPOD_DATACENTER_IDS`
   填卷所在的数据中心。
3. **GPU 白名单**：`RUNPOD_GPU_TYPES` 填允许的 gpuTypeId（Settings → GPU pod → GPU
   types 可查），Studio 只会在这些型号里起 Pod，按可用性自动挑。
4. **工作流**：`workers/h3-runpod/workflows/` 里的 T2VA/I2VA/FL2VA/R2VA JSON 和
   `mapping.json`。

Serverless 模式仍在代码里（`RUNPOD_MODE=serverless`），暂不维护，列为 TODO。
