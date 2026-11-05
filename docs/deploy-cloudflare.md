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

新功能会带来新迁移，每个只执行一次（D1 → `studio` → Console 粘贴执行）：

| 文件 | 内容 |
|---|---|
| `migrations/0002_gpu.sql` | Pod 模式：`gpu_pods` 表（幂等，重复执行无害） |
| `migrations/0003_loras_stats.sql` | LoRA 库 `loras` 表；`takes` 表加 GPU 型号、时价、视频秒数三列（**只能执行一次**，ALTER 重复会报列已存在，报错可忽略） |
| `migrations/0004_brief.sql` | 导演第一层：`projects` 表加 `brief`、`target_seconds`（同样只执行一次） |
| `migrations/0005_seed_loras.sql` | 预置两个 lightx2v turbo LoRA（幂等） |
| `migrations/0006_adopted.sql` | `gpu_pods` 表加 `adopted` 列（手动建的 Pod 由 Studio 接管；只执行一次） |
| `migrations/0007_seed_more_loras.sql` | 预置 7 个社区 LoRA（fal 写实人物、Jojocodex 运镜 / 物理、anime 风格等；幂等） |
| `migrations/0008_take_progress.sql` | `takes` 表加 `progress_json`（生成进度：阶段、步数、预计剩余；只执行一次） |
| `migrations/0009_take_upscale.sql` | `takes` 表加 `upscale_json`（Open-H3-Regenerate-2K 的 2K 版本；只执行一次） |

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

1. **镜像**：默认不需要自己构建。`RUNPOD_POD_IMAGE` 用 RunPod 官方的
   `runpod/comfyui:1.3.3-comfyuiv0.30.0-cuda13.0`，`RUNPOD_POD_BOOTSTRAP=1` 时 Pod 启动会
   先跑镜像自己的入口（ComfyUI），再从 `https://studio.zyhu.dev/api/pod/bundle` 拉取作业
   服务（handler、server、工作流 JSON，约 22 KB）并在 8000 端口启动。代码永远和仓库同步。
   想要自带作业服务的镜像，用 `workers/h3-runpod/Dockerfile.pod` 构建后把
   `RUNPOD_POD_BOOTSTRAP` 设为 `0`。
2. **网络卷**：放 H3 权重，ID 填 `RUNPOD_NETWORK_VOLUME_ID`；`RUNPOD_DATACENTER_IDS`
   填卷所在的数据中心。
3. **GPU 白名单**：`RUNPOD_GPU_TYPES` 填型号名的子串，按优先级排列（默认
   `RTX 5090,RTX PRO 6000,A100 80GB,A100-SXM4-80GB,H100 80GB,H100 PCIe,H200`），起 Pod 前
   会解析成 RunPod 的精确 ID；Settings → GPU pod → GPU types 能看到哪些被匹配上。
4. **模型放哪**（默认：**本地盘，每次开机下载**）：`RUNPOD_NETWORK_VOLUME_ID` 留空、
   `RUNPOD_NETWORK_VOLUMES` 不填时，Pod 不挂任何卷，启动脚本用 aria2 十六线程把 `models.txt`
   里的 68 GB 下到容器盘（RunPod 机房到 HuggingFace 通常 300 MB/s 以上，几分钟），`/health` 报告
   `models.ready`，齐了 Studio 才显示 running。容器盘默认 120 GB。Stop 会清空容器盘，所以
   空闲自动关机默认 45 分钟。好处：不依赖任何卷，数据中心随便挑，没有全局盘的 venv 和读取
   速度问题。想不自动下载就在 Pod 环境变量里设 `AUTO_DOWNLOAD_MODELS=0`。
   用卷的两种方式如下。
