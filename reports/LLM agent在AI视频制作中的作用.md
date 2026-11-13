# 分镜与锚定图定成片，措辞居次

视频模型固定时，LLM agent 的 prompt 工作有用，但作用有上限，而且主要不在措辞上。把各系统的消融实验放在一起看，削弱 agent 的规划层会让同一个视频模型的评分在 5 分制上掉 **0.2 到 0.8 分**；掉得最多的是分镜拆解和视觉锚定（参考图、首尾帧），只改单镜描述写法的那一份在同一篇论文里最小。单个 shot 的 prompt 有一条不能低于的底线：符合模型训练时的 caption 格式，用可见的动作和幅度写清谁在什么时间做什么。过了这条线，没有任何测量显示继续打磨词句还有收益。本项目的内部记录方向一致：H3 的 prompt 由确定性编译器生成，agent 为每一镜写的自由文本约占三分之一，记录下来的八条"故障→修复"链里没有一条身份或道具故障是靠改词修好的。想做出电影级成片，按证据强弱排，顺序是：故事、先图后视频、每条生成只要一件事、合乎格式的 prompt、多 take 加看得到运动的选片、写进数据结构的连续性、剪辑与收尾。这个排序是从来源各异的证据推出来的，不是测出来的：没有任何研究在同一个实验里同时变动 prompt、首帧、seed 和分镜方案，也没有第三方在 MiniMax H3 或 Seedance 上做过对照。

**证据边界。** 本报告综合四份笔记。三份外部调研笔记（论文、单镜 prompt、行业实践）只基于搜索结果摘要：本次会话无法抓取网页（arxiv.org 等均被拦截），没有一篇论文或幕后文章被完整读过。下文数字沿用笔记原有的可信度标注：【论文】指搜索摘要引到了论文或官方页面的原文，【二手】指只有第三方摘要给出该数字，【存疑】指数字对应的行列或量表不明，【厂商】【媒体】【个例】分别指厂商说法、媒体报道和个人实测。带【二手】【存疑】的数字，引用前要对照原表。第四份是本项目的内部证据，标【实测】【默认】【断言】；它的样本很小（全部记录里只有 11 条 take 带审查，故障标签只出现在两个项目，git 历史是 2026-11-09 至 11-13 的浅克隆），用到时会再写明。

## 同一个模型上，agent 层挪动 0.2–0.8 分，模型换代挪得更多

