/* Chinese for the Cut (timeline, rough cut), the Director page and its panel. Keys are the English text; the terms follow zh/core.ts. */
export const cut: Record<string, string> = {
  /* the Cut: head, undo, reset */
  "Reset the cut? Every circled take joins in board order, from 0 s at its full length; the current order, trims and transitions are replaced.": "重置剪辑？每个圈选镜次会按分镜顺序接起来，从 0 秒起、用全长；现在的顺序、修剪和转场都会被替换。",
  "1 clip": "1 个片段", "{n} clips": "{n} 个片段", " against a target of {t}": "，目标 {t}",
  ". Drag a clip to move it, an edge to trim it.": "。拖动片段可以移动，拖动边缘可以修剪。", " Not saved yet.": "还没保存。",
  "Undo the last change (Ctrl/⌘+Z)": "撤销上一步（Ctrl/⌘+Z）", "Undo": "撤销",
  "Rebuild from the circled take of every shot, from 0 s at full length": "用每个镜头的圈选镜次重建，从 0 秒起、用全长", "Reset": "重置",
  "Save the cut": "保存剪辑", "Dismiss": "知道了",
  "Nothing in the cut yet": "剪辑里还什么都没有", "Reset joins the circled take of every shot in board order.": "“重置”会把每个镜头的圈选镜次按分镜顺序接起来。",
  "No shot has a circled take yet: circle one per shot in Screening and it joins the cut.": "还没有哪个镜头圈选了镜次：在放映里给每个镜头圈选一条，它就会进剪辑。",
  "Build the cut": "生成剪辑", "Removed {slate} take {n} from the cut": "已从剪辑中移除 {slate} 镜次 {n}", "Removed the clip from the cut": "已从剪辑中移除这个片段",

  /* export and the full-resolution pass */
  "Export": "导出", "Preset": "预设", "Burn in subtitles": "烧录字幕", "Export {preset}": "导出 {preset}",
  "1 seam still jumps in this cut": "这版剪辑还有 1 处接缝跳帧", "{n} seams still jump in this cut": "这版剪辑还有 {n} 处接缝跳帧", "the cut is saved first": "会先保存剪辑",
  "Full resolution · {a} of {b} picks": "全分辨率 · 选用镜次 {a}/{b}", " · {n} rolling": " · {n} 条在拍", "Final quality": "成片画质", "close to the draft": "贴近草稿",
  "Measured so far: about {price} a pick. The exact estimate is shown before anything renders.": "目前实测：每条选用镜次约 {price}。开拍前会显示确切估价。",
  "No full-resolution take has finished in this project, so there is no measured price yet. Probe one pick before the rest; the estimate is shown before anything renders.": "这个项目还没有拍完过全分辨率镜次，所以还没有实测价格。先试一条，再做其余的；开拍前会显示估价。",
  "Probe {slate} at {res}": "用 {res} 试拍 {slate}", "All picks are at {res}": "选用镜次都已是 {res}",
  "Regenerate 1 pick at {res}": "以 {res} 重拍 1 条选用镜次", "Regenerate {n} picks at {res}": "以 {res} 重拍 {n} 条选用镜次",
  "music track": "音乐轨",

  /* seams */
  "Seams": "接缝", "Seams · none jump": "接缝 · 没有跳帧", "Seams · {n} jump": "接缝 · {n} 处跳帧",
  "Run it to the last frame · +{s} s": "延到最后一帧 · +{s} 秒", "Run all {n} to the last frame · +{s} s": "{n} 处全部延到最后一帧 · +{s} 秒",
  "Every continuous shot starts on the last frame its anchor shows in the cut.": "每个连续镜头都从它的锚镜头在剪辑里露出的最后一帧开始。",
  "At||seam": "位置", "Join": "接点", "Anchor is cut at": "锚镜头剪在", "Its take ends at": "其镜次结束于", "Gap": "差距", "Fix": "修正",
  "A continuous shot starts on its anchor's last frame. A shot renders on H3's frame grid, so a 5 s shot is 5.17 s long; trimming the anchor to 5.00 s makes the picture jump at the join.": "连续镜头从锚镜头的最后一帧开始。镜头按 H3 的帧网格渲染，所以 5 秒的镜头实际长 5.17 秒；把锚镜头剪到 5.00 秒，接点处画面就会跳。",

  /* mix, beat grid, subtitles */
  "Mix": "混音", "Music track": "音乐轨", "Upload music": "上传音乐", "Upload from this device": "从这台设备上传", "None": "无",
  "Dialogue": "对白", "Effects": "音效", "Music": "音乐", "Fade in (s)": "淡入（秒）", "Fade out (s)": "淡出（秒）",
  "Beat grid": "节拍网格", "Snap every cut to the music: each clip ends on a beat, bar or half beat within what its take can give.": "让每个剪点卡在音乐上：每个片段在它的镜次长度允许的范围内结束在拍、小节或半拍上。",
  "Beats per bar": "每小节拍数", "Cut on": "剪在", "beat||grid": "拍", "bar||grid": "小节", "half beat||grid": "半拍",
  "{n} cuts snapped · last at {s} s": "已对齐 {n} 个剪点 · 最后一个在 {s} 秒", "not applied": "未应用", "Snap cuts to the grid": "剪点对齐网格",
  "Subtitles": "字幕",
  "The dialogue lines of the clips in order. Each is checked for reading time: CJK ÷ 4.5 + Latin ÷ 15 + 1.5 s, at least 1.8 s. The SRT is what burn-in uses.": "按顺序列出各片段的对白。每句都检查阅读时间：中日韩字符数 ÷ 4.5 + 拉丁字符数 ÷ 15 + 1.5 秒，至少 1.8 秒。烧录用的就是这份 SRT。",
  "Check subtitles": "检查字幕", "every line has time to be read": "每句都有足够的阅读时间", "line||subtitle": "字幕行",
  "Hide SRT": "隐藏 SRT", "Show SRT": "显示 SRT", "Copy SRT": "复制 SRT", "(no dialogue in the cut)": "（剪辑里没有对白）",

  /* exports */
  "Exports": "导出记录", "No exports yet": "还没有导出", "Status": "状态", "Started": "开始时间", "Download": "下载",
  "queued||status": "排队中", "running||status": "进行中", "completed||status": "已完成", "failed||status": "失败",
  "Spent so far: {spent} of {cap}.": "目前已花费 {spent}，上限 {cap}。",

  /* the tracks */
  "Tracks": "轨道", "Titles": "画面文字", "exact text": "文字准确",
  "No titles. Text is laid over the picture here; the model never draws it.": "没有画面文字。文字在这里叠加到画面上，模型从不画字。",
  "{kind} · {at} for {d} s": "{kind} · {at} 起，{d} 秒", "{at} for {d} s": "{at} 起，{d} 秒",
  "card||title kind": "字幕卡", "overlay||title kind": "叠加文字", "caption||title kind": "说明字幕",
  "Picture||track": "画面", "Clip {i}: {slate} take {n}, {a} to {b}": "片段 {i}：{slate} 镜次 {n}，{a} 到 {b}",
  "cut||transition": "硬切", "dissolve||transition": "叠化", "fade black||transition": "黑场过渡", "fade white||transition": "白场过渡", "iris||transition": "圆形划像", "wipe||transition": "划像",
  "The next shot starts on this take's last frame, and the cut leaves before it": "下一个镜头从这条镜次的最后一帧开始，而剪辑在那之前就切走了",
  "Take sound": "镜次原声", "effects {db} dB": "音效 {db} dB", "muted": "已静音",
  "Narration": "旁白", "dialogue {db} dB": "对白 {db} dB", "None.": "无。", "a line at {at}": "{at} 处的一句",
  "No music track.": "没有音乐轨。", "Silences": "静默", "No silence is marked.": "没有标出静默。",

  /* the selected clip */
  "Selected clip": "选中的片段", "Clip {i} · {slate} · take {n}": "片段 {i} · {slate} · 镜次 {n}", "Clip {i} · {id}": "片段 {i} · {id}", "Screen takes": "看镜次",
  "In (s)": "入点（秒）", "Out (s)": "出点（秒）", " · take {s}": " · 镜次长 {s}", "Transition in": "入转场", "Length (s)": "时长（秒）",
  "Sound leads (J-cut, s)": "声音先入（J-cut，秒）", "Sound trails (L-cut, s)": "声音延后（L-cut，秒）", "Hold last frame (s)": "定格尾帧（秒）",
  "Speed (×)": "速度（×）", "Repeat": "重复", "Mute this take's own sound": "静音这条镜次的原声",
  "{slate} starts on this take's last frame, and the cut leaves it {s} s before that.": "{slate} 从这条镜次的最后一帧开始，而剪辑提前 {s} 秒就切走了。",
  "Run to the last frame": "延到最后一帧", "Move earlier": "前移", "Move later": "后移", "Remove from the cut": "从剪辑中移除",

  /* titles, silences, narration */
  "Titles · {n}": "画面文字 · {n}", "Add a title": "加一条文字",
  "Titles, captions, signs and on-screen displays are added here and drawn by the assembler, so they are exact. The model is never asked for text.": "标题、说明字幕、招牌和屏幕显示都在这里添加，由合成机绘制，所以文字准确。从不让模型画字。",
  "Text||title": "文字", "At (s)": "起点（秒）", "For (s)": "时长（秒）", "Kind": "类型", "Remove": "移除",
  "Silences and narration": "静默与旁白", "Silences · {n}": "静默 · {n}", "Mark a silence": "标一段静默",
  "A silence takes the whole mix out for a stretch: the breath before a turn.": "静默会让整个混音停一段：转折前的那一口气。",
  "Narration · {n}": "旁白 · {n}", "Upload a recording first, or have the director speak a line": "先上传一段录音，或者让导演念一句", "Add a line": "加一句",
  "Off-screen and inner lines are laid on the film at their times; the music ducks under them.": "画外音和内心独白按各自的时间铺到片子上；音乐会在它们下面压低。",
  "Recording||narration": "录音",

  /* the rough cut */
  "Nothing to preview yet: the timeline needs clips whose takes have finished.": "还没有可预览的：时间线上需要有镜次已拍完的片段。",
  "Play rough cut": "播放粗剪", "Restart||playback": "从头", "Prev": "上一个", "Next": "下一个",
  "{pos} / {total} s · clip {i}/{n}": "{pos} / {total} 秒 · 片段 {i}/{n}",
  "Hard cuts only; dissolves, music and subtitles appear in the exported file.": "这里只有硬切；叠化、音乐和字幕要在导出的文件里才有。",

  /* the Director page */
  "Who decides what": "谁来决定什么", "What waits for you, what the checks found, and what the director may do without asking.": "等你决定的事、检查发现的问题，以及导演不用问你就能做的事。",
  "1 take is rolling": "1 条镜次正在拍", "{n} takes are rolling": "{n} 条镜次正在拍", "Nothing is rolling · last change {when}": "没有在拍 · 最近改动 {when}",
  "1 error": "1 个错误", "{n} errors": "{n} 个错误", "1 warning": "1 个警告", "{n} warnings": "{n} 个警告", "checking…": "检查中…",
  "No errors and no warnings.": "没有错误，也没有警告。", "Open in Cut": "在剪辑中打开", "Open Script": "打开剧本", "Open Brief & style": "打开简报与风格",
  " · film": " · 全片", "Notes · {n}, by kind": "提示 · {n} 条，按类型", "Check||lint": "检查项", "Where and what": "位置与内容",
  "{first} (and {n} more like it)": "{first}（另有 {n} 处类似）",

  /* the director's panel: permissions */
  "Let the director approve the script on your behalf? It still needs a fresh reviewer's pass (script) or a clean lint (shotlist), every approval is logged, and overturning it puts the checkpoint back in draft.": "让导演代你批准剧本？它仍然要有一位全新评审通过（剧本）或检查没有错误（分镜），每次批准都会记录，推翻批准会让这个关卡回到草稿。",
  "Let the director approve the shotlist on your behalf? It still needs a fresh reviewer's pass (script) or a clean lint (shotlist), every approval is logged, and overturning it puts the checkpoint back in draft.": "让导演代你批准分镜？它仍然要有一位全新评审通过（剧本）或检查没有错误（分镜），每次批准都会记录，推翻批准会让这个关卡回到草稿。",
  "Allow image generation on this project? The director (Claude, Grok…) and the buttons may then draw pictures with {model}, up to the image limit below.": "在这个项目上允许生成图片？之后导演（Claude、Grok…）和页面上的按钮都可以用 {model} 画图，最多画到下面的图片上限。",
  "the model below": "下面选的模型",
  "{model} draws on the GPU pod, only while it runs (it bills per hour); its pictures get no Codex self-check. Use it for this project's pictures?": "{model} 在 GPU 机器上画图，只在机器运行时可用（按小时计费）；它画的图没有 Codex 自检。这个项目的图片用它吗？",
  "Allow voice generation on this project? The director may then make voices and speak lines through the voice API (TokenSail) with {model}, billed per character, up to the budget below.": "在这个项目上允许生成语音？之后导演可以通过语音 API（TokenSail）用 {model} 制作声音、念台词，按字符计费，最多用到下面的预算。",
  "Why overturn this decision? The director reads it.": "为什么推翻这个决定？导演会读到。",
  "What the director may do, and what it has decided": "导演可以做什么，以及它做了哪些决定",
  "Image generation": "图片生成",
  "Off by default. Switched on, character sheets, first and last frames, region edits, style frames and Remake keyframes can be drawn — by the buttons on the Elements, Board, Takes and Look pages, and by the director (Claude, Grok…) — with the model picked here, the same models as Canvas. GPT Image and Qwen-Image 3.0 Pro are drawn by a painter away from the GPU (Machine page → Painters): Codex uses your ChatGPT plan, the API models are paid per picture. MiniMax H3 Image draws on the GPU pod, only while it runs.": "默认关闭。打开后，角色设定图、首帧和尾帧、局部修改、风格图和重做（Remake）的关键帧都可以画——由元素、分镜、镜次和风格页面上的按钮画，也由导演（Claude、Grok…）画——用这里选的模型，和画布用的是同一批模型。GPT Image 和 Qwen-Image 3.0 Pro 由 GPU 之外的绘图机画（机器页 → 绘图机）：Codex 用你的 ChatGPT 套餐，API 模型按张付费。MiniMax H3 Image 在 GPU 机器上画，只在机器运行时可用。",
  "Allow image generation by agent": "允许导演生成图片", "Model": "模型", " · GPU pod": " · GPU 机器", " · not ready": " · 未就绪",
  "Quality": "画质", "low (drafts)": "低（草稿）", "medium||quality": "中", "high||quality": "高", "Image limit": "图片上限", "{used} used · {left} left": "已用 {used} · 剩 {left}",
  "LoRAs": "LoRA", "Trained for this model; picking one applies its card's settings to every picture the director draws": "为这个模型训练的；选一个，它卡片上的设置会用在导演画的每张图上",
  "No LoRA in the library is trained for {model} (Library → LoRAs).": "素材库里没有为 {model} 训练的 LoRA（素材库 → LoRA）。",
  "Settings: {s}": "设置：{s}", " (from {list})": "（来自 {list}）",
  "{name} is 18+: the director's pictures with it are drawn only from pictures the Studio drew and the reference library — a picture that is, or was drawn from, an upload or an imported image is refused (it may be a real person).": "{name} 是 18+ 的：导演用它画的图只能以 Studio 自己画的图和参考图库为底——上传或导入的图片、以及从它们画出来的图都会被拒绝（可能是真人）。",
  "{name} is 18+: the director's pictures with it are drawn only from pictures the Studio drew and the reference library — a picture that is, or was drawn from, an upload or an imported image is refused (it may be a real person). 18+ is off for you now: show 18+ on the Canvas page, or the pictures are refused.": "{name} 是 18+ 的：导演用它画的图只能以 Studio 自己画的图和参考图库为底——上传或导入的图片、以及从它们画出来的图都会被拒绝（可能是真人）。你现在关着 18+：在画布页打开显示 18+，否则这些图会被拒绝。",
  "Agent use Canvas": "导演使用画布",
  "The director may compose a character from the Canvas library — a portrait, a costume, a pose — when it decides a look is needed (compose_character), drawn with {model}{loras}, and put it on the character as its look. It counts against the image limit.": "导演觉得需要造型时，可以从画布素材里组合出一个角色——肖像、服装、姿势（compose_character），用 {model}{loras} 画，再放到角色上作为它的造型。计入图片上限。",
  " and the LoRAs above": " 和上面的 LoRA",
  "Off: the director draws characters with element sheets only; the Canvas page stays yours.": "关闭：导演只用设定图画角色；画布页留给你用。",
  "A fresh Codex session looks at every drawn picture beside its references and brief (anatomy, extra people, identity, mirrored features, text, framing) before it reaches you. Uses Codex usage, not image quota.": "每张画好的图在交给你之前，都由一个全新的 Codex 会话对照参考图和简报检查一遍（解剖结构、多余的人、身份、镜像特征、文字、构图）。消耗的是 Codex 用量，不占图片额度。",
  "Self-check every picture": "每张图都自检", "Redraws on a blocker": "遇到硬伤时重画", "0 (just flag it)": "0（只标出来）", "A redraw counts as a picture.": "重画一次算一张图。",
  "Stopped: {reason}": "已停止：{reason}", "Resume||images": "继续",
  "Voice generation": "语音生成",
  "Off by default. Switched on, the director may make character voices on the voice API (TokenSail, with the Worker's TOKENSAIL_API_KEY) — cloned from a voice card's reference audio, or designed from its description with CosyVoice — speak lines with them (off-screen lines, inner monologue, audition samples) and transcribe audio to check pronunciation. Speech is billed per character, up to the budget below.": "默认关闭。打开后，导演可以在语音 API 上制作角色声音（TokenSail，用 Worker 的 TOKENSAIL_API_KEY）——从声音卡的参考音频克隆，或用 CosyVoice 按声音卡的描述设计——用这些声音念台词（画外音、内心独白、试音样本），并转写音频来检查发音。语音按字符计费，最多用到下面的预算。",
  "Allow voice API use by agent": "允许导演使用语音 API", "Voice model": "语音模型", " · clone or design": " · 克隆或设计", " · clone": " · 克隆",
  "Character budget": "字符预算", "Reset count": "计数清零",

  /* spend envelope, delegated approval */
  "Spend envelope": "花费额度",
  "Inside it the director renders a shot without asking — only when a fresh reviewer passed that exact prompt and those frames, and never a re-run of a rejected take. Every spend lands in the decision log. Script and shotlist approvals stay yours.": "额度之内，导演拍镜头不用问你——前提是一位全新评审通过了那条提示词和那些画面，而且绝不重拍被否掉的镜次。每笔花费都记进决定日志。剧本和分镜仍由你批准。",
  "${used} of ${envelope} used": "已用 ${used}，额度 ${envelope}", " · until {date}": " · 到 {date} 为止",
  "Revoke": "收回", "Envelope (USD)": "额度（美元）", "For (hours)": "时长（小时）", "Grant": "授予",
  "Delegated approval": "代为批准",
  "Off by default: you approve the script and the shotlist yourself. Switched on, the director may approve for you — the script only after a fresh reviewer passed the current text, the shotlist only with the script approved and no lint errors. Each approval appears under Decisions; overturn it and the checkpoint goes back to draft.": "默认关闭：剧本和分镜由你自己批准。打开后，导演可以代你批准——剧本要等一位全新评审通过了当前文本，分镜要在剧本已批准且检查没有错误时。每次批准都列在“决定”下；推翻它，这个关卡就回到草稿。",
  "Let the director approve the script": "让导演批准剧本", "Let the director approve the shotlist": "让导演批准分镜",

  /* requirements, decisions, reviews */
  "Requirements": "需求", "· {n} open": "· {n} 条未满足",
  "A requirement is a sentence the film is held to at every review. The director records what you ask for here; you can add one yourself.": "需求是每次评审都要对照的一句话。导演会把你提的要求记在这里；你也可以自己加。",
  "A requirement in your own words": "用你自己的话写一条需求", "In your own words, e.g. the cat never looks into the camera": "用你自己的话写，例如：猫从不看镜头",
  "Add": "添加", "Met": "已满足", "Drop||requirement": "放弃", "Reopen": "重新打开",
  "Decisions": "决定", "None logged yet.": "还没有记录。", "Overturn": "推翻",
  "Reviews": "评审", "No cold-reader reviews yet (review_packet → a fresh agent → record_review).": "还没有冷读评审（review_packet → 一个全新的智能体 → record_review）。",
  "story||review stage": "故事", "shot||review stage": "镜头", "film||review stage": "成片", "frame||review stage": "画面",
  "PASS||verdict": "通过", "FAIL||verdict": "不通过", "fresh agent||reviewer": "全新评审", "self||reviewer": "自审", "human||reviewer": "人工",
  "{n} finding(s)": "{n} 条意见", "Basis: {basis}": "依据：{basis}", " (maybe)": "（不确定）", "Retro (Markdown)": "复盘（Markdown）",
};
