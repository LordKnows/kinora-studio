# Cinema Studio 复刻方案（MiniMax H3 导向，RunPod 自托管）

> 目标：在本仓库基础上，复刻 Higgsfield Cinema Studio 的完整结构
> （Project → Scene → Shot、项目级 Look、Hero Frame First、Cast / Elements、
> 每镜头生成、多镜头、时间线导出、自然语言编排 agent），
> 生成引擎统一换成 **自托管在 RunPod 上的 MiniMax H3 开源权重**，
> 编排 agent 使用订阅版 Grok 与 Claude（不走 API）。
>
> 状态：设计稿 v3（v1 以 Higgsfield 托管 H3 为后端；v2 改为 RunPod 自托管；
> v3 确定部署目标为 Cloudflare Workers + R2，并补充前端分工、MCP 指南投递、服务器加固；
> v4 补齐接口清单与鉴权矩阵、检查点状态机、Assembler 契约、按模式分化的 Compiler 模板、
> prompt 评测方案、`edit` 模式，并确定网页登录方式）。
> 标注「待验证」的条目来自二手资料，实施前需对照官方文档或实测确认。

---

## 0. 一页总览

```
                  ┌──────────────────────────────────────────────┐
  用户的订阅版     │   Grok (grok.com)        Claude (Desktop/Web)  │
  聊天客户端       │        └──── 远程 MCP 自定义连接器 ────┘        │
                  └───────────────────┬──────────────────────────┘
                                      │  tools: write_script / breakdown_shots /
                                      │         build_cast / generate_shot / ...
                                      ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Studio 服务端（Next.js 16，本仓库扩展）                                │
│                                                                       │
│   REST + Server Actions ◄──► Web Studio UI（项目 / 分镜表 / 时间线）     │
│   MCP Server (/mcp, OAuth 2.1)                                        │
│   Prompt Compiler（Shot JSON → H3 prompt 文本）                        │
│   Orchestrator（任务队列 + 服务端轮询 + 重试 + 预算）                     │
│   Assembler（ffmpeg 拼接 / 混音 / 字幕 / 导出预设）                      │
│   ──────────────────────────────────────────────────────────────────  │
│   运行在 Cloudflare Workers（OpenNext）；Postgres（Neon 经 Hyperdrive）  │
│   R2（所有素材 / 中间结果 / 成片）；Cron Triggers 做轮询兜底              │
└──────────┬───────────────────────────────────────┬────────────────────┘
           │ GenerationBackend 接口                 │
           ▼                                       ▼
┌──────────────────────────────┐     ┌──────────────────────────────────┐
│ RunPod Serverless Endpoint   │     │ Higgsfield Platform API（可选）    │
│  ComfyUI worker + H3-Base    │     │  图像模型（Soul 2 / Flux 等）       │
│  T2VA / I2VA / FL2VA / R2VA  │     │  用于 hero frame 与角色设定图       │
│  网络卷 /runpod-volume 存权重 │     └──────────────────────────────────┘
│  webhook → /api/runpod/hook  │
└──────────────────────────────┘
```

三个关键决策：

1. **以"镜头"为原子单位，每个镜头 = 一次 H3 请求。** 这与本仓库现有的
   `{model, prompt, media, settings}` 一一对应，生成层通过一个
   `GenerationBackend` 接口对接 RunPod（视频）和 Higgsfield（图像）。
2. **Hero Frame First + Elements。** 一致性由图决定，不由文字决定。
   角色 / 场景 / 道具先用图像模型做成参考图，再通过 H3 的 omni-reference
   或首尾帧喂进去。
3. **控制反转：LLM 调我们，而不是我们调 LLM。** 因为 Grok / Claude 都是订阅版、
   没有 API，所以把 Studio 暴露成远程 MCP 服务器，用户在自己的聊天客户端里
   让 Grok / Claude 扮演 Mr. Higgs / Supercomputer，通过工具调用驱动整个流水线。
   同时保留一个「Prompt Pack」复制粘贴兜底路径。

---

## 1. 需求与约束

### 1.1 要复刻的 Cinema Studio 结构（功能需求）

| Cinema Studio 功能 | 本方案对应 |
|---|---|
| Project → Scene → Shot 三层结构 | 领域模型 §3 |
| 项目级 Look（类型、调色板、机位、镜头、光线，设一次全镜头继承） | `Project.look` + Prompt Compiler 注入 |
| Mr. Higgs / AI Director：剧本 → 镜头、选机位、写 prompt | MCP 工具 + Director Skill（§6） |
| Hero Frame First：先出静帧，选一张"Use as ref"，再动起来 | `Shot.heroFrame` + 图像模型 + H3 i2v |
| Cast / Soul Cast：可复用演员，带正 / 侧 / 背三视图 | `Element(kind=character)` + `CharacterSheet` |
| Elements：角色 / 场景 / 道具，项目内有效，可跨项目调用 | `Element` 表 + 库 |
| 每镜头独立选模型、显式镜头运动 | `Shot.engine` + `Shot.camera` |
| 多镜头：一次生成内含多个 cut，自动 / 手动模式 | H3 分时间段 prompt（§5.3） |
| 关键帧动画（首帧 / 末帧） | H3 image-to-video 首尾帧 |
| 时间线 + 导出预设 | Assembler（§4.4）+ 时间线端点（§7） |
| Supercomputer：自然语言 → 计划 → 派发 → 组装 | MCP 工具链 + Orchestrator |

### 1.2 硬约束

- 生成模型：**只用 MiniMax H3 系列，且必须部署在 RunPod 上调用**，不走 Higgsfield
  托管的 H3，也不在本地跑。推论：可用的是开源的 **H3-Base**（768p + 原生音频），
  托管版独有的 2K 上采样和 Context-IR 不可用；模型的地域许可（§2.3）由部署者负责。
- 编排 agent：**订阅版 Grok 和 Claude，并列，不走 API**。
  推论：服务端不能主动调用 LLM；任何"AI 写剧本 / 拆镜头"都必须由用户在
  聊天客户端里触发。禁止做浏览器自动化去操控聊天界面（违反服务条款、不稳定）。
- 其他结构与 Cinema Studio 保持一致。

### 1.3 非功能需求

- 一个项目典型规模：10–40 个镜头，每镜头 5–15 秒，每镜头 1–4 个 take。
- 单镜头生成 1–5 分钟，整片生成要能跑几十分钟，**不能依赖浏览器标签页存活**。
- 成本可见：按秒计费，每次生成前显示预估，项目有预算上限。
- 单用户 / 小团队自托管优先，不做多租户。
- 部署目标：**Cloudflare**（Workers 跑应用、R2 存文件），GPU 在 RunPod，ffmpeg 在 RunPod CPU
  worker 或 Cloudflare Containers。本地只做开发，不做生产，因为 MCP 连接器和 RunPod webhook
  都需要公网 HTTPS。

---

## 2. MiniMax H3 调研结论

### 2.1 托管版 H3 的事实（作为能力上限的参照）

> 下表描述的是 MiniMax / Higgsfield 托管的 H3。本方案用的是自托管的 H3-Base，
> 实际能力以 §2.3 为准；保留本表是为了说明自托管缺了什么。

| 项目 | 结论 | 来源可靠度 |
|---|---|---|
| 系列成员 | MiniMax-H3（主力）、H3-Max（更快，480p/768p）、H3-Highspeed、H3-Lite | MiniMax 官方 API 文档列出；Higgsfield 目前**只暴露 `minimax/h3`** 一个 |
| 时长 | 5–15 s（Higgsfield）；MiniMax 原生 4–15 s | 多源一致 |
| 分辨率 | 原生 2K（默认），24 fps；MiniMax 原生 768p / 2K | 多源一致；Higgsfield 上 2K 可用性**待验证** |
| 宽高比 | 6 种，21:9 到 9:16；i2v 支持 `auto` | 多源一致 |
| 音频 | **同一次生成原生输出立体声**（对白、音效、音乐都由 prompt 控制） | 官方博客 |
| 文生视频 | `minimax/h3/text-to-video`：prompt, duration, resolution, aspect_ratio | Higgsfield 文档 |
| 图生视频 | `minimax/h3/image-to-video`：`image_url` 为首帧；Higgsfield 博客称支持 Start/End Frame | 首帧确认；**末帧参数名待验证** |
| 参考生视频 | `minimax/h3/reference-to-video`：`image_urls`(≤9) + `video_urls`(≤3) + `audio_urls`(≤3)，总数 ≤12；参考音视频每段 2–15 s，合计 ≤15 s；音频必须搭配至少一张图或一段视频 | Higgsfield 文档 + 博客 + 第三方 |
| 互斥 | **图生视频（首尾帧）与参考生视频互斥**，不能同时给 | MiniMax 官方 |
| 编辑 | 参考生视频带 `video_urls` 时可做局部编辑（"精确的局部修改"） | fal 指南，细节少 |
| 续写 | 未找到官方 extend 端点 | 空白 |
| prompt 上限 | 约 7000 字符 | 社区镜像，**待验证** |
| 价格 | Higgsfield API 约 $0.065/s（折扣价），标价 $0.13/s；消费端 5 s 2K ≈ 20 credits | 多源，数字不一致 |

### 2.2 H3 的 prompt 写法（决定 Director 层的输出格式）

社区指南对官方格式的共识：

1. **参考角色声明**：每个参考文件写明用途（"Image 1 = 主角身份，Image 2 = 场景，
   Audio 1 = 配音音色"）。这是 reference-to-video 最高杠杆的一条。
2. **核心意图**：一句话讲清这个镜头在讲什么。
3. **分时间段视觉时间线**：`0–3s … / 3–7s … / 7–10s …`，各段加起来等于 duration；
   一段一个主动作，写"起始状态 → 一个主要动作 → 结束状态"。
4. **镜头运动用自然语言**，不要用旧版 Hailuo 的 `[Push in]` 方括号指令。
   每镜头**一个**主运动 + 幅度 + 速度（"缓慢推近，前 4 秒"）。
   支持的运动类型：zoom、push in / pull out、pan、truck、tilt、pedestal、arc、
   tracking、static、shake、POV、roll。**H3 默认会漂移**，要锁定画面必须显式写 "holds a static shot"。
5. **对白写原文**：给每个说话人稳定 ID，每句前缀说话人 / 语言 / 情绪。
6. **声音分块**：音效（物理声）、环境声、音乐（非叙事）各一块；不要音乐就写 `Music: N/A`。
7. **约束块**：no text / no logos / no extra dialogue 等。
8. **一次生成内多镜头**：用时间段 + "hard cut at 6s" 之类的措辞，在一个 15 秒 clip 里切 2–3 个 cut。

