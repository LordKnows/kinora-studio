/* Chinese for Canvas, Library, LoRAs, Models, Machine, the GPU menu, painters, Connect. Keys are the English text; the terms follow zh/core.ts. */
export const global: Record<string, string> = {
  /* Canvas: the page, the recipe and the picture settings */
  "Compose a character from a portrait, a costume and a pose — from the reference library or your own pictures. GPT Image, Qwen-Image 3.0 Pro (API), or MiniMax H3 Image on the GPU pod, draws it into a project, ready to become an element's look.":
    "用一张人像、一套服装和一个姿势组合出一个角色——图来自参考库或你自己的图片。由 GPT Image、Qwen-Image 3.0 Pro（API）或 GPU 机器上的 MiniMax H3 Image 画进项目里，可以直接用作元素的造型。",
  "18+ references are shown; click to hide them": "正在显示 18+ 参考图；点击隐藏", "18+ references are hidden": "18+ 参考图已隐藏", "18+ shown": "18+ 已显示", "18+ hidden": "18+ 已隐藏",
  "No project yet": "还没有项目", "Canvas pictures belong to a project.": "画布画的图片要放在一个项目里。", "Create a Canvas project": "新建一个画布项目", "Pick a project…": "选择项目…",
  "Canvas pictures are kept in a project and count against its image limit. Pick the one they belong to.": "画布的图片保存在项目里，并计入该项目的图片上限。选一个它们该归属的项目。",
  "{model} · {used}/{max} used · {quality}": "{model} · 已用 {used}/{max} · {quality}", " · stopped: {reason}": " · 已停止：{reason}",
  "low||quality": "低", "medium||quality": "中", "high||quality": "高",
  "Image generation is off for this project. Turned on, pictures are drawn with {model} (up to 100; the model and the limit are on the project's Director page).": "这个项目的图片生成是关着的。打开后用 {model} 画图（最多 100 张；模型和上限在项目的导演台页里改）。",
  "Turn on": "打开", "Attach to element": "挂到元素上", "Keep in Pictures only": "只保存在图片里", "Put on {name} ({kind})": "挂到 {name}（{kind}）", "As view": "作为哪个视图",
  "character||element kind": "角色", "location||element kind": "场景", "prop||element kind": "道具",
  "face||ref view": "脸部", "front||ref view": "正面", "three quarter||ref view": "四分之三侧", "side||ref view": "侧面", "back||ref view": "背面", "full body||ref view": "全身", "expression||ref view": "表情", "detail||ref view": "细节",
  "Recipe": "配方", "text to image": "文生图", "{n}/{max} pictures": "{n}/{max} 张图", "Random": "随机", "Clear": "清空",
  "How the picture is made": "图片的生成方式", "Compose from a portrait, a costume, a pose and more pictures": "用人像、服装、姿势和更多图片组合", "Draw from a description alone, no picture": "只凭文字描述来画，不用图片",
  "Describe the picture": "描述画面", "Who or what, where, the light and the framing; the style, size, model and LoRAs below still apply": "画谁或画什么、在哪里、光线和构图；下面的风格、尺寸、模型和 LoRA 照样生效",
  "Two people in one picture: a face and an outfit each (or a project character), in a two-person pose": "一张图里画两个人：每人一张脸和一套服装（或一个项目角色），用双人姿势",
  "Person {who}: a project character instead of a portrait": "人物{who}：用项目角色代替人像", "Face: the portrait slot": "脸：用人像格里的图", "Character: {name}": "角色：{name}",
  "The library fills this person": "参考库里选的图填给这个人", "Person {who}'s name in the prompt": "人物{who}在提示词里的名字",
  "Person A in the pose": "姿势里的人物A", "Which figure of the pose picture, as shown (after a flip), is person A; the other is person B": "姿势图里（按显示的样子，含翻转）哪个人是人物A；另一个是人物B",
  "Library picks go to person {who} (click a slot of the other person to switch). A character sheet stands for a face and an outfit in one picture and keeps the faces apart best. A picture of two people stays in Pictures.":
    "参考库里选的图会给人物{who}（点另一个人的任一格即可切换）。角色设定图一张就包含脸和服装，最能让两张脸不混淆。双人图片只保存在图片里。",
  "CharaDB outfits cannot go on an uploaded photo: its author forbids depicting real people. Use a library portrait or another costume source.": "CharaDB 的服装不能用在上传的照片上：作者禁止用来描绘真人。请改用参考库的人像，或换一个服装来源。",
  "The recipe holds an 18+ reference that is hidden now: show 18+ or replace it.": "配方里有一张现在被隐藏的 18+ 参考图：打开 18+ 显示，或者换掉它。",
  "With {what}, R18 pictures are drawn only from pictures tagged 模拟 (the library, uploads whose face check found a 3D render, an illustration or no face, Studio pictures drawn only from those). An upload tagged 真实 — a photograph or anything photorealistic — is refused for R18 and fine for everything else.":
    "使用 {what} 时，R18 图片只用标为 模拟 的图来画（参考库的图、人脸检查结果为 3D 渲染、插画或无人脸的上传图，以及只用这些画出的镜谱图片）。标为 真实 的上传图——照片或任何照片级写实的图——不能用于 R18，其他用途都可以。",
  "18+ references": "18+ 参考图",
  /* why Generate is off */
  "Pick a project": "选一个项目", "Pictures are off for this project (its Director page)": "这个项目没有开启图片生成（在它的导演台页打开）",
  "Image generation stopped: {reason}": "图片生成已停止：{reason}", "Image quota used ({used}/{max})": "图片额度已用完（{used}/{max}）",
  "Person A: pick a portrait, a costume or a character": "人物A：选一张人像、一套服装或一个角色", "Person B: pick a portrait, a costume or a character": "人物B：选一张人像、一套服装或一个角色",
  "{name} is 18+: show 18+ first": "{name} 是 18+ 内容：先打开 18+ 显示", "Pick at least one reference": "至少选一张参考图", "{model} takes at most {n} pictures": "{model} 最多接受 {n} 张图片",
  "The recipe holds an 18+ reference; show 18+ or replace it": "配方里有 18+ 参考图：打开 18+ 显示，或者换掉它", "CharaDB outfits cannot go on an uploaded photo": "CharaDB 的服装不能用在上传的照片上",
  "Pick a project first: uploads belong to a project": "请先选一个项目：上传的图片要放进项目里", "Pick an image file (PNG, JPEG or WebP)": "请选择图片文件（PNG、JPEG 或 WebP）",
  "{model} takes at most {n} pictures per call": "{model} 每次最多接受 {n} 张图片", "Pick a project first": "请先选一个项目", "{handle} added to the project's Pictures": "{handle} 已加到项目的图片里", "Picture": "图片",
  /* the picture settings */
  "LoRAs": "LoRA", "Picking one applies its card's settings": "选中后会套用它模型卡上的推荐设置", "Style": "风格", "Size": "尺寸", "Resolution": "分辨率",
  "2:3 portrait": "2:3 竖图", "3:4 portrait": "3:4 竖图", "1:1 square": "1:1 方图", "3:2 landscape": "3:2 横图", "16:9 wide": "16:9 宽屏",
  "drawn at {size}, not resized": "按 {size} 画，不缩放", "; several times slower": "；会慢好几倍", "drawn at 4 MP, resized to the size": "按 4 MP 画，再缩放到所选尺寸", "Standard · {size}": "标准 · {size}",
  "Prompt language": "提示词语言", "the edited prompt stays as typed": "改过的提示词保持你输入的样子", "{model}'s own": "{model} 的默认语言", " · model default": " · 模型默认", "English||prompt language": "英文",
  "Project default ({quality})": "项目默认（{quality}）", "Project default": "项目默认", "Low · draft": "低 · 草稿", "Medium||quality": "中", "High||quality": "高",
  "prompt_extend: the vendor rewrites the prompt before drawing (the pose gallery turns it on; off keeps the 图1/图2/图3 roles exactly as composed)": "prompt_extend：厂商在作画前改写提示词（姿势图库默认打开；关掉则严格按组合好的 图1/图2/图3 分工）",
  "Negative prompt": "反向提示词", "What the picture must not show, e.g. 多余的手指, 文字水印": "画面里不能出现的东西，例如 多余的手指、文字水印",
  "Note||canvas": "补充", "Added to the prompt, e.g. 教室窗边逆光，微风吹拂发丝": "追加到提示词里，例如 教室窗边逆光，微风吹拂发丝",
  "Prompt": "提示词", "edited": "已改", "Edit": "编辑", "Back to composed": "恢复自动组合", "Copy": "复制", "Pick a portrait, a costume or a pose.": "选一张人像、一套服装或一个姿势。", "Generate": "生成",
  "Model": "模型", "ChatGPT plan": "ChatGPT 订阅", "API, per picture": "API，按张计费", "settings by the service": "设置由服务决定", " (from {list})": "（来自 {list}）", "up to {n} pictures": "最多 {n} 张图",
  "OpenAI moderation": "OpenAI 内容审核", "Alibaba Cloud moderation": "阿里云内容审核", "no content filter": "无内容过滤", "can draw now · {drawers}": "现在就能画 · {drawers}",
  " The pod is starting; its painter reports once the model is loaded.": " GPU 机器正在启动；模型加载好后，它的绘图机会上报。", "Bills per hour; stops by itself when idle": "按小时计费；空闲时自动停机", "Start GPU pod": "启动 GPU 机器",
  /* the results */
  "Results": "结果", "All pictures": "全部图片", "Drawing…": "正在画…", "queued for a painter": "排队等绘图机", "a painter is drawing it": "绘图机正在画", "Failed: {error}": "失败：{error}", "no picture||failed job": "没出图", "no picture||character": "没有图片",
  "Generated characters appear here, and in the project's Pictures.": "生成的角色会出现在这里，也会出现在项目的图片里。",
  "References": "参考图", "Review: {review}": "评审：{review}", "Use this recipe again": "再用一次这个配方", "Download": "下载", "Open in Pictures": "在图片里打开", "Hide the prompt": "隐藏提示词", "Show the prompt": "显示提示词",
  "portrait||ref role": "人像", "costume||ref role": "服装", "pose||ref role": "姿势", "extra||ref role": "附加图", "character||ref role": "角色", "portrait_b||ref role": "人像B", "costume_b||ref role": "服装B", "character_b||ref role": "角色B",
  /* the slots */
  "your picture": "你的图片", "Change it in the library": "在参考库里换一张", "Pick from the library": "从参考库里选", "Uploading…": "上传中…", "Pick from the library, or drop a picture": "从参考库里选，或把图片拖到这里", "hidden now": "现已隐藏",
  "Pose picture": "姿势图", "Line art": "线稿", "Depth map": "深度图", "What the uploaded pose picture is": "上传的姿势图是哪一种",
  "A photo of a person: only the pose and framing are taken, not their looks or clothes": "人物照片：只取姿势和构图，不取长相和衣服", "A mannequin (白模) or line art": "白模或线稿", "A grey depth map": "灰度深度图", "Flip the pose left to right": "左右翻转姿势",
  "portrait||slot": "人像", "costume||slot": "服装", "pose||slot": "姿势",
  "Random, like this one": "随机换一张相似的", "Random {kind}, like this one": "随机换一张相似的{kind}", "Random from everything": "从全部里随机", "Random {kind} from everything": "从全部{kind}里随机",
  "Upload your own picture": "上传你自己的图片", "Upload a {kind} picture": "上传{kind}图片", "Clear||slot": "清除", "Clear the {kind}": "清除{kind}",
  "project character · its sheet": "项目角色 · 用它的设定图", "Use the portrait slot instead": "改用人像格", "Take {name} out": "移出 {name}",
  "More pictures": "更多图片", "(props, accessories, a background — paste with ⌘V / Ctrl+V)": "（道具、配饰、背景——可用 ⌘V / Ctrl+V 粘贴）", "Name": "名称", "Remove {name}": "移除 {name}", "Add a picture": "添加图片", "No room": "已满",
  /* 18+ */
  "Show 18+ references": "显示 18+ 参考图",
  "The library holds adult reference material: two pose systems (全身单人・性感系, 双人缠绵 — grey mannequins) and lingerie and sensual outfits (内衣・睡衣, 性感穿搭). It stays hidden — for you and for the director connected to this Studio — until you confirm you are an adult.":
    "参考库里有成人参考素材：两套姿势（全身单人・性感系、双人缠绵——灰色白模）以及内衣和性感服装（内衣・睡衣、性感穿搭）。在你确认自己已成年之前，这些内容一直隐藏——对你和连接到这个镜谱的导演都一样。",
  "This is your own confirmation, not an age check. It is stored for your account; switch it off any time. Image models keep their own rules: GPT Image refuses sexual content, and repeated refusals can put the account it runs on at risk. CharaDB pictures are never used for minors or real people.":
    "这只是你本人的确认，不是年龄验证。它保存在你的账号里，随时可以关掉。图像模型有各自的规则：GPT Image 拒绝色情内容，反复被拒可能让它所用的账号面临风险。CharaDB 的图片绝不用于未成年人或真人。",
  "I am 18 or older and want to see 18+ reference material": "我已年满 18 岁，想查看 18+ 参考素材", "Cancel": "取消",

  /* the reference library */
  "Reference library": "参考库", "Search": "搜索", "{n} 18+ hidden": "已隐藏 {n} 张 18+", "picture unavailable": "图片加载不了",
  "Preview {name}": "预览 {name}", "In the recipe": "已在配方里", "{name} is in the recipe": "{name} 已在配方里", "{action}: {name}": "{action}：{name}",
  "Use as portrait": "用作人像", "Use as costume": "用作服装", "Use as pose": "用作姿势", "Show more ({n} left)": "显示更多（还有 {n} 个）",
  "Section": "分区", "All": "全部", "Hair length": "发长", "Any length": "不限长度", "Hairstyle": "发型", "All hairstyles ({n})": "全部发型（{n}）", "Top 10 🔥": "热门前十 🔥", "Top 10": "前十",
  "No portrait matches": "没有符合条件的人像", "Clear a filter or the search.": "清除一个筛选条件或搜索词。",
  "Source": "来源", "All sources": "全部来源", "Category": "类别", "Tag": "标签", "All tags": "全部标签", "No costume matches": "没有符合条件的服装",
  "Pose system": "姿势体系", "All categories ({n})": "全部类别（{n}）", "Angle": "角度", "Any angle": "不限角度", "By pose": "按姿势", "Every picture": "逐张", "{n} poses": "{n} 个姿势", "No pose matches": "没有符合条件的姿势",
  "Front||pose angle": "正面", "Three-quarter||pose angle": "斜侧", "Side||pose angle": "侧面", "From above||pose angle": "俯视", "From below||pose angle": "仰视",
  "← Prev": "← 上一张", "Next →": "下一张 →", "Hair": "头发", "Tags": "标签", "Prompt words": "提示词", "System": "体系", "Pose": "姿势", "Depth": "深度图",
  "CharaDB: reference only — never on a real person's photo, never for a minor, no redistribution.": "CharaDB：仅供参考——不得用在真人照片上，不得用于未成年人，禁止再分发。",
  "AI-generated, fictional adult. Never use it to pass as a real person.": "AI 生成的虚构成年人。不得用来冒充真人。",
  "Fetch this one picture into the project's Pictures": "把这一张图片取到项目的图片里", "Add to project pictures": "加到项目图片", "Original": "原图",
  /* the galleries' terms (references-model.ts) */
  "Poses and depth maps: ギア (@giaaibusi), ai-pose-gallery.pages.dev. Free to use one picture at a time as a generation reference, commercial work included; bulk download, redistribution and resale are not allowed.":
    "姿势和深度图：ギア（@giaaibusi），ai-pose-gallery.pages.dev。可以一次一张免费用作生成参考，包括商业作品；禁止批量下载、再分发和转售。",
  "Portraits: ギア, ai-portrait-gallery.pages.dev, CC0. AI-generated fictional adults; never use one to impersonate a real person.": "人像：ギア，ai-portrait-gallery.pages.dev，CC0。均为 AI 生成的虚构成年人；不得用来冒充真人。",
  "Chinese names and tags: anhao/ai-pose-gallery-zh.": "中文名称和标签：anhao/ai-pose-gallery-zh。",
  "Free to use as a reference, commercial work included. No bulk download, no redistribution of the pictures.": "可免费用作参考，包括商业作品。禁止批量下载，禁止再分发图片。",
  "Pictures load from ギア's site; follow its terms.": "图片从 ギア 的网站加载；请遵守其条款。",
  "Reference only: never on a real person's photo, never for a minor, no redistribution, the pictures themselves cannot be sold.": "仅供参考：不得用在真人照片上，不得用于未成年人，禁止再分发，图片本身不得出售。",
  "CC0 (wquguru). AI-generated references, not scholarly reconstructions.": "CC0（wquguru）。AI 生成的参考图，不是学术复原。",
  "Your own pictures, uploaded to the library.": "你自己上传到参考库的图片。",
  /* 我的 */
  "Add to {mine}": "添加到{mine}", "What the picture is": "图片类型", "What the pose picture is": "姿势图类型", "Name (the file name)": "名称（默认用文件名）", "Tags: 短发, 3D, 赛博…": "标签：短发、3D、赛博…",
  "Uploading and checking…": "上传并检查中…", "Upload a picture": "上传图片",
  "A portrait gets its face check: 模拟 (3D, illustrated or AI) can go into any picture, R18 included; 真实 into everything but R18.": "人像会做人脸检查：模拟（3D、插画或 AI）可以用在任何图片里，包括 R18；真实 可以用在除 R18 以外的所有图片里。",
  "A costume or a pose gets no face check.": "服装和姿势不做人脸检查。",
  " Drop a picture here too. Your pictures show in every project, and in the Portraits, Costumes and Poses tabs under {mine}.": "也可以把图片拖到这里。你的图片在每个项目里都能用，也会出现在人像、服装和姿势标签页的“{mine}”下。",
  "Kind": "类型", "Search 搜索 (name, tags)": "搜索（名称、标签）", "No picture matches": "没有符合条件的图片", "Nothing of yours yet": "还没有你自己的图片", "Upload a portrait, a costume or a pose above.": "在上面上传人像、服装或姿势。",
  "Tags, separated by commas": "标签，用逗号分隔", "Checking…": "检查中…", "Check again": "重新检查",
  "Take {name} out of {mine}? Pictures already drawn from it stay.": "把 {name} 移出“{mine}”？已经用它画出的图片会保留。", "Delete": "删除",

  /* Library: styles */
  "Style presets the director compiles into a Look, the LoRAs a project can switch on, and the models the Studio runs with the settings they recommend. Shared across projects.":
    "导演编译成 Look 的风格预设、项目可以开启的 LoRA，以及镜谱运行的模型及其推荐设置。所有项目共用。",
  "Styles": "风格", "Models": "模型", "No styles": "没有风格", "The director package ships 16 presets; the build generates them into the studio.": "导演包自带 16 个预设；构建时会把它们生成到镜谱里。",
  "Close": "关闭", "Could not load this style.": "无法加载这个风格。", "Loading…": "加载中…",

  /* Library: LoRAs */
  "Speed LoRAs cut the step count; style and effect LoRAs shape the look. Each carries the settings its card recommends — picking a speed LoRA sets the steps, sampler, schedule and shift. Projects pick defaults on Brief & style; a shot can override.":
    "加速 LoRA 减少步数；风格和特效 LoRA 塑造画面。每个 LoRA 都带着它模型卡推荐的设置——选中加速 LoRA 会设定步数、采样器、调度和 shift。项目在「简报与风格」里选默认 LoRA；单个镜头可以覆盖。",
  "Delete {name} from the library? Projects that reference it will simply skip it.": "从素材库删除 {name}？引用它的项目会直接跳过它。",
  "Add LoRA": "添加 LoRA", "No LoRAs yet": "还没有 LoRA", "Add the acceleration LoRA first (e.g. lightx2v 8-step), then any style or effect LoRAs you use.": "先添加加速 LoRA（例如 lightx2v 8-step），再添加你要用的风格或特效 LoRA。",
  "{kind} LoRAs": "{kind} LoRA", "Speed||LoRA kind": "加速", "Style||LoRA kind": "风格", "Effect||LoRA kind": "特效",
  "File": "文件", "Recommended": "推荐设置", "Trigger words": "触发词", "Workflows": "工作流", "all||workflows": "全部", "on the volume": "在存储卷上",
  "New LoRA": "新建 LoRA", "Save": "保存", "Create": "创建", "Filename": "文件名", "Inside ComfyUI's models/loras on the pod.": "在 GPU 机器上 ComfyUI 的 models/loras 里。",
  "HuggingFace link": "HuggingFace 链接", "Paste the file's HuggingFace link (…/blob/main/xxx.safetensors); the pod downloads it into models/loras when missing.": "粘贴这个文件的 HuggingFace 链接（…/blob/main/xxx.safetensors）；文件不在时，GPU 机器会把它下载到 models/loras。",
  "Default strength · {n}": "默认强度 · {n}", "Steps hint": "建议步数", "Speed LoRAs: the step count they are trained for; becomes the project default.": "加速 LoRA：它训练时对应的步数；会成为项目默认值。",
  "Base model": "基础模型", "The model family it was trained for; it only loads with that family's workflows.": "它所针对的模型系列；只在该系列的工作流里加载。",
  "Recommended settings": "推荐设置", "— from its model card; a speed LoRA's replace the base model's when it is picked": "——来自它的模型卡；选中加速 LoRA 时，它的设置会取代基础模型的设置",
  "Sampler": "采样器", "Scheduler": "调度器", "Shift (video)": "Shift（视频）", "Shift (audio)": "Shift（音频）", "Strength from": "强度下限", "Strength to": "强度上限",
  "In effect: {params}": "当前生效：{params}", "the base model's settings": "基础模型的设置", "Appended to the LOOK block when this LoRA is active.": "启用这个 LoRA 时追加到 LOOK 块。",
  "None selected = applies to every workflow.": "都不选 = 适用于所有工作流。", "Notes": "备注",

  /* Library: models */
  "GPU pod: {status}": "GPU 机器：{status}", "not set up": "未配置", "painter · API": "绘图机 · API", "no filter": "无过滤", "set by the service": "由服务设定",
  "up to {n} per call": "每次最多 {n} 张", " · named <Picture 1>…": " · 以 <Picture 1>… 指代", "Licence": "许可", " · not for commercial use": " · 不可商用", "Files": "文件",
  "{gb} GB, downloaded onto the pod at boot": "{gb} GB，开机时下载到 GPU 机器上", "LoRAs for {family}": "{family} 的 LoRA",
  "speed||lora": "加速", "style||lora": "风格", "effect||lora": "特效",

  /* Machine */
  "The RunPod pod that renders every take, the painters that draw the pictures before it starts, what it costs, and the storage behind it.": "拍所有镜次的 RunPod GPU 机器、在它启动之前画图的绘图机、它们的花费，以及背后的存储。",
  "Pictures (painters, off the GPU)": "图片（绘图机，不占 GPU）", "Remake models (on the pod)": "Remake 模型（在 GPU 机器上）", "Backends": "后端",
  "Signed in": "已登录", "dev mode, no auth": "开发模式，无认证", "configured": "已配置", "missing RUNPOD_* secrets": "缺少 RUNPOD_* 密钥", "R2 storage": "R2 存储", "missing R2_* secrets": "缺少 R2_* 密钥",
  "Image models": "图像模型", "GPT Image and Qwen-Image 3.0 Pro on the painters, MiniMax H3 Image on the GPU pod; each project picks its model on its Director page": "GPT Image 和 Qwen-Image 3.0 Pro 在绘图机上，MiniMax H3 Image 在 GPU 机器上；每个项目在自己的导演台页里选模型",

  /* the GPU pod: the top bar's pill and menu, the rail card, the Machine page */
  "GPU pod": "GPU 机器", "GPU (serverless)": "GPU（serverless）", "GPU not set up": "GPU 未配置",
  "GPU off": "GPU 关", "GPU starting": "GPU 启动中", "GPU creating": "GPU 创建中", "GPU on": "GPU 开", "GPU stopping": "GPU 停止中", "no GPU": "暂无 GPU",
  "off||gpu": "已关机", "none||gpu": "无", "creating||gpu": "创建中", "starting||gpu": "启动中", "running||gpu": "运行中", "stopping||gpu": "停止中", "stopped||gpu": "已停止", "terminated||gpu": "已销毁", "unavailable||gpu": "暂时没资源",
  "one for all projects": "所有项目共用一台", "Could not read the GPU state: {error}": "读不到 GPU 状态：{error}", "{n} take(s) waiting for the GPU": "{n} 条镜次在等 GPU",
  "Last refresh failed: {error}": "上次刷新失败：{error}", "RunPod is not configured": "RunPod 没有配置", "not configured": "未配置",
  "Start||gpu": "启动", "Stop||gpu": "停止", "Retry||gpu": "重试", "Machine page": "机器页",
  "Loading stats…": "正在加载统计…", "No completed takes yet.": "还没有拍完的镜次。", "GPU type": "GPU 型号", "Generation": "生成用时", "Video s": "视频秒数", "GPU-s / video-s": "GPU 秒 / 视频秒", "USD / video-s": "USD / 视频秒",
  " · estimate basis": " · 估算依据", "Sorted by USD per second of video. Set RUNPOD_GPU_PRIORITY=cost to order the allow-list by this column when a pod is created.": "按每秒视频的美元花费排序。设置 RUNPOD_GPU_PRIORITY=cost 后，创建 GPU 机器时允许列表就按这一列排序。",
  "Terminate the pod? Its container disk is deleted; models on the network volume stay.": "销毁 GPU 机器？它的容器磁盘会被删除；网络存储卷上的模型会保留。",
  "Apply the studio's boot command and env to this pod and restart it?": "把镜谱的启动命令和环境变量应用到这台 GPU 机器上并重启？",
  "Mode": "模式", "RunPod pod (Secure Cloud)": "RunPod GPU 机器（Secure Cloud）", "RunPod serverless (TODO)": "RunPod serverless（待做）", "Status": "状态", "Pod": "机器",
  " · adopted (created by hand; never replaced)": " · 已接管（手动创建；不会被替换）", "Cost": "费用", "this session {usd} ({time}) · lifetime {total}": "本次 {usd}（{time}）· 累计 {total}",
  "Allowed GPUs": "允许的 GPU", "RUNPOD_GPU_TYPES is empty": "RUNPOD_GPU_TYPES 为空", "Idle stop": "空闲自动停机", "after {n} min without work": "无任务 {n} 分钟后", "Queue": "队列",
  "Retry on allowed GPUs": "在允许的 GPU 上重试", "Set the studio's start command and env on the pod, then restart it": "在 GPU 机器上设置镜谱的启动命令和环境变量，然后重启", "Apply boot & restart": "应用启动配置并重启",
  "Terminate": "销毁", "GPU types": "GPU 型号", "Generation stats by GPU": "各 GPU 型号的生成统计", "VRAM": "显存", "Secure $/h": "Secure 价格 $/h", "Allowed": "允许", "yes": "是",
  "Adopt a pod created by hand": "接管手动创建的 GPU 机器",
  "If the studio cannot create the pod itself (for example the model volume is not attachable through the API), create it in the RunPod console and paste its id here. The studio then starts, stops and runs jobs on it, but never terminates or replaces it.":
    "如果镜谱自己创建不了 GPU 机器（例如模型存储卷无法通过 API 挂载），就在 RunPod 控制台里创建，再把它的 id 粘贴到这里。之后镜谱会启动、停止它并在上面运行任务，但绝不会销毁或替换它。",
  "RunPod pod id": "RunPod 机器 id", "Adopt": "接管", "Hide recipe": "隐藏配方", "Show what to paste into RunPod": "显示要粘贴到 RunPod 的内容",
  "The env block contains the worker token and R2 keys. Paste it only into the pod's environment variables.": "环境变量块里有 worker 令牌和 R2 密钥。只能粘贴到这台 GPU 机器的环境变量里。",
  /* RunPod's console is in English: its field names stay beside the Chinese */
  "Container image": "容器镜像（Container Image）", "Expose HTTP ports": "暴露 HTTP 端口（Expose HTTP Ports）", "Container disk (GB)": "容器磁盘（Container Disk，GB）", "Volume mount path": "存储卷挂载路径（Volume Mount Path）",
  "Entrypoint (JSON, overrides the image's /start.sh)": "Entrypoint（JSON，覆盖镜像的 /start.sh）", "Start command (only for images without an ENTRYPOINT)": "启动命令（Start Command，只用于没有 ENTRYPOINT 的镜像）",
  "GPU types (in priority order)": "GPU 型号（按优先级排序）", "Environment variables": "环境变量（Environment Variables）",

  /* painters */
  "Painters": "绘图机", "— draw sheets, frames, edits, crops and frame extracts before the GPU pod starts": "——在 GPU 机器启动之前画设定图和画面，做编辑、裁剪和抽帧",
  "Hide setup": "隐藏设置方法", "Add a painter": "添加绘图机", "Refresh": "刷新",
  "No painter is online{except}: picture jobs wait in the queue{orPod}. With a painter pod below, the Studio starts it by itself when pictures are queued; otherwise start a painter on any small machine — see “Add a painter”.":
    "{except}没有绘图机在线：图片任务在队列里等待{orPod}。下面配了 CPU 绘图机的话，有图片排队时镜谱会自己启动它；否则请在任意一台小机器上启动一个绘图机——见「添加绘图机」。",
  " except the GPU pod": "除了 GPU 机器，", " (or until the GPU pod runs, which also draws)": "（或等 GPU 机器运行，它也能画）",
  "On any Linux machine with Python 3 (a RunPod CPU pod, a VPS): the painter only calls out, so it needs no open port.": "在任何装有 Python 3 的 Linux 机器上（RunPod CPU 机器、VPS）：绘图机只向外连接，不需要开放端口。",
  "Or with Docker: {build}, then {run}. The token is the Worker secret {token}{unset}. Add {painterPath} and {podPath} to the Cloudflare Access bypass application. On a RunPod CPU pod, attach a volume at /workspace so the Codex login survives a restart.":
    "或者用 Docker：{build}，然后 {run}。令牌是 Worker 的密钥 {token}{unset}。把 {painterPath} 和 {podPath} 加到 Cloudflare Access 的 bypass 应用里。在 RunPod CPU 机器上，在 /workspace 挂一个存储卷，这样重启后 Codex 登录还在。",
  " — not set yet: add PAINTER_TOKEN in the Worker's secrets": "——还没设置：在 Worker 的密钥里添加 PAINTER_TOKEN",
  "GPU pod (fallback)": "GPU 机器（后备）", "online · {busy}/{slots} drawing": "在线 · {busy}/{slots} 在画", "offline · last seen {when}": "离线 · 最后上线 {when}",
  "Codex logged in": "Codex 已登录", "Codex not logged in": "Codex 未登录", "Codex not installed": "Codex 未安装", "code-mode helper missing": "缺少 code-mode 辅助程序", "images API": "图像 API",
  "Asking the painter…": "正在请求绘图机…", "Log in with a device code": "用设备码登录", "Forget": "移除",
  "1. Open {link} on any device and sign in to ChatGPT.": "1. 在任意设备上打开 {link}，登录 ChatGPT。", "the link": "链接", "2. Enter this code:": "2. 输入这个代码：",
  "Device-code sign-in must be on in ChatGPT → Settings → Security. The code expires after a few minutes; press the button again for a new one.": "必须在 ChatGPT → 设置 → 安全 里打开设备码登录。代码几分钟后过期；再按一次按钮可获取新代码。",
  "Login failed: {error}.": "登录失败：{error}。", "Login failed.": "登录失败。", "Last error: {error}": "上次错误：{error}",
  "Login kept in {home}": "登录信息保存在 {home}", " on {host}": "（{host} 上）", " · painter {version}": " · 绘图机 {version}",
  "Painter pod": "CPU 绘图机", "painter online · {n} drawing": "绘图机在线 · {n} 在画", "painter not up yet": "绘图机还没起来",
  "Created by itself when pictures are queued and no painter can draw them, terminated after {n} idle minutes — a new pod each time ({flavors}, {vcpu} vCPU, {image}) in {dc}, with volume {volume} at /workspace keeping the Codex login.":
    "有图片排队且没有绘图机能画时自动创建，空闲 {n} 分钟后销毁——每次都是一台新机器（{flavors}，{vcpu} vCPU，{image}），位于 {dc}，存储卷 {volume} 挂在 /workspace，保存 Codex 登录。",
  "Not set up: {why}. Set PAINTER_POD_VOLUME_ID and PAINTER_POD_DATACENTER (Worker variables, wrangler.jsonc) and the Studio creates a CPU pod only while pictures wait.":
    "未配置：{why}。设置 PAINTER_POD_VOLUME_ID 和 PAINTER_POD_DATACENTER（Worker 变量，wrangler.jsonc）后，镜谱只在有图片等待时才创建 CPU 机器。",
  "up {time} ({usd}) · ": "已运行 {time}（{usd}）· ", "{usd} so far": "累计 {usd}",
  /* Viggle Remake on the pod */
  "Download the Viggle Remake {modes} model onto the volume (about {gb} GB)?": "把 Viggle Remake 的 {modes} 模型下载到存储卷上（约 {gb} GB）？",
  "Download the Viggle Remake {modes} models onto the volume (about {gb} GB)?": "把 Viggle Remake 的 {modes} 模型下载到存储卷上（约 {gb} GB）？", " and ||list": " 和 ",
  "Start the GPU pod to see this ({why}).": "启动 GPU 机器后才能看到这里（{why}）。", "nodes installed": "节点已安装", "nodes missing (restart the pod)": "缺少节点（重启 GPU 机器）",
  "edit ready": "edit 已就绪", "edit not downloaded": "edit 未下载", "swap ready": "swap 已就绪", "swap not downloaded": "swap 未下载", "Downloading…": "下载中…", "Download models": "下载模型",

  /* Connect */
  "Connect a director": "连接导演", "Your subscription Claude or Grok works through the Studio MCP: script, elements, shotlist, batch plan, renders. Every paid action still asks you to confirm.": "你订阅的 Claude 或 Grok 通过镜谱的 MCP 工作：剧本、元素、分镜、批量计划、拍摄。每个要花钱的操作仍会先请你确认。",
  "MCP endpoint": "MCP 端点", "OAuth metadata": "OAuth 元数据",
  "Settings → Connectors → Add custom connector → paste the endpoint → sign in on the consent page.": "设置（Settings）→ 连接器（Connectors）→ 添加自定义连接器（Add custom connector）→ 粘贴端点 → 在授权页登录。",
  "grok.com → Connectors → New Connector → Custom → paste the same endpoint → sign in.": "grok.com → Connectors → New Connector → Custom → 粘贴同一个端点 → 登录。",
  "Start a film": "开拍一部片子", "Say “start a new film”. The agent reads the director guide through the connector; pasting it into project instructions is optional.": "说「开始一部新片」。导演会通过连接器读取导演指南；粘贴到项目说明里不是必须的。",
  "Hide director guide": "隐藏导演指南", "Show director guide": "显示导演指南", "Copy guide": "复制指南",
  "your steps": "你设的步数",
  "Added a tool lately? Remove and re-add the connector in the chat client so its tool list refreshes.": "最近加了工具？在聊天客户端里删除连接器再重新添加，它的工具列表才会刷新。",
};
