# Cinema Studio 复刻方案（MiniMax H3 导向）

> 目标：在本仓库基础上，复刻 Higgsfield Cinema Studio 的完整结构
> （Project → Scene → Shot、项目级 Look、Hero Frame First、Cast / Elements、
> 每镜头生成、多镜头、时间线导出、自然语言编排 agent），
> 生成引擎统一换成 MiniMax H3 系列，编排 agent 使用订阅版 Grok 与 Claude（不走 API）。
>
> 状态：设计稿 v1。标注「待验证」的条目来自二手资料，实施前需对照官方文档确认。

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
│   Postgres（项目 / 元素 / 镜头 / 任务）   Vercel Blob（素材 / 成片）      │
└───────────────────────┬───────────────────────────────────────────────┘
                        │ 复用现有 catalog / to-platform / platform client
                        ▼
      Higgsfield Platform API ── minimax/h3/{text,image,reference}-to-video
                               └─ 图像模型（Soul 2 / Flux 等）用于 hero frame
```

三个关键决策：

1. **以"镜头"为原子单位，每个镜头 = 一次 H3 请求。** 这与本仓库现有的
   `{model, prompt, media, settings}` 一一对应，生成层可直接复用。
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
| 时间线 + 导出预设 | Assembler（§7） |
| Supercomputer：自然语言 → 计划 → 派发 → 组装 | MCP 工具链 + Orchestrator |

### 1.2 硬约束

- 生成模型：**只用 MiniMax H3 系列**（通过 Higgsfield Platform API）。
- 编排 agent：**订阅版 Grok 和 Claude，并列，不走 API**。
  推论：服务端不能主动调用 LLM；任何"AI 写剧本 / 拆镜头"都必须由用户在
  聊天客户端里触发。禁止做浏览器自动化去操控聊天界面（违反服务条款、不稳定）。
- 其他结构与 Cinema Studio 保持一致。

### 1.3 非功能需求

- 一个项目典型规模：10–40 个镜头，每镜头 5–15 秒，每镜头 1–4 个 take。
- 单镜头生成 1–5 分钟，整片生成要能跑几十分钟，**不能依赖浏览器标签页存活**。
- 成本可见：按秒计费，每次生成前显示预估，项目有预算上限。
- 单用户 / 小团队自托管优先，不做多租户。

---

## 2. MiniMax H3 调研结论

### 2.1 模型事实（用于约束设计）

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

### 2.3 "H3 导向"对架构的具体影响

| Cinema Studio 的 Seedance 导向 | 换成 H3 后 |
|---|---|
| 音频往往后期加 | H3 原生出声，**对白 / 音效 / 音乐在 Director 阶段就写进镜头**；后期只做混音平衡和配乐替换 |
| 参考图 + 首尾帧可同时用 | 互斥 → 每个镜头必须二选一：**Keyframe 模式**（首尾帧，适合连续动作和转场）或 **Reference 模式**（omni，适合角色 / 产品一致性） |
| 单段最长 30 s–1 min | 单段 ≤15 s → 镜头切分更细，长镜头靠**末帧接下一镜头首帧**链式衔接 |
| 多模型按镜头切换 | 引擎固定 H3；仅在 Higgsfield 开放 H3-Max 后，为 previz 提供"快速 / 低清"档 |
| Soul Cast 出三视图 | 用本仓库已有的图像模型（Soul 2 / Flux 2 / Qwen Image 3 等）做角色设定图，H3 本身不出静帧 |

---

## 3. 领域模型

```
Project
 ├─ look: LookSettings        # 项目级风格，所有镜头继承
 ├─ budget: { capUsd, spentUsd }
 ├─ script: Script            # 版本化
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
  resolution: "768p" | "2k";
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