### 2.3 自托管 H3-Base 的事实（本方案真正的能力边界）

| 项目 | 结论 | 可靠度 |
|---|---|---|
| 开源内容 | **H3-Base**：联合生成 768p 视频 + 同步立体声。不含 H3-Context-IR（托管版的 prompt 处理 / 长上下文参考系统）和 H3-Regenerate-2K（2K 上采样） | MiniMax 官方文档 |
| 许可证 | MiniMax Community License，非 OSI。**适用地域为全球除美国、欧盟、英国、韩国**；限制覆盖模型和产物的使用、分发、展示；被排除地区可向 MiniMax 申请单独授权；禁止用产物训练其他模型 | 许可证原文 + 多源 |
| 官方推荐的两条自托管路径 | (a) **ComfyUI ≥ 0.30.0 原生节点 + 模板**（T2V / I2V / 参考驱动），用 Comfy-Org 的裁剪 + 量化权重（INT8 / NVFP4），官方注明与 BF16/FP32 基线**不是同一数值基准**；(b) **SGLang 服务器**跑官方完整检查点，参考配置 8×B200 | MiniMax 官方文档 |
| 其他推理栈 | vLLM-Omni 社区 recipe（4 卡：`--num-gpus 4 --usp 4`，支持 4 步 turbo LoRA）、diffusers、DiffSynth-Studio、SD.Next | 社区 |
| 权重体积 | 完整 BF16 约 134 GiB；裁剪 INT8 + NVFP4 约 42.5 GB | 第三方实测 |
| 显存 | 4×H100（TP2 + Ulysses2）每卡峰值约 66 GB，5 s 1344×768 约 13 s；单张 80–96 GB 卡跑 INT8 + 分层 offload 可行但慢；消费卡靠 offload 能跑但分钟级 | 第三方实测，**待复测** |
| 模式 | 社区 RunPod worker 提供 **T2VA、I2VA、FL2VA（首尾帧）、R2VA（参考图）**，另有 "Singularity R2VA"（最多 3 张参考图 + 1 段参考视频）和多场景 Director 工作流 | 社区 worker README |
| 参考上限 | 自托管的参考模式约 **3 图 + 1 视频**（社区 worker），远小于托管版的 9 / 3 / 3；是否支持参考音频**未确认** | 社区，**待验证** |
| 分辨率预设 | `1344x768 (16:9)`、`1184x864 (4:3)`、`auto`；可选 TensorRT 上采样 + RIFE 插帧后处理 | 社区 worker |
| 速度 | 8 步 lightx2v turbo LoRA（fl2v / ref2v）；单卡生成时长未公布，**P0 必须实测** | 社区 worker |
| 提示词增强 | 托管版的 Context-IR 不在开源包里；社区 worker 内置一个 Qwen3.5-9B GGUF 做 `enhance`，可关 | 社区 worker |

### 2.4 RunPod 的事实

| 项目 | 结论 |
|---|---|
| 产品形态 | **Serverless**（按秒计费的 Flex worker，可缩到零）和 **Pod**（按小时的整机）。社区 H3 worker 是 Serverless 形态，RunPod Hub 可一键部署 |
| 作业 API | `POST /v2/{endpoint}/run` 异步返回 job id；`GET /v2/{endpoint}/status/{id}` 返回 `IN_QUEUE / IN_PROGRESS / COMPLETED / FAILED / CANCELLED / TIMED_OUT`；`/cancel`、`/retry`；`/runsync` 仅适合短任务 |
| Webhook | 请求体里与 `input` 并列放 `webhook` URL，完成后 POST 结果；失败重试 2 次、间隔 10 s |
| 超时 | `executionTimeout` 默认 600 000 ms（仅计 worker 执行时间，范围 5 s–7 天）；`ttl` 默认 24 h 含排队；**结果在完成后只保留 30 分钟**，必须及时取走 |
| 幂等 | 网络错误后重发 `/run` 会产生第二个计费作业；必须记下 job id 用 `/status` 跟踪 |
| 权重存储 | 网络卷挂载在 `/runpod-volume`，不放卷上的文件在 worker 回收后消失；H3 worker 要求 **≥160 GB** 卷，首次启动自动下载约 100 GB |
| 冷启动 | 大模型冷启动很重；社区建议 **max workers = 1、保持 1 个 warm worker 排队跑**，而不是多个冷 worker；可用 FlashBoot、active workers > 0 |
| GPU 档位 | 社区 worker 要求 **96 GB 级 Blackwell**（`BLACKWELL_96` 池，即 RTX PRO 6000 96 GB 一类）；32B 文本编码器 + 两个 DiT + TensorRT 引擎需要这个余量 |
| 大文件输出 | worker 自己负责把产物上传到 S3 兼容存储（MinIO / B2 / Spaces 等），不要走 base64 回传 |
| 价格（2026 年中，多源不一致，**待核对**） | Serverless Flex：H100 约 $4.79/h、H200 约 $5.93/h、B200 约 $8.64/h；Pod：H100 SXM 约 $3.49/h、H200 约 $4.59/h、B200 约 $6.79/h；Serverless 比 Pod 贵 26–71%，换来缩零和自动扩缩 |

### 2.5 "H3 导向"对架构的具体影响

| Cinema Studio 的 Seedance 导向 | 换成 H3 后 |
|---|---|
| 音频往往后期加 | H3 原生出声，**对白 / 音效 / 音乐在 Director 阶段就写进镜头**；后期只做混音平衡和配乐替换 |
| 参考图 + 首尾帧可同时用 | 互斥 → 每个镜头必须二选一：**Keyframe 模式**（首尾帧，适合连续动作和转场）或 **Reference 模式**（omni，适合角色 / 产品一致性） |
| 单段最长 30 s–1 min | 单段 ≤15 s → 镜头切分更细，长镜头靠**末帧接下一镜头首帧**链式衔接 |
| 多模型按镜头切换 | 引擎固定为自托管 H3-Base；"快速 / 低清"档改为 worker 的 turbo LoRA 步数（8 步 previz，更多步数出成片） |
| 原生 2K | **自托管只有 768p**（1344×768）。成片分辨率定为 768p；需要更高分辨率时在 Assembler 阶段做可选上采样（worker 内置 TensorRT 上采样，或独立上采样模型） |
| 参考 9 图 + 3 视频 + 3 音频 | 自托管约 3 图 + 1 视频 → **参考预算紧张**：角色一张正面图 + 场景一张 + hero frame 一张就满了。角色三视图改为"主参考一张 + 其余由 hero frame 承载"；音色一致性无法靠参考音频，改为对白文本里固定"声线描述" |
| Context-IR 做 prompt 处理 | 不可用 → **Prompt Compiler 的格式化变得更重要**；worker 内置的 Qwen 增强器只在 text 模式打开 |
| Soul Cast 出三视图 | 用本仓库已有的图像模型（Soul 2 / Flux 2 / Qwen Image 3 等，经 Higgsfield）做角色设定图，H3 本身不出静帧。若将来图像模型也要自托管，再加一个 RunPod endpoint 即可，接口不变 |

---

## 3. 领域模型

```
Project
 ├─ look: LookSettings        # 项目级风格，所有镜头继承
 ├─ budget: { capUsd, spentUsd }
 ├─ script: Script            # 版本化，带 approval
 ├─ shotlistApproval          # 分镜表的检查点状态（§3.2）
 ├─ elements[]: Element       # 角色 / 场景 / 道具（可从库导入）
 ├─ scenes[]: Scene
 │    └─ shots[]: Shot
 │         ├─ heroFrame?: Asset
 │         ├─ takes[]: Take   # 每次生成一个 take
 │         └─ selectedTakeId
 └─ timeline: Timeline         # 镜头顺序、入出点、转场、混音
```

### 3.1 核心实体

```ts
type LookSettings = {
  genre: string;            // "neo-noir thriller"
  palette: string;          // "teal and amber, crushed blacks"
  camera: string;           // "Arri Alexa, anamorphic"
  lens: string;             // "35mm, shallow DOF"
  lighting: string;         // "practical sources, hard key"
  aspectRatio: "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
  resolution: "768p";       // 自托管 H3-Base 只有 768p
  upscale: boolean;         // 导出时是否做后处理上采样
  negative: string[];       // ["no on-screen text", "no logos"]
};

type Element = {
  id: string;
  projectId: string | null;   // null = 全局库
  kind: "character" | "location" | "prop";
  name: string;
  description: string;        // 文字设定，供 Director 和 Compiler 引用
  refs: Asset[];              // 参考图；角色应含正 / 侧 / 背三视图
  voiceRef?: Asset;           // 角色配音样本（音频，≤15 s）
};

type Scene = { id: string; index: number; slug: string; location?: ElementId; summary: string };

type Script = {
  id: string; projectId: string; version: number; text: string;
  approval: "draft" | "approved";          // 检查点 1，见 §3.2
  createdAt: number; approvedAt?: number;
};

type Shot = {
  id: string; sceneId: string; index: number;
  durationS: number;                       // 5–15
  mode: "keyframe" | "reference" | "text" | "edit"; // 对应 worker 的 FL2VA / I2VA、R2VA、T2VA、R2VA+video
  sourceTakeId?: AssetId;                  // edit 模式：被编辑的源视频（上一 take 或任意 R2 视频）
  editInstruction?: string;                // edit 模式：只写"改什么"，不重述整个镜头
  intent: string;                          // 核心意图一句话
  beats: Beat[];                           // 分时间段视觉时间线
  camera: { move: CameraMove; amplitude: "subtle"|"moderate"|"strong"; speed: "slow"|"medium"|"fast"; note?: string };
  dialogue: Line[];                        // { speaker: ElementId, text, language, delivery }
  sound: { sfx: string[]; ambience: string; music: string | "N/A" };
  characters: ElementId[]; location?: ElementId; props: ElementId[];
  linkToPrev: "cut" | "continuous";        // continuous ⇒ 首帧取上一镜头末帧
  heroFrameId?: AssetId;                   // keyframe 模式首帧
  endFrameId?: AssetId;                    // keyframe 模式末帧（可选）
  compiledPrompt?: string;                 // Compiler 输出，可人工覆盖
  promptOverride?: string;
};

type Beat = { from: number; to: number; action: string; cut?: boolean };  // 秒，段和 = durationS；cut=true 表示此段开头硬切

type CameraMove = "static" | "push_in" | "pull_out" | "pan" | "tilt" | "truck" | "pedestal"
  | "arc" | "tracking" | "handheld" | "pov" | "roll" | "zoom";

type Take = {
  id: string; shotId: string; n: number;
  backend: "runpod" | "higgsfield";
  request: { workflow: string; input: unknown }; // 实际发给后端的东西，可追溯
  requestId?: string;                            // RunPod job id 或平台 request_id
  status: "queued"|"running"|"completed"|"failed"|"canceled"|"timeout";
  resultUrl?: string; lastFrameUrl?: string; thumbUrls?: string[];  // 均由 worker 产出并直传 R2
  executionMs?: number; costUsd?: number; error?: string; seed?: number;
  review?: { score: 1|2|3|4|5; notes: string; by: "human"|"agent"; at: number };
  createdAt: number; finishedAt?: number;
};

type ExportJob = {
  id: string; projectId: string; preset: "master-768p" | "master-upscaled" | "social-9x16" | "preview-480p";
  status: "queued"|"running"|"completed"|"failed";
  resultUrl?: string; srtUrl?: string; error?: string; createdAt: number; finishedAt?: number;
};

type Asset = { id: string; url: string; kind: "image"|"video"|"audio"; width?: number; height?: number; durationS?: number; source: "upload"|"generated"|"frame-extract"; meta: Record<string, unknown> };

type Timeline = { clips: { shotId: string; takeId: string; inS: number; outS: number; transition: "cut"|"dissolve" }[]; music?: AssetId; mix: { dialogueDb: number; sfxDb: number; musicDb: number } };
```

