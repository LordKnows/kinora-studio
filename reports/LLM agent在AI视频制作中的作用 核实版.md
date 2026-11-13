# 锚定图定连续，格式定遵循，词句居末

视频模型固定时，agent 层的作用是实的，但方向不保证为正。在同一个模型上做过人评的三组对照里，设计得好的 agent 层在 5 分制上加 **0.25 到 0.6 分**，两套旧设计跑在同一个 Veo 3.1 上却比裸模型低 **0.5 到 0.6 分**。"分镜重要还是单镜写法重要"这个二选一，核实后的证据两边都不支持：只产出规划文本的 agent 与完全不做规划的基线几乎打平，三步消融里"加剧本、加切分、加帧锚定"大小相当；另一头，只把 prompt 改写成模型训练时的 caption 格式、权重不动，多事件完成率就从 45.9% 升到 64.6%，上一版说的"换什么措辞都过不去"站不住。挪动分数最多、也被各篇论文作者自己点名为最重要的是第三样东西：每一条生成以什么为条件，即参考图、首尾帧和跨镜携带的状态。对 H3 或 Seedance，由此推出的顺序是：先定条件；规划（每条生成要什么、先后顺序）和格式（按该模型的官方 caption 格式写，并在看过结果后修订）并列其次，各管一类故障；格式对齐之后的词句打磨最小，只值 0.3 到 1.6 分，而且要微调模型才拿得到。电影级成片最要紧的是七件事：故事与可信的人物，先图后视频并把连续性写进数据，每条生成只要一件事，按模型分别编译 prompt，多 take 加看得见运动的选片，花钱之前的独立审查，剪辑调色与声音。这个顺序是推断，不是测量：没有任何研究在同一个设计里同时变动 prompt、首帧、seed 和分镜方案，也没有人把模型的原生多镜头与 agent 逐镜驱动同一个模型放在一起比过。

**证据标注。** 本版对照一手来源重写：论文读的是 arXiv 全文和原表，厂商指南读的是官方页面和模型仓库，幕后文章读的是原文。每个数字后注明测量类型：【人评】指人类评分者，【LLM评】指 LLM、VLM 或 MLLM 当裁判，【自动】指自动指标，【厂商】【主创】【媒体】【个例】分别指官方指南、主创自述、媒体报道和个人实测，【内部】指本项目的记录。论文数字除注明外全部是系统作者自报，没有独立复现；WanPE 里关于 H3 的那一项出自竞争方。内部证据没有重做，沿用原笔记及其限制：全部记录里只有 11 条 take 带审查，故障标签只出现在两个项目，git 历史是 2026-11-09 至 11-13 的浅克隆，prompt 构成的切分只做过一条 take。仍未能打开的来源：Screen Daily（数字改引 Creative Bloq）、JoBlo 与 CineD 的影评、两篇知乎文章、X 上 Eian 文章的正文（内容经三个转述它的开源仓库核对）、LinkedIn、PetaPixel、AV Club；华尔街日报和 The Verge 的两篇只读到二手转述；CameraBench 的表格单元未能读出；MiniMax 预告的 H3 技术报告没有找到。

## 相对上一版，这些结论和数字改了

| 上一版的说法 | 一手来源实际写的 | 对结论的影响 |
|---|---|---|
| 没有论文以 H3 或 Seedance 为固定底座 | CineEvolve 把自己和三套 agent 基线都跑在 8 步蒸馏的 MiniMax-H3 Turbo 上；CineForge 把四套 agent 跑在 Seedance 2.0 上；Script 论文表 2 有 Seedance1.5-Pro 一行 | 该句删除。仍然缺的是"裸模型对同一模型加 agent"这一臂 |
| ViMax 去掉分镜 agent，均分 4.107→3.658，是"同一视频模型有无 agent"的例子；RAG 是给镜头语言做检索；去掉候选筛选掉 3.8% | 表 3 是 GPT-5.4 给分镜**文本**打分，视频合成关闭；消融保留镜头数和顺序，只去掉"视觉化描述"；掉分的 VSU 是"描述是否具体可用"；RAG 检索的是原著；3.8% 是关键帧筛选的自动指标，且 3 选 1、4 选 1 比 2 选 1 更低 | 从"同模型对照"和"分镜大于措辞"的证据里拿掉 |
| Script 论文的增益主要来自切分和锚定，只加剧本的一份最小 | 表 5 由三个 LLM 打分，没有人评；三步的增量是 +0.06–0.24、+0.06–0.24、+0.10–0.16，大小相当；"只加剧本"是把整份逐镜计划当一条长 prompt 交给模型 | "纯措辞最小"不能靠这张表 |
| Co-Director 里 MovieAgent 和 AniMaker 搭在旧渲染器上 | 两者都用 Veo 3.1 实例化；人评 3.22 和 3.07，低于裸 Veo 3.1 的 3.71 | 读法反转：旧的 agent 设计在同一模型上输给裸模型 |
| StoryEval 上 Wan2.2 只有 45.9%，说明有些限制换什么措辞都过不去 | 45.9% 是不加提示词增强的那一行；同一权重换成 caption 锚定的增强器是 64.6%，官方增强器只有 47.5% | 该句收窄为"运动方向绑定和多主体多动作不随 prompt 变" |
| SeqBench：Kling 2.0 多主体多动作 0.366 | 0.366 是多主体**单**动作；多主体多动作是 0.192、0.258、0.228；单主体单动作的基线本身只有 0.291 | 数字改正 |
| 否定句不起作用（当作各家通则） | 只对 Runway Gen-4 和 H3 开放权重成立；Seedance 2.0 指南写"约束词十分重要"，2.5 有"负向控制"一节；Veo 3.1 和 Sora 2 的官方示例也用否定 | 按模型区分 |
| H3 的 caption 格式来自 lightx2v turbo LoRA 的训练 caption；不做 CFG 是 turbo 链路的属性 | 格式由 MiniMax 官方指南定义，也是其托管增强器 H3-Context-IR 的输出格式；官方基座权重本身就是 CFG 蒸馏的 | 归属改正；`docs/handoff/HANDOFF.md` 里有同样的归属 |
| 首帧模式下画面归图、文字归运动（当作通则） | Runway、Kling、Sora、Seedance 2.5 如此；H3 官方指南对单首帧模式要求先描述图里的风格、主体、构图和场景锚点，再写动作 | 按模型和模式区分 |
| H3 接受带时间窗的节拍 | 官方格式只在切镜处有时间码，镜内用散文写先后；ComfyUI 的 H3 指南明说用单个时间点，不用区间 | 没有官方依据，列为待测 |
| 海螺指南建议用上一镜末帧做下一镜首帧 | 被引的那一页说的是每一镜都用同一张主参考图；末帧接首帧写在别的页面上，用途是把一个复杂运镜拆成 4 秒小段 | 引用改正 |
| 虎嗅：Seedance 2.0 把可用率从约 20% 提到 90% 以上 | 原文是"得跑 10 次，只有最后 1 次能用"到"90% 以上"，是评论文章的修辞，没有测试；"十段里两段能用"在另一篇文章，说的是可灵 3.0 | 不再当证据 |
| 凤凰网的 22 万部、1,055 部，与杭州日报的"十几次到两三次"（当作两个来源） | 是同一篇杭州网稿件，凤凰网为转载；市场数字的一手来源是 DataEye：22.19 万部、1,055 部、破亿率 0.47%（另一处写 0.48%），口径在"全网"和"抖音端"之间不一致，统计对象是"AI 剧与漫剧" | 来源和口径改正 |
| Hell Grind：Variety 说情节不知所云，TechRadar 说人物不可信（当作一致意见）；数字引 Screen Daily | 两篇影评在情节和画面上都相反，一致的只有表演和对白弱；Screen Daily 未能打开，数字见于 Creative Bloq | "画质救不回弱故事"改为"两位评论者共同点名的是人物" |
| Air Head 主创说未处理素材缺乏连续性和整体感；Dear Upstairs Neighbors 的微调模型引 No Film School | "缺乏整体感"是 Notebookcheck 的转述，主创原话是加颗粒和闪烁"to just sort of meld it all together"；微调定制模型出自 Google 博客，No Film School 写的是 video-to-video；ANCESTRA 的先图后视频流程确认无误，"200–1,000 次生成"出自 shots.net，数的是图 | 归属改正 |