type Shot = {
  id: string; sceneId: string; index: number;
  durationS: number;                       // 5–15
  mode: "keyframe" | "reference" | "text"; // H3 三个端点，互斥
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

type Beat = { from: number; to: number; action: string };  // 秒，段和 = durationS

type Take = {
  id: string; shotId: string; n: number;
  request: { path: string; body: unknown };   // 实际发给平台的东西，可追溯
  requestId?: string; status: "queued"|"running"|"completed"|"failed"|"nsfw"|"canceled"|"timeout";
  resultUrl?: string; costUsd?: number; error?: string;
  review?: { score: number; notes: string; by: "human"|"agent" };
  createdAt: number; finishedAt?: number;
};

type Asset = { id: string; url: string; kind: "image"|"video"|"audio"; width?: number; height?: number; durationS?: number; source: "upload"|"generated"|"frame-extract"; meta: Record<string, unknown> };

type Timeline = { clips: { shotId: string; takeId: string; inS: number; outS: number; transition: "cut"|"dissolve" }[]; music?: AssetId; mix: { dialogueDb: number; sfxDb: number; musicDb: number } };
```

### 3.2 存储选择

- **Postgres**（Vercel Postgres / Neon / 自托管均可）：以上全部实体。现有的
  IndexedDB 历史只保留为"个人画廊"的兼容路径，项目数据不进浏览器。
- **Vercel Blob**（沿用）：上传素材、hero frame、take 产物的镜像副本。
  平台返回的 CDN URL 会过期，**每个 completed take 必须在服务端回拉一份存入 Blob**，
  这是现有仓库明确踩过的坑（README 里的"历史记录会出现空洞"）。
- 任务队列：起步用 Postgres 表 + 一个 worker 轮询（Vercel Cron 或常驻进程）；
  规模上去再换 Redis / Upstash QStash。

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

### 4.2 Prompt Compiler（确定性，无 LLM）

输入 `Shot + Project.look + Elements`，输出 H3 prompt 文本和请求体。这是"导演"中
**不需要智能的那一半**：把结构化字段按 §2.2 的格式拼成文本，保证每次生成都带上项目 Look、
参考角色声明和约束块，避免 agent 每次都要重写这些。

模板（reference 模式示例）：

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

请求体映射（新增到 `src/generation/to-platform.ts`）：

| Shot.mode | 端点 | 媒体 |
|---|---|---|
| `text` | `minimax/h3/text-to-video` | 无 |
| `keyframe` | `minimax/h3/image-to-video` | `image_url` = heroFrame；末帧字段名**待验证**（Higgsfield 博客称支持 Start/End Frame） |
| `reference` | `minimax/h3/reference-to-video` | `image_urls` ≤9（角色三视图 + 场景 + 道具 + hero frame）、`video_urls` ≤3、`audio_urls` ≤3 |

Compiler 做的校验：beats 时长之和 = durationS；参考总数 ≤12；音频必须有图或视频陪同；
keyframe 与 reference 互斥；prompt 长度 ≤7000；`continuous` 镜头必须有上一镜头的末帧。

### 4.3 Orchestrator（服务端任务编排）

把现有浏览器侧的 `poll.ts` 逻辑搬到服务端：

```
Take 创建 ──► 队列 ──► worker: submit ──► requestId ──► 轮询 (4 s, 10 min deadline)
                                   │                          │
                                   │ 429/5xx: 指数退避重试 ≤3   ├─ completed: 回拉到 Blob, 抽末帧, 记账
                                   │                          ├─ failed/nsfw/canceled: 记录原因
                                   ▼                          └─ timeout: 标记, 允许重试
                               预算检查（预估 = durationS × 单价）
```

- **幂等**：Take 以 `(shotId, n)` 唯一；重复提交返回同一 take。
- **并发**：项目级并发上限（默认 3），避免一次把 40 个镜头全砸给平台。
- **末帧抽取**：completed 后用 ffmpeg 抽最后一帧存为 Asset，供下一个 `continuous` 镜头作首帧。
- **预算**：`Project.budget.capUsd`，超限拒绝入队；每个 take 记录实际秒数 × 单价。
- 现有 `createPlatformClient` / `PlatformError` / 状态映射直接复用。

### 4.4 Assembler

- `ffmpeg concat`（同编码直接拼；不同分辨率先统一到项目分辨率）
- 混音：H3 自带音轨为主；可选叠加项目配乐，按 `Timeline.mix` 调电平
- 字幕：从 `Shot.dialogue` 自动生成 SRT，可烧录
- 导出预设：`master-2k`、`social-9x16`、`preview-720p`
- 运行位置：Vercel 函数跑 ffmpeg 有体积和时限问题，建议 Assembler 作为独立 worker（Fly.io / Railway / 自托管容器）

### 4.5 MCP Server（agent 的接口）

见 §6。

---

## 5. 核心工作流

### 5.1 从需求到分镜表（Writer + Director，在用户的聊天客户端里完成）

```
用户在 Grok/Claude 里：  "给我做一支 60 秒的霓虹雨夜追逐短片，主角是……"
   │
   ├─ agent 调 create_project(name, look 草案)
   ├─ agent 写剧本 → 调 save_script(projectId, text)
   ├─ agent 调 list_elements → 发现没有角色 → 调 create_element(kind=character, description)
   ├─ agent 拆镜头 → 调 save_shotlist(projectId, shots[])   ← 严格 JSON schema
   └─ 用户在 Web Studio 的 /board 看到分镜表（人工检查点 1）
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
| 角色 / 产品必须高度一致，镜头内有对白 | `reference`，角色三视图 + 声音样本 + hero frame 作为 image 之一 | 身份锁定 + 音色一致 |
| 空镜、氛围镜头 | `text` | 最便宜 |

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

Timeline 页面选 take、排序、转场 → `export(preset)` → Assembler worker → 成片存 Blob → 下载。

---

## 6. Agent 层：订阅版 Grok / Claude 如何扮演 Mr. Higgs / Supercomputer

### 6.1 为什么是 MCP

两家的订阅产品都支持**远程 MCP 自定义连接器**：

- Grok：grok.com → Connectors → New Connector → Custom，填公网 HTTPS 地址，仅支持远程服务器，付费计划可用（第三方资料，**待官方确认**）。
- Claude：Claude Desktop / Web 的自定义连接器，远程 MCP + OAuth 2.1；Claude Code 也能直接挂 MCP。

因此 Studio 暴露一个 `https://<studio>/mcp` 端点，用户在两边各连一次。
不需要任何 LLM API key；推理成本全部落在用户已有的订阅里。

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
5. 预算规则：先 previz（768p，每镜头 1 take），用户满意后再 2K。

Grok 和 Claude 用**同一份** Skill 和同一套工具，差别只在客户端。

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

```
POST   /api/projects                        创建
GET    /api/projects/:id                    聚合视图
PATCH  /api/projects/:id/look
POST   /api/projects/:id/script             新版本
GET    /api/projects/:id/elements
POST   /api/projects/:id/elements
POST   /api/elements/:id/generate-refs      → jobId
PUT    /api/projects/:id/shotlist           整表覆盖（schema 校验）
PATCH  /api/shots/:id
GET    /api/shots/:id/compile               Compiler 预览
POST   /api/shots/:id/hero-frames           → jobId
POST   /api/shots/:id/takes                 → takeId（含预估费用；需 confirm）
GET    /api/takes/:id
POST   /api/projects/:id/export             → jobId
GET    /api/jobs/:id
POST   /mcp                                 MCP 传输端点（Streamable HTTP）
GET    /.well-known/oauth-authorization-server   MCP OAuth 元数据
```

MCP 工具是这些 REST 的薄封装，共用一套 zod schema。

---

## 8. 与现有仓库的映射

| 现有模块 | 处理 |
|---|---|
| `src/generation/catalog/` | 保留。`minimax-h3.ts` 从 `t2v()` 简写改为完整条目：`roles: { start:1, end:1, reference:9, video:3, audio:3 }`，settings 加 `aspectRatio` 6 值、`resolution: 768p/2k`、`duration 5–15`，`paths` 加 `reference: "minimax/h3/reference-to-video"` |
| `src/generation/to-platform.ts` | 新增 `mapH3`：实现 keyframe / reference 互斥、末帧字段、参考数组；`mapByPaths` 现有的"无媒体也发 image-to-video"问题顺手修掉 |
| `src/generation/platform.ts` | 原样复用 |
| `src/generation/poll.ts` | 逻辑搬到服务端 worker；浏览器侧改为订阅 `/api/jobs/:id`（SSE 或轮询） |
| `src/generation/actions.ts` | `submitGeneration` 改为内部函数，由 Orchestrator 调用；凭证从 cookie 改为项目级配置（自托管时存环境变量） |
| `src/openhiggsfield/history.ts`、`idb.ts` | 仅保留给 `/playground` |
| `src/app/api/blob/route.ts` | 保留；加鉴权（现在是公开上传） |
| 图像模型（Soul / Flux / Qwen 等） | 作为 hero frame 和角色设定图引擎直接复用 |
| 新增 | `src/studio/`（领域模型、Compiler、Orchestrator）、`src/app/mcp/`、`src/app/p/[id]/*`、`workers/assembler/`、`agent/director.md` |

---

## 9. 实施路线

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 验证（1 周） | 用 `/playground` 手工跑通 H3 三个端点；确认末帧参数名、2K 可用性、参考数上限、prompt 上限 | §2 表中"待验证"全部清零 |
| P1 领域 + Compiler（1–2 周） | Postgres schema、Shot 编辑器、Compiler、单镜头生成走服务端 Orchestrator | 能手工建一个 5 镜头项目并逐个生成 |
| P2 Elements + Hero Frame（1 周） | 元素库、角色三视图生成、hero frame 四选一、keyframe / reference 两种模式 | 同一角色跨 5 个镜头脸不漂 |
| P3 MCP + Director Skill（1 周） | MCP 服务器 + OAuth、工具清单、Skill 文档、Prompt Pack 兜底 | Grok 和 Claude 各自从一句话需求跑到分镜表 |
| P4 Assembler（1 周） | ffmpeg worker、时间线、导出预设、字幕 | 导出一支 60 s 成片 |
| P5 审核回路 + 预算 | 缩略帧、agent 评分、重跑、预算上限 | 全流程无人值守跑完一个项目 |

---

## 10. 权衡与风险

| 决策 | 取舍 |
|---|---|
| MCP 而不是 API | 零 LLM 费用、两家并列；代价是必须有公网 HTTPS + OAuth，且 agent 的行为取决于用户客户端版本 |
| 确定性 Compiler 而不是让 agent 直接写 prompt | 稳定、可审计、Look 永不遗漏；代价是表达力受 schema 限制，所以保留 `promptOverride` |
| 镜头 ≤15 s、靠末帧链接 | 符合 H3 限制；长镜头衔接处可能有跳变，需要 Assembler 加短 dissolve |
| Postgres + 单 worker | 简单、自托管友好；并发上百镜头时需要换队列 |
| 回拉所有产物到 Blob | 存储费用上升；换来历史不丢 |

待验证清单（实施 P0 时逐条确认）：

1. Higgsfield `minimax/h3/image-to-video` 的末帧参数名及是否真的支持。
2. Higgsfield 上 H3 的 2K 是否可用、`resolution` 枚举值。
3. `reference-to-video` 的参数名是否就是 `image_urls / video_urls / audio_urls`，及上限。
4. prompt 7000 字符上限。
5. Grok 自定义连接器对 OAuth 的具体要求（有用户报告 OAuth 流程启动失败）。
6. Higgsfield 是否会开放 H3-Max（用于 previz 低清档）。
7. 实际单价（$0.065 vs $0.13 /s）。

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

Cinema Studio
- https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-cinema-studio
- https://higgsfield.ai/blog/cinema-studio-4-0-complete-guide
- https://higgsfield.ai/blog/cinema-studio-guide
- https://higgsfield.ai/blog/how-we-built-supercomputer

Agent 连接
- https://docs.x.ai/grok/connectors
- https://skillsplayground.com/integrations/grok/
- https://forum.cursor.com/t/grok-bot-custom-remote-mcp-oauth-never-starts-fetch-failed-same-url-works-in-cursor-ide/168188
