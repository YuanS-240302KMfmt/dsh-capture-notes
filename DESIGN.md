# 录屏字幕台 · 设计

> 需求基线：[`docs/capture-notes-requirements.md`](docs/capture-notes-requirements.md)（v1.2，已冻结）
> 参考实现：`live-translate`、`.video-notes`（只读，不修改；不在本仓库）

## 1. 架构

```
┌──────────────── 小窗（WPF / PowerShell） ────────────────┐
│ 实时 / 录屏 / 文件 三 tab，字幕区，状态区                    │
│ 采集：NAudio WASAPI loopback + 麦克风（分轨）               │
│ 录屏：ffmpeg gdigrab（无音轨）→ 停止后与两路 WAV 封装        │
└───────────────┬──────────────────────────────┬───────────┘
                │ start.json / PCM 分片          │ live.json
                ▼                               │
┌──────────────── Host（lib/index.js） ──────────┴───────────┐
│ native watcher → 双路 ASR worker（VAD + SenseVoice）        │
│ 翻译队列（ctx.translator）→ 字幕事件 → 小窗快照             │
│ 会话清单 session.json、产物落盘、CLI（文件模式）             │
└────────────────────────────┬───────────────────────────────┘
                             ▼
              sessions\<id>\  work\<slug>\  out\<slug>\
```

- 实时与文件共用 `lib/core`：audio / asr / subtitle / media / session。
- 双路识别：每路一个 VAD+Recognizer 实例；字幕带 `source: system|mic`。
- 录屏不实时叠加字幕；停止后由文件模式复用会话 `segments.json` 生成成片。

## 2. 关键决策（摘要）

| 决策 | 结论 |
|---|---|
| 定位 | 实时与文件双入口同等 |
| 独立性 | 自带模型/运行时，不引用旧目录 |
| 说话人 | v1 不做聚类；用双路做天然两人先验（P1 功能在 P6） |
| 录屏 | 全屏，MP4 + 2 音轨 + WAV 分轨；停止后弹窗加字幕 |
| 文件译文 | agent 生成 `translation.<target>.json`，默认双语 |
| 纪要 | 按需由技能生成，不自动烧 token |

完整表见需求文档第 1、11 节。

## 3. P0 验证（已完成）

结果见 [`p0\REPORT.md`](p0/REPORT.md)：v1 录屏+双轨封装、v2 双路 ASR、v3 音频分轨三项通过；麦克风一路被 Windows 拒绝（`E_ACCESSDENIED`），P0 用替身音轨完成了封装验证。

| 脚本 | 验证 | 实测 |
|---|---|---|
| `p0/v1-record.mjs` | gdigrab + NAudio 双路 → MP4 双音轨 | 2560×1600@30，2 条 AAC 音轨，时长差 0 s，解码通过 |
| `p0/v2-dual-asr.mjs` | 两个 SenseVoice+VAD worker 并发 | 双路 RTF 0.042（23.8×），两路文本正确 |
| `p0/v3-audio-tap.mjs` | 一次采集同时出 48k WAV 与 16k 分片 | 6.08 s vs 6.00 s，节奏均值 495 ms |

环境事实：ffmpeg 为 2018 构建（N-92722），`-devices` 不列 gdigrab 但实测可用；P5 换现代 ffmpeg 静态构建。麦克风需在 Windows 隐私设置里放行桌面应用后重跑。

## 4. 阶段

| 阶段 | 内容 |
|---|---|
| P0 | ✅ 三个验证脚本（`p0/`） |
| P1 | ✅ 双 lane 采集、识别、翻译、归档、MD/SRT、独立小窗 |
| P2 | ✅ 全屏录制、双音轨、同会话字幕、MP4 封装、后处理弹窗、崩溃恢复、磁盘检查 |
| P3 | ✅ 文件模式、软/硬字幕成片、只抽内嵌字幕、CLI、agent 译文应用 |
| P4 | ✅ 全局技能、纪要/译文/文件工作流、演示会话 |
| P5 | ✅ 自带模型/运行时、profile 接入、`selfContained` 与空参考目录验证 |
| P6 | 说话人聚类 + 重叠标记（按设计文档，另行立项） |

## 5. 文件职责