另有几处小的改动：MAViS 的 34.00→13.67 在论文里没有量表也没有评分者，它的 Structure Reviewer 审的是场景和镜头如何切分排列；FilMaster 的 4.17→4.67 只是一个案例上的 LLM 打分；RAPO 的 248/246/256 是 EvalCrafter 总和分，79.75% 是 Open-Sora 改写器而不是 GPT-4（GPT-4 是 79.69%）；Video-T1 的增量是 +4.90 分；PRIS 的 15 分是"可控性与创造力"一类的均分；Adaptive Low-Pass Guidance 的 36% 和 33% 分别来自 v1 和 v2；36氪原文是"审美和镜头思维"，没有"剧本理解"；开源 skill 里独立审查设在四个节点，不是每一关。

## 同一个模型上，agent 层从减 0.6 分到加 0.6 分

有人评的同模型对照现在有三组。*The Script is All You Need* 在 50 条测试样本上给七个视频模型各做了"原始对白"对"agent 剧本加跨镜策略"，人评均分全部上升 0.4 到 0.6 分，其中 **Seedance1.5-Pro 从 3.4 升到 4.0**，角色一致性 3.2→4.1，物理规律 3.1→3.9【人评，0–5 分，评分人数未写】([arXiv 2601.17737](https://arxiv.org/html/2601.17737))。MovieAgent 在渲染器固定为 CogVideoX 时，多 agent 与内部 CoT 全开比全关高 0.27 分（3.55→3.82），动的是剧本忠实度（3.36→3.92）和叙事连贯（3.09→3.55），角色一致性、画面观感和物理规律几乎不动；单开 CoT 只值 0.06 分【人评，三部电影，评分人数未写】([arXiv 2503.07314](https://arxiv.org/html/2503.07314))。Co-Director 的 50 个广告场景里，它自己的流水线得 3.96，裸 Veo 3.1 得 3.71，而同样跑在 Veo 3.1 上的 MovieAgent 和 AniMaker 只有 **3.22 和 3.07**【人评，每条视频 5 人，1–5 分】([arXiv 2604.24842](https://arxiv.org/html/2604.24842))。

第三组是本次核实带来的新结论：agent 层可以输给裸模型。旁证有两处。StoryEngine 在 Veo 3.1 上比较四种方法，完全不调用语言模型的 Direct I2V 得 0.526，MovieAgent 得 0.539，相差 0.013；换到 Wan2.2，两套 agent 基线的跨镜锚点保持率还低于 Direct I2V 的 0.672【LLM评，60 个故事各 10 镜，裁判同时是该系统的内部评估器，无人评】([arXiv 2609.33627](https://arxiv.org/html/2609.33627))。MSVBench 给所有方法同一份脚本和参考图，Veo3.1（4.11）和 Sora2（4.06）的得分高于每一个 agent 框架，AniMaker 是 3.17【人评，10 名有动画背景的评分者】([arXiv 2602.23969](https://arxiv.org/html/2602.23969))。把输赢分开的不是有没有规划，而是 agent 构造了什么条件：参考图、携带到下一镜的帧、修复回路。

不同 agent 设计之间的差距可以比"有无 agent"更大。FilmWorld 把六套系统放在同一组模型上（Gemini 3.1 Pro、Nano Banana 2、Wan 2.7），得分从 **2.42 到 4.25**【人评，6 人评 90 部片，0–5 分】；这是小说改编任务，分数里有一大块是对长文本的忠实度，不能直接搬到一分钟的原创短片上 ([arXiv 2607.19038](https://arxiv.org/html/2607.19038))。

H3 和 Seedance 现在各有一篇论文作底座。CineEvolve 把自己和 STAGE、CineCrew、ViMax 都跑在 FLUX.2-klein-9B 加 **8 步蒸馏的 MiniMax-H3 Turbo** 上，与本项目同一条链路：跨镜一致性在三套基线上是 0.76 到 0.81，CineEvolve 是 0.89【LLM评】；25 个故事的七选一偏好里它拿到 52% 到 59%，ViMax 拿到 7% 到 10%【人评，20 名 AMT 评分者】。这篇论文的导演是微调过的 8B VLM，基线也被换成同一个 8B 模型来跑，而不是它们原本设计所用的大模型 ([arXiv 2610.29590](https://arxiv.org/html/2610.29590))。CineForge 把四套系统统一到 GLM 5.1 加 **Seedance 2.0**：MovieAgent 3.60，ViMax 3.74，AniMaker 3.84，CineForge 4.02，用以往制作演化出的策略再到 4.38【LLM评，0–5 分，45 个剧本；裁判与人的 Spearman 相关 0.710】([arXiv 2608.29621](https://arxiv.org/html/2608.29621))。两篇都没有"裸模型、不加 agent"的一臂，所以它们回答的是"在 H3 或 Seedance 上 agent 设计之间差多少"，没有回答"加 agent 比不加好多少"。

agent 层与模型换代谁更大，取决于量的是什么。StoryEngine 的指标只含叙事和连续性，没有画质项：换渲染器只挪 0.002 到 0.032，换方法最多挪 0.24。Co-Director 的人评含画质：三个裸模型之间差 0.23（3.48 到 3.71），好的 agent 层加 0.25。FilmWorld 的作者自己写道，镜头呈现这一组分数各方法相当一致，反映的是共用底座模型的主导作用。画面和运动的上限归模型，叙事、连续性和对要求的遵循归 agent 层。

换一个更强的 LLM 当导演，改变的主要是文本。ViMax 的规划模型对照里，Claude-Sonnet-4.6 的分镜文本在角色行为一致性、叙事连贯和描述可用性三项上最高【LLM评，裁判 GPT-5.4】，渲染出来的全局一致性却是四个模型里最低的（0.528，GPT-5.4 为 0.562）【自动，ViCLIP 相似度】；作者的话是"local storyboard quality alone does not guarantee stable cross-shot visual state"([arXiv 2606.07649](https://arxiv.org/html/2606.07649v2))。DirectorBench 固定即梦的 agent 工作流、轮换包括 Claude Opus 4.7 在内的六个 LLM，结论是画面、音频和稳定性维度对 LLM 的选择基本不敏感，换 LLM 的效应次于工作流设计【LLM评，只给了热力图，没有印出数值】([arXiv 2605.30090](https://arxiv.org/html/2605.30090))。SAGE 让 Claude Opus 4.6 从专业剧本写分镜，裸写 65.2 分，加上从导演分镜里学出的规则后 77.8 分，人类导演 77.1 分；这是纯文本，裁判也是 Claude Opus 4.6，没有渲染任何视频【LLM评，18 集】([arXiv 2608.17468](https://arxiv.org/html/2608.17468))。

这些数字要打折读。多数消融由 LLM 当裁判，常常就是流水线里那个模型家族。两种评分都有的地方，裁判偏高且与人的相关不强：*One Sentence, One Drama* 的 LLM 裁判比 20 名人类评分者平均高 0.38 分 ([arXiv 2605.22144](https://arxiv.org/html/2605.22144))，Co-Director 的 MLLM 裁判与人在画质一项上的 Pearson 相关只有 0.345，FilmWorld 的裁判与人在镜头呈现一组上是 0.330。一篇 2026 年 10 月的综述没有汇总任何消融表，它对世界模型 harness 这一层的评价是：多数机制只在单个系统里演示过，很少有研究报告了可单独归因于 harness 的增益 ([arXiv 2610.40191](https://arxiv.org/pdf/2610.40191))。

## 规划文本单独最弱，条件最强，格式这一项比上一版说的大

### "分镜大于措辞"的两条主证据不成立

上一版把增益归给分镜拆解，主要靠 ViMax 和 MAViS。ViMax 那张表给的是 GPT-5.4 对分镜文本的评分，视频合成是关着的，被去掉的是"把每一镜写具体"的能力，镜头数和顺序都保留；它测的是描述的具体程度，不是切分，也不是视频。MAViS 的数字没有量表和评分者。剩下的 Script 论文消融由三个 LLM 评分、没有人评，三步大小相当：把整份逐镜计划作为一条长 prompt 交给模型（+0.06–0.24），再按镜头切成多次生成（+0.06–0.24），再加帧锚定（+0.10–0.16）【LLM评，Wan2.6 和 HYVideo1.5】([arXiv 2601.17737](https://arxiv.org/html/2601.17737))。计划的内容与把它拆成几次生成，值得差不多。

在 Seedance 上有一项同模型的直接测试。PersonaShot 用同一个 Seedance 分别接受逐镜 prompt 和一条全局 prompt，总分是 0.793 对 0.766，15 个共同指标全部是逐镜更高，幅度 0.008 到 0.040；同一张表里模型之间的差距是 0.79 对 0.58–0.69【自动，蒸馏的专用评估模型；25 段序列上与 10 名专家核对，Krippendorff α 0.76】([arXiv 2608.16717](https://arxiv.org/html/2608.16717))。逐镜写确实更好，但在一个原生支持多镜头的模型上只值 0.03。

规划文本管的是事件有没有发生，管不了跨镜。StoryEngine 里两套 agent 基线把事件完成率从 Direct I2V 的 0.62 提到 0.88 到 0.91，锚点保持率却停在 0.43 到 0.55，StoryEngine 自己是 0.94。它的消融里，去掉故事状态规划只掉 0.014，去掉"有依据的渲染规划"（角色和场景的标准参考图加空间定位）掉 0.057，去掉连续性感知的生成掉 0.044【LLM评】([arXiv 2609.33627](https://arxiv.org/html/2609.33627))。VideoGen-of-Thought 的消融方向相同：只开 LLM 故事线，跨镜一致性指标（CS-FC）从 0.113 到 0.117，几乎不动；只开身份肖像是 0.329【自动，一个 30 镜的故事】([arXiv 2412.02259](https://arxiv.org/html/2412.02259))。VideoStudio 的人评排名里，加 LLM 脚本让逻辑连贯变好、内容一致性变差，直到加入参考图两项才一起到第一【人评，12 人，100 条 prompt，2024 年的旧模型】([arXiv 2401.01256](https://arxiv.org/html/2401.01256))。

### 决定每条生成以什么为条件，是分数挪得最多的一项

消融最完整的几篇论文里，作者各自点名的最重要组件都是这一类，没有一篇点名措辞或推理链。VideoStudio 系统内去掉参考图，场景一致性从 **77.3 掉到 40.9**【自动】。*One Sentence, One Drama* 去掉 3D 首帧合成，角色空间连续性 3.52→2.81，环境布局连续性 4.05→3.02，其余各列最多掉 0.15；去掉故事生成，四个叙事列各掉 0.73 到 0.80；去掉多阶段审查，每一列都掉 0.34 到 0.57【LLM评，50 条 prompt，连续性由前后各三帧静帧判断】。作者的总结是每个组件对应一种不同的故障 ([arXiv 2605.22144](https://arxiv.org/html/2605.22144))。FilmWorld 去掉显式世界状态，总分 90.15→84.28，角色一致性从 **82.12 塌到 54.50**【LLM评，三部小说】。Co-Director 去掉关键帧修订，素材保真度掉 9.8 分【LLM评，0–100】。*Lights, Camera, Consistency* 去掉种子帧、只用文生视频，角色一致性从 7.99 掉到 0.55【LLM评，四个角色】([arXiv 2512.16954](https://arxiv.org/html/2512.16954))。MSAVBench 上同一个 LTX-2.3，每镜先合成关键帧再生成，跨镜布局从 0.439 到 0.670，视觉一致性从 0.596 到 0.762，总分从 64.40 到 72.63【基准自带的综合分】([arXiv 2605.20183](https://arxiv.org/html/2605.20183))。

条件也有代价和上限。把上一镜的尾帧直接当下一镜的首帧，保住了局部外观，却限制了视角变化（*One Sentence, One Drama* 作者语）。ViMax 的局限一节写道，视频模型并不总是尊重关键帧的语义，例子是站在跑步机上的角色被生成为跑下跑步机 ([arXiv 2606.07649](https://arxiv.org/html/2606.07649v2))。StoryEngine 里不可逆的状态推进这一项，所有方法都低于 0.67。

### prompt 格式是独立的一项，而且不小

CAPE-T2V 在 StoryEval 的 423 条多事件 prompt 上固定 Wan2.2 的权重，只换提示词增强器：不加是 **45.9%**，Wan 官方增强器 47.5%，caption 锚定的增强器 **64.6%**；LTX-2.3 上不加是 29.1%，官方增强器 53.7%【LLM评，GPT-5.5 三次一致投票，每条 prompt 9 条视频】。格式对齐以后，剩下的措辞差异（作者称 PE-Caption gap）只值 0.3 到 1.6 分，而且要微调模型本身才拿得到 ([arXiv 2608.03046](https://arxiv.org/html/2608.03046))。这同时说明两件事：格式这一项可以很大；它有多大取决于增强器，同一个模型上官方的那个只值 1.6 分。

WanPE 给出了人评的版本，并且第一次量到了"已经写得很细的 prompt 还能不能涨"。60 名影视专业评审做了约 1.1 万次盲评成对比较，改写后的偏好分在 5 到 15 秒片段上高 10.66 到 18.84 分，30 秒片段上高 50.86 分；这个分数是竞技场里的相对胜率，不是绝对质量。按请求的详细程度分，本来就按镜头写好景别、运镜、动作和对白的请求仍然涨 **13.45 分**，一句话意图涨 18.55 分。一个强的通用 LLM 加上 8 名专家改了 27 版的写作指令，拿到训练过的增强器约六成的增益（39.49 对 49.86，基线 23.05）。在 H3 上，同一篇论文把 MiniMax 自己的增强器 H3-Context-IR 与 WanPE 的输出（转成 H3 格式）放在 MiniMax-H3-Base 上比，是 35.92 对 41.09【人评；作者是 Wan 团队，MiniMax 的竞争方，分表样本量未给】([arXiv 2609.30221](https://arxiv.org/html/2609.30221))。这是目前唯一显示 prompt 内容在 H3-Base 上有影响的第三方数字。

"像训练时的 caption"比"写得多"重要，这一点没有变。RAPO 在两个 2023–2024 年的模型上，GPT-4 随意改写让 LaVie 的 VBench 总分从 80.89% 掉到 79.69%，贴近训练分布的改写到 82.38%【自动，单次运行】([arXiv 2504.11739](https://arxiv.org/html/2504.11739))。

看过结果再改 prompt，比多抽几次强。PRIS 在已经做过标准扩写的 prompt 上比较：Wan2.1-14B 的"可控性与创造力"均分 53.66，10 选 1 到 58.51，看结果修订 prompt 到 68.85；它的文生图实验里，固定 prompt 加采样预算，在用来选片的指标上还在慢慢涨，在没参与选片的遵循度指标上停在 0.68 不动【自动，VBench-2.0 与文生图奖励指标】([arXiv 2512.03534](https://arxiv.org/html/2512.03534))。VQQA 在 CogVideoX-5B 上，一次性改写（+6.66）与 5 选 1（+6.81）相当，提问再修订的回路 +11.57【自动，T2V-CompBench】([arXiv 2603.12310](https://arxiv.org/html/2603.12310))。只做 seed 选择的 Video-T1 把 Pyramid-Flow 的 VBench 总分从 81.61 提到 86.51，论文自己写明到一定阈值后收敛【自动】([arXiv 2503.18942](https://arxiv.org/html/2503.18942))。候选更多不一定更好：ViMax 的关键帧 3 选 1、4 选 1 的一致性低于 2 选 1。

不随 prompt 变的东西还有，但比上一版说的窄。VQQA 的表里，运动方向绑定这一列在所有方法下都是 26.1 到 28.6。SeqBench 上 Kling 2.0 的多主体多动作是 0.19 到 0.26，不过它在单主体单动作上也只有 0.291，这个指标本身就严【自动，2025 年的模型】([arXiv 2510.13042](https://arxiv.org/html/2510.13042))。片内属性变化在 T2V-CompBench 上最好的模型低于 0.07【自动，2024 年的模型】([arXiv 2407.14505](https://arxiv.org/html/2407.14505))，在 VBench-2.0 上 PRIS 却把它从 48.89 修到 73.33：它在哪个基准上都是最难的一类，绝对值跟着指标走。

图生视频里，文字管的是动多少。同一组 prompt 在 Wan 2.1 上文生视频的 Dynamic Degree 是 39.4，图生视频是 32.1；在 Wan 2.2 图生视频上把 prompt 改写成强调运动，从 31.7 升到 38.6，与采样侧的修正（39.0）相当，两者叠加到 43.5【自动】([arXiv 2506.08456](https://arxiv.org/html/2506.08456))。在图像保真类指标上，改 prompt 和选 seed 都只值约 1 分（VBench-I2V 上 96.62 到 97.5–97.9），因为图已经把它们定住了【自动，CogVideoX-5B-I2V】([arXiv 2603.12310](https://arxiv.org/html/2603.12310))。

### 本项目的记录指向同一处，样本很小

Kinora Studio 里 agent 不直接写 H3 的 prompt，它填结构化字段，由确定性编译器序列化（`agent/director.md:94`、`src/studio/compiler.ts`）。对一条真实 take 的编译结果按来源手工切分：模板和字段名 16.8%，枚举键展开的目录短语 14.3%，项目级 Look 与调色 19.0%，元素固定特征 17.3%，agent 为这一镜写的自由文本 **32.7%**（`get_take(tke_neupodk9lgw1)`）【内部，n=1】。两个项目记下的八条"故障到修复"链里，六条的原因或修复落在图、帧或生成模式上（新画的尾帧、用首帧替换参考图、Viggle Remake），两条落在时间分配上，一条是 prompt 与首尾帧自相矛盾；对身份漂移试过改词的那一次，记录写的是"Prompt wording did not fix it"，最后靠修正了眼睛的关键帧加 Remake 修好（`get_retro(prj_pxz50vl9ahuw)`、`get_retro(prj_dv8phoozmfds)`）【内部，审查基于抽帧】。唯一一次由独立 agent 做的故事审查在没花 GPU 的情况下否决了第一版剧本，四条阻断全在规划层（`rev_aol6oh8vmcze`）。这些是个案，不是比率：约 79 条完成的 take 里 68 条没有任何审查。

### 重新推出的答案

把三类证据放在一起，各项管的是不同的故障，不在一条刻度上。条件（参考图、首尾帧、状态）管身份、布局和跨镜连续性，而连续性正是人评里当前长视频最弱的一项。规划管事件有没有发生、顺序对不对、是否忠于剧本。格式管单条生成内部对要求的遵循。措辞在格式对齐之后是最小的余项。上一版的"分镜大于措辞"应改成：**条件大于规划文本和格式，后两者量级相当，格式对齐后的词句最小**。这个排序是跨论文的推断，各项的量表、裁判和模型都不同。

模型原生多镜头与 agent 逐镜生成，没有同模型的对比。能说的只有：MSAVBench 的 19 个系统里 Seedance-2.0 的原生生成排第一（75.92），开源的 LTX-2.3 靠每镜先出关键帧追到 72.63；Co-Director 的人评里一条 prompt 的 Kling 3.0 Omni 和 Veo 3.1 得 3.59 和 3.71，设计得好的 agent 在 Veo 3.1 上 3.96；ViMax 对原生多镜头模型 HoloCine 的人评胜率是 60.48%。ViMax 的作者自己预计，未来的 harness 会转向跨场景的长程视觉记忆，而不是重做更强的模型原生就有的能力。

## H3 与 Seedance 的官方写法四处相反，prompt 的形式要按模型编译

各家官方指南共同的规则只有三条：写看得见的身体动作而不是情绪词；一镜一个运镜任务、一个主要动作；给每个参考素材写明用途。上一版说"六家指南在这一点上一致"，对"每条生成少要一点"成立，不能延伸到否定句、时间写法、是否复述首帧和篇幅。

| 项目 | MiniMax H3（官方指南，适用于权重） | Seedance 2.0 | Seedance 2.5 |
|---|---|---|---|
| 否定与约束 | MiniMax 自己的材料没有负向提示词参数，也没有相关说法；ComfyUI 的开放权重指南写"Ban lists add unwanted concepts"，要求只写应出现的东西 | "约束词十分重要"，模板如"不要生成Logo"；同时承认做不到 100% | 有"负向控制"一节（"不要字幕""无 bgm"）；官方对眼睛发光的修法是写"人物眼睛不发光"；仍有概率失效，建议在开头和结尾各写一遍 |
| 时间 | 只在切镜处写时间码（`[Shot 2] At 00:03.500, the camera cuts to...`），第一镜不带时间；镜内用散文写先后 | 只响应镜头序号；"模型对精确时间（如 0–3 秒）的支持不稳定" | 响应整数秒时间戳，区间、时间点、相对时间都可；一段时间里内容过多会"过度剪切或剧情遗漏" |
| 图生视频是否描述图 | 单首帧：先交代图里的风格、主体、构图和场景锚点，再写动作；首尾帧：不重复两张图，只写连接它们的运动路径 | 空间关系优先用参考图表达，减少文字 | 参考素材够精准时"只做指代、减少画面复述" |
| 参考上限 | 图 9、视频 3、音频 3，文件总数不超过 12；首尾帧模式与参考模式是两个检查点，不能混用 | 共 15（图 9、视频 3、音频 3），建议只用 4 到 5 个；不建议人物多视图 | 共 50（图 30、视频 10、音频 10）；1 到 5 个主体效果较好；支持多视图 |
| 原生多镜头 | 训练任务里有原生多镜头；官方示例是 5 到 10 秒里 1 到 3 镜；首尾帧模式倾向单镜头 | 用"镜头1、镜头2"组织；打斗、追逐、蒙太奇建议分段生成再剪 | 官方示例 13 秒 8 镜；分镜宫格建议 15 格以内 |
| 篇幅 | "as detailed and explicit as possible"；参考模式的详述字段通常 350 到 500 个英文词 | "描述尽量简洁，避免冗余"；不要把整份剧本当 prompt | 结构化四段：素材指代、一句话概述、逐段剧情、收尾 |
| 时长 | 4 到 15 秒 | 最长 15 秒 | 4 到 30 秒 |

出处：H3 的两份提示词指南和模型卡 ([base guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md); [ref guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md); [model card](https://huggingface.co/MiniMaxAI/MiniMax-H3))，MiniMax 的发布文章 ([MiniMax blog](https://www.minimax.io/blog/minimax-h3))，ComfyUI 的 H3 指南 ([ComfyUI](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide))，火山方舟的两份指南和 2.5 教程 ([Seedance 2.0](https://docs.volcengine.com/docs/ark/seedance-2-0-prompt-guide); [Seedance 2.5](https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5-prompt-guide); [Seedance 2.5 教程](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh))，全部为【厂商】。相邻两个版本之间就有两条规则翻转（时间戳、多视图），不同模型之间有四条。这是把 prompt 的形式交给每个模型一份的编译器、而不是交给 agent 文风的最直接理由。同一类故障在两个模型上的官方修法也相反：眼睛画错，Seedance 2.5 的指南让你写一句否定；在 H3 开放权重上，本项目的规则是禁令会被画成它禁止的东西（`AGENTS.md`），内部那条眼睛漂移的 take 的 prompt 里恰好有三处针对眼睛的否定写法，记录没有检验它们是不是原因。

### H3 的建议要分托管版和自托管权重

MiniMax 把系统分成三块：把用户输入转成模型读得懂的中间表示的 H3-Context-IR，生成 768p 音视频的 H3-Base，以及只在托管端提供的 2K 重生成。模型卡的原话是 H3-Context-IR"is critical to the quality of the final output"，并建议要么接入它，要么"following the 'Prompting Guidance' to build your own context-processing system"；它依赖多个托管模型，不在开源发布里 ([model card](https://huggingface.co/MiniMaxAI/MiniMax-H3))。官方示例里，一条 32 个词的请求被增强器写成两镜头的长 prompt，可复现的 8 秒首帧示例有 4,534 个字符。

只属于托管产品的：H3-Context-IR、`prompt_expansion_mode` 开关（文档里只有 `MiniMax-H3-Max` 可以关）、2K、7,000 字符上限、Highspeed/Lite/Max 变体 ([MiniMax API](https://platform.minimax.io/docs/api-reference/video-generation-v2-create))。本次找到的所有实测帖也都跑在托管版上，增强器开着，所以它们测的是增强器加模型。一位测试者看到增强器把"slow dolly-in"写成小幅慢速推近，把三段连续运镜拆成三个镜头并在 1.58 和 3.67 秒硬切，把排在 3.5 秒的台词说在了 5.8 到 6.4 秒【个例，H3 Max】([Fuser](https://fuser.studio/articles/minimax-h3-prompt-guide))。另一位做了同 seed 的成对测试，结论是结构"buys control rather than quality"，方括号里的定时节拍"works"，加不加否定清单被禁的东西都没有出现，一句"The frame never moves"换来了完全固定的画面【个例，两对】([PixelDojo](https://pixeldojo.ai/guides/minimax-h3-prompting-guide))。后两点与开放权重的规则相左，原因在于托管路径上模型看到的是增强器重写过的文本。

适用于本项目自托管权重的：两份指南里的 caption 格式、运镜词表（类型加幅度加速度，写成句子里的动作）、说话人与 `<d>` 对白语法、指令行、4 到 15 秒和短边 768。链路上只有一个文本输入，没有负向输入（`docs/handoff/HANDOFF.md:26-27`）；官方检查点是 CFG 蒸馏的，所以没有负向分支是 20 步基座和 8 步 turbo 共有的属性。MiniMax 的本地部署指南对 turbo 的说法是：FL2VA 工作流默认 20 步，可选的 8 步 Turbo LoRA 更快，"can reduce motion and audio quality"，参考模式的 4 步 LoRA 另算；ComfyUI 模板用的是剪枝和量化过的文件，与官方检查点不是同一个制品 ([MiniMax 部署指南](https://platform.minimax.io/docs/guides/local-deploy-h3))。lightx2v 的仓库没有发布 turbo 与基座在任何指标上的对比，也没有说明蒸馏用的 caption ([ModelTC/Minimax-H3-Turbo](https://github.com/ModelTC/Minimax-H3-Turbo))。

少步蒸馏是否削弱文本遵循，H3 上没有测量。Wan2.1 上有：4 步、无 CFG 的学生模型与教师在 VBench Semantic 上相差 −3.3 到 +2.0 分，取决于蒸馏方法和给教师打分时用的 prompt 扩写；同一个教师的两种蒸馏之间差 11.5 分【自动】([arXiv 2601.09881](https://arxiv.org/html/2601.09881); [arXiv 2506.08009](https://arxiv.org/html/2506.08009))。这个指标不测定时节拍、切镜、运镜幅度和对白，而这些正是本项目的 prompt 在要的东西。

### 编译器与官方格式有五处不同，都没测过

自托管没有增强器，官方指南就是编译器要满足的规格。读 `src/studio/compiler.ts:735-790`，它与官方 H3 格式有五处不同。

| 项 | 官方 H3 格式 | 编译器现在的输出 |
|---|---|---|
| 指令行位置 | 整个 prompt 的第一行，空一行后才是三个字段 | 写在 `integrated_multimodal_description:` 字段里面（lightx2v 的 ComfyUI 说明也是这样放） |
| 首尾帧的指令句 | 固定句式"How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark ...; Picture 2 (from Shot N) aligns with the S.SS-second mark ..." | 单首帧的句子后面加", and the target video ends on <Picture 2>" |
| 文生视频 | 没有指令行，直接从三个字段开始 | 输出"For the target video, N shot(s)..." |
| 镜内节拍 | 只有切镜处的时间码；镜内用"Early in the clip""As the clip progresses"这类散文 | 数字区间，如"0–2.5s: ..." |
| 运镜 | 写成句子里的自然动作，不要作为单独的标签堆在句尾 | 标签式的 `Camera: ...` |

这是一处没有测量过的差异，不是已确认的缺陷。项目把"节拍是一条 prompt 里带时间戳的行"记为自己的工作规则（`AGENTS.md`），lightx2v 的三行提示也只覆盖字段名、对白写法和指令句。镜内数字区间目前的证据都指向一个方向但都很薄：官方格式没有它，ComfyUI 的指南明说用单个时间点而不用区间、对白要系在可见事件上而不是时间码上，托管版有一例台词晚了 2.3 秒，本项目有一条 take 把要求在 0 到 2.5 秒完成的滑动在约 0.5 秒内做完（`tke_ehziu951bori`）【内部，单例】。没有人发表过 H3-Base 上"合规 prompt 对不合规 prompt"的对照，所以这五处是在加任何措辞规则之前最值得先做的 A/B：同一镜、同一组 seed、合规格式对现行格式，并且要在项目实际跑的 8 步 turbo 上做。单首帧模式是否复述首帧可以一起测：官方指南要求复述，项目指南写的是不要描述首帧已有的东西（`agent/director.md:108`），而编译器里已经有一个默认关闭的 `restateFrame` 开关。镜头长度与质量的关系在本项目里同样未测，现行的短镜头默认值出自成本，不能当作发现引用；OpenAI 的 Sora 2 指南说较短的片段更听指令、建议用两段 4 秒代替一段 8 秒，那是另一个模型的厂商说法，不是 H3 的测量 ([OpenAI](https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide))。

## 电影级成片的七件事，前两件在视频模型之外

下表按证据的一致程度排序。它是综合三份核实笔记和内部证据后的推断，各行证据类型不同，不是测出来的权重。

| 序 | 要点 | agent 在这里做什么 | 依据与测量类型 |
|---|---|---|---|
| 1 | 故事和可信的人物 | 定结构和每个转折的因果；把模型演不好的戏留在故事之外；让没看过的读者在渲染前审 | 影评、主创与平台方说法、DataEye 市场数据、公开评审标准；一致，无测量 |
| 2 | 先图后视频，状态写进数据 | 在图像阶段锁定 look、角色、场景和每镜首尾帧；每镜重挂同一组参考；实体状态存成可寻址的记录 | 多篇消融【LLM评为主】、主创自述、厂商指南、内部故障链；最强的一组 |
| 3 | 每条生成只要一件事 | 一个主要动作、一个运镜；多事件拆镜；不要求模型做不稳的内容 | 各家指南一致【厂商】；限制有测量，拆到多短没有 |
| 4 | 按模型编译的 prompt | 输出该模型官方的 caption 格式；H3 与 Seedance 分开处理否定、时间和首帧描述 | CAPE-T2V【LLM评】、WanPE【人评】、官方指南；H3 上只有一个竞争方数字 |
| 5 | 多 take、看结果修订、看得见运动的选片 | 留重抽预算；偶发故障重抽，每条都犯的故障改 prompt 或改输入；运动和声音交给人 | PRIS、VQQA【自动】、幕后比例【主创/媒体】 |
| 6 | 花钱之前的独立审查 | 另开只读的审查者看 prompt、首尾帧和分镜；报告里写明查不了什么 | 消融里是稳定的小增益【LLM评】、开源 skill【个例】、内部一例 |
| 7 | 剪辑、统一的收尾和声音 | 取舍与重定时；统一调色；声音和配音按人听过的为准 | 主创自述；声音没有任何测量 |

故事排第一，但依据要说准。Hell Grind 是数字公开得最全的一部：前 25 分钟用了 **16,181 次视频生成换 253 个成片镜头**，每条 prompt 生成约 15 秒，片方称成本约 50 万美元，其中 40 万是算力【厂商数据，经媒体】([Creative Bloq](https://www.creativebloq.com/ai/the-future-is-one-person-making-a-whole-film-says-director-of-first-ai-movie-at-cannes))；制作用的是 Seedance 2.0 加片方自己的模型 ([Love Horror](https://lovehorror.co.uk/horror-news/97653/hell-grind-unveils-first-fully-ai-generated-fantasy-trailer/))。两篇看过全片的评论并不一致：Variety 说情节"nonsensical"、人物"shockingly real and consistent"，TechRadar 说"The story mostly held together"、但"at no point did any of it look real"。两人一致的是人：Variety 写两方角色都不会表达情绪，TechRadar 写 AI 仍做不好"believable people"、对白像聊天机器人在写电影台词；片方 CEO 自己转述的反馈是缺专业配音【媒体】([Variety](https://variety.com/2026/film/features/i-saw-hell-grind-ai-generated-film-cannes-shocking-realistic-1236770720/); [TechRadar](https://www.techradar.com/ai-platforms-assistants/i-watched-a-90-minute-ai-movie-made-in-just-two-weeks-and-hollywood-can-stop-worrying-for-now))。市场一侧，DataEye 统计 2026 年上半年新上线的 AI 剧与漫剧 22.19 万部，播放破亿的 1,055 部，破亿率 0.47%【媒体转引的行业数据，口径在全网与抖音端之间不一致】([界面新闻](https://www.jiemian.com/article/14777777.html))。昆仑万维 CEO 方汉的说法是 AI 生成剧本的爆款率仍然相对较低，同一模型下不同创作者的成品差别很大 ([澎湃](https://thepaper.cn/newsDetail_forward_34451159))；杭州一家制作公司的负责人说选剧本是所有环节里的重中之重，"故事好不好，AI判断不了"【媒体】([杭州网](https://ori.hangzhou.com.cn/ornews/content/2026-10/19/content_9345947.htm))。唯一公开的评审量表（Chroma Awards 第一季）五项等权，叙事、制作水准、音乐与声音各占一项，并写明"judged as a film ... not as a piece of AI"([Chroma Awards](https://chromaawards.devpost.com/rules))。没有人发表过 LLM 写的剧本与人写的剧本的对照测试。

先图后视频是说明过自己流程的制作的共同做法，口碑最好的两部走得更远，用控制输入替代文字。ANCESTRA 让 Gemini 把旧照片描述成 prompt，用 Imagen 定概念图，再由 Veo 把选中的图动起来；穿越身体的运镜来自 3D 模型里录的草稿镜头，因为"it would have been difficult to control motion using text prompts alone"【主创/厂商】([Google blog](https://blog.google/technology/google-deepmind/ancestra-behind-the-scenes/))。*Dear Upstairs Neighbors* 的导演说"we didn't rely on text prompting"，用 video-to-video 控制表演和节奏，每天开样片会，有问题的镜头由画师改画 ([No Film School](https://nofilmschool.com/dear-upstairs-neighbors-hybrid-ai-short-film))；Google 的文章补充说团队在美术设定上微调了定制的 Veo 和 Imagen，而只用文字驱动微调后的模型，运动是"random, uncontrolled, and often bizarre"【主创】([Google blog](https://blog.google/innovation-and-ai/models-and-research/google-deepmind/dear-upstairs-neighbors/))。新华网描述的漫剧链条是剧本、AI 生图、AI 抽卡、剪辑、审核，生成的图是喂给抽卡的"种子"([新华网](https://www.news.cn/politics/20260429/b541e4e3478c4a43916c4777eb9b8b80/c.html))。反例有一个：42 工作室说换用 Seedance 2.0 后素材可直接文生视频，省去了配图环节【媒体】([搜狐](https://www.sohu.com/a/1030284284_114986))。

抽卡比例有三种口径，不能混用。含探索的全片比例：Hell Grind 按片方数字算是每个成片镜头 64 条生成；Air Head 的后期负责人说一分半的成片用了"hundreds of generations"，凭记忆估素材与成片约 300:1，并自己说了算术不好【主创】([fxguide](https://www.fxguide.com/fxfeatured/actually-using-sora/))。素材锁定后的单镜抽卡数：一个精品短剧团队报"抽卡率"约 20%，即平均 5 次得到一个满意画面 ([搜狐](https://www.sohu.com/a/1030284284_114986))；杭州那家公司说标准化工作流加预先备好的人物、场景、道具，把单镜从"十几次"降到"两三次"，同一位负责人也说校对和修图的工作量反而加重了【媒体，一家公司的说法，无数据】。厂商经验值：海螺的知识库说复杂的轨迹匹配常要重抽两三次，并自称是内部经验而非对照研究 ([Hailuo](https://hailuoai.video/knowledge/trajectory-matching-seamless-ai-video-cuts))。本项目五个有多条 take 的项目里，82 条 take 中 51 条（62%）是某一镜的第二条或更后的 take，其中一部分是有意的备选；单条 take 约 0.05 到 0.23 美元、2.5 到 9.5 分钟 GPU 时间，稀缺的是时间和注意力，而文字阶段的修改这两样都不花【内部】。

连续性要由管线自己的数据承载。DirectorBench 的 14 名人类评分者把跨镜连续性、段落连贯和多模态一致列为当前长视频最弱的方面，prompt 遵循和局部画质反而较好；它的自动评估器给转场质量 0.256、用户需求满足 0.71【前者人评未印数值，后者 LLM评】([arXiv 2605.30090](https://arxiv.org/html/2605.30090))。PersonaShot 里 Seedance 最低的四列是面部动作时间连贯（0.562）、情绪弧线连贯（0.617）等，画面保真是最高的 0.981 ([arXiv 2608.16717](https://arxiv.org/html/2608.16717))。论文里印出的失败案例分成两类：规划侧的是遗漏和顺序（缺一个过渡、动作先于前提发生、状态被重置），agent 可以靠结构减少；模型侧的是小尺度身份、多接触的互动、物理、口型，以及视频模型不照关键帧来，agent 对这一类只能选择不要求。海螺知识库的做法是先生成包含所有角色和环境地标的最宽全景当"spatial source of truth"，每一镜都用同一张主图作输入；末帧接首帧被用来把一个复杂运镜拆成几段【厂商，三篇文章均写于 H3 发布之前，自称内部经验】([正反打](https://hailuoai.video/knowledge/director-guide-shot-reverse-shot-spatial-logic); [轨迹匹配](https://hailuoai.video/knowledge/trajectory-matching-seamless-ai-video-cuts); [多轴运镜](https://hailuoai.video/pages/knowledge/ai-video-multi-axis-camera-control))。本项目的规则更直接：只写在散文里的计划不会被遵守，新的规划规则要进 treatment、声音表或时间线（`AGENTS.md`）。

收尾和声音的依据是主创自述。Air Head 全片经过调色、稳定和放大，很多片段被放慢到 50% 到 75%，最后加颗粒和闪烁把镜头"meld it all together"([fxguide](https://www.fxguide.com/fxfeatured/actually-using-sora/))。统一的收尾取决于 look：一套做扁平二维动画的开源工作流明确不加颗粒 ([xdlkc/ai-video-production](https://github.com/xdlkc/ai-video-production/blob/main/SKILL.md))。*Dear Upstairs Neighbors* 的导演说声音设计"is what powers the entire narrative"([No Film School](https://nofilmschool.com/dear-upstairs-neighbors-hybrid-ai-short-film))；被称赞的几部片里，作曲、声音设计和配音是最常保留给人的部分。没有任何观众测试或有无声音设计的对照。H3 的模型卡称对包括中文在内的 11 种语言的对白有稳定支持【厂商】，本项目里自托管模型的普通话准确度和口型同步仍未测量（`agent/director.md:95`）。

审查是稳定的二阶修正，薄弱处在审查者看得见什么。消融里去掉审查的损失均匀而不大（*One Sentence, One Drama* 每列 0.34 到 0.57），FilmWorld 的作者称验证器是"residual defect corrector"；FilmAgent 的多 agent 版本比单 agent 版本高 0.94 分（3.98 对 3.04），它渲染用的是 Unity，变的只有规划【人评，15 个故事】([arXiv 2501.12909](https://arxiv.org/html/2501.12909))。审查者自己有偏：MAViS 的审查让图生视频阶段的 Dynamic Degree 从 44.58 降到 35.62，作者解释是高动态的视频更容易出物理错误，审查 agent 因此偏向低动态的结果【自动】([arXiv 2508.08487](https://arxiv.org/html/2508.08487))；Co-Director 的作者指出 MLLM 逐帧分析，会严罚人在连续播放时不觉得碍眼的瞬时瑕疵。通用 VLM 认运镜最弱：2025 年的 ShotBench 上 24 个模型里 15 个在运镜识别上不超过 40%，没有测 Claude，对当前模型多半已过时 ([arXiv 2506.21356](https://arxiv.org/html/2506.21356))。没有论文比较过看得见运动的审查者与只看帧的审查者。本项目的 agent 只看静帧、听不到声音（`agent/director.md:29`）。一位用 Claude Code 或 Codex 当导演、Seedance 出片的创作者把分工写成"我：选方向、确认画风、批准花钱、看动态、听声音"；由它衍生的开源 skill 把独立只读的审查者放在故事定稿后、首尾帧方案落图前、每次提交视频前和成片后四处，理由是改几个字不要钱、重画一张图基本不要钱、重新生成视频按秒付费，并要求审查报告写明"查不了的东西"，即动态手感和声音【个例，无成片数据和抽卡率】([xdlkc/ai-video-production](https://github.com/xdlkc/ai-video-production))。

agent 自己也会把噪声写成规则。本项目的决策日志里，一次重排分镜的依据是"H3 在约 5 秒内把一个动作保持得好，超过 10 秒每秒成本翻四倍"；提交 `859b081` 把两半都撤回了：四倍来自两次估算之间 GPU 均值的漂移，5 秒的说法没有 take 数据支持。

## 结论

核实改变的不是"措辞最小"这一点，而是它上面的结构。上一版把问题读成规划对写作，答案是规划；一手来源显示规划文本和写作格式是两个量级相当的中间项，真正拉开差距的是它们之外的一项：agent 是否亲手决定每条生成看到哪些图、继承哪些状态。一个写得出最好分镜文本的 LLM，画面一致性可以是最差的；一套旧设计的 agent 可以输给裸模型。对用 Claude 驱动 H3 或 Seedance 的人，这意味着判断力应花在首尾帧、参考位和状态记录上，花在看过一条失败的 take 之后改哪个输入上，而 prompt 的形式应一次按官方格式做对。两个模型的侧重也不同：Seedance 原生多镜头强、参考位多，按 PersonaShot 的结果逐镜拆分只值很小的一份，官方还鼓励用约束词；自托管的 H3 少了厂商称为"对最终质量至关重要"的增强器，格式是否合规在这条链路上的分量因此更重。

对本项目，最便宜也最先该做的测量从"更多 prompt 规则"换成了三个对照：编译器现行格式对 MiniMax 官方格式（五处差异加 `restateFrame`），8 步 turbo 对 20 步基座在定时节拍、切镜和对白上的遵循度，以及上一版已列出的镜头长度 A/B（12 秒对 6+6 `continuous`）。再加上独立镜头审查的拦截率和让看得见运动的人参与选片后的重抽率，这五个数字出来之前，本报告的排序足以决定精力往哪里放，不足以写成定量结论。
