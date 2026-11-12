# Claude 调 Codex 生图与质检：调研和改进

2026-11 调研。目标：减少有质量问题的图，并在图被拿去做 take 之前把问题拦下来。

## 1. 流程（改后）

```
导演 (Claude) ──MCP──► Studio：generate_element_sheet / generate_shot_frame / edit_frame …
                         │  拼 prompt（分段、参考图角色、人数、左右）→ 生图作业进 D1 队列
                         ▼
               画图机器 painter.py（CPU 机器；GPU Pod 兜底）领任务
                         │  codex exec -i ref1 -i ref2 … "调用画图工具一次，prompt 原样"
                         │  像素检查（空白 / 边框 / 裁掉多少 / 设定图背景 / 编辑范围）
                         │  自检：全新的 codex exec 对照参考图和要求打分（JSON）
                         │  有硬伤 → 带着问题重画一次（项目可设 0–2 次）
                         ▼
               图片 + checks + autoReview 回到 Studio，挂到镜头 / 元素上
                         ▼
导演 view_frames 看图 → review_packet(stage frame) 交给全新的审稿 agent → record_review
                         ▼
               局部问题 edit_frame（只改框内）；全局问题改要求后重画
```

## 2. 找到的问题

| # | 问题 | 依据 | 后果 |
|---|---|---|---|
| 1 | **Codex 的画图工具不接受尺寸参数**。后端固定 `size: "auto"`，画幅由 prompt 决定 | openai/codex#19175（内置 image_gen 的 tool spec 只有类型和输出格式）；oh-my-pi PR #15601（Codex 后端忽略 size，只能写进 prompt） | 旧 prompt 写的是 "exact aspect ratio 1344:768 (1.750:1)"，这不是模型认识的比例 |
| 2 | 旧逻辑：比例偏差超过 3% 就重画；第二次无论如何都收下，再**居中裁切** | `paint.py` 旧版 `run_codex` | 16:9 的帧如果拿到 3:2 的图，每张都白画一次（耗 ChatGPT 额度），再从上下裁掉约 14%，头和脚就没了，而且没有任何记录 |
| 3 | 参考图通过「把路径写在消息里，让 agent 填 `referenced_image_paths`」传给 Codex | 同上 #19175：内置工具的参数里没有这个字段 | 参考图很可能根本没进生成。角色长得不像、服装不对，根源可能就在这里 |
| 4 | 设定图 prompt 写的是 "Character reference sheet" | 这个词在训练数据里对应带标注的多视图转身图 | 一张图里出现好几个人，还带文字标签，和 "No text" 冲突 |
| 5 | 参考图没说明用途 | 旧 `shotFramePrompt` 只写了 "1 = Mia" | 设定图的灰底、站姿和平光被带进镜头帧，人物像贴上去的 |
| 6 | 单侧特征（伤疤、纹身）只写 "on the left cheek" | 模型分不清是画面左边还是人物自己的左边 | 特征被镜像；视频会照抄，Remake 也很难救 |
| 7 | 没写人数 | — | 背景里多出路人，或者同一个角色出现两次 |
| 8 | prompt 是一整段长句 | GPT Image 对分段、带标签的 prompt 更稳 | 关键信息被稀释 |
| 9 | 质检只靠导演看 1024 px 的预览图，检查清单比较笼统；审稿人看不到画图时用的参考图 | 旧 `framePacket` | 手指、人数、镜像这类问题漏检；审完只有 PASS/FAIL，不知道该怎么修 |
| 10 | 选 Codex 后端时 `quality` 参数不起作用（工具没有这个参数） | 同 #1 | 设置里的 quality 只影响 API 后端 |

## 3. 已做的改动