| 路径 | 职责 | 状态 |
|---|---|---|
| `lib/index.js` | Host：native watcher、双 lane 会话、翻译队列、快照、归档、录制封装、后处理、崩溃恢复、文件任务 | P3 |
| `lib/window.ps1` | WPF 小窗：实时/录屏/文件 tab、采集、分片/归档、gdigrab、后处理弹窗、文件进度、预览与诊断 | P3 |
| `lib/asr-worker.js` | 每 lane 一个 VAD + SenseVoice，临时/最终字幕（实时与文件共用） | P1 |
| `lib/core/media.js` | ffmpeg：probe、TS concat + 双音轨封装、软字幕 mux、硬字幕烧录 | P2 |
| `lib/core/subtitle.js` | 逐字稿 → 字幕 cue（单语重切 / 双语整段）、SRT / ASS | P2 |
| `lib/core/pipeline.js` | 文件流水线：抽音、识别、简体、逐字稿、字幕、成片；译文应用 | P3 |
| `lib/capture.ps1` | NAudio + gdigrab 独立采集脚本 | 未使用（采集在 window.ps1 内） |
| `scripts/cli.mjs` | 文件模式、译文应用、繁转简（技能调用） | P3 |
| `scripts/install-skill.ps1` | 把 `skill/` 安装/升级到 `~\.dsh\skills\capture-notes` | P4 |
| `scripts/doctor.mjs` | 模型/运行时/设备/ffmpeg 自检 | P1 |
| `skill/SKILL.md` | 纪要、译文、文件三条工作流；已安装为全局技能 | P4 |

### 5.1 P1 文件协议

窗口与 Host 只通过文件交换数据，不共享进程、不互相调用：

| 文件 | 方向 | 内容 |
|---|---|---|
| `native/start.json` | 窗口 → Host | `{ lanes, language, target, provider, formats }` |
| `native/chunks/<lane>/chunk-*.pcm` | 窗口 → Host | 16 kHz mono PCM16，每片 0.5 s |
| `native/audio/<lane>.wav` | 窗口 → Host | 设备原生格式归档，停止时移入会话 |
| `native/stop.request` | 窗口 → Host | 停止并冲刷尾段 |
| `live.json` | Host → 窗口 | 状态、双 lane partial、最近 8 段（原文/译文） |
| `window.pid` / `alive.txt` | 窗口 → Host | 存活心跳 |
| `show.request` / `quit.request` | Host → 窗口 | 召回 / 退出 |

时序：窗口先打开设备并写 `start.json`，随后每 0.5 s 落分片；Host 每 250 ms 取走并删除分片。停止时窗口先关设备、冲刷尾片，再写 `stop.request`；Host 先做一次最终摄取，再让 worker 冲刷 VAD，最后落盘。

### 5.2 P2 录制与后处理协议

| 文件 | 方向 | 内容 |
|---|---|---|
| `native/video/part-%03d.ts` | 窗口 → Host | gdigrab H.264，1 s 分片，1 s GOP |
| `native/record.json` | 窗口 → Host | `{ audioStartedAt, videoStartedAt }`，用于裁剪音频前导 |
| `native/post.request` | 窗口 → Host | `{ sessionId, mode: soft\|burn\|srt }` |
| `native/post.json` | Host → 窗口 | `{ status: running\|done\|error, output, cues, error }` |

录制时序：

1. 窗口打开音频设备 → 启动 ffmpeg（无音轨 TS 分片）→ 写 `record.json` 与 `start.json`。
2. Host 建会话、双 lane 识别；视频分片只落盘，不进内存。
3. 停止：窗口杀 ffmpeg → 关音频、冲刷尾片 → 写 `stop.request`。
4. Host 移归档 → `concatAndMux`（TS + 1~2 路 WAV，按前导裁剪）→ `screen.mp4` → 写 `session.json`、`live.json`（stopped）。
5. 窗口弹窗 → `post.request` → Host 用会话 `segments.json` 重切字幕 → `subtitles.srt/.ass` → `screen.soft.mp4` / `screen.hardsub.mp4` → `post.json`。

崩溃恢复：插件启动时若 `native/video` 里存在超过 5 秒未更新的有效分片，就把分片 + `native/audio` 恢复成 `sessions/recovered-<stamp>/screen.mp4`，清单标记 `status: aborted`、`crashRecovered: true`。最多丢最后一个 1 秒分片。

后处理字幕：双语时一条 ASR 段对应一条 cue（原文在上、译文在下，各最多两行）；单语时按标点与宽度重切成 cue。软字幕保留视频流、加 `mov_text` 轨；硬字幕用 ASS 重编码，字号按画面高度 4.5%。

### 5.3 P3 文件任务协议与 CLI

窗口的文件 tab 只写请求，Host 在进程内跑流水线（与实时/录屏互斥）：

| 文件 | 方向 | 内容 |
|---|---|---|
| `native/file.request` | 窗口 → Host | `{ input, language, subtitle: soft\|burn\|both\|none, font, margin }` |
| `native/file.cancel` | 窗口 → Host | 取消当前任务 |
| `native/file.json` | Host → 窗口 | `{ status: running\|done\|cancelled\|error, stage, percent, outDir, result, error }` |

流水线（`lib/core/pipeline.js`）：