先看量级。"同一个视频模型，有无 agent"的实验里，差别看得见，但不大。*The Script is All You Need* 把同一批视频模型分别喂原始对白和 agent 写的剧本：Wan2.6 的 Script Faithfulness 从 **3.2 升到 4.0**【论文】，Sora2-Pro 从 3.6 升到 4.2【二手】([arXiv 2601.17737](https://arxiv.org/html/2601.17737v2))。ViMax 把分镜 agent 换成按剧本机械切分，六项平均分从 **4.107 掉到 3.658**【论文】([arXiv 2606.07649](https://arxiv.org/html/2606.07649))。MovieAgent 在渲染固定、LLM 为 GPT-4o 时，从"无 CoT、无多 agent"到两者都开，人评平均分从 3.55 升到 3.82【论文，行与开关的对应需核对原表】；同一方法换不同的 LLM，平均分在 3.44 到 3.82 之间 ([arXiv 2503.07314](https://arxiv.org/pdf/2503.07314))。用哪个 LLM 当导演，和流水线怎么搭，影响在同一个量级。

单看 prompt 改写这一层，量级相近。WanPE 用约 1.1 万次盲评成对比较发现，把用户的原始短 prompt 改写成模型训练时的 caption 风格，5–15 秒片段的人类偏好分提高约 **10.7–18.8 分**，30 秒片段提高约 50.9 分【论文】([arXiv 2609.30221](https://arxiv.org/abs/2609.30221))。注意对照组是"裸的用户输入"；从一份已经写得密的 prompt 再往上改，没有论文测过。

模型换代的差距更大。Co-Director 的人评（50 个广告场景、5 名评分者、1–5 分）里，它自己的 agent 流水线得 3.96，不加任何 agent 的 Veo 3.1 得 3.71，搭在旧渲染器上的 MovieAgent 和 AniMaker 只有 3.22 和 3.07 ([arXiv 2604.24842](https://arxiv.org/html/2604.24842))。这不是干净的对照，但比例说明问题：好的 agent 层在同代模型上加了约 0.25 分，旧模型加 agent 却比新模型不加 agent 低 0.5 到 0.65 分。中文媒体关于 Seedance 2.0 把可用率"从约 20% 提到 90% 以上"的说法没有样本量【媒体，未核实】，它归因的也是模型换代，不是 prompt ([虎嗅](https://www.huxiu.com/article/4833593.html))。

规划再对，也只能兑现模型做得出的部分。2023 年的 LVD 里，GPT-4 的布局规划 98% 正确，渲染出的视频对齐率只有 49.4%【论文，模型已旧】([arXiv 2309.17444](https://arxiv.org/html/2309.17444v3))。StoryEval 用 423 条各含 2–4 个连续事件的 prompt 测了 11 个模型，没有一个的平均完成率超过 **50%**；2026 年的一篇论文报告 Wan2.2 为 45.9%【论文】([arXiv 2412.16211](https://arxiv.org/pdf/2412.16211); [arXiv 2608.03046](https://arxiv.org/pdf/2608.03046))。

这些数字要打折读。几乎全部是系统作者自报，样本小，没有独立复现，很多还由 LLM 打分：FilMaster 的 FilmEval 裁判与人类评分的平均相关是 0.6230【论文】([arXiv 2506.18899](https://arxiv.org/pdf/2506.18899))。LLM 裁判从抽帧判断"叙事连贯"和"镜头语言"，容易偏向 LLM 规划者写出来的东西，所以规划的增益更可能被高估（这是笔记的推断）。没有一篇论文以 H3 或 Seedance 为固定底座，最接近的是 Wan2.6、HYVideo1.5、Veo 3.1 和 Sora2-Pro。

## 增益集中在分镜拆解和视觉锚定，纯措辞的一份最小

同一篇论文里把组件逐个拿掉，排序相当一致。ViMax 去掉分镜 agent 掉 0.45 分，其中一项子分 VSU 从 **4.94 掉到 3.10**；去掉标为"PC"的组件掉 0.24 分；去掉给镜头语言做检索增强的 RAG 几乎不变（4.110 对 4.107）【论文；VSU 和 PC 的全称搜索摘要未给出】([arXiv 2606.07649](https://arxiv.org/html/2606.07649))。MAViS 有三个审稿 agent，去掉审叙事结构的那个，Narrative 分从 **34.00 塌到 13.67**；去掉审内容的是 32.33，去掉审风格的是 20.00【论文】([arXiv 2508.08487](https://arxiv.org/html/2508.08487v2))。*The Script is All You Need* 的四级消融（原始对白、加剧本、加按镜头切分、加帧锚定）逐级上升，作者把节奏和运镜的提升归给切分与锚定；一篇第三方评述估计只加剧本的增益约 0.1–0.2 分，这是意见，不是测量 ([arXiv 2601.17737](https://arxiv.org/pdf/2601.17737); [pith.science](https://pith.science/paper/2601.17737))。

视觉锚定的效应同样大。VideoStudio 在 LLM 规划之上加入实体参考图，Coref-SV 场景一致性从 VideoDirectorGPT 的 42.8 升到 **77.3**【论文，2024 年的旧模型】([arXiv 2401.01256](https://arxiv.org/pdf/2401.01256))。*One Sentence, One Drama* 的消融里，去掉首帧合成对连续性的伤害最大【论文，数值未取得】([arXiv 2605.22144](https://arxiv.org/html/2605.22144v1))。审查与选片也有稳定收益，大约是规划效应的一半到三分之二：AniMaker 每镜只生成一个候选约掉 7.1%【二手】，ViMax v1 去掉 VLM 候选筛选后全局一致性掉 3.8%【论文】([Moonlight](https://www.themoonlight.io/en/review/animaker-automated-multi-agent-animated-storytelling-with-mcts-driven-clip-generation); [arXiv 2606.07649v1](https://arxiv.org/html/2606.07649v1))。选片是拿生成次数换的，规划几乎不花 GPU。

本项目的内部证据指向同一处，但只能当个案读。Kinora Studio 里 agent 不写 H3 的 prompt：它填结构化字段，确定性编译器把字段序列化成 turbo LoRA 训练用的 caption 格式（`agent/director.md:94`、`src/studio/compiler.ts`）。对一条真实 take 的编译结果按来源手工切分（n=1，约 4,100 字符，FL2VA 模式）：模板和字段名 16.8%，枚举键展开成的目录短语 14.3%，项目级 Look 与调色 19.0%，元素固定特征 17.3%，agent 为这一镜写的自由文本 **32.7%**（`get_take(tke_neupodk9lgw1)`）【实测，单例】。自动检查的分布也偏向规划：按不同的 finding code 粗数，规划层约 68 个，剪辑与声音约 31 个，prompt 措辞约 6 个，画面约 5 个；`lintShotlist` 和 `lintCraft` 里严重度为 error 的六个全是结构性的（`packages/director/src/lint/shotlist.ts:28-63`）。分类和计数出自笔记作者，是近似值。

故障记录更小。约 79 条完成的 take 里只有 11 条带审查，故障标签只出现在两个项目里。这两个项目记下的八条"故障→修复"链中（一条链可归两类），六条的原因或修复落在图、帧或生成模式上：新画的尾帧、用首帧替换参考图、Viggle Remake；两条落在时间分配上；一条是 prompt 与首尾帧自相矛盾。对身份漂移试过改词的那一次，记录写的是"Prompt wording did not fix it"，最后靠一张修正了眼睛的关键帧加 Remake 才修好，花了 0.187 美元和 567 秒，而它修的那条 take 本身只花 0.059 美元和 178 秒。唯一标为"只改了 prompt"的那条，实际是把镜头从 6 秒延到 7 秒并重排节拍（`get_retro(prj_pxz50vl9ahuw)`、`get_retro(prj_dv8phoozmfds)`）【实测，小样本，审查基于抽帧】。唯一一次由独立 agent 做的故事审查在没花任何 GPU 的情况下否决了第一版剧本，四条阻断全在规划层：一个 6 秒镜头塞了七件事，四只手挤在一个小区域，镜头内变光，故事前提在画面里看不出来（`list_reviews(prj_pxz50vl9ahuw, story)`，`rev_aol6oh8vmcze`）。这是一例，不是比率。

所以问题里的二选一要改一下。agent 在单个 shot 上最有分量的决定也是结构性的：这一镜多长，节拍怎么切，用首帧还是参考图，接不接上一镜的尾帧，三个参考位给谁。真正属于"写法"的部分，也就是用哪个词，是其中最小的一块。项目指南里"多数重抽是 prompt 错误而非模型失败"这句话（`packages/director/docs/DIRECTOR.md:128`）【断言】在仓库里没有数据支持，除非把"prompt 错误"宽泛地读成"规格与图不一致"。

## 单镜 prompt 不能省的三件事：对齐训练格式、写清运动、看片后修订

prompt 改写的收益来自"像训练时的 caption"，不来自"写得多"。RAPO 的消融里，LaVie 基线总分 248，用 GPT-4 随意改写反而是 **246**，贴近训练分布的改写才到 256【论文，旧模型】([arXiv 2504.11739](https://arxiv.org/html/2504.11739v1))；RAPO++ 里通用 refiner 的 79.75% 也低于基线的 80.89%【论文】([arXiv 2510.20206](https://arxiv.org/pdf/2510.20206))。CAPE-T2V 给这个现象起了名字，叫推理时改写的 prompt 与训练 caption 之间的"PE-Caption gap"【论文，增量未取得】([arXiv 2608.03046](https://arxiv.org/abs/2608.03046))。对自托管的 H3，这一条更硬：管线里没有提示词增强，没有负向提示词，引导器不做 CFG，prompt 是唯一的文本输入，格式由 lightx2v turbo LoRA 的训练 caption 决定（`docs/handoff/HANDOFF.md:26-27, 40, 48-50`）【实测，来自跑通的工作流】。把字段编译成那个格式，等于替托管服务里的改写器干活。托管版的改写器自己也会坏事：一位测试者报告 H3 的 prompt expander 把"slow dolly-in"缩成轻微推近，把三段运镜拆成了硬切【个例】([Fuser](https://fuser.studio/articles/minimax-h3-prompt-guide))。

首帧模式下，画面归图，文字归运动。Runway 的指南说图生视频的 prompt 应几乎全部用来描述运动；Kling 说重述图里已有的内容是浪费；火山方舟说上传图片的质量对图生视频影响较大，心里有确定画面就先用图像模型做出来【厂商】([Runway](https://help.runwayml.com/hc/en-us/articles/48324313115155-Image-to-Video-Prompting-Guide); [Kling](https://kling.ai/topics/image-to-video-prompts); [火山方舟](https://ark.volcengine.com/region:cn-beijing/docs/82379/2298881?lang=zh))。研究多走了一步：I2V 模型过度依赖条件帧，会压制运动，Adaptive Low-Pass Guidance 靠削弱这种依赖把 VBench 的 dynamic degree 提高约 33%（另一版本写 36%）【论文】([arXiv 2506.08456](https://arxiv.org/html/2506.08456))。首帧模式下文字真正难的任务是让画面动起来并且动得对，要写起始状态、结束状态和幅度。

否定句不起作用，写法还随模型版本而变。Runway 明说模型理解的是该发生什么，不是该避免什么【厂商】([Runway](https://help.runwayml.com/hc/en-us/articles/39789879462419-Gen-4-Video-Prompting-Guide))；H3 没有负向分支，本项目的规则是禁令会被画成它禁止的东西（`AGENTS.md`）。内部那条眼睛漂移的 take 里，prompt 恰好含三处针对眼睛的否定写法；记录没有检验否定是不是漂移的原因，只能说与规则一致。时间戳是另一个例子：火山引擎的指南写明 Seedance 2.0 不响应时间戳、只响应镜头序号，2.5 才响应整数秒的时间戳【厂商】([Seedance 2.5 提示词指南](https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5-prompt-guide))。同一种写法在相邻两个版本上一个有效一个无效，这类知识适合固化成每个模型一份的编译器，不适合靠 agent 的文风。H3 接受带时间窗的节拍，但不保证照做：内部有一条 take 把要求 0–2.5 秒完成的滑动在约 0.5 秒内做完，之后约 3.8 秒几乎静止（`get_shotlist(prj_pxz50vl9ahuw)`，`tke_ehziu951bori`）【实测，单例】。

有些限制换什么措辞都过不去。SeqBench 上领先的 Kling 2.0 在单主体多动作 prompt 上只有 **0.266**，多主体多动作 0.366【论文】([arXiv 2510.13042](https://arxiv.org/html/2510.13042))；T2V-CompBench 里片内属性变化这一类，最好的模型也低于 0.07，数量超过三个就开始数不对【论文】([arXiv 2407.14505](https://arxiv.org/pdf/2407.14505))。prompt 侧唯一有效的回应是每条生成少要一点：一个动作，一个运镜，其余拆到别的镜头。这是分镜决定，不是写作技巧；笔记汇总的六家厂商指南（部分经第三方转述）在这一点上一致。Seedance 2.0 把多镜头写进一条 prompt 的原生能力没有取消这个决定：实践者报告一条 4–15 秒的 prompt 里超过两三次切镜就容易出错【个例】([知乎](https://zhuanlan.zhihu.com/p/2050274027709768829))。至于单镜该拆到多短，H3 上没有测过：镜头长度与质量的关系在本项目里明确标为未测量，现行的短镜头默认值出自成本，不是质量发现（`AGENTS.md`）【默认】。

重抽和改 prompt 修的是两种故障。Video-T1 只在初始噪声上做 best-of-N，Pyramid-Flow 的 VBench 总分从 81.61 升到 86.51【论文；另一来源写的增量是 5.86，两者不符，需核对原表】([arXiv 2503.18942](https://arxiv.org/pdf/2503.18942))。PRIS 报告固定 prompt 下加 seed 或加步数很快到顶【论文】([arXiv 2512.03534](https://arxiv.org/pdf/2512.03534))。VQQA 让 agent 看生成结果、提问、再改 prompt，比原样生成高 **8.43–11.57** 个百分点，比只做打分选片高 3.46–4.76【论文】([arXiv 2603.12310](https://arxiv.org/pdf/2603.12310))。从这几篇推出的读法是：随机故障（某一条 take 的手、一次闪烁）再抽一次最便宜；系统性漏项（每条 take 都丢同一个元素）抽多少次都在，只能改 prompt 或改输入。agent 在 prompt 上最有价值的工作因此是事后的，读懂失败的 take 再修订，而不是事前堆描述。

## 电影级成片的七个杠杆，故事和首帧排在 prompt 前面

下表按证据强弱排序。它是综合四份笔记后的推断，各行证据的类型不同，不能当成测量出来的权重。

| 序 | 杠杆 | agent 在这里做什么 | 主要依据与强度 |
|---|---|---|---|
| 1 | 故事和观点 | 定结构、每个转折的因果、开头的钩子；让独立读者在渲染前审 | 影评、市场数据、MAViS、内部一例；强，多方一致 |
| 2 | 先图后视频 | 在图像阶段锁定 look、角色、场景和每镜首尾帧；一致性靠素材，不靠文字 | 主创自述、VideoStudio、厂商指南、内部故障链；强 |
| 3 | 每条生成只要一件事 | 一个动作一个运镜，多事件拆镜，把模型做不稳的内容留在故事之外 | StoryEval、SeqBench、厂商指南；限制是测过的，拆多短没测过 |
| 4 | 合乎格式的 prompt | 编译到模型训练的 schema；写可见动作、起止状态和幅度；只做正面陈述 | WanPE、RAPO、厂商指南；"从裸到密"测过，"从密到更密"没测过 |
| 5 | 多 take 与选片 | 留出重抽预算；随机故障重抽，系统性故障改输入；选片要看运动 | 幕后比例、AniMaker、VQQA；比例强，方法弱 |
| 6 | 写进数据的连续性 | 每场的轴线和机位侧、角色状态、尾帧接首帧、每镜重挂同一组参考 | 基准测试的残余故障、厂商指南；中 |
| 7 | 剪辑与收尾 | 取舍、统一调色加颗粒、清理、声音 | Air Head 主创、FilMaster【二手】；中，声音一项弱 |

故事排第一，因为画面质量在任何来源里都没有救回弱故事。Higgsfield 的 *Hell Grind* 前 25 分钟用了 **16,181 次生成换 253 个镜头**，筛选比 64:1【厂商数据，经媒体报道】；Variety 的现场报道是"情节不知所云，画面逼真得惊人"，TechRadar 说 AI 仍做不好让电影被记住的东西，即可信的人物【媒体】([Screen Daily](https://www.screendaily.com/news/in-pictures-higgsfield-unveils-fully-ai-generated-feature-hell-grind-in-cannes/5216871.article); [Variety](https://variety.com/2026/film/features/i-saw-hell-grind-ai-generated-film-cannes-shocking-realistic-1236770720/); [TechRadar](https://www.techradar.com/ai-platforms-assistants/i-watched-a-90-minute-ai-movie-made-in-just-two-weeks-and-hollywood-can-stop-worrying-for-now))。市场一侧，2026 年上半年抖音新增 AI 短剧超过 22 万部，播放过亿的 1,055 部，爆款率不到 0.5%【媒体】([凤凰网](https://feng.ifeng.com/c/8xLyyeokUev))；中文从业者把稀缺能力放在剧本理解、审美和镜头思维上，不放在工具上【媒体】([36氪](https://www.36kr.com/p/3827470501122690))。

先图后视频是所有说明过自己流程的制作的默认做法。ANCESTRA 先用 Imagen 和 Veo 出候选图、按情绪和色彩整理，再让 Veo 把选中的图动起来【主创/厂商】([Google blog](https://blog.google/technology/google-deepmind/ancestra-behind-the-scenes/))；新华网描述的漫剧链条是剧本、AI 生图、AI 抽卡、剪辑、审核，人设图和场景图是喂给抽卡的"种子"【媒体】([新华网](https://www.news.cn/politics/20260429/b541e4e3478c4a43916c4777eb9b8b80/c.html))。它同时做了三件事：定住身份和美术方向，把随机性挪到重试只花几分钱的阶段，给审查者一个渲染前就能检查的东西。口碑最好的团队走得更远，用控制输入而不是更好的文字来压随机性：*Dear Upstairs Neighbors* 用 video-to-video 控制表演和节奏，在美术设定上微调了定制模型，问题镜头有时由画师直接改画【主创】([No Film School](https://nofilmschool.com/dear-upstairs-neighbors-hybrid-ai-short-film))。准确的说法是：首帧决定 look、身份和构图的上限，运动、表演和物理仍然是抽的。

时间花在哪和质量来自哪是两个阶段。时间在生成和筛选上：Air Head 的后期负责人估计素材与成片约 300:1【主创】([fxguide](https://www.fxguide.com/fxfeatured/actually-using-sora/))，一个中文团队报的内部抽卡率约 20%【媒体】([搜狐](https://www.sohu.com/a/1030284284_114986))。这些比例口径不一，有的数图，有的数片段，有的含探索，不能取平均。质量则被归给生成之前的决定和之后的剪辑。杭州一家团队说标准化工作流把单镜抽卡从"十几次"降到"两三次"【媒体】([杭州日报](https://ori.hangzhou.com.cn/ornews/content/2026-10/19/content_9345947.htm))，这是规划降低重抽率的少数直接说法之一，没有可核对的数据。本项目的记录里，五个有多条 take 的项目共 82 条 take，其中 51 条（62%）是某一镜的第二条或更后的 take；一部分是有意的备选，所以这是浪费的上限。单条 take 约 0.05–0.23 美元、2.5–9.5 分钟 GPU 时间，钱很少，稀缺的是时间和注意力，而文字阶段的修改这两样都不花（`get_retro` 各项目，`gpu_stats()`）【实测】。

连续性必须由管线自己的数据承载，因为模型不保存场景状态。DirectorBench 的人评把跨镜连续性列为最弱项，prompt 遵循和局部画质反而较好；MSVBench 评了 20 种方法，结论相同【论文】([arXiv 2605.30090](https://arxiv.org/html/2605.30090v1); [arXiv 2602.23969](https://arxiv.org/html/2602.23969v1))。残余故障在镜头之间，agent 对它的杠杆就是决定每一镜以什么为条件：海螺自己的指南建议用上一镜的末帧做下一镜的首帧，并承认复杂的轨迹匹配常要重生成两三次【厂商，无数据】([hailuoai.video](https://hailuoai.video/knowledge/trajectory-matching-seamless-ai-video-cuts))。本项目的规则说得更直接：只写在散文里的计划不会被遵守，新的规划规则要进 treatment、声音表或时间线（`AGENTS.md`）。

收尾的证据以主创自述为主。Shy Kids 说未经处理的 Sora 素材缺乏连续性和整体感，成片经过了稳定、放大、调色和擦除【主创】([fxguide](https://www.fxguide.com/fxfeatured/actually-using-sora/))。FilMaster 里按模拟观众反馈修改粗剪的后期阶段把平均分从 4.17 提到 4.67【二手】([Moonlight](https://www.themoonlight.io/en/review/filmaster-bridging-cinematic-principles-and-generative-ai-for-automated-film-generation))。声音的分量没有找到任何量化的一手说法。表演、对白和口型是影评点名的短板，PersonaShot 也把微表情持续性和情绪弧线列为主要瓶颈【论文】([arXiv 2608.16717](https://arxiv.org/html/2608.16717v1))；中文团队的绕法是文戏用真人，本项目里 H3 的普通话准确度和口型同步尚未测量（`agent/director.md:95`）。

## 审片是最薄的一环：只看静帧会偏向选静态镜头

规划和审查的价值都取决于审的人看得见什么。本项目的 agent 只能看静帧，看不到运动、听不到声音（`agent/director.md:29`）。文献显示这种审查者有可预期的偏差：MAViS 的审查原则让 I2V 阶段的 Dynamic Degree 从 44.58 降到约 35.6【论文】([arXiv 2508.08487](https://arxiv.org/html/2508.08487v2))，AniMaker 的作者指出 VBench 偏好静态一致性，为此另建了评估器【论文】([arXiv 2506.10540](https://arxiv.org/pdf/2506.10540))。识别运镜是通用 VLM 最弱的一项：2025 年的 ShotBench 上最好的模型平均 59.3%，过半模型在 camera movement 上不超过 40%【论文；2025 年的数据，对当前前沿模型多半已过时】([arXiv 2506.21356](https://arxiv.org/html/2506.21356v1))。agent 无法从静帧确认要求的运镜是否发生。行业里的选片方式是人看运动：*Dear Upstairs Neighbors* 开每日样片会；一位用 Claude 当导演、Seedance 出片的创作者把"看动态、听声音"留给自己【个例】([X/@EianLu](https://x.com/EianLu/status/2118317430665613741))。

审查还要独立。FilmAgent 的多 agent 版本人评 3.98，单 agent 版本 3.04【二手】，但它的角色分工捆着"批评—修正—验证"的回路，结果同样可以读成"有审查步骤才有用" ([arXiv 2501.12909](https://arxiv.org/html/2501.12909v1))。从上述创作者工作流衍生的几个开源 skill 不约而同地给每一关配了独立 agent 审查【个例】([xdlkc/ai-video-production](https://github.com/xdlkc/ai-video-production))。本项目的记录是同一个故事的小样本：抓出四条阻断的那次是独立 agent 做的，之后五次故事审查都是自审；所有项目的镜头独立审查和成片审查都是 0 次，约 79 条完成的 take 里 68 条没有任何审查。关卡存在于代码里，它们对结果的效果在记录里没有体现。

还有一类风险来自 agent 自己：把噪声写成规则。本项目的决策日志里，一次重排分镜的依据是"H3 在约 5 秒内把一个动作保持得好，超过 10 秒每秒成本翻四倍"；提交 `859b081` 把两半都撤回了：四倍来自两次估算之间 GPU 均值的漂移，5 秒的说法没有 take 数据支持，故障在 5 秒的 take 里同样出现。同一份分镜后来把一个镜头改回 7 秒才修好节奏故障。

## 结论

"分镜重要还是 prompt 写法重要"这个问法预设 prompt 是一段要写好的文字。证据描绘的是另一幅图：prompt 的格式是可以一次做对的工程产物，交给每个模型一份的编译器；agent 的判断力花在三处：拍什么和不拍什么，每条生成被要求做多少、以哪张图为条件，以及失败之后改哪个输入。Seedance 的原生多镜头把分镜写进了 prompt 的形式里，两者在文本上合一了，决定却没有变：仍然是先决定这 15 秒里有几个镜头、各自要一件什么事。

对本项目，最值得补的不是更多的 prompt 规则，而是四个还没有的测量：镜头长度 A/B（12 秒对 6+6 `continuous`），turbo 8 步对 20 步基座在同一 prompt 上的遵循度，独立镜头审查能拦下多少故障，以及让能看运动的人或模型参与选片后重抽率怎么变。在这些数字出来之前，"规划优先于措辞"是一个方向一致、但每一环都靠小样本或自报数据支撑的判断；它足以决定精力往哪里放，不足以写成定量结论。