- **画幅**：prompt 里写模型认识的标准比例和方向，例如 "landscape (wider than tall) image, 16:9 aspect ratio, a widescreen film frame. Fill the whole canvas edge to edge"。按 #15601 的实测，写 "16:9" 得到 1672×941，误差在 2% 以内。现在只有偏差超过 10% 才重画；4% 以内直接收下。裁掉了多少、裁的是哪两边，都写进 `checks`：超过 2% 记 warn，超过 20% 记 fail。
- **参考图**：改用 `codex exec -i 文件`（Codex CLI 官方的附图方式，按顺序附上，被编辑的图放最后）。消息里写明「Image 1 是参考图 1 …… 最后一张是要编辑的图」，路径仍列出来作为后备。
- **prompt 分段**（`src/studio/imaging.ts`）：SCENE / PEOPLE / STAGING / CAMERA / COMPOSITION / COLOUR / CONTINUITY / REFERENCES / STYLE / RULES。
  - 每张参考图都写明用途。角色图：「完全照抄脸、发型、体型、年龄、服装、颜色；忽略那张图的姿势、构图、纯色背景和光」。场景图：同一个地方，忽略里面的人。风格帧：只学渲染、调色和质感，不学内容。
  - 人数写死：「Exactly 2 people in the frame: Mia, Ola. No one else, no extras, no one twice.」
  - 单侧特征写成人物自己的那一侧，并说明它在画面上的哪一侧：「a scar on the left cheek — their OWN left (the right side of the picture when they face the camera); never mirrored」。
  - 设定图改成「ONE figure, ONE view …… not a turnaround, not a multi-view sheet」，背景是带地面阴影的浅灰影棚。
  - 统一的 RULES 段：正常的手和五根手指；不要文字、标签、水印、边框、拼图格。
  - 编辑类 prompt 加上「同样画幅，不裁不缩，不重新构图」。
- **像素检查**（`paint.auto_checks`，不调用模型，免费）：近乎空白、边框或黑边、为对上画幅裁掉的比例、设定图四角不干净、无选区编辑却改动了超过 45% 的像素。
- **自检**（`paint.review_with_codex`）：一个全新的 `codex exec`（推理强度 medium）把成品和参考图都作为附件，按 9 条规则检查（anatomy、count、identity/wardrobe、feature_side、text、framing、style/background、edit_scope、prompt_mismatch），用 `--output-schema` 输出 JSON。有 blocker 的就带着 findings 重画，次数由项目设置决定，默认 1 次；重画算图片额度，检查本身只消耗 Codex 用量。判定结果存进图片的 `autoReview`。
- **审稿包**（`review_packet` stage frame）：附上原图全尺寸、画图时用到的参考图、设定图的其他视角，还有像素检查和第一轮自检的结论。自检结论只作为「需要确认或推翻的线索」，并要求审稿人先独立看一遍，避免被它带偏。每条问题要写代码、严重度、位置（可以是框）和修法：局部问题写 `edit: …`，全局问题写 `redraw: …`。有 blocker 的图不能记为 pass。
- **修图原则**（写进导演指南）：局部问题用 `edit_frame` 只改选区；全局问题先改要求再重画，不用同一个 prompt 反复抽卡；同一张图最多重画两次，之后问用户。

## 4. 还没验证、可以接着做的

1. **`-i` 在实机上的表现**：要确认 Codex 当前版本会把附件交给画图工具当输入图。可以用同一个角色、同一张参考图，分别用 `-i` 和旧的路径方式各画 5 张，对比长相的一致性。如果 `-i` 不行，再试「先让 agent 用 view_image 打开图片，再调用画图工具」。
2. **自检的成本**：每张图多一次 `codex exec`，大约 30–90 秒。可以在 Design 页的 Pictures 标签按 Flagged 筛选，统计 `autoReview` 的失败率，以及它和审稿 agent 结论的一致程度。如果一致率很高，审稿 agent 可以只看被标记的图。
3. **API 后端**：`gpt-image-2` 的 API 能指定精确尺寸（16 的倍数），`quality` 也有效。对画幅要求严格的首尾帧，可以在项目里切到 API 后端，按张付费。
4. **没有采用的方案**：用 Codex 登录的 token 直接调 `chatgpt.com/backend-api/codex/images/*`（例如 codex-imagegen-cli），能指定尺寸和质量，也不需要 CLI。但这是 OpenAI 没有公开的接口，随时可能失效，也有违反服务条款的风险，所以没有用。

## 来源

- [openai/codex#19175 — 内置 image_gen 无法指定尺寸](https://github.com/openai/codex/issues/19175)
- [can1357/oh-my-pi PR #15601 — Codex 托管生图忽略 size，需写进 prompt；实测 16:9 → 1672×941](https://github.com/can1357/oh-my-pi/pull/15601)
- [jdmnk/codex-imagegen-cli — 复用 Codex 登录直连后端（未采用）](https://github.com/jdmnk/codex-imagegen-cli)
- [codex exec JSONL 参考（`--output-schema`、`-o`）](https://codex.danielvaughan.com/2026/04/08/codex-exec-jsonl-reference/)
- [codex-wrapper exec 参数（`-i/--image` 可重复）](https://docs.rs/codex-wrapper/latest/aarch64-apple-darwin/src/codex_wrapper/command/exec.rs.html)
