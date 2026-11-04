# MiniMax H3 · ComfyUI 交接

这个文件夹里的四个 JSON 是 ComfyUI API 格式，也就是直接 POST 给 `/prompt` 的 `prompt` 字段内容，和 Dev mode 里 "Save (API Format)" 导出的结构一样，每个节点带 `_meta.title`。它们不是从 ComfyUI 界面导出的，而是从实际提交到 `/prompt` 的工作流里取出来的。

四个文件用同一套 turbo 8 步采样链，只在 MiniMax H3 节点的输入上有区别。

2026-11-04 在 A100 SXM 80 GB 上把四个文件原样各跑了一次，只把 `104.length` 改成 124 帧（约 5 秒）。四个都成功出片：5.17 s，1344×768，24 fps，H.264 加 AAC 立体声。验证脚本、日志和输出视频在 `verify/` 里。

| 文件 | 模式 | 验证情况 |
| --- | --- | --- |
| `R2VA.json` | 参考图生视频 | ✅ A100 124 帧跑通；之前在 PRO 6000 上 243 帧也跑通过 |
| `I2VA.json` | 图生视频（首帧） | ✅ A100 124 帧跑通；之前在 PRO 6000 上 243 帧跑通过 7 次 |
| `T2VA.json` | 文生视频 | ✅ A100 124 帧跑通 |
| `FL2VA.json` | 首尾帧 | ✅ A100 124 帧跑通，最后一帧和指定的尾帧几乎一模一样（对比图：`verify/fl2va_last_vs_target.jpg`） |

FL2VA 测试时把示例 prompt 换成了一段具体描述（见 `verify/verify_handoff.py`），因为文件里的示例 prompt 只是模板。

和跑通的版本相比，只改了这几处：LoadImage 的文件名换成占位名（`first_frame.png`、`last_frame.png`、`ref_0.png`、`ref_1.png`）、SaveVideo 的文件名前缀，以及 T2VA 和 FL2VA 的示例 prompt。

## 1. 节点 id 和输入名

四个文件的节点 id 统一，同一个参数在每个文件里都是同一个 id。

| 参数 | 节点 id · class_type | 输入名 | 说明 |
| --- | --- | --- | --- |
| 正向提示词 | `104` · MiniMaxH3ImageToVideo / MiniMaxH3ReferenceToVideo | `prompt` | 唯一的文本输入 |
| 负向提示词 | 无 | — | H3 节点没有负向输入，引导器是 `BasicGuider`（不做 CFG） |
| 时长 | `104` | `length` | 单位是**帧**，不是秒。24 fps，帧数按 17k+5 取整：124 帧 ≈ 5.17 s，243 帧 ≈ 10.1 s。节点说明的训练范围约 124–362 帧 |
| 宽 | `104` | `width` | 必须是 32 的倍数 |
| 高 | `104` | `height` | 必须是 32 的倍数 |
| 步数 | `9` · BasicScheduler | `steps` | 必须和 LoRA 匹配，8 步 LoRA 就填 8 |
| seed | `15` · RandomNoise | `noise_seed` | |
| 首帧 | `200` · LoadImage | `image` | I2VA、FL2VA。接到 `104.first_frame` |
| 末帧 | `203` · LoadImage | `image` | 仅 FL2VA。接到 `104.last_frame` |
| 参考图 0 | `201` · LoadImage | `image` | 仅 R2VA。接到 `104.ref_images.ref_image_0`，prompt 里是"first reference image"，也就是 `<Subject 1>` |
| 参考图 1 | `202` · LoadImage | `image` | 仅 R2VA。接到 `104.ref_images.ref_image_1` |
| 更多参考图 | 自行新增 LoadImage | — | 节点支持 `ref_images.ref_image_0` 到 `ref_image_8`，另有 `ref_videos`、`ref_audios` 输入，我没用过 |
| 参考图缩放 | `104` | `ref_image_size` | 仅 R2VA。`match` 或 `max`。turbo LoRA 按 `match` 训练 |
| 源视频 LoadVideo | 无 | — | |
| 提示词增强 | 无 | — | |
| 帧率 | `91` · CreateVideo | `fps` | 24 |
| 最终输出 | `92` · SaveVideo | `filename_prefix` / `format` / `codec` | 输出 H.264 + AAC 的 mp4，带音频。`/history` 里这个节点的输出在 `images` 字段下 |