### 3.2 检查点状态机（人工确认在哪里卡住 agent）

Cinema Studio 的流程里，改一个字的剧本或分镜会让下游几十个镜头全部重做，所以这两处必须
由人确认后 agent 才能往下花钱。规则写死在服务端，不靠 agent 自觉：

```
Script.approval:      draft ──(approve_script)──► approved
                        ▲                            │
                        └──── 任何 save_script ───────┘   # 新版本回到 draft

Project.shotlistApproval: draft ──(approve_shotlist)──► approved
                            ▲                              │
                            └── save_shotlist / revise_shot（结构字段）──┘
                                 # 只改 promptOverride / camera.note 不回退

Take 创建前置条件：  shotlistApproval == approved  且  Script.approval == approved
                    否则 generate_take / POST /takes 返回 409 { reason: "shotlist_not_approved" }
Export 前置条件：    每个 timeline clip 都指向 status=completed 的 take
```

- `approve_*` 只能由网页上的登录用户触发，MCP 不暴露这两个工具。agent 的工作是把草案做好，
  然后告诉用户"去分镜表页面确认"。
- hero frame 选择和 take 选择不设审批门，因为它们本身就是用户在网页上的点击动作。
- 单镜头的 `promptOverride` 调整不回退审批，否则微调一句 prompt 都要重新审一遍分镜表。

### 3.3 存储选择

- **Postgres**（Neon，经 Cloudflare Hyperdrive 连接；或改用 D1）：以上全部实体。现有的
  IndexedDB 历史只保留为"个人画廊"的兼容路径，项目数据不进浏览器。
- **Cloudflare R2**（唯一的文件存储，替代 Vercel Blob）：上传素材、角色图、hero frame、
  每个 take 的视频、末帧、缩略帧、成片全部在这里。RunPod worker 用 S3 SDK 直传 R2，
  Studio 只拿 URL。原因：Workers 没有磁盘；RunPod 的结果只保留 30 分钟；R2 没有出口流量费。
  布局与成本见 §4.8。
- 任务队列：Postgres 表 + Cloudflare Cron Triggers（每分钟）或 Durable Object alarm 驱动；
  主路径仍是 RunPod webhook，队列只做兜底和并发控制。

---

## 4. 系统组件

### 4.1 Web Studio（扩展现有 Next.js 应用）

页面结构对齐 Cinema Studio：

- `/projects` 项目列表
- `/p/[id]/look` 项目级 Look 面板（表单，即 `LookSettings`）
- `/p/[id]/elements` 元素库：角色（三视图 + 声音样本）、场景、道具；"生成设定图"按钮调图像模型
- `/p/[id]/script` 剧本（版本列表，只读展示 + 粘贴导入）
- `/p/[id]/board` **分镜表**：按场景分组的镜头卡片，每卡显示 hero frame、时长、模式、状态、最新 take；
  卡片内是镜头编辑器（beats / camera / dialogue / sound / refs）+ "编译 prompt"预览 + "生成 take"
- `/p/[id]/timeline` 时间线：拖排顺序、选 take、转场、混音、导出
- 现有的单发 composer 保留为 `/playground`，继续用现有 catalog

**前端与聊天客户端的分工。** 前端不能省：挑 hero frame、确认角色图、并排比较 take、
剪时间线，这些必须看图看视频才能做决定，聊天窗口做不了。Supercomputer 也没有取代
Cinema Studio 的界面，只是把每一步派发到对应工作区。

| 在聊天客户端里做（Grok / Claude 经 MCP） | 在 Web 前端里做 |
|---|---|
| 从一句话需求写剧本 | 看分镜表、改单个镜头字段 |
| 拆镜头、写 beats / camera / dialogue | 选 hero frame、确认角色图 |
| 决定每个镜头的模式 | 对比 take、打分、选定 |
| 触发生成、读缩略帧做初审 | 时间线、导出 |
| 回答预算、进度类问题 | Look 表单、RunPod / R2 配置页、测试连接 |

两边操作同一份数据库。最小可用版本只需要**分镜表**（含镜头编辑、hero frame 选择、take 对比）
和**时间线**两个页面；项目创建、Look、元素库第一版可以只经 MCP 工具操作，页面只读。

### 4.2 Prompt Compiler（确定性，无 LLM）

输入 `Shot + Project.look + Elements`，输出 H3 prompt 文本和请求体。这是"导演"中
**不需要智能的那一半**：把结构化字段按 §2.2 的格式拼成文本，保证每次生成都带上项目 Look、
参考角色声明和约束块，避免 agent 每次都要重写这些。

**模板按模式分化。** 四种模式给模型的信息不同，prompt 的重点也必须不同，用一套模板会把
已经由图片承载的信息重复写进文字里，反而干扰模型：

| 模式 | worker 工作流 | prompt 里写什么 | prompt 里**不**写什么 |
|---|---|---|---|
| `text` | T2VA | 完整：Look、场景外观、人物外观、时间线、镜头、对白、声音、约束 | 无 |
| `keyframe` | I2VA / FL2VA | **动作与变化**：从首帧出发发生了什么、镜头怎么动、对白、声音；末帧存在时写"结束于末帧所示状态" | 不重述首帧里已有的人物长相、服装、场景布置、光线 |
| `reference` | R2VA | **参考角色声明** + 完整场景时间线、镜头、对白、声音；人物外观只写"与 Image N 一致" | 不逐项描述参考图里已有的外观 |
| `edit` | R2VA + 源视频 | 源视频角色声明 + **只写改动**（换什么、加什么、去什么、保留什么）| 不重述源视频里不变的内容 |

通用骨架（各模式按上表裁剪）：

```
REFERENCES
Image 1: {character.name} — lead character identity (front view). Keep face, hair, wardrobe exactly.
Image 2: {character.name} — side view, same person.
Image 3: {location.name} — the setting. Keep layout and light direction.
Audio 1: {character.name}'s voice — use this timbre for all of {character.name}'s lines.

LOOK
{look.genre}. {look.palette}. Shot on {look.camera}, {look.lens}. {look.lighting}.

SHOT INTENT
{shot.intent}

TIMELINE ({shot.durationS}s)
0–{b1.to}s: {b1.action}
{b1.to}–{b2.to}s: {b2.action}
...

CAMERA
{camera.speed} {camera.move}, {camera.amplitude} amplitude, {camera.note}.
(若 move = static: "The camera holds a static, locked-off shot for the entire duration.")

DIALOGUE
{speaker.name} ({line.language}, {line.delivery}): "{line.text}"

SOUND
SFX: {sound.sfx.join("; ")}
Ambience: {sound.ambience}
Music: {sound.music}

CONSTRAINTS
{look.negative.join(". ")}. No extra dialogue. No subtitles.
```

请求体映射（新增 `src/generation/backends/runpod.ts`，目标是 worker 的输入 schema）：

| Shot.mode | worker 工作流 | 媒体 |
|---|---|---|
| `text` | `T2VA` | 无；可开 `enhance` |
| `keyframe` | `I2VA`（只有首帧）或 `FL2VA`（首帧 + 末帧） | `images[0]` = heroFrame 或上一镜头末帧；`images[1]` = 末帧 |
| `reference` | `R2VA` / `Singularity R2VA` | 最多 3 张参考图 + 1 段参考视频（**上限待验证**） |

worker 输入示例（字段名以社区 worker 为准，fork 后固定成我们自己的 schema）：

```json
{
  "input": {
    "workflow": "FL2VA",
    "prompt": "<Compiler 输出>",
    "seconds": 8,
    "video_size": "1344x768",
    "images": ["https://.../hero.png", "https://.../end.png"],
    "enhance": false,
    "upscale": false,
    "rife": false,
    "steps": 8,
    "seed": 1234,
    "output": { "bucket": "studio-takes", "key": "p1/s3/take2.mp4" },
    "studio_take_id": "take_…"
  },
  "webhook": "https://<studio>/api/runpod/hook?sig=…",
  "executionTimeout": 900000
}
```

`edit` 模式的 worker 输入在 R2VA 基础上加 `video: "<源视频 R2 URL>"`，prompt 只含
REFERENCES（"Video 1 = 源视频，保留其构图、运动和时长"）、EDIT（改动清单）、SOUND（如需改）、CONSTRAINTS。

Compiler 做的校验：beats 时长之和 = durationS（5–15）；参考数不超过 worker 上限；
keyframe / reference / edit 互斥；prompt 长度 ≤7000；`continuous` 镜头必须有上一镜头的末帧；
`edit` 必须有 `sourceTakeId`；`seed` 固定记录，便于重跑对比。

**P0 prompt 评测方案**（"完美"不是写出来的，是测出来的）：

1. **固定测试集**：10 个镜头，覆盖 4 种模式、有无对白、静态与运动镜头、单 cut 与多 cut、中英文各半。
2. **每条规则做 A/B**：方括号镜头指令 vs 纯自然语言；有无 "holds a static shot"；对白有无说话人前缀；
   声音分块 vs 混写；REFERENCES 角色声明有无；中文 vs 英文 prompt；keyframe 模式写不写首帧外观。
   每组固定 seed，各出 2 个 take。