5. **数据中心**（用卷时）：
   - **全局盘（首选）**：一个能被任意数据中心挂载的卷，填 `RUNPOD_NETWORK_VOLUME_ID`，
     `RUNPOD_DATACENTER_IDS` 留空，`RUNPOD_NETWORK_VOLUMES` 不填。起 Pod 时不限数据中心，
     RunPod 在白名单 GPU 里按可用性挑。**全局盘不能挂在 `/workspace`**：官方 ComfyUI 镜像会把
     Python 环境建在那里，而全局盘不支持 venv 需要的文件权限（RunPod 控制台会提示
     "Unsupported volume type"）。所以 `RUNPOD_VOLUME_MOUNT_PATH` 默认是 `/runpod-volume`：
     卷只出借模型，ComfyUI 和 venv 装在容器盘上，作业服务启动时把容器盘上的
     `/workspace/runpod-slim/ComfyUI/models` 软链到卷里的模型目录（在卷上依次找
     `runpod-slim/ComfyUI/models`、`ComfyUI/models`、`models`，只认真有权重文件的那个，再不行就
     全卷搜 `unet`/`diffusion_models`）。**卷上一个权重都没有时，Pod 会自动按 `models.txt` 下载
     约 68 GB 到卷上（只此一次）**，期间 Pod 卡片显示 "H3 models not all present"，下载完自动变 running；
     不想自动下载就在 Pod 环境变量里设 `AUTO_DOWNLOAD_MODELS=0`。每次开机镜像重装 ComfyUI
     约一分钟，模型零下载。若跨区读取慢，Pod 环境变量里设 `MODELS_LINK_FROM=<卷上的模型目录>`、
     `MODELS_LINK_TO=/opt/models`、`MODELS_COPY=1`，启动时拷到本地盘（容器盘要 ≥100 GB）。
   - **每个数据中心一个卷（退路）**：填 `RUNPOD_NETWORK_VOLUMES="EU-RO-1:vol_xxx,US-TX-3:vol_yyy"`
     （密钥），起 Pod 时按顺序遍历数据中心（上次成功的优先），全部失败才显示"暂时没资源"。
6. **工作流**：`workers/h3-runpod/workflows/` 里的 T2VA/I2VA/FL2VA/R2VA JSON 和
   `mapping.json`（已随交接文档放好）。

### 9a. RunPod API 版本（`RUNPOD_API`）

RunPod 有两代 REST API。旧的 v1（`rest.runpod.io/v1`）查不到也挂不上"全局"网络卷
（`/networkvolumes` 返回空，`POST /pods` 带 `networkVolumeId` 报 `network volume not found`）。
新的 v2（`api.runpod.io/v2`）把卷写成 `mounts.network[{volumeId,path}]`，每次请求一个 GPU 型号
（Studio 自己按 GPU × 数据中心遍历），启动命令是一个字符串 `args`，并且能 `PATCH` 已有 Pod 的
启动命令和环境变量。`RUNPOD_API=v2` 是默认值；出问题可以在 wrangler 变量里改回 `v1`。
v2 的字段名来自 RunPod 自己的迁移文档，尚未在真机验证；失败时 Settings 会把请求体和响应
原样显示。

### 9b. 手动建 Pod，再由 Studio 接管

v2 应该能直接挂全局盘自动建 Pod；如果仍然失败，就在控制台手动建一次，之后的启停、作业、
费用统计都由 Studio 管。**用 v2 时接管会自动把 Studio 的启动命令和环境变量 PATCH 到这台
Pod 上（保留它原有的环境变量），正在运行的会重启**，不需要在控制台粘任何东西，只要镜像、
GPU、卷、端口对。Settings 里的 **Apply boot & restart** 随时可以再做一次。

1. Settings → GPU pod → **Show what to paste into RunPod**。页面会列出镜像、要暴露的 HTTP
   端口（8000、8188）、容器盘大小、卷挂载路径、容器启动命令、按优先级排的 GPU 型号，以及一整块
   环境变量（含 worker token 和 R2 密钥，只粘到 Pod 的环境变量里）。
2. RunPod 控制台 → Pods → Deploy：选白名单里的 GPU（5090 / PRO 6000 优先），
   **Network Volume 选 `minimax-h3-models`**，Pod Template 用 Edit / Customize 把上面的值逐项填进去
   （Container Image、Container Disk、**Volume Mount Path 填 `/runpod-volume`，不要用 `/workspace`**、
   Expose HTTP Ports、Container Start Command、Environment Variables）。Secure Cloud。挂载路径建好后
   改不了，挂错了只能终止重建。
3. 部署后复制 Pod ID，回到 Settings → **Adopt** 粘贴。Studio 会读取这台 Pod 的状态、GPU 型号和时价，
   （v2）写入启动命令和环境变量并重启，健康检查通过后把排队的 take 送过去。
4. 被接管的 Pod（卡片上标 *adopted*）**永远不会被 Studio 终止或替换**：Stop 后 Start 拿不到卡时只显示
   "暂时没资源"，稍后再 Retry；真要换型号，到控制台重建一台再 Adopt 一次（旧记录自动标为 terminated，
   卷上的模型不受影响）。Terminate 按钮仍然可用，但那是你明确点的。

