# 前端重设计调研（2026-11）

> 状态（2026-11-13）：几处状态开始用颜色。样式表多了四个信号色（`--sig-ok` 绿、`--sig-warn` 琥珀、`--sig-err` 红、`--sig-info` 蓝），只用在状态自己的记号上：分镜页副标题里的分镜状态图标、“检查”面板的错误 / 警告 / 提示分组（错误默认展开，警告和提示默认折叠）、导演面板里需求的“已满足 / 放弃”、确认删除的按钮。其余界面仍是墨色加一个信号红。同一次改动：分镜页的“加一场”移到右上角（气泡弹层），色板改成弹层编辑，草图按场打开（`/sketch?scene=<id>`），删除场次和镜头先在按钮旁确认，长页有“返回顶部”；导演面板的需求、决定、评审是三个常驻标题，同时只展开一个；放映页没有可看的镜次时有“返回”（有镜次时出口仍是“开灯”）。
>
> 下面是这之前的状态。

> 状态（2026-11-12 再更新）：项目栏从 8 页改成 5 页加 2 层，旧地址都跳转到新位置。
>
> - **Reel**（`/p/:id`，原总谱，地址不变）：总览；"等你决定"和完整的问题列表（`#problems`）也在这里。
> - **Story**（`/story`）：brief 和目标时长（原 Brief & style 的前半）加剧本（原 Script，`?view=lined` 等模式照旧）。
> - **Design**（`/design`）三个标签：Look（`?tab=look`：风格、画幅、LoRA、风格帧，原 Brief & style 的后半）、Elements（`?tab=elements`）、Pictures（`?tab=pictures`，`show=` / `pic=` 照旧）。
> - **Board** 不变；**Cut** 改到 `/cut`（原 `/timeline`，`#seams` 等照旧）；放映（`/screening`）是全屏模式。
> - 导演台（`/director`）不再是页面：要求、决定（推翻）、评审在 **Director 面板**（项目栏的 Director 按钮，`/p/:id?panel=director`）；图片生成、声音生成、花费额度、代为批准和"最近删除"在项目的 **Settings** 页（`/settings`）。
>
> 下面一段是这之前的状态。

> 状态（2026-11-12 更新）：外观和信息架构已换成 **Score（总谱）**，取代下文第 2 节推荐的"后期机房"深色方案。
>
> - 外观：浅灰卡底加墨色（场灯亮），放映页为暗场（场灯暗）；直角；Archivo（可变宽度）+ IBM Plex Mono，自带字体文件；只保留一个信号红，只表示"你在这里""正在拍（花钱）""下一步"。成功、警告、失败都用墨色记号区分形状，不再用颜色。
> - 结构：去掉项目左栏和手机底栏，换成阶段栏加"片脊"（整部片按时长缩放的一条线）。项目首页是总谱（`/p/:id`）：同一时间轴上排场次、剧本、分镜画面、镜次、声音、剪辑、问题、花费，上方是"等你决定"。
> - 新页面：放映（`/screening`，并排对比、连续评审、全键盘）、导演台（`/director`，从 Settings 搬出）、剪辑（原 Timeline，拖动排序与裁剪、撤销、接缝一键修复、并入 Finals 的全分辨率批量）。Finals 页删除，旧地址跳转到剪辑页。
> - 交互：打开的镜头、标签、筛选、放映的镜次都写进地址；花钱的按钮带估价；同因失败合并；镜次完成/失败的通知；剪辑里移除片段可撤销；EN / 中 切换（已翻译：顶栏、阶段栏、总谱、等你决定、放映）。
> - 后续（同日）：删除可撤销（镜头、场景、元素、图片、整个项目进回收站 14 天，网页上有撤销通知和"最近删除"列表）；剧本覆盖（镜头的 `scriptLines` 引用剧本原句，剧本页"贯线"视图画出贯线，未拍的分句标红，lint 检查 `script.uncovered` / `script.quote.stale`）；全部页面的中文。
> - 仍是英文的：服务器生成的文字（lint 提示、报错信息）。
>
> 下文是 2026-11 早些时候的调研和第 1 到 3 阶段的记录，保留作背景。

