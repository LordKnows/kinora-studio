# Stave 镜谱：名字与标志

<img src="../public/icon-192.png" alt="Stave 的标志" width="96" height="96">

## 名字

**Stave**，中文名 **镜谱**。

- **Stave** 是五线谱的“谱表”：一组平行的线，音乐写在上面，从左往右是时间，从上往下同时读。
  Studio 的第一页（总谱）就是这样排一部片子的：时间、场次、剧本、分镜、镜次、声音、剪辑，各占一行谱表，
  任何一刻都能竖着读下来。名字就是这一页。
- **镜谱**：镜头的谱。和“曲谱”“棋谱”一样，是一套把东西记下来、照着做的写法；“心里有谱”也是这个谱。
- 描述语：**AI film studio** / **AI 电影工作室**。

为什么是它：一个音节，好读好写，中英文各有自己的意思又指向同一件事；在 AI 视频领域没有撞名
（用这个词的只有几个五线谱记谱小应用，不同行）。

排除过的候选：

| 候选 | 为什么不用 |
|---|---|
| Oner（一镜） | 已有一个叫 Oner AI 的 AI 视频工具，用的也是 MiniMax 的模型 |
| Rushes（样片） | 已有 RushesLab，做的正是给电影人的 AI 镜头生成 |
| 影谱 | 影谱科技是一家做生成式 AI 视频的中国公司 |
| Tally（红灯） | Tally 是很有名的表单工具 |
| Slate、Reel、Kino、Spool | 词太常用，到处都有同名产品 |

### 写法

- 英文写 **Stave**，只有字标用全大写 **STAVE**。中文写 **镜谱**。
- 两个一起出现时写 **Stave 镜谱**（字标、标题），句子里写 **Stave（镜谱）**。
- 界面英文里把产品叫 “the Studio” 的地方照旧；中文界面里直接叫“镜谱”。

## 标志

![标志的构成](../public/og.png)

三行谱表，每行切成长短不一的几段：每一段是一个镜头。一条红线竖着穿过三行：那是“此刻”，
片子现在走到的地方，和总谱页上的红线是同一条。

- **网格**：32 × 32 单位。线宽 2 单位，横线中心在奇数位置（9、15、21），红线在 x = 19、从 4 到 26，
  端点都在偶数位置，所以在 16 px 和 32 px 下每条线都正好落在整像素上，不发虚（`tests/brand.test.ts` 会检查）。
- **两种用法**：
  - 带墨色底板（圆角 7 单位）：图标、favicon、App 图标、社交卡片。
  - 不带底板：印在浅色底上的场合，谱线用正文颜色，红线用 `--accent`。界面顶栏用带底板的，免得在手机上和右边的菜单按钮（☰）混在一起。
- **最小尺寸**：带底板 16 px；不带底板 18 px。
- **字标**：Archivo，宽度 125%，字重 800，全大写，字距 0.14em；旁边的“镜谱”用宋体，700。

### 不要

- 不要改红线的颜色、位置或粗细，不要给它加发光。
- 不要把三行线改成五行（16 px 下会糊成一块），也不要把镜头的切口对齐成一列。
- 不要加渐变、阴影、描边，不要拉伸。
- 红色只表示“此刻 / 在拍 / 下一步”，界面其他地方不要拿它当装饰色。

## 颜色

| 名字 | 色值 | 用途 |
|---|---|---|
| 墨 | `#121212` | 文字、谱线、图标底板 |
| 灰卡 | `#E6E6E4` | 页面底色，图标上的谱线 |
| 红 | `#FF4B1F` | 只表示此刻、在拍、下一步 |

## 字体

- **Archivo**（可变宽度）：标题和字标。
- **IBM Plex Mono**：时间码、编号、读数。
- **宋体**：剧本正文和中文名“镜谱”。

## 文件

| 文件 | 内容 |
|---|---|
| `src/brand.ts` | 名字、描述语、颜色、标志的几何。改名或改标志只改这里 |
| `src/studio-ui/brand-mark.tsx` | 界面里用的标志组件 |
| `scripts/build-brand-assets.mjs` | 从 `src/brand.ts` 生成 `src/app/icon.svg`、`public/icon-*.png`、`src/app/apple-icon.png` 和 `public/og.png`（`node scripts/build-brand-assets.mjs`，需要 Node 22.18 以上和一个 Chromium） |

## 没有改名的东西

改名只改了看得见的地方。下面这些是部署和数据用的标识，改了会断，所以保留旧名：

- Cloudflare Worker `cinema-studio`、`cinema-studio-cron`，D1 数据库和 R2 桶 `studio`：
  Worker 改名等于新建一个 Worker，原来的密钥和域名不会跟过来。
- RunPod 上的 GPU 机器 `cinema-studio-h3*` 和绘图机 `cinema-studio-painter*`：Studio 靠这些名字认领已有的机器。
- 数据库迁移文件里的注释（已经执行过的迁移不改）。
- `docs/cinema-studio-h3-design.md`：最初复刻 Higgsfield Cinema Studio 的设计稿，保留原文。
- GitHub 仓库名 `open-higgsfield-server`：要改的话在 GitHub 仓库的 Settings → General → Repository name 里改，
  旧地址会自动跳转；改完把 Cloudflare Workers Builds 里连接的仓库确认一下。

导演包的自定义风格目录从 `~/.openhiggsfield/my-styles` 改成了 `~/.stave/my-styles`；
只有旧目录存在时仍然读旧目录，不用手动搬。