一旦 RunPod 公布全局卷对应的 API 字段，把它放进 `RUNPOD_POD_BODY_OVERRIDES`（JSON，合并进
创建请求）就能恢复 Studio 自动建 Pod，不需要改代码。

Serverless 模式仍在代码里（`RUNPOD_MODE=serverless`），暂不维护，列为 TODO。

## 10. GPU 统计与 LoRA

- **GPU 统计**：每个完成的 take 记录它跑在哪种 GPU、当时的时价、生成耗时和视频秒数。
  Settings → GPU pod → "Generation stats by GPU" 按型号汇总总生成时间、总视频时长、
  每秒视频耗费的 GPU 秒数和美元。有数据后成本预估自动改用实测速度（编译预览会标
  "measured"）。把 `RUNPOD_GPU_PRIORITY` 设为 `cost`，起 Pod 时白名单会按"每秒视频
  美元"从低到高排序。agent 用 `gpu_stats` 读同一份数据。
- **LoRA**：`/loras` 页面是全局库，每条记录文件名、HuggingFace 链接、类型（speed /
  style / effect）、默认强度、触发词、推荐步数、适用工作流。项目的 Look 页选默认 LoRA
  （加速 LoRA 放这里），镜头编辑器可覆盖或关闭。编译时把 LoRA 写进 worker 输入，触发词
  进 LOOK 块，加速 LoRA 的推荐步数作为默认步数。**不用加速 LoRA 时**（项目和镜头都没选 speed
  LoRA），编译器自动切到交接文档 §3 的原版采样链：`res_multistep`，调度 `simple`（R2VA 用 `beta`），
  Sigma shift 关掉（1.0），步数默认 `H3_BASE_STEPS=20`，耗时约为 turbo 的 2.5 倍。Board 的 Steps
  留空就是自动；填了数字才覆盖。Pod 上缺文件时 handler 按 HF 链接下载到
  `LORA_DIR`（默认是镜像 ComfyUI 的 `models/loras`；受限仓库在 Pod 环境变量里设
  `HF_TOKEN`）。图里的 LoraLoader 节点要在 `workers/h3-runpod/workflows/mapping.json`
  的 `loras` 槽位里登记，见那里的 README。

## 11. 交接文档落地（HANDOFF.md）

已按交接文档接入：

- 节点映射 `workers/h3-runpod/workflows/mapping.json`：prompt / 宽高 / 帧数在 `104`，步数 `9.steps`，
  seed `15.noise_seed`，首帧 `200`，末帧 `203`，参考图 `201`、`202`，LoRA 槽 `7`，输出 `92`。
  `length` 是帧数（17k+5，24 fps），handler 把秒数换算成 124–362 帧；H3 没有负向提示词。
- LoRA 库预置 fl2v / ref2v 两个 turbo LoRA（8 步，强度 1.0），分别只作用于 T2VA/I2VA/FL2VA 和 R2VA；
  新项目默认带上它们。
- prompt 按交接工作流里实际跑通的写法生成（`H3_PROMPT_FORMAT=lightx2v-lines`）：`字段: 内容`
  段落、段落间空行、`[Shot k]` 段标记；I2VA/FL2VA 用 `<Picture 1> (from [Shot 1]) is fully
  referenced`（FL2VA 加 `ends on <Picture 2>`）；R2VA 用 `subject_definitions / summary（[reference
  generation]）/ retention_analysis（<Subject N> (appears in [Shot 1]): fully_preserved - …）/
  detailed_description / overall_soundscape / non_diegetic_music`；没有音乐写 `N/A`。镜头内的硬切
  变成 `[Shot 2]`、`[Shot 3]` 段。
- 镜像用交接的 `runpod/comfyui:1.3.3-comfyuiv0.30.0-cuda13.0`（宿主 CUDA ≥ 13）。这个镜像把
  ComfyUI 装在卷上的 `/workspace/runpod-slim/ComfyUI`，模型目录就是它下面的
  `models/{unet,text_encoders,vae,loras}`；作业服务启动时自动把 `MODELS_DIR` / `LORA_DIR`
  指到那里。`workers/h3-runpod/download_models.sh` 按 `models.txt` 下载约 68 GB 的底模、
  文本编码器、VAE 和 LoRA。
- 镜像的 start.sh 写死了 venv 名 `.venv-cu128`（13.0 标签也是），`/workspace` 上有 ComfyUI 但没有
  这个 venv 时它会报 `bin/activate: No such file` 并挂起。常规网络卷挂在 `/workspace` 时作业服务的
  `start.sh` 会先检查：有别的 `.venv*` 就用那个（`COMFYUI_VENV_NAME`），一个都没有就按镜像的方式
  新建一个。全局盘上建不了 venv，所以全局盘不挂 `/workspace`（见 §9 第 4 条）。