> 状态：第 1 到 3 阶段已实现（commit `67a31ac`、`cf5d9f3` 及其后续）。壳、token、Geist、六步导航、Library / Machine / Connect、Brief & style 的风格库、Board 的 Lint / Apply style / Render batch、Finals、Timeline 的节拍网格与字幕检查都已上线。第 4 阶段（assembler 的 J/L cut、标题卡、旁白轨道）和 Director log 仍待做。

基于本地跑起来的 Studio 截图（桌面 1440 宽、手机 390 宽，九个页面加 Board 的镜头抽屉），
以及导演层 MCP 现有的 27 个工具，给出三部分结论：现状问题、视觉模版的选择、
信息架构怎么和导演技能对齐。最后是分阶段的实施计划。

## 1. 现状审计

### 1.1 视觉层面

| 问题 | 在哪里 | 为什么不协调 |
|---|---|---|
| 荧光绿（`#d1fe17`）用得太多 | 主按钮、链接、表格数字、芯片、选中态、进度条、状态灯 | 一个页面上七八处绿，没有一处是"最重要"的。Settings 的统计表整行绿字最明显 |
| 字号层级只有两档 | 全站 | 页面标题 24px，其余几乎全是 13px，副标题、区块标题、表头、说明文字靠颜色区分，扫一眼分不出结构 |
| 卡片比例失控 | Elements 的 3:4 大灰块（无参考图时）、Board 的 16:9 空占位 | 没有内容时占位比有内容时还抢眼 |
| 两栏布局失衡 | Look 页左栏只有五个输入框，右栏三块叠到 1400px 高 | 左下方大片空白 |
| Settings 是一面文字墙 | Settings | 后端状态、GPU、接管、统计、MCP、评测六件事平铺，没有主次 |
| 手机端侧栏失效 | 所有项目页 | 侧栏没有变成顶部横条，占满第一屏，内容在一屏之后才开始（截图里能看到） |
| 删除按钮太显眼 | 项目卡片、场景行 | 红色描边按钮和主操作并排 |
| 边框和分隔线不统一 | 卡片、表格、区块 | 有的用 1px 线，有的用底色，有的用虚线空状态 |

### 1.2 结构层面

- 项目列表页几乎是空的，没有告诉用户"下一步做什么"。
- Look 页同时承担 brief、目标时长、视觉设定、LoRA、负向约束五件事，但导演层已经有 16 个风格预设（`suggest_styles` / `compile_look`），页面上完全看不到。
- Script 页只有一个粘贴框。导演层的 treatment 结构（logline、三种候选结构、hook、结尾回响、签名镜头、声音设计）和 `validate_treatment` 的警告没有落到页面上。
- Board 的镜头卡片只显示时长、模式、运镜、link 类型文字，看不出摄影参数是否填了、`lint_shotlist` 有没有意见、哪些镜头缺锚点。
- 生成是逐镜头点按钮，`plan_batch`（先 R2VA、锚点先于接续镜头、一次确认总预估）没有入口。
- 定稿流程（挑 take、2K 再生成、评测对比）分散在 Board 抽屉和 Settings 的评测区。
- Timeline 没有节拍网格（`check_cue_map` / `cut_on_beats`）和字幕检查（`check_subtitles`）的入口；J/L cut、标题卡、旁白轨道在 assembler 里也还没有。
- GPU、MCP 连接、LoRA 库是全局的事，却挂在项目的 Settings 下或者散在顶栏。
- Playground 是旧的单图生成器，和工作流无关。

## 2. 视觉模版：三个候选，推荐 A

| | A. 后期机房（Frame.io 2024 版 / Resolve 的克制） | B. 工具型密度（Linear / Raycast） | C. 营销风（Higgsfield 官网） |
|---|---|---|---|
| 底色 | 近黑中性灰，三级表面 | 偏暖的深灰，两级表面 | 大面积渐变、玻璃 |
| 强调色 | 一种，只用于主操作和"正在进行" | 一种品牌色，用得更克制 | 多色 |
| 字体 | 无衬线 + 等宽数字 | 13px 密排无衬线 | 大字展示 |
| 适合 | 看片、挑 take、读数字 | 表格、快捷键、表单 | 首页 |
| 结论 | **推荐** | 取它的密度规则和表格 | 不适合工作台 |

推荐 A 的理由：这个产品 80% 的时间在看视频缩略图、比较 take、读时长和费用。画面周围的 chrome 越中性，视频越好看；强调色只在"你现在该点这里"和"这个正在跑"两种场景出现。

