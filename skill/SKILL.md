---
name: capture-notes
description: 对「录屏字幕台」（dsh-capture-notes）的会话做二次加工：生成会议/课程/访谈纪要（notes.md）、按 segments.json 生成译文并应用为双语字幕、或调用文件模式 CLI 处理本地视频。当用户说「给最近这次录制出纪要」「把这段录屏翻译成中文」「用这个视频出字幕成片」时使用。
whenToUse: 用户提到录屏字幕台 / capture-notes / 最近一次录制 / 录屏产物，要求出纪要、出译文、加字幕或处理本地视频。
---

# 录屏字幕台 · 会话二次加工（capture-notes）

> 模块根目录：`{{MODULE_ROOT}}`
> 实时/录屏会话：`{{MODULE_ROOT}}\sessions\<id>\`
> 文件模式产物：`{{MODULE_ROOT}}\out\<slug>\`
> 技能已安装为全局技能：`~\.dsh\skills\capture-notes\`

## 先检查

```powershell
cd "{{MODULE_ROOT}}"
node scripts\doctor.mjs
```

`ready: true` 才继续。缺模型/运行时/ffmpeg 时按输出的路径提示处理，不要在工作区里重新 `npm install`。

动手前确认：

- 目标目录里有 `transcript.md` 或 `segments.json`；0 段（纯音乐/静音）**不要**硬写纪要。
- 译文与纪要把逐字稿文本发给模型；先告诉用户这一点，得到同意再跑。
- 不要修改 `segments.json` 的原文，除非用户明确要求纠正错字。

## 定位会话

```powershell
Get-ChildItem "{{MODULE_ROOT}}\sessions", "{{MODULE_ROOT}}\out" -Directory -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 8 FullName,LastWriteTime
```

读 `session.json`：

| 字段 | 用途 |
|---|---|
| `mode` | `live` / `record` / `file` |
| `status` | `completed` 才适合写纪要；`aborted` 只看已恢复的音视频 |
| `languages` | 源语言 / 目标语言 |
| `artifacts` | 逐字稿、字幕、成片、译文的文件名 |
| `recording.video` | 录屏成片（`screen.mp4`） |
| `input.path` | 文件模式的原始媒体路径 |

文件模式没有 `sessions\<id>`，只有 `out\<slug>`；录屏模式的成片与字幕都在会话目录里。

## A. 生成纪要

1. 读 `transcript.md`；需要精确时间戳时配合 `segments.json`。
2. 按 `references\notes-template.md` 写 `notes.md` 到会话目录。
3. 规则：
   - **一律简体**，不要繁体或简繁混排。
   - 每条要点尽量带 `[HH:MM:SS]`。
   - 只写逐字稿里出现的内容；推断标「（推断）」，缺失写「片段未提及」。
   - 会议类给行动项表（谁 / 做什么 / 何时）；课程类给大纲 + 结论；访谈类给观点脉络 + 金句。
   - 超过 40k 字时分块写 `parts\01.md`…，再合并去重。
4. 兜底繁转简：

```powershell
node scripts\cli.mjs simplify --file "sessions\<id>\notes.md"
```

5. 汇报：会话 id、时长、段数、纪要路径、逐字稿路径、识别质量提示（可能错的词、听不清的片段）。

## B. 生成译文并应用

1. 读 `segments.json`，按 `id` 逐段翻译：**不合并、不拆分、不增删**。
2. 写 `translation.<target>.json` 到会话目录：

```json
{
  "schema": 1,
  "target": "zh-CN",
  "source": "segments.json",
  "segments": [{ "id": "s00001", "text": "译文" }]
}
```

3. 应用（默认双语，原文上 / 译文下）：

```powershell
node scripts\cli.mjs apply-translation --session "sessions\<id>" --target zh-CN --format bi --mux soft
```

- `--format bi|target`：双语 / 只出目标语言。
- `--mux none|soft|burn`：只写字幕文件 / 重建软字幕成片 / 烧录硬字幕。
- 校验失败会列出缺失、多余、重复的 id；按提示补齐后重跑，不要改 `segments.json`。
- 产物：`subtitles.srt/.ass`、`transcript.<target>.md`、`subtitled.<target>.mp4`（`--mux` 时）。

## C. 处理本地视频/音频

```powershell
# 默认：逐字稿 + 软字幕成片
node scripts\cli.mjs file --input "D:\videos\a.mp4" --language zh

# 硬字幕 / 只抽内嵌字幕 / 保留音频
node scripts\cli.mjs file --input "D:\videos\a.mkv" --subtitle burn
node scripts\cli.mjs file --input "D:\videos\a.mp4" --subs-only
node scripts\cli.mjs file --input "D:\videos\a.mp4" --keep-audio
```

- 产物在 `out\<slug>\`：`transcript.md/.srt/.txt`、`segments.json`、`subtitles.srt/.ass`、`<原名>.soft.mp4` / `.hardsub.mp4`、`session.json`。
- 中间音频在 `work\<slug>\audio.wav`，默认成功后删除。
- 命令输出 JSON 里的 `outDir` 就是产物目录，直接用它，不要自己拼。
- 进度写 stderr，最终 JSON 写 stdout；不要用管道捕获子进程输出（DSH 沙箱限制）。

## D. 给录屏加字幕（错过了停止后的弹窗）

录屏会话已经有 `segments.json` 时，优先走 B 的 `apply-translation`（复用逐字稿，不重新识别）。

如果只有 `screen.mp4`、没有可用逐字稿，则重新跑文件模式：

```powershell
node scripts\cli.mjs file --input "sessions\<id>\screen.mp4" --language ja --subtitle soft
```

注意：这会重新识别并写到 `out\<slug>\`，不是原会话目录；汇报时要说明。

## 汇报清单

给用户：会话 id / 文件名、时长、段数、产物路径（逐字稿 / 字幕 / 成片 / 纪要 / 译文）、识别质量提示。不要只丢路径。

## 失败处理

| 现象 | 处理 |
|---|---|
| `doctor` 不 ready | 按提示补模型/运行时/ffmpeg；不要在工作区重装 |
| 找不到 `transcript.md` | 会话可能未正常结束；看 `session.json.status` 与 `crashRecovered` |
| 0 段 | 纯音乐/静音；说明情况，不要编纪要 |
| 译文 id 对不上 | 按 CLI 列出的差异补齐；不要改 `segments.json` |
| 繁体残留 | 跑 `simplify` |
| 字幕与画面错位 | 不要用 `--limit` 的结果生成字幕；重新全片转写 |
| 文件没有音频 | 提示换文件或先分离音频 |
| 硬字幕太慢 | 说明 1 小时约 6–12 分钟；可先只出软字幕 |
| 在线链接 | 当前只支持本地文件；先下载 |

## 隐私

- 媒体、逐字稿只落本机；实时翻译会把文本发往 Bing/Google。
- 文件译文与纪要会把逐字稿发进对话上下文/模型；先告知用户。
- 不采集、不保存声纹。