- 成本常量：每秒视频约 32 秒 GPU（A100 ≈ 35，RTX PRO 6000 ≈ 27），冷启动约 3 分钟。
  有真实 take 后统计表会覆盖它。

- 四个工作流 JSON 已放进 `workers/h3-runpod/workflows/`，映射逐节点核对过；R2VA 的参考图超过
  两张时 handler 会克隆 LoadImage 节点并接到 `ref_images.ref_image_N`（最多 9 张）。
- Studio 经 RunPod 代理访问 Pod 时带浏览器 User-Agent（否则 Cloudflare 403）。
- 交接原文和验证脚本存档在 `docs/handoff/`。

## 11b. Regenerate 2K（Open-H3-Regenerate-2K）

NVIDIA Sana 团队开源的 H3 高分辨率再生成阶段，集成为 Board 上完成 take 的 **Regenerate 1080p / 2K / 4K**
按钮和 MCP 的 `regenerate_take`。Pod 开机时（`REGEN_2K=1`，默认开）会 clone 两个节点包
（`rdh9616/ComfyUI-Open-H3-Regenerate`、`LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler`）并在核心模型之后
下载约 21 GB 权重（`workers/h3-runpod/models-regen.txt`：refiner LoRA 12.4 GB、sharp 分支 1.2 GB、快速
VAE 解码器 6.5 GB、3D latent 上采样器 0.7 GB）。`/health` 的 `regen.ready` 说明是否就绪；没就绪时按钮
会报错说明缺什么。

- 它是"重画"不是"放大"：默认 `start_sigma = 0` 更锐但会改画面，勾选 **stay close to the draft**
  （0.8）更贴近草稿，角色镜头建议勾选。
- 耗时：5 秒片段 2K 约 150 GPU 秒（dense attention），4K 两遍约 2.2 倍。`REGEN_SPARSE_ATTN=1` 插入 ComfyUI
  的 BlockSparseAttention（sol-attn）能快约 4 倍，但 ComfyUI issue 16382 报告它和 LoRA 一起用有伪影，默认关。
- 2K 文件存在 take 旁（`upscale_json`），Board 可切换 768p / 2K 播放；`export_project` 的 `master-upscaled`
  预设用 2K 文件，缺 2K 的片段回退 768p 并在返回里列出。
- 显存：LoRA 本身 12.4 GB（节点内转 bf16 后 6.2 GB）加底模 21 GB，5090 32 GB 要靠卸载到内存，PRO 6000 宽裕。
- 节点包在 ComfyUI 0.42 测试，我们的镜像是 0.30，第一次跑若节点导入失败，容器日志里会有
  `ComfyUI-Open-H3-Regenerate` 的 import error，把它贴出来。

## 12. 第一次真机：验证顺序

1. Settings → GPU pod：Allowed GPUs 不再是红字，Status 为 off。点 **GPU types**，确认白名单里
   至少有几条标了 allowed（型号名按子串匹配）。
2. 全局盘的情况按 §9b 先在控制台建好 Pod 并 **Adopt**；否则点 **Start**。状态应依次为
   starting → running；"starting" 期间 Pod 在拉镜像、跑入口、拉作业服务。
   卡住超过 10 分钟：到 RunPod 控制台看该 Pod 的日志，常见是作业服务没起来（`/api/pod/bundle`
   没放进 Access bypass，或 `STUDIO_WORKER_TOKEN` 没设）。
3. running 之后，RunPod 控制台 → 该 Pod → Connect → HTTP 8000 端口，访问 `/health`（需要
   `X-Studio-Token` 头，用浏览器看会是 401，正常）。
4. Studio 里：建项目 → Script 批准 → 一个 5 秒 `text` 镜头的分镜表并批准 → Board 里对它点
   Generate take。侧栏显示 take 在排队，首个任务要加载 21 GB 底模和文本编码器，交接实测冷跑
   约 3–6 分钟，热跑 5 秒片段约 3 分钟（A100）。
5. take 完成后卡片出现缩略图，Settings 的 GPU 统计表出现第一行；预估开始用实测速度。
6. 15 分钟没有任务 Pod 自动停机；再点 Start 时若拿不到卡，Studio 自建的 Pod 会自动换型号或
   数据中心重建，接管的 Pod 只提示"暂时没资源"。