### 2.1 具体规格

**字体**：`Geist Sans` 做 UI，`Geist Mono` 做所有数字（时长、费用、步数、seed、GPU 秒）。两者免费（Vercel 开源），字形比 Inter 窄一点，表格和卡片上更省地方；等宽数字让费用列对齐。备选：保留 Inter，加 `JetBrains Mono` 做数字。中文内容（提示词、剧本）走系统字体回退即可。

**字号层级（五档，别再多）**

| 档 | 用途 | 大小 / 行高 / 字重 |
|---|---|---|
| Display | 页面标题 | 22 / 28 / 600 |
| Title | 区块标题、卡片标题、抽屉标题 | 15 / 22 / 600 |
| Body | 正文、表单值、按钮 | 13.5 / 20 / 450 |
| Label | 字段名、表头、芯片 | 11.5 / 16 / 550，大写字距 0.04em 只用于表头 |
| Mono | 数字 | 12.5 / 18，等宽 |

**色板**（保留现有变量名，改值和用法）

| 变量 | 值 | 用法 |
|---|---|---|
| `--bg` | `#0b0c0e` | 画布 |
| `--rail` | `#0f1113` | 侧栏、顶栏 |
| `--s1 / --s2 / --s3` | `#141618 / #1a1d20 / #22262a` | 卡片、输入框、悬浮层，每级只亮一点 |
| `--line / --line-2` | 白 6% / 11% | 分隔，不用实色 |
| `--tx / --tx2 / --tx3` | `#ececec / #a6abb0 / #767c82` | 三级文字，去掉现在的四级 |
| `--accent` | `#d1fe17` 保留，但只用于：主按钮、当前选中、正在生成 | 链接改为 `--tx` 加下划线，表格数字改为 `--tx` |
| `--live` | 同 accent | 状态灯"running" |
| `--warn` | `#f2b84b` | lint 警告、预算接近上限、"暂时没资源" |
| `--danger` | `#ff8d78` 保留 | 失败、删除确认 |
| `--ok` | `#8fd18a` | 完成、已批准（取代用绿强调色表示 approved） |

**间距与形状**：4pt 网格；页面内边距 32（桌面）/ 16（手机）；卡片内边距 16；圆角 8（控件）/ 12（卡片）/ 16（抽屉）；阴影只给悬浮层。

**状态语言**：每个 take、每个镜头、每个任务只用一个语义：`draft / ready / queued / running / done / failed / warning`，颜色固定，图标固定（圆点 + 文字），不再有"approved"用绿强调、"Rendering"用灰字的混用。

### 2.2 实现方式

不换框架。现在是手写 CSS 加 `.ohf` 作用域的 token，这一套保留，只重写 token 值和 `studio.css` 的组件层。两处引入现成库：

- `@radix-ui/react-*` 的 Select、Dialog、Tabs、Tooltip（无样式，解决可访问性和键盘），替换抽屉和各处原生 `<select>`。
- `@dnd-kit` 做 Board 的拖拽排序，替换上下箭头。

Playground 整个目录删除（`src/app/playground`、`src/openhiggsfield/` 里只被它用到的组件）。

## 3. 信息架构：对齐导演层

### 3.1 新的导航

全局顶栏：项目切换、GPU 状态灯（点开是 GPU 面板）、本项目花费 / 上限、连接状态（MCP 是否有 agent 在线）。项目左栏按工作顺序排：