3. **盲评**：网页上提供"评测模式"，随机顺序展示两个 take，评审只看镜头意图打 1–5 分（对象一致性、
   动作完成度、镜头运动正确性、音频匹配度四项）。评分落库。
4. **输出**：每条规则的胜率表；胜率 < 60% 的规则从 Compiler 模板里删掉或改成可选。
5. **结果固化**：写回 `agent/director.md` 和 Compiler 模板，并记录测试日期和 worker 版本，
   worker 或权重升级后重跑一遍。

这套流程也是 §2.2 里所有"社区共识"在自托管 H3-Base 上的验证手段。

### 4.3 Orchestrator（服务端任务编排）

把现有浏览器侧的 `poll.ts` 逻辑搬到服务端，并抽象出后端接口：

```ts
interface GenerationBackend {
  submit(job: CompiledJob): Promise<{ requestId: string }>;
  status(requestId: string): Promise<BackendStatus>;   // queued | running | completed(url) | failed(reason) | canceled | timeout
  cancel(requestId: string): Promise<void>;
}
// 实现：RunPodBackend（视频，H3）、HiggsfieldBackend（图像，现有 platform.ts 包一层）
```

```
Take 创建 ──► 队列(Postgres) ──► 预算检查 ──► backend.submit ──► requestId
                                                                 │
          ┌──────────────────────────────────────────────────────┘
          ▼
   主路径：RunPod webhook → /api/runpod/hook（验签）→ 标记 completed/failed
   兜底：  worker 每 15 s 对 running 的 take 调 backend.status（webhook 丢了也能收口）
          │
          ├─ completed: 校验 S3 对象存在 → 抽末帧 → 记账（GPU 秒 × 单价）
          ├─ failed / canceled: 记录 worker 返回的错误
          └─ timeout（executionTimeout 触发）: 标记，允许 /retry
```

- **幂等**：Take 以 `(shotId, n)` 唯一；`studio_take_id` 随 input 下发，webhook 回来按它对账；
  提交阶段网络错误**不重发 `/run`**，先查队列里有没有同 take 的 job id。
- **并发**：项目级并发上限默认 1–2。RunPod 侧 max workers = 1 时，多余的 job 在 RunPod 队列里排队，
  Studio 侧的并发上限主要用来控制预算，不是吞吐。
- **末帧抽取**：completed 后 ffmpeg 抽最后一帧存为 Asset，供下一个 `continuous` 镜头作首帧。
- **预算**：`Project.budget.capUsd`，超限拒绝入队；每个 take 记录 `executionTime` × 单价。
  RunPod 的状态响应带 `executionTime`（毫秒），这是精确记账的依据。
- **冷启动感知**：webhook 迟迟不来且 status 一直 `IN_QUEUE` 时，UI 显示"GPU 正在启动"而不是"生成中"。

### 4.4 Assembler

**运行位置**：RunPod **CPU serverless** endpoint（和 H3 worker 同一套 `/run` + webhook 调用方式，
不引入第三家云）。镜像只含 ffmpeg 和一个 Python handler。Cloudflare Containers 作为备选。

**契约**（Studio → Assembler，经 RunPod `/run`）：

```json
{
  "input": {
    "export_job_id": "exp_…",
    "preset": "master-768p",                     // master-768p | master-upscaled | social-9x16 | preview-480p
    "clips": [
      { "url": "https://r2/.../take1.mp4", "in_s": 0, "out_s": 8.0, "transition_in": "cut" },
      { "url": "https://r2/.../take7.mp4", "in_s": 0.5, "out_s": 6.0, "transition_in": "dissolve", "transition_s": 0.4 }
    ],
    "audio": {
      "keep_clip_audio": true,
      "music_url": "https://r2/.../music.mp3",   // 可选
      "mix_db": { "dialogue": 0, "sfx": -3, "music": -12 },
      "music_duck_under_dialogue": true
    },
    "subtitles": { "srt": "1\n00:00:00,000 --> …", "burn_in": false },
    "output": { "bucket": "studio", "key": "projects/p1/exports/exp_….mp4" }
  },
  "webhook": "https://<studio>/api/assembler/hook?sig=…",
  "executionTimeout": 1800000
}
```

**返回**（经 webhook）：`{ export_job_id, status, url, srt_url?, duration_s, size_bytes, error? }`。

**内部步骤**：拉取 clips → 统一到预设分辨率与 24 fps → 按 in/out 裁剪 → 转场（cut 直接 concat，
dissolve 用 xfade）→ 音轨：各 clip 自带音轨拼接，叠加配乐并在对白段自动压低 → 字幕生成或烧录 →
上传 R2 → webhook。`master-upscaled` 预设在 concat 前先调用 H3 worker 的上采样 + RIFE 工作流，
耗时和质量在 P0 实测后决定是否保留。

**不做的事**：不做智能剪辑、不做调色，这些由 Look 在生成阶段控制。

### 4.5 MCP Server（agent 的接口）

见 §6。

### 4.6 RunPod 推理服务（H3 的部署）

**两种部署形态，建议从 A 起步：**

| | A. Serverless endpoint（ComfyUI worker） | B. 专用 Pod（vLLM-Omni / SGLang 多卡） |
|---|---|---|
| 适合 | 每天 GPU 忙碌 < 6–8 小时、单人或小团队、间歇出片 | 每天持续出片、需要最低延迟和官方数值基线 |
| 权重 | Comfy-Org 裁剪 + INT8 / NVFP4 | 官方 BF16 检查点（约 134 GiB） |
| 硬件 | 1 × 96 GB Blackwell（RTX PRO 6000 一类），网络卷 ≥160 GB | 4 × H100 / H200 或 8 × B200 |
| 速度 | 8 步 turbo，单卡时长待实测 | 4×H100 约 13 s 出 5 s 片段 |
| 质量 | 量化 + 裁剪，略低于托管 | 接近托管版 768p 基线 |
| 成本 | 按秒计费 + 冷启动损耗 | 按小时，空闲也计费 |
| 运维 | RunPod Hub 一键部署，一个 warm worker | 自己维护容器、模型加载、健康检查 |

**方案 A 的具体做法：**

1. **fork 社区 worker**（`venkteshmaram/runpod-minimax-h3` 或同类），锁定版本，
   把输入 schema 固定成 §4.2 的样子，加三件事：
   - 产物上传到 R2，返回 `{ url, last_frame_url, thumb_urls[4], execution_ms, seed }`；
   - **末帧和 4 张缩略帧由 worker 抽取并一并上传**（定稿：不交给 Assembler，Studio 不下载视频）；
   - `studio_take_id` 原样回传。
2. **网络卷**：创建 ≥160 GB 卷，首次启动让 worker 自动下载约 100 GB 权重到 `/runpod-volume`，
   之后关掉自动填充（`VOLUME_AUTOPOPULATE=false`）防止意外重下。
3. **endpoint 配置**：GPU 池选 96 GB 级；`max workers = 1`；出片高峰期把 `active workers`
   设为 1 消灭冷启动，闲时设 0；开 FlashBoot；`executionTimeout` 默认 900 s；
   `ttl` 默认 2 h（覆盖排队 + 执行）。
4. **地域**：endpoint 的数据中心必须选在许可证允许的地域（见 §2.3、§10），这是部署者的责任，
   Studio 在配置页里显式提示。
5. **健康检查**：worker 支持 `{"action":"health"}`，Studio 的配置页提供"测试连接"按钮，
   并在每天第一次生成前预热（发一个 2 秒的 T2VA 小任务）。

**环境变量**（新增到 `.env.example`）：

```
RUNPOD_API_KEY=
RUNPOD_ENDPOINT_ID=
RUNPOD_WEBHOOK_SECRET=        # 签 webhook URL 的 HMAC 密钥
R2_ACCOUNT_ID=
R2_BUCKET=                    # 单桶，按前缀分项目
R2_ACCESS_KEY_ID=             # 给 RunPod worker 的 S3 凭证（只授予该桶的写权限）
R2_SECRET_ACCESS_KEY=
R2_PUBLIC_BASE_URL=           # 桶绑定的自定义域名
```

**成本模型**（P0 实测后填数）：

```
单个 take 成本 ≈ (冷启动秒数 / 该 worker 生命周期内的 take 数 + 生成秒数) × GPU 单价/秒
```

示例：若 96 GB 卡 Flex 价约 $X/h，8 步 turbo 出一个 10 s 片段耗时 T 秒，
则热 worker 下一个 take ≈ X/3600 × T 美元。一个 30 镜头、每镜头 2 个 take 的项目 = 60 × 该值。
与托管版（$0.065–0.13/s × 10 s = $0.65–1.3/take）对比，自托管的盈亏平衡取决于 T 和冷启动摊销，
**在没有实测 T 之前不要下结论**。

---

### 4.7 部署：Cloudflare Workers

**解决了什么。** 绑定自定义域名后自动 HTTPS，MCP 端点和 RunPod webhook 都有了公网地址，
不需要隧道。R2 与 Workers 同账号，零出口流量费。

**没有自动解决什么：OAuth。** Claude / Grok 的自定义连接器要求 MCP 服务器自己充当
OAuth 2.1 授权服务器（元数据端点、动态客户端注册、授权码 + PKCE、签发 token）。
用 Cloudflare 官方的 `workers-oauth-provider` 库和"远程 MCP 服务器"模板实现，
登录方式接 GitHub 或 Google，单用户场景配置量很小。Claude 也接受无鉴权的 MCP 服务器，
但那等于把 GPU 账单暴露给拿到 URL 的任何人，**不采用**。

**Next.js 在 Workers 上的限制与对策：**

| 限制 | 对策 |
|---|---|
| 必须经 OpenNext 适配器；Pages 对 Next 的支持已让位于 Workers | 用 `@opennextjs/cloudflare` 构建，CI 里跑一次 `preview` 验证 server actions 可用 |
| 没有原生二进制，ffmpeg 不能跑 | Assembler 和末帧 / 缩略帧抽取放到 **RunPod CPU serverless worker**（和 H3 worker 同一套调用方式），或 Cloudflare Containers |
| 没有常驻进程，不能起 15 s 轮询循环 | **Cron Triggers**（每分钟）扫 running 的 take 调 `/status`；需要更细粒度时用 Durable Object alarm |
| 请求有 CPU 时间上限 | 所有重活都是"发请求 + 等 webhook"，Worker 本身只做调度 |
| 数据库连接 | Neon Postgres 经 **Hyperdrive**（连接池 + 就近缓存），或直接用 D1 |