1. `probe` 输入；`subs-only` 时只抽 `0:s:0` 到 `transcript.srt`。
2. ffmpeg 抽 16 kHz mono WAV 到 `work/<slug>/audio.wav`。
3. 复用 `asr-worker.js` 单 lane 流式识别；按 30 s 块喂入，进度按已喂样本数上报。
4. 中文/粤语段经 OpenCC `t → cn` 统一简体。
5. 写 `transcript.md/.srt/.txt`、`segments.json`、`subtitles.srt/.ass`。
6. 默认软字幕成片；可选硬字幕；`--limit` 时跳过成片避免错位。
7. 写 `out/<slug>/session.json`；默认删除 `audio.wav`（`--keep-audio` 保留）。

译文应用（`applyTranslation`）：

- 输入 `translation.<target>.json`，按 `id` 与 `segments.json` 严格对齐；缺失/多余/重复 id 直接报错。
- 默认双语字幕，`--format target` 出单语；写 `subtitles.srt/.ass` 与 `transcript.<target>.md`。
- `--mux soft|burn` 时用原始输入视频重建成 `subtitled.<target>.mp4` / `subtitled.<target>.hardsub.mp4`。
- 更新 `session.json.artifacts.translations` 与 `subtitledVideo`。

CLI（`scripts/cli.mjs`）：

```powershell
node scripts\cli.mjs file --input <media> [--subtitle soft|burn|both|none] [--subs-only] [--keep-audio]
node scripts\cli.mjs apply-translation --session <dir|id> --target zh-CN [--format bi|target] [--mux none|soft|burn]
node scripts\cli.mjs simplify --file <md>
```

取消：Host 用 `AbortController`；识别阶段终止 worker，抽音阶段终止 ffmpeg，封装/烧录阶段尽力而为。

### 5.4 P4 技能工作流

技能源在 `skill/`，安装到 `~\.dsh\skills\capture-notes\`（`SKILL.md` + `references\notes-template.md`）；`scripts/install-skill.ps1` 负责复制/升级。

| 用户意图 | 技能动作 |
|---|---|
| 「给最近这次录制出纪要」 | 定位 `sessions/` 或 `out/` 最新会话 → 读 `transcript.md`/`segments.json` → 按模板写 `notes.md` → `simplify` |
| 「把这段录屏翻译成中文/英文」 | 逐段写 `translation.<target>.json` → `apply-translation --format bi --mux soft` |
| 「把这个视频出字幕」 | `cli.mjs file --input ...`（软/硬/只抽字幕） |
| 「给录屏加字幕，但错过了弹窗」 | 有 `segments.json` 走译文应用；否则 `file --input screen.mp4` 重新识别 |

约束：只用逐字稿里出现的内容；漏识标「片段未提及」；纪要一律简体；译文 id 严格对齐；不覆盖 `segments.json` 原文；先把隐私边界告诉用户。

演示：`sessions\p4-demo\`（90 秒合成会话）已生成 `notes.md`、`translation.en.json`、双语 `subtitles.srt`、`subtitled.en.mp4`（25 条 cue），`session.json.artifacts.notes = notes.md`。

### 5.5 P5 打包与独立性

```
capture-notes\
  models\sensevoice\model.int8.onnx   229 MB
  models\silero_vad.onnx              0.6 MB
  runtime\node_modules\
    sherpa-onnx-node + sherpa-onnx-win-x64   22 MB
    opencc-js                                 6 MB
    @ffmpeg-installer (+ win32-x64)          62 MB
    @ffprobe-installer (+ win32-x64)         77 MB
```

合计约 396 MB。路径解析一律**模块优先**，`.video-notes` 只作回退：

- `media.resolveFfmpeg/ffprobe`：`runtime/ffmpeg` → `runtime/node_modules/@*-installer` → `.video-notes`
- `index.resolveEngine`：`runtime/node_modules` → `.video-notes`；`models/sensevoice` → `.video-notes`
- `pipeline.runtimeDir` / `resolveModel` / `resolveVad`：同上

profile 接入（一次性）：

- `profiles/desktop/package.json`：`dependencies` 加 `"dsh-capture-notes": "link:D:/dsh_mod/capture-notes"`，`dsh.profile.bundles` 加 `dsh-capture-notes`。
- 模块自带 `cordis.patch.yml` 插入 `id: capture-notes`；不要在 profile 的 patch 里重复插入。
- `pnpm install` 后 node_modules 下生成 junction；重启 DSH 生效。

自检：

```powershell
node scripts\doctor.mjs        # ready:true, selfContained:true, runtimeSource:module
$env:VIDEO_NOTES_HOME='<空目录>'
node tests\file-e2e.mjs        # 仍通过，证明不依赖 .video-notes
```

`models/`、`runtime/` 被 `.gitignore` 忽略；npm `files` 不包含，当前是本地 link 安装。

## 6. 边界

- 不写入 `.video-notes`，不接管 `live-translate` 的插件 id 与输出目录。
- 不注册 DSH 页面内悬浮 UI。
- 所有媒体只落本机；实时翻译会发送文本，文件译文会进入模型上下文（需明示）。