| 页 | 承担 | 对应的 MCP 工具 |
|---|---|---|
| **Brief** | 一句话需求、目标时长、**风格选择**（16 个预设卡片，带 STYLE.md 预览和"为什么适合"）、由风格编译出的 Look（可改）、LoRA 默认、负向约束 | `start_film` `suggest_styles` `get_style` `compile_look` `update_look` |
| **Script** | 左：treatment 结构化字段（logline、弧线、三种候选结构 + 选定、hook ≤ 3 s、结尾回响、签名镜头、原生运镜、段落节奏、声音设计表、静默）；右：剧本正文 + 版本 + 批准。顶部一条 `validate_treatment` 的警告列表 | `validate_treatment` `save_script` |
| **Elements** | 不变，卡片改 16:9 或 1:1，无图时显示大写首字母而不是灰块 | `create_element` `select_element_refs` |
| **Board** | 镜头卡片增加：link 图标、摄影参数缩写（ELS · HIGH · WIDE · NEON）、lint 徽章（黄点 + 数量）、锚点状态、take 数和最佳 take 缩略图。顶部工具条："Apply style"、"Lint"（右侧抽屉列出每条意见并可跳到镜头）、"Render batch"（`plan_batch` 的顺序和总预估，一次确认） | `apply_style` `lint_shotlist` `plan_batch` `save_shotlist` `generate_take` |
| **Finals**（新） | 每个镜头一行：已选 take、原始分辨率、全分辨率状态、评分；只做全部升级（"Final quality" 1080p / 2K / 4K，默认 close to the draft），不做单条升级；不设盲评 A/B | `select_take` `regenerate_take` `review` |
| **Timeline** | 默认把所有已选 take 按 Board 顺序拼接，每条 0 秒入场、全长；"Reset" 重建。左：节拍网格（tempo 段、hit 点、静默）+ "Cut on beats"；中：片段条（可拖长度，显示 repeat）；右：字幕检查（阅读时长）、音乐轨、导出预设 + 缺 2K 片段的提示 | `check_cue_map` `cut_on_beats` `check_subtitles` `check_timeline` `save_timeline` `export_project` |

全局页（顶栏菜单）：**Library**（LoRA 库 + 风格库，风格可新增用户自定义）、**Machine**（GPU 面板、接管、统计、下次启动用哪张卡）、**Connect**（MCP 端点、OAuth、导演指南）。项目里的 Settings 只剩预算上限和删除项目。

### 3.2 Board 卡片的信息密度

现在一张卡只说"10s · reference · push in · 1 take · $0.140"。改成三行：

```
#1  ELS · HIGH · WIDE · NEON+OVERCAST          [link: cut]
Establish the rooftop and Alice alone in the rain
10 s · R2VA · ●done 1/1 · $0.14          ⚠ 2 lint
```

缩略图用最佳 take 的中间帧；正在生成时缩略图位置放进度条；没有 take 时放 hero frame 或风格色块，不放空灰块。

### 3.3 和 agent 的协作可见

加一个全局的"Director log"侧边抽屉：最近 50 条 MCP 调用（工具名、镜头、结果、warnings），用户能看到 Grok 正在做什么、哪条 `save_shotlist` 带回了 warnings。需要一张 `agent_events` 表，MCP 层每次调用写一行。这是把"agent 只在导演层工作"这件事做得可见的最省办法。

### 3.4 手机端

侧栏改成底部标签栏（Brief / Script / Board / Finals / Timeline），Board 卡片单列，抽屉改全屏页。现在的横向侧栏 CSS 没生效要先修（`.st-rail` 的媒体查询被 `height: 100dvh` 覆盖）。

## 4. 实施计划

| 阶段 | 内容 | 工作量 |
|---|---|---|
| 1 基础 | 新 token、字体、五档字号、按钮/输入/卡片/表格组件统一；修手机端侧栏；删 Playground；顶栏 + 全局页拆分（Library / Machine / Connect） | 1 天 |
| 2 工作流 | Brief 页风格选择 + 编译 Look；Script 页 treatment 字段 + 校验；Board 卡片重做、Lint 抽屉、Render batch；Finals 页 | 2 到 3 天 |
| 3 时间线 | 节拍网格、字幕检查、拖拽片段、导出提示；Director log | 1 到 2 天 |
| 4 assembler | J/L cut、标题卡、旁白轨道、ducking 做进 Pod 的 ffmpeg 组装（导演层 `check_timeline` 已经会生成这些字段） | 1 到 2 天 |

每个阶段单独提交，阶段 1 完成后先看一轮截图再进阶段 2。

## 5. 顺带发现的问题

- 手机端侧栏布局坏了（见上）。
- Settings 的 GPU 统计表全是强调色数字，和"这是数据"的语义冲突。
- 项目卡片的 Delete 和主信息并排，容易误触，应该收进菜单并二次确认。
- Elements 卡片 3:4 比例在无图时是一块 370px 高的灰色。
- Look 页"Upscale at export"复选框现在应该直接链接到 Finals 的 2K 状态，而不是一个独立开关。