其余节点：`6` UNETLoader → `7` LoraLoaderModelOnly → `8` MiniMaxH3SigmaShift → 同时接 `9` BasicScheduler 和 `16` BasicGuider；`13` CLIPLoader（type `minimax`）；`11`/`24` 是视频和音频 VAELoader；`17` KSamplerSelect；`14` SamplerCustomAdvanced；`10` VAEDecode 和 `23` VAEDecodeAudio 再到 `91`。

LoadImage 读的是 ComfyUI `input/` 目录里的文件，图要先用 `POST /upload/image` 传上去，再把返回的 `name` 填进 `image`。

prompt 用 lightx2v 的结构化格式，turbo LoRA 是用这种格式训练的：
- I2VA/FL2VA/T2VA：`integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`，首帧写作 `<Picture 1>`，尾帧写作 `<Picture 2>`。
- R2VA：`subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music`，参考图写作 `<Subject N>`。

## 2. 模型文件

| 文件 | ComfyUI 目录 | 大小 | 来源 |
| --- | --- | --- | --- |
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `models/diffusion_models`（这个镜像实际放在 `models/unet`） | 20,970,379,616 B | `https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | 同上 | 20,970,379,616 B | `…/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `models/text_encoders` | 15,687,142,551 B | `…/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` |
| `minimax_h3_video_vae_fp16.safetensors` | `models/vae` | 5,207,808,496 B | `…/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors` |
| `minimax_h3_audio_vae_fp32.safetensors` | `models/vae` | 605,254,808 B | `…/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors` |

T2VA、I2VA、FL2VA 用 fl2va 底模，R2VA 用 ref2va 底模。

**LoRA**（放在 `models/loras`，权重都是 1.0）

| 文件 | 用于 | 大小 | 来源 |
| --- | --- | --- | --- |
| `minimax_h3_fl2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors` | T2VA / I2VA / FL2VA | 1,956,193,000 B | `https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors` |
| `minimax_h3_ref2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors` | R2VA | 1,956,193,000 B | `…/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_ref2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors` |

**自定义节点：** 没有安装任何自定义节点仓库。用到的节点（包括 `MiniMaxH3ImageToVideo`、`MiniMaxH3ReferenceToVideo`、`MiniMaxH3SigmaShift`）都是这个镜像里 ComfyUI 0.30.0 自带的。

## 3. 实际参数

| 项 | turbo（交付的这四个） | 之前的 20 步原版 |
| --- | --- | --- |
| 分辨率 | 1344×768 | 1344×768（最早一次测试是 864×480） |
| 步数 | 8 | 20 |
| 采样器 / 调度 | euler / simple | res_multistep / simple（fl2va），beta（ref2va） |
| Sigma shift | 视频 6.0，音频 3.0（lightx2v 给 768p 模型的值） | 不接 |
| CFG | 不适用（BasicGuider，等效 1） | 同左 |
| 帧率 | 24 | 24 |
| 单段长度 | 243 帧 ≈ 10.1 s | 同左 |

## 4. 耗时

时间是 `run_h3.py` 从提交到拿到结果的墙钟时间。"冷"表示包含从磁盘加载底模的时间（换底模时也要重新加载），"热"表示底模已经在内存里。

**5 秒片段（124 帧），A100 SXM 80 GB，turbo 8 步，1344×768**（四个工作流按 R2VA → I2VA → T2VA → FL2VA 顺序运行）

| 模式 | 耗时 | 说明 |
| --- | --- | --- |
| R2VA | 392 s | 冷：首次加载 ref2va 底模和文本编码器 |
| I2VA | 296 s | 冷：换成 fl2va 底模 |
| T2VA | 180 s | 热，最能代表 A100 上 5 秒片段的纯生成速度 |
| FL2VA | 229 s | 热，多编码一张尾帧 |

NVFP4 文本编码器和 int8_convrot 底模在 A100（Ampere）上都能直接用，不用改任何节点。

**10 秒片段（243 帧）**