**服务器部署相对本地必须补的加固**（本地可以偷懒、公网不能）：

1. **网页登录（定稿：Cloudflare Access）。** 整个 Studio 域名套 Cloudflare Access，登录方式用
   GitHub 或 Google 的 one-time PIN，允许名单只放你自己的邮箱。应用侧只读 `Cf-Access-Jwt-Assertion`
   头并校验签名，不自己存密码。例外路径：`/mcp`、`/.well-known/*`（走 MCP 的 OAuth）、
   `/api/runpod/hook`、`/api/assembler/hook`（走 HMAC 签名）要在 Access 里设 bypass。
   现有 `/api/blob` 公开上传路由删除。
2. **凭证只在服务端。** 现有仓库把 Higgsfield key 存用户 cookie，单人自用的服务器直接放 Workers secrets；RunPod key 和 R2 key 绝不进浏览器。
3. **预算与限流从"建议"变"必须"。** 项目预算上限、每小时生成次数上限、花钱工具二次确认。
4. **上传改为预签名直传 R2。** 浏览器拿短期签名 URL 直接传桶，Worker 不中转文件。
5. **备份与审计。** Neon 定期备份；每个 take 的请求体、RunPod job id、`executionTime` 落库。

流程顺序、角色分工、数据模型与本地部署完全一致。

### 4.8 R2 存储布局、容量与成本

**布局**（单桶，按前缀分项目，便于生命周期规则和整项目删除）：

```
r2://studio/
  uploads/{deviceOrUser}/{assetId}.{ext}          浏览器预签名直传
  projects/{projectId}/
    elements/{elementId}/{assetId}.png             角色 / 场景 / 道具参考图（Higgsfield 产物回拉）
    shots/{shotId}/
      hero/{assetId}.png                           hero frame 候选（只保留被选中的）
      takes/{takeId}.mp4                           RunPod worker 直传
      takes/{takeId}.last.png                      末帧（供下一镜头首帧）
      takes/{takeId}.thumbs/{n}.jpg                缩略帧（供 agent 审核）
    exports/{jobId}.{preset}.mp4                   成片
```

**数据流**：RunPod 算 → R2 存 → Postgres 记账 → Workers 只做调度和展示，不碰文件内容。
Higgsfield 图像模型的产物由 Worker 拿到 CDN URL 后立即回拉写入 R2，因为平台 URL 会过期。

**容量**：R2 桶没有容量上限，单对象最大 5 TB，不存在"空间够不够"的问题。

**价格**（2026 年第三方整理，下单前核对官方页）：

| 项目 | 标准存储 | 免费额度 / 月 |
|---|---|---|
| 存储 | $0.015 / GB·月 | 10 GB |
| Class A 写操作（PUT / COPY / LIST） | $4.50 / 百万次 | 100 万次 |
| Class B 读操作（GET / HEAD） | $0.36 / 百万次 | 1000 万次 |
| 出口流量 | 免费，无上限 | |
| Infrequent Access 档 | $0.01 / GB·月 + $0.01 / GB 读取，30 天最短存储期 | 无 |

**用量估算**：一个 30 镜头、每镜头 2 take 的项目，768p 视频每个 10–30 MB：

| 内容 | 估算 |
|---|---|
| 60 个 take | 约 1.2 GB |
| 角色图、hero frame、缩略帧 | 约 0.2 GB |
| 成片与上采样版本 | 约 0.3 GB |
| **合计** | **约 2 GB / 项目** |

| 累计项目 | 存储 | 月费 |
|---|---|---|
| 5 | 10 GB | $0（免费额度内） |
| 10 | 20 GB | 约 $0.15 |
| 50 | 100 GB | 约 $1.35 |
| 100 | 200 GB | 约 $2.85 |

操作次数每项目几千次，在免费额度内。**存储费用不到 GPU 费用的 1%**，不值得为它优化。

**策略**：

- 生命周期规则先不做，存一年也只是几美元；留在 TODO。
- 完成超过 90 天的项目可按前缀自动转 Infrequent Access；频繁回看的项目不转，因为有读取费。
- 读取方式：第一版用桶绑定域名公开读 + 不可猜的随机路径；在意链接外泄再改为 Worker 签发短期 URL。
- 建桶时指定地域提示：成片的存放与展示地域也在 MiniMax 许可证措辞范围内（§2.3）。

## 5. 核心工作流

### 5.1 从需求到分镜表（Writer + Director，在用户的聊天客户端里完成）

```
用户在 Grok/Claude 里：  "给我做一支 60 秒的霓虹雨夜追逐短片，主角是……"
   │
   ├─ agent 调 create_project(name, look 草案)
   ├─ agent 写剧本 → 调 save_script(projectId, text)
   ├─ agent 调 list_elements → 发现没有角色 → 调 create_element(kind=character, description)
   ├─ agent 拆镜头 → 调 save_shotlist(projectId, shots[])   ← 严格 JSON schema
   └─ 用户在 Web Studio 的 /script 点 approve，再到 /board 看分镜表并点 approve
      （检查点 1 和 2，见 §3.2；未 approve 之前 generate_take 一律 409）
```

### 5.2 元素与 Hero Frame（Asset / Continuity 阶段）

```
对每个角色：generate_character_sheet(elementId)
   → 用图像模型（Soul 2 / Flux 2 等）生成正 / 侧 / 背三视图，用户挑选确认 → Element.refs
对每个场景 / 道具：generate_element_ref(elementId)
对每个镜头：generate_hero_frames(shotId, n=4)
   → 图像模型按 Look + 镜头描述出 4 张静帧 → 用户选 1 张 "Use as ref" → Shot.heroFrame
   （人工检查点 2：这一步最便宜，改一张图比重跑一个视频便宜 20 倍）
```

### 5.3 镜头生成（Video maker 阶段）

三种模式的选择规则（Director 决定，用户可改）：

| 情况 | 模式 | 理由 |
|---|---|---|
| 有 hero frame，且需要和上一镜头连续 | `keyframe`，首帧 = 上一镜头末帧或 hero frame，末帧 = 本镜头 hero frame（可选） | 连续性最好 |
| 角色 / 产品必须高度一致 | `reference`，角色主参考图 + 场景图 + hero frame（自托管约 3 图上限，**待验证**） | 身份锁定 |
| 镜头内有对白、要音色稳定 | 任一模式 + 对白文本里固定该角色的"声线描述"；自托管是否支持参考音频未确认 | 开源包没有 Context-IR / 参考音频保证 |
| 空镜、氛围镜头 | `text` | 最便宜 |
| 已有一个基本满意的 take，只想换道具 / 改表情 / 去掉穿帮 | `edit`，源视频 = 该 take，只写改动 | 比重跑便宜且保住已满意的部分（自托管编辑质量**待验证**） |

**一次生成内多镜头**（对应 Cinema Studio 的 multi-shot）：当一个 Shot 的 beats 带
`cut: true` 标记时，Compiler 在时间线里写成 "hard cut at 6s to …"。建议每段 ≤3 个 cut，
超过就拆成多个 Shot，由 Assembler 拼。

**多 take**：同一镜头可连续出 1–4 个 take（对应现有 batch 逻辑），用户在卡片里横向对比选一个。

### 5.4 审核回路（Reviewer）

- 人工：卡片上 1–5 星 + 备注。
- agent：MCP 提供 `get_take(takeId)` 返回视频 URL 和缩略帧序列（服务端抽 4 帧），
  Grok / Claude 看图对照 `Shot.intent / beats` 打分，不合格就调 `revise_shot` 改 prompt 后 `generate_take` 重跑。
  超过 3 次不合格自动停，等人。

### 5.5 组装与导出

Timeline 页面选 take、排序、转场、配乐 → `export(preset)` → Assembler worker（§4.4）→ 成片存 R2 → 下载。
导出前置条件：每个 clip 指向 completed 的 take。

---

## 6. Agent 层：订阅版 Grok / Claude 如何扮演 Mr. Higgs / Supercomputer

### 6.1 为什么是 MCP

两家的订阅产品都支持**远程 MCP 自定义连接器**：

- Grok：grok.com → Connectors → New Connector → Custom，填公网 HTTPS 地址，仅支持远程服务器，付费计划可用（第三方资料，**待官方确认**）。
- Claude：Claude Desktop / Web 的自定义连接器，远程 MCP + OAuth 2.1；Claude Code 也能直接挂 MCP。

因此 Studio 暴露一个 `https://<studio>/mcp` 端点，用户在两边各连一次。
不需要任何 LLM API key；推理成本全部落在用户已有的订阅里。
OAuth 由 Cloudflare 的 `workers-oauth-provider` 提供（§4.7）。

### 6.2 工具清单（MCP tools）

| 工具 | 输入 | 作用 |
|---|---|---|
| `list_projects` / `create_project` | name, look? | 项目 |
| `get_project` | projectId | 返回 look、元素、场景、镜头摘要（agent 的工作记忆） |
| `update_look` | projectId, LookSettings 部分字段 | 项目级风格 |
| `save_script` | projectId, text | 新版本 |
| `list_elements` / `create_element` / `update_element` | kind, name, description | 元素 |
| `generate_character_sheet` / `generate_element_ref` | elementId | 调图像模型，返回候选图 URL |
| `select_element_refs` | elementId, assetIds | 用户 / agent 选定 |
| `save_shotlist` | projectId, shots[]（严格 schema） | 覆盖或合并分镜表 |
| `revise_shot` | shotId, patch | 改 beats / camera / dialogue / sound / mode |
| `compile_prompt` | shotId | 返回 Compiler 结果（agent 可检查） |
| `generate_hero_frames` | shotId, n | 图像模型出静帧 |
| `select_hero_frame` | shotId, assetId | |
| `generate_take` | shotId, n? | 入队，返回 takeId 和预估费用 |
| `get_take` | takeId | 状态、URL、缩略帧（供审核） |
| `select_take` | shotId, takeId | |
| `get_budget` | projectId | 已花 / 上限 |
| `export` | projectId, preset | 触发组装 |
| `get_director_guide` | 无 | 返回 `agent/director.md` 全文；Skill 要求开始项目时先调一次 |
| `cancel_take` / `retry_take` | takeId | 转调 RunPod |
| `review_take` | takeId, score, notes | agent 审核结果落库，`by = "agent"` |
| `auto_timeline` / `save_timeline` | projectId, TimelineInput | 时间线 |
| `import_element` | projectId, elementId | 从全局库复制 |

**不暴露给 agent 的操作**：`approve_script`、`approve_shotlist`、删除类、上传预签名、评测投票。
这些只能在网页上由登录用户完成（§3.2、§7.1）。

**边界**：任何花钱的工具（`generate_*`、`export`）在 MCP 层返回"预估费用 + 需要确认"，
由用户在聊天里确认后 agent 再调一次带 `confirm: true`。防止 agent 一轮对话烧掉预算。

### 6.3 Director Skill（给 agent 的系统指令）

放在仓库 `agent/director.md`，用户复制到 Claude 的 Project instructions / Grok 的
自定义指令里。内容：

1. 角色定义：你是 Mr. Higgs，分三步工作：剧本 → 元素 → 分镜表；每步结束等用户确认。
2. H3 的 prompt 规则（§2.2 全文）。
3. `save_shotlist` 的 JSON schema 和一个完整示例。
4. 决策规则：镜头模式选择表（§5.3）、每镜头 ≤15 s、≤3 个 cut、一个主运动、对白写原文、
   `continuous` 必须接末帧、音频参考必须配图。
5. 预算规则：先 previz（8 步 turbo，每镜头 1 take），用户满意后再加步数或开上采样出成片。
6. 后端事实：自托管 H3-Base 只有 768p、参考上限约 3 图 + 1 视频、没有 Context-IR，
   所以 prompt 必须自带完整结构，不能指望模型侧增强。

Grok 和 Claude 用**同一份** Skill 和同一套工具，差别只在客户端。

**H3 prompt 格式如何投递给 agent。** MCP 有 tools / resources / prompts 三种原语，但
客户端支持参差不齐：Claude Desktop 能读 resources，claude.ai 和 Grok 的连接器基本只用
tools，且模型是否主动读 resource 不可控。所以采用三层叠加、一个来源：

1. **结构化 schema 做硬约束。** `save_shotlist` / `revise_shot` 的输入是 beats、camera、
   dialogue、sound 等字段，不是自由文本 prompt；每个字段的 description 写明规则（例如 camera：
   "自然语言、一个主运动、要锁定画面必须写 static"）。校验失败直接拒绝并返回原因。
   Compiler 负责拼成 H3 格式，agent 不需要记住 H3 的 prompt 语法。
2. **`get_director_guide` 工具返回指南全文。** tools 所有客户端都支持。
3. **同一份文件也挂为 MCP resource，并供用户贴进自定义指令。**

仓库只维护 `agent/director.md` 一个文件，三个出口都从它生成。指南本身要短，
每次调用都占上下文；细节规则放进 schema description，指南只讲流程和判断标准。
"skills" 是 Claude 侧的概念，MCP 服务器无法给 Grok 注入 skill，因此以 tools 为主对两家一致。

### 6.4 兜底：Prompt Pack（无连接器时）

Web Studio 的每个阶段提供"复制给 AI"按钮，生成一段自包含的 prompt
（含 Look、元素、当前分镜、schema），用户粘贴到任一聊天里，把返回的 JSON 粘回
"导入"框；服务端用同一套 schema 校验。连接器挂了或换客户端时依然能跑。

### 6.5 明确不做的事

- 不做浏览器自动化操控 grok.com / claude.ai（违反服务条款，且极不稳定）。
- 服务端不内置任何 LLM 调用；将来若改用 API，只需在 Orchestrator 里加一个
  "自动 Director" worker 调同一套 MCP 工具，其他不变。

---

## 7. API 设计（REST，供 Web UI 和 MCP 共用）

### 7.1 鉴权矩阵

| 调用方 | 凭证 | 覆盖路径 |
|---|---|---|
| 网页（浏览器） | Cloudflare Access JWT（`Cf-Access-Jwt-Assertion`） | `/`、`/p/*`、`/api/*`（下表所有端点） |
| agent（Grok / Claude） | MCP OAuth bearer token（`workers-oauth-provider` 签发） | `/mcp` 内部转调下表端点，权限列标 `A` 的才可用 |
| RunPod H3 worker / Assembler | URL 上的 HMAC 签名 + 时间戳 | `/api/runpod/hook`、`/api/assembler/hook` |
| 浏览器直传 R2 | 预签名 URL（15 分钟） | R2，不经 Studio |

权限列：`W` = 仅网页，`A` = 网页和 agent 都可，`$` = 花钱、agent 调用需 `confirm: true`。

### 7.2 端点清单

```
# 项目
GET    /api/projects                               A   列表
POST   /api/projects                               A   { name, look? }
GET    /api/projects/:id                           A   聚合视图：look、budget、approval、elements、scenes、shots 摘要
PATCH  /api/projects/:id                           A   { name?, budget.capUsd? }
DELETE /api/projects/:id                           W   连同 R2 前缀一起删（二次确认）
PATCH  /api/projects/:id/look                      A   LookSettings 部分字段
GET    /api/projects/:id/budget                    A   { capUsd, spentUsd, estimatePerTakeUsd }

# 剧本
GET    /api/projects/:id/scripts                   A   版本列表
POST   /api/projects/:id/scripts                   A   { text } → 新版本，approval=draft
GET    /api/scripts/:id                            A
POST   /api/scripts/:id/approve                    W   检查点 1

# 元素
GET    /api/projects/:id/elements                  A   含 ?includeLibrary=1 时附带全局库
POST   /api/projects/:id/elements                  A   { kind, name, description }
PATCH  /api/elements/:id                           A
DELETE /api/elements/:id                           W
POST   /api/elements/:id/generate-refs             A$  { n } → jobId；图像模型出候选图
POST   /api/elements/:id/refs                      A   { assetIds[] } 选定参考图（替换整组）
POST   /api/elements/:id/promote                   W   复制到全局库（projectId=null）
POST   /api/projects/:id/elements/import           A   { elementId } 从全局库复制进项目

# 分镜表与镜头
GET    /api/projects/:id/shotlist                  A   scenes + shots 全量
PUT    /api/projects/:id/shotlist                  A   整表覆盖（schema 校验）；approval 回到 draft
POST   /api/projects/:id/shotlist/approve          W   检查点 2
POST   /api/projects/:id/scenes                    A
PATCH  /api/scenes/:id                             A
DELETE /api/scenes/:id                             W
POST   /api/scenes/:id/shots                       A
PATCH  /api/shots/:id                              A   结构字段回退审批；promptOverride / camera.note 不回退
DELETE /api/shots/:id                              W
POST   /api/shots/reorder                          A   { sceneId, shotIds[] }
GET    /api/shots/:id/compile                      A   Compiler 预览：{ workflow, prompt, input, warnings[] }
POST   /api/shots/:id/hero-frames                  A$  { n } → jobId
POST   /api/shots/:id/hero-frame                   A   { assetId } 选定
POST   /api/shots/:id/end-frame                    A   { assetId } 选定（可选）

# take
POST   /api/shots/:id/takes                        A$  { n?, steps?, seed? } → { takeIds[], estimateUsd }；未审批 409
GET    /api/shots/:id/takes                        A
GET    /api/takes/:id                              A   状态、url、lastFrameUrl、thumbUrls、executionMs、costUsd、review
POST   /api/takes/:id/cancel                       A   转调 RunPod /cancel
POST   /api/takes/:id/retry                        A$  转调 RunPod /retry（timeout / failed 时）
POST   /api/takes/:id/review                       A   { score, notes }；by 按调用方自动填
POST   /api/shots/:id/select-take                  A   { takeId }

# 素材上传
POST   /api/uploads/presign                        W   { filename, contentType, size } → { url, key, expiresAt }
POST   /api/uploads/commit                         W   { key, kind } → Asset（HEAD 校验对象存在）

# 时间线与导出
GET    /api/projects/:id/timeline                  A
PUT    /api/projects/:id/timeline                  A   { clips[], music?, mix }
POST   /api/projects/:id/timeline/auto             A   按分镜顺序用 selectedTake 生成初版
POST   /api/projects/:id/exports                   A$  { preset } → exportJobId；clip 未完成 409
GET    /api/projects/:id/exports                   A
GET    /api/exports/:id                            A   状态、url、srtUrl

# 任务与进度
GET    /api/jobs/:id                               A   通用任务（generate-refs / hero-frames）
GET    /api/projects/:id/events                    W   SSE：take / job / export 状态变更推送（定稿：SSE，不轮询）

# 评测模式（§4.2）
GET    /api/projects/:id/eval/pairs                W   随机配对的两个 take
POST   /api/eval/votes                             W   { takeA, takeB, winner, scores }

# 回调
POST   /api/runpod/hook                            HMAC  H3 worker 完成 / 失败
POST   /api/assembler/hook                         HMAC  Assembler 完成 / 失败

# MCP
POST   /mcp                                        OAuth Streamable HTTP
GET    /.well-known/oauth-authorization-server     公开
GET    /.well-known/oauth-protected-resource       公开
```

### 7.3 核心 schema（zod，REST 与 MCP 共用）