| GPU | 模式 | 设置 | 耗时 |
| --- | --- | --- | --- |
| RTX PRO 6000 Blackwell 96 GB | R2VA turbo | 1344×768，8 步 | 278 s |
| RTX PRO 6000 Blackwell 96 GB | I2VA turbo | 1344×768，8 步 | 263–280 s |
| RTX PRO 6000 Blackwell 96 GB | 文生视频 / I2V 原版 | 1344×768，20 步 | 608–613 s |
| RTX PRO 6000 Blackwell 96 GB | R2VA 原版 | 1344×768，20 步 | 804 s |
| RTX 5090 32 GB | 文生视频原版 | 1344×768，20 步 | 932 s |
| RTX 5090 32 GB | 文生视频原版 | 864×480，20 步 | 363 s |

## 5. 镜像

没有自己写 Dockerfile，用的是 Runpod 官方 ComfyUI 镜像 `runpod/comfyui:1.3.3-comfyuiv0.30.0-cuda13.0`（Runpod 模板 `wgd3p4n4o6`）。宿主机 CUDA 需要 13.0 以上（我们的 pod 是 13.2）；pod 盘至少要放下约 68 GB 的模型（两个底模、文本编码器、两个 VAE、两个 LoRA），我们用的是 100 GB 的 `/workspace`。

## 6. 其他模型版本，以及在 Ampere / Hopper 上怎么选

交付的工作流用的是 `pruned_int8_convrot` 底模加 `nvfp4_awq` 文本编码器。Comfy-Org/MiniMax-H3 里还有下面这些版本，fl2va 和 ref2va 各一套，大小相同；换版本只需要改节点 `6`（`unet_name`）、`13`（`clip_name`）、`11`（`vae_name`）里的文件名。

| 类型 | 文件后缀 | 大小 | Comfy-Org 模型卡的说明 |
| --- | --- | --- | --- |
| 扩散模型 | `pruned_int8_convrot` | 21.0 GB | 首选："prefer `int8_convrot` if you are able to use pytorch with cu130"。本交接用的就是这个 |
| 扩散模型 | `int8_convrot`（未剪枝） | 34.0 GB | 同上 |
| 扩散模型 | `pruned_fp8_scaled` | 21.0 GB | 只在用不了 int8_convrot 时用 |
| 扩散模型 | `pruned_bf16` / `bf16` | 40.2 / 66.3 GB | 原精度 |
| 扩散模型 | `pruned_w6a8` | 16.0 GB | 没有说明 |
| 文本编码器 | `nvfp4_awq` | 15.7 GB | "does not require Blackwell GPU to use" |
| 文本编码器 | `int8_convrot` / `bf16` | 27.1 / 51.5 GB | |
| 视频 VAE | `int8_convrot` / `fp16` | 2.8 / 5.2 GB | |

模型卡没有讲剪枝和未剪枝的区别，也没有显存、速度和画质的对比。

按架构的建议。int8_convrot 只要求 PyTorch 是 cu130，本镜像满足。FP8 的部分是通用硬件知识，不是 H3 官方的说法：

- **Blackwell（RTX PRO 6000、RTX 5090 等）：** 原样使用本交接的配置。两张卡都实测过，见第 4 节。
- **Hopper（H100 80 GB、H200 141 GB）：** 同样用剪枝 int8_convrot 底模加 nvfp4 或 int8 文本编码器。Hopper 有 FP8 张量核心，`pruned_fp8_scaled` 作为备选也能加速。显存够的话可以换未剪枝 int8（34 GB）或 `pruned_bf16`（40 GB）。
- **Ampere（A100 80 GB、A6000 48 GB 等）：** 首选剪枝 int8_convrot 底模，**不要选 fp8_scaled**：Ampere 没有 FP8 张量核心，fp8 权重要先转成 bf16 再算，只省显存、不会更快。文本编码器用 nvfp4 或 int8_convrot 都可以。
- **已实测：** A100 上原样使用本交接的配置可以跑通，5 秒片段热跑约 180–229 s，见第 4 节。Hopper 还没实测。

## 附：模型下载方式

模型是通过这个镜像自带的下载接口拉到 pod 上的：`POST /server_download/start`，body 是 `{"url", "save_path", "filename"}`，再用 `GET /server_download/status` 查进度。这个接口是 Runpod 镜像特有的，换别的环境要改用 `huggingface-cli` 或 `wget` 下载。另外，通过 Runpod 代理访问时请求要带浏览器 User-Agent，否则 Cloudflare 会返回 403。