```ts
const LookSettings = z.object({
  genre: z.string().max(200), palette: z.string().max(200), camera: z.string().max(200),
  lens: z.string().max(200), lighting: z.string().max(200),
  aspectRatio: z.enum(["21:9","16:9","4:3","1:1","3:4","9:16"]),
  resolution: z.literal("768p"), upscale: z.boolean(),
  negative: z.array(z.string().max(80)).max(10),
});

const Beat = z.object({ from: z.number().min(0), to: z.number().max(15), action: z.string().min(5).max(400), cut: z.boolean().optional() });
const Line = z.object({ speaker: z.string(), text: z.string().min(1).max(300), language: z.string().max(10), delivery: z.string().max(80) });

const ShotInput = z.object({
  sceneId: z.string(), durationS: z.number().int().min(5).max(15),
  mode: z.enum(["text","keyframe","reference","edit"]),
  intent: z.string().min(5).max(300),
  beats: z.array(Beat).min(1).max(6),
  camera: z.object({
    move: z.enum(["static","push_in","pull_out","pan","tilt","truck","pedestal","arc","tracking","handheld","pov","roll","zoom"])
      .describe("自然语言镜头运动的枚举；一个镜头只有一个主运动；static 会被编译成 'holds a static, locked-off shot'"),
    amplitude: z.enum(["subtle","moderate","strong"]), speed: z.enum(["slow","medium","fast"]),
    note: z.string().max(200).optional(),
  }),
  dialogue: z.array(Line).max(8),
  sound: z.object({ sfx: z.array(z.string().max(80)).max(8), ambience: z.string().max(200), music: z.string().max(200) }),
  characters: z.array(z.string()).max(3), location: z.string().optional(), props: z.array(z.string()).max(3),
  linkToPrev: z.enum(["cut","continuous"]),
  sourceTakeId: z.string().optional(), editInstruction: z.string().max(600).optional(),
  promptOverride: z.string().max(7000).optional(),
}).superRefine((shot, ctx) => {
  const total = shot.beats.reduce((n, b) => n + (b.to - b.from), 0);
  if (Math.abs(total - shot.durationS) > 0.01) ctx.addIssue({ code: "custom", message: "beats 总时长必须等于 durationS" });
  if (shot.mode === "edit" && !shot.sourceTakeId) ctx.addIssue({ code: "custom", message: "edit 模式需要 sourceTakeId" });
  if (shot.beats.filter((b) => b.cut).length > 3) ctx.addIssue({ code: "custom", message: "一个镜头最多 3 个 cut，再多请拆镜头" });
});

const ShotlistInput = z.object({
  scenes: z.array(z.object({ slug: z.string(), summary: z.string(), location: z.string().optional(),
    shots: z.array(ShotInput).min(1) })).min(1),
});

const TakeRequest = z.object({ n: z.number().int().min(1).max(4).default(1), steps: z.number().int().min(4).max(30).optional(),
  seed: z.number().int().optional(), confirm: z.boolean().default(false) });

const ReviewInput = z.object({ score: z.number().int().min(1).max(5), notes: z.string().max(500) });

const TimelineInput = z.object({
  clips: z.array(z.object({ shotId: z.string(), takeId: z.string(), inS: z.number().min(0), outS: z.number().max(15),
    transition: z.enum(["cut","dissolve"]), transitionS: z.number().min(0.2).max(1).optional() })),
  music: z.string().optional(),
  mix: z.object({ dialogueDb: z.number(), sfxDb: z.number(), musicDb: z.number() }),
});
```

### 7.4 错误模型

所有非 2xx 返回 `{ error: { code, message, details? } }`。固定 code：

| code | HTTP | 含义 |
|---|---|---|
| `validation` | 400 | schema 校验失败，`details` 是 zod issues，原样回给 agent |
| `unauthorized` | 401 | 无凭证 |
| `forbidden` | 403 | 该端点不开放给 agent（权限列 `W`） |
| `not_found` | 404 | |
| `not_approved` | 409 | 检查点未通过，`details.checkpoint` 是 `script` 或 `shotlist` |
| `needs_confirm` | 409 | 花钱操作未带 `confirm: true`，`details.estimateUsd` 给出预估 |
| `budget_exceeded` | 409 | 项目预算不足 |
| `backend_error` | 502 | RunPod / Higgsfield 返回错误，`details` 含原始 body |

MCP 工具是上面端点的薄封装：工具名 = 端点动作，输入输出共用同一套 zod schema，
`validation` 和 `needs_confirm` 的 details 原样放进工具返回，让 agent 自己修正后重试。

---

## 8. 与现有仓库的映射

| 现有模块 | 处理 |
|---|---|
| `src/generation/catalog/` | 保留给图像模型。新增 `minimax-h3-runpod.ts` 条目：`backend: "runpod"`，`roles: { start:1, end:1, reference:3, video:1 }`，settings：`aspectRatio`（16:9 / 4:3 / auto）、`duration 5–15`、`steps`、`enhance`、`upscale`；`ModelEntry` 类型加可选 `backend` 字段 |
| `src/generation/to-platform.ts` | 保留给 Higgsfield 图像模型；`mapByPaths` 现有的"无媒体也发 image-to-video"问题顺手修掉 |
| `src/generation/backends/runpod.ts`（新增） | `RunPodBackend`：`/run`、`/status`、`/cancel`，webhook 验签，输入 schema 由 Compiler 产出 |
| `src/generation/platform.ts` | 包成 `HiggsfieldBackend`，只用于图像模型 |
| `src/generation/poll.ts` | 逻辑搬到服务端 worker；浏览器侧改为订阅 `/api/jobs/:id`（SSE 或轮询） |
| `src/generation/actions.ts` | `submitGeneration` 改为内部函数，由 Orchestrator 调用；Higgsfield key 仍可走 cookie，RunPod 凭证只在服务端环境变量 |
| `src/app/api/runpod/hook/route.ts`（新增） | 接 RunPod webhook，HMAC 验签，更新 Take |
| `workers/h3-runpod/`（新增） | fork 的 ComfyUI worker：Dockerfile、固定的工作流 JSON、S3 上传、末帧抽取 |
| `src/openhiggsfield/history.ts`、`idb.ts` | 仅保留给 `/playground` |
| `src/app/api/blob/route.ts` | **移除**，改为 `/api/uploads/presign` 签发 R2 预签名 URL，并要求登录 |
| `@vercel/blob` 依赖 | 移除；换 `@aws-sdk/client-s3` 或 Workers 的 R2 binding |
| 构建与部署 | 新增 `@opennextjs/cloudflare`、`wrangler.toml`（R2 binding、Hyperdrive、Cron Triggers、secrets） |
| 图像模型（Soul / Flux / Qwen 等） | 作为 hero frame 和角色设定图引擎直接复用 |
| 新增 | `src/studio/`（领域模型、Compiler、Orchestrator、检查点）、`src/app/mcp/`、`src/app/p/[id]/*`、`src/app/api/assembler/hook/route.ts`、`workers/assembler/`（RunPod CPU worker：Dockerfile + ffmpeg handler）、`agent/director.md` |

---

## 9. 实施路线

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 部署与实测（1–2 周） | 在 RunPod 部署社区 H3 worker（先不改代码）；用 `/playground` 加一个临时 RunPod 后端跑通 T2VA / I2VA / FL2VA / R2VA；实测每种模式 5 s / 10 s / 15 s 的生成时长、冷启动时长、单 take 成本、参考图上限、参考音频是否可用；确认 endpoint 地域与许可证 | §2.3 / §2.4 中"待验证"全部清零，拿到成本表 |
| P0.5 prompt 评测（与 P0 并行，1 周） | 按 §4.2 的评测方案跑 10 镜头测试集和 A/B，产出规则胜率表，固化到 Compiler 模板和 `agent/director.md` | 每条 prompt 规则都有实测依据 |
| P1 领域 + Compiler（1–2 周） | Postgres schema、检查点状态机、Shot 编辑器、四模式 Compiler、单镜头生成走服务端 Orchestrator、Cloudflare Access 接入 | 能手工建一个 5 镜头项目并逐个生成；未审批时生成被 409 拦下 |
| P2 Elements + Hero Frame（1 周） | 元素库、角色三视图生成、hero frame 四选一、keyframe / reference 两种模式 | 同一角色跨 5 个镜头脸不漂 |
| P3 MCP + Director Skill（1 周） | MCP 服务器 + OAuth、工具清单、Skill 文档、Prompt Pack 兜底 | Grok 和 Claude 各自从一句话需求跑到分镜表 |
| P4 Assembler（1 周） | RunPod CPU worker（§4.4 契约）、时间线页面与端点、导出预设、字幕、SSE 进度 | 导出一支 60 s 成片 |
| P5 审核回路 + 预算 | 缩略帧、agent 评分、重跑、预算上限 | 全流程无人值守跑完一个项目 |

---

## 10. 权衡与风险

| 决策 | 取舍 |
|---|---|
| RunPod 自托管而不是托管 H3 | 单价可能更低、不受平台限流、可改工作流（turbo LoRA、上采样、抽末帧）；代价是**只有 768p、参考上限小、没有 Context-IR、量化权重质量略低、要背许可证地域责任、冷启动和运维** |
| Serverless 起步而不是 Pod | 零闲置费用、Hub 一键部署；代价是冷启动损耗和 Flex 溢价，日出片量上去后要换 Pod |
| MCP 而不是 API | 零 LLM 费用、两家并列；代价是必须有公网 HTTPS + OAuth，且 agent 的行为取决于用户客户端版本 |
| 确定性 Compiler 而不是让 agent 直接写 prompt | 稳定、可审计、Look 永不遗漏；代价是表达力受 schema 限制，所以保留 `promptOverride` |
| 镜头 ≤15 s、靠末帧链接 | 符合 H3 限制；长镜头衔接处可能有跳变，需要 Assembler 加短 dissolve |
| Postgres + Cron 驱动的队列 | 简单；并发上百镜头时需要换 Queues / Durable Objects |
| 所有产物落 R2 | 几美元级的存储费；换来历史不丢、零出口流量费 |
| Cloudflare Workers 而不是 Vercel / VPS | 自动 HTTPS、R2 同账号、官方 OAuth 库；代价是没有 ffmpeg 和常驻进程，Assembler 和轮询要外置，Next 需经 OpenNext |

**最高优先级风险：许可证地域。** MiniMax Community License 把美国、欧盟、英国、韩国排除在
适用地域之外，且措辞覆盖模型和产物的使用、分发、展示。RunPod 的数据中心很多在美国和欧洲。
部署前必须：(1) 读许可证原文确认限制边界；(2) 选择允许地域的 RunPod 数据中心；
(3) 考虑成片的展示地域；(4) 必要时向 MiniMax 申请单独授权。这不是技术问题，是部署者的法律责任。

其他风险：

- **质量落差**：自托管是裁剪 + 量化的 H3-Base，768p，无 Context-IR；与托管版的差距要在 P0 用同一组 prompt 对比。
- **GPU 可得性**：96 GB 级 Blackwell 在 RunPod 上可能缺货；备选是 H100 80 GB + 更激进的 offload（更慢）或 2 卡方案。
- **冷启动**：100 GB 权重加载，首个 take 可能等几分钟；用 active worker 和预热缓解。
- **社区 worker 的维护**：它不是官方项目，fork 后要锁版本并自己维护。

待验证清单（实施 P0 时逐条确认）：

1. 自托管 R2VA 的参考上限（3 图 + 1 视频？）以及是否支持参考音频。
2. FL2VA 的末帧控制在量化权重上的效果。
3. 单卡 96 GB 下 5 / 10 / 15 s 片段的生成时长与冷启动时长。
4. RunPod 该 GPU 档位的 Flex 与 Active 单价，以及数据中心地域列表。
5. prompt 7000 字符上限在开源权重上是否同样适用。
6. Grok 自定义连接器对 OAuth 的具体要求（有用户报告 OAuth 流程启动失败）。
7. worker 内置上采样 / RIFE 的质量与耗时，决定成片是否值得开。
8. `edit` 模式（R2VA + 源视频）在自托管权重上的局部编辑质量。
9. Cloudflare Access 对 `/mcp` 和 webhook 路径 bypass 后，OAuth 与 HMAC 各自能否独立成立。

---

## 参考资料

MiniMax H3
- https://www.minimax.io/blog/minimax-h3
- https://huggingface.co/MiniMaxAI/MiniMax-H3
- https://platform.minimax.io/docs/api-reference/video-generation-v2-create
- https://platform.minimax.io/docs/api-reference/video-generation-v2-h3-context-ir
- https://open.higgsfield.ai/models/minimax/h3/image-to-video/api-reference
- https://docs.higgsfield.ai/docs/models/minimax-h3.md
- https://docs.higgsfield.ai/docs/models/minimax-h3/reference-to-video.md
- https://higgsfield.ai/blog/minimax-h3-higgsfield
- https://fal.ai/learn/devs/minimax-h3-prompting-guide
- https://fal.ai/models/minimax/h3/reference-to-video/api
- https://www.kapwing.com/resources/how-to-prompt-minimax-h3-hailuo-3-0-a-guide-for-ai-video-creators/
- https://www.krea.ai/blog/10-best-minimax-h3-prompts-for-ai-film-influencers-and-omni-reference-2026
- https://www.atlascloud.ai/blog/tips/minimax-h3-prompt-guide
- https://github.com/ecomimagelab/awesome-minimax-h3-prompts/blob/main/docs/FAL_PROMPTING_GUIDE.md
- https://docs.comfy.org/tutorials/partner-nodes/minimax/minimax-h3

MiniMax H3 自托管与许可证
- https://platform.minimax.io/docs/guides/local-deploy-h3
- https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/LICENSE
- https://huggingface.co/Comfy-Org/MiniMax-H3
- https://huggingface.co/MiniMaxAI/MiniMax-H3/discussions/36
- https://recipes.vllm.ai/MiniMaxAI/MiniMax-H3
- https://github.com/MiniMax-AI/awesome-minimax-h3-integration
- https://www.spheron.network/blog/deploy-minimax-h3-gpu-cloud/
- https://we0.ai/articles/why-minimax-h3-s-open-weight
- https://superpowerdaily.com/posts/minimax-h3-opens-its-video-weights-but-not-where-many-developers-work
- https://kingy.ai/news/minimax-h3-benchmarks-specs-hardware-review/

RunPod
- https://github.com/venkteshmaram/runpod-minimax-h3
- https://docs.runpod.io/serverless/endpoints/send-requests
- https://docs.runpod.io/serverless/references/operations
- https://docs.runpod.io/serverless
- https://github.com/huchukato/runpod-ltx-25
- https://www.runpod.io/articles/guides/comfyui-wan-2-2
- https://northflank.com/blog/runpod-gpu-pricing
- https://www.spheron.network/blog/runpod-h100-pricing-2026/

Cinema Studio
- https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-cinema-studio
- https://higgsfield.ai/blog/cinema-studio-4-0-complete-guide
- https://higgsfield.ai/blog/cinema-studio-guide
- https://higgsfield.ai/blog/how-we-built-supercomputer

Cloudflare
- https://developers.cloudflare.com/agents/guides/remote-mcp-server/
- https://github.com/cloudflare/workers-oauth-provider
- https://opennext.js.org/cloudflare
- https://developers.cloudflare.com/r2/pricing/
- https://upstash.com/kb/cloudflare-r2-pricing-in-2026-storage-operations-and-real-monthly-bills
- https://www.bucketmate.app/blogs/cloudflare-r2-pricing-2026
- https://tech-insider.org/cloudflare-r2-pricing-standard-vs-infrequent-access-2026/

Agent 连接
- https://docs.x.ai/grok/connectors
- https://skillsplayground.com/integrations/grok/
- https://forum.cursor.com/t/grok-bot-custom-remote-mcp-oauth-never-starts-fetch-failed-same-url-works-in-cursor-ide/168188

---

## 附录 A. 实现状态（v4 之后的首个实现）

| 设计章节 | 状态 | 实现位置 |
|---|---|---|
| §3 领域模型、§3.2 检查点 | 已实现 | `src/studio/types.ts`、`schemas.ts`、`repo.ts`、`checkpoints.ts` |
| §3.3 存储 | 已实现，数据库选了 **SQLite / D1**（设计里的备选），R2 为唯一文件存储；`save_shotlist` 为合并语义，不会删除已有 take | `src/db/`、`src/studio/storage/r2.ts`、`repo.mergeShotlist` |
| §4.2 Compiler（四模式模板、校验、成本估算） | 已实现；评测模式的端点和页面已实现，评测本身待 P0 | `src/studio/compiler.ts`、`cost.ts` |
| §5.2 Hero Frame / 角色设定图的图像生成 | **已关闭，列为 TODO**：Higgsfield 图像后端已移除，参考图和 hero frame 改为上传；take 的末帧也可作为帧 | `UploadButton`、`list_assets` 工具 |
| §4.3 Orchestrator（webhook 主路径 + 轮询兜底、幂等、预算、记账） | 已实现 | `src/studio/orchestrator.ts`、`src/app/api/runpod/hook`、`src/app/api/cron/sweep`、`workers/cron` |
| §4.4 Assembler 契约 | 已实现（输入构造 + ffmpeg worker） | `src/studio/backends/assembler.ts`、`workers/assembler/` |
| §4.5 / §6 MCP + Director Skill | 已实现（36 个工具、resource、`get_director_guide`） | `src/mcp/`、`agent/director.md` |
| §4.6 RunPod H3 worker | handler 已实现；**ComfyUI 工作流 JSON 由部署者放入**。部署形态改为 **Pod 模式**（§4.6 的方案 B 变体）：Studio 自己创建 / 启停 Pod，GPU 型号白名单，空闲自动关机，Pod 内作业服务同时承担生成与组装；Serverless 保留为 TODO | `workers/h3-runpod/server.py`、`src/studio/gpu.ts` |
| §4.7 Cloudflare 部署、Access、OAuth | 已实现：OpenNext 配置、Access JWT 校验、自带 OAuth 2.1 授权服务器（未用 `workers-oauth-provider`，因为它与 OpenNext 的 fetch 包装不兼容） | `wrangler.jsonc`、`src/auth/`、`src/oauth/` |
| §7 接口 | 已实现，含鉴权矩阵与错误模型 | `src/app/api/**` |
| §4.1 Web Studio | 已实现：项目、Look、剧本、元素、分镜表、时间线、设置（含 MCP 连接说明与评测模式） | `src/app/p/[id]/*`、`src/studio-ui/` |
| §9 P0 实测 | **未做**：需要真实 RunPod endpoint；成本常量和 prompt 规则仍是占位 | `.env.example` 中的 `RUNPOD_*` |

## 附录 B. 导演三层（Director skills）

| 层 | 输入 | 落点 | 实现 |
|---|---|---|---|
| 一层 · Brief | 用户总 prompt + 总时长 + 画幅 + 风格 | `Project.brief`、`targetSeconds`、Look | `start_film` 工具一次返回时长骨架、三层指令、剪辑语法、摄影目录、LoRA 库 |
| 二层 · 分镜与剪辑 | 一层 | `Shot.link { type, anchor }` | `src/studio/editing.ts`：cut / continuous / bridge / insert_return / reverse / match_cut / jump_cut / montage；编译器按锚点镜头的尾帧决定 I2VA / FL2VA / R2VA 及传图；`plan_durations` 做 5–15 s 的切分算术 |
| 三层 · 摄影与精修 | 二层 | `Shot.cinematography`（size / angle / lens / dof / lighting / grade / texture / vfx / animation / pace） | `src/studio/cinematography.ts` 目录，schema 校验键，编译器渲染成 CINEMATOGRAPHY 块；动画风格进 LOOK |

指南由目录生成（`pnpm guide:emit` → `agent/editing.md`、`agent/cinematography.md`），
MCP 以 `get_director_guide({section})`、resource 和 `direct_film` prompt 模板三种方式提供，
`start_film` 在第一次调用时就把全部技能带入上下文。时间线才能做的事（叠化、J/L cut）在
`TIMELINE_ONLY` 里列出，J/L cut 与淡入淡出仍是 TODO。

## 附录 C. 决策记录（2026-11）

- **edit 模式停用**：交接的 H3 图没有接视频输入，改动一个 take 的方式是改镜头后重新生成一个新 take，在 Board 里挑选。代码保留在 `H3_EDIT_MODE` 开关后。
- **审片只由人做**：`review_take` 从 MCP 工具里移除，agent 只负责到分镜表和生成；评分、选 take 在网页上完成。
- **粗剪预览在浏览器里做**：Timeline 页按顺序连播各 take 的 R2 文件（含入出点和 repeat），只做硬切；叠化、配乐、字幕要看导出文件。
- **GPU × 数据中心**：白名单按子串匹配并按优先级排序；每个数据中心一个模型卷，起 Pod 时遍历。
- **全局卷与接管的 Pod**：模型放在一个全局网络卷上（任意数据中心可挂）。RunPod REST API 目前既列不出也挂不上这种卷，所以第一台 Pod 在控制台手动建、由 Studio **接管**（`adoptPod`）：Studio 负责启停、作业、费用统计，但永远不终止或替换接管的 Pod；之后发现 RunPod 的 v2 API（`api.runpod.io/v2`）用 `mounts.network` 挂卷并支持 `PATCH` Pod，Studio 改为默认走 v2：接管时自动写入启动命令和环境变量，自动创建也走 v2（GPU × 数据中心逐个请求）。
- **全局盘只放模型**：全局卷不支持 venv 需要的文件权限，官方 ComfyUI 镜像把 Python 环境建在 `/workspace` 上会失败。于是卷挂在 `/runpod-volume`，ComfyUI 和 venv 装在容器盘，启动脚本把 `models/` 软链到卷上；每次开机重装 ComfyUI 约一分钟，模型零下载。后来实测全局盘读取极慢（冷加载文本编码器十分钟以上），改为**默认不挂卷**：每次开机用 aria2 并行下载 68 GB 到容器盘（RunPod 机房到 HuggingFace 几分钟），空闲关机放宽到 45 分钟；网络卷仍可选。
