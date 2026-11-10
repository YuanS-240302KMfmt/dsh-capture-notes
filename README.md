# 录屏字幕台（dsh-capture-notes）

Windows 桌面小窗模块：**实时 / 录屏 / 文件**三种模式共用一套「采集 → VAD → 识别 →（翻译）→ 字幕 / 逐字稿」引擎。

- 实时：系统音频 / 麦克风分轨采集，本地 SenseVoice 识别，内置 translator 出双语字幕。
- 录屏：全屏 + 两条独立音轨，同一次会话出字幕；停止后弹窗一键加软/硬字幕。
- 文件：本地视频/音频 → 逐字稿 + 软/硬字幕成片；支持只抽内嵌字幕、CLI、agent 译文应用。
- 纪要 / 文件译文：由 agent 在对话中按需生成。

完整需求见 [`docs/capture-notes-requirements.md`](docs/capture-notes-requirements.md)（v1.2，已冻结）。

## 当前状态

| 阶段 | 状态 |
|---|---|
| 需求冻结 | ✅ 2026-11-08 |
| 骨架 | ✅ 目录 / 包元数据 / 技能源 |
| P0 技术验证 | ✅ 3/3 通过（麦克风权限已于 2026-11-10 放行并实测）→ [`p0\REPORT.md`](p0/REPORT.md) |
| P1 实时链路 | ✅ 双 lane 采集、识别、翻译、归档、MD/SRT/segments、独立小窗 |
| P2 录屏链路 | ✅ 全屏录制、双音轨、同会话字幕、MP4 封装、后处理弹窗、崩溃恢复、磁盘检查 |
| **P3 文件链路** | ✅ 抽音/识别/逐字稿、软/硬字幕成片、只抽字幕、CLI、agent 译文应用、窗口文件 tab |
| **P4 技能与纪要** | ✅ 全局技能已安装、纪要/译文/文件三条工作流、演示会话产物 |
| **P5 打包与独立性** | ✅ 本地安装自带模型/运行时、profile 接入、`selfContained` 与空参考目录验证；GitHub clone 不含这两块（见「从源码运行」） |
| **0.7.0 稳定性/格式/托盘** | 🚧 长文件、格式边界、取消、托盘、最近会话、译文状态已实现；待人工验收 |

测试（全部通过）：

| 命令 | 覆盖 |
|---|---|
| `node tests/e2e.mjs` | P1 双 lane 文件协议、翻译、产物、归档移动 |
| `node tests/window-e2e.mjs` | 真实小窗采集系统回环 → Host → 落盘 |
| `node tests/record-e2e.mjs`（`P2_POST=soft`） | 真实录屏 + 双轨音频 + 封装 + 软字幕 |
| `node tests/record-e2e.mjs`（`P2_POST=burn`） | 硬字幕烧录 |
| `node tests/recovery-e2e.mjs` | 中断录制从 TS 分片恢复为可播 MP4 |
| `node tests/file-e2e.mjs` | 文件流水线、双语译文、id 校验、只抽字幕 |
| `node tests/file-host-e2e.mjs` | `native/file.request` → Host 文件任务 |
| `node tests/file-window-e2e.mjs` | 真实小窗发起文件任务并显示进度 |
| `VIDEO_NOTES_HOME=<空目录> node tests\file-e2e.mjs` | 不依赖 `.video-notes` 的独立性验证 |
| `pwsh -File tests\window-stale-snapshot.ps1` | 旧 `stopped` 快照不再误停新采集；同会话真停止仍生效 |
| `node tests/formats-e2e.mjs` | 纯音频、无音轨、MKV、内嵌字幕 |
| `node tests/cancel-e2e.mjs` | 取消 ASR / mux / burn，无半成品 |
| `pwsh -File tests/tray-e2e.ps1` | 关闭到托盘、quit 退出 |
| `pwsh -File tests/recent-e2e.ps1` | 「最近」菜单打开不闪退 |
| 真实 88 分钟文件（手工） | 814 段、174 s、峰值 591 MB、成片 10.9 GB |
| 本地 `sessions\p4-demo\`（手工演示，不提交） | 技能：纪要、英文译文、双语字幕成片、简繁兜底 |

## 从源码运行（Git clone）

仓库**不包含** `models\` 与 `runtime\`（合计约 396 MB，见 `.gitignore`）。首次运行前需要准备：

```
models\
  sensevoice\model.int8.onnx
  sensevoice\tokens.txt
  silero_vad.onnx
runtime\node_modules\
  sherpa-onnx-node\
  sherpa-onnx-win-x64\
  opencc-js\
  @ffmpeg-installer\
  @ffprobe-installer\
```

可以从已有的 `live-translate` / `.video-notes` 安装复制，或按相同版本下载；详细步骤见 [`docs/assets.md`](docs/assets.md)。准备后：

```powershell
node scripts\doctor.mjs     # ready: true / selfContained: true
node tests\e2e.mjs
```

模型与运行时不要提交到 Git；`.gitignore` 已排除。没有这两块时，窗口和 CLI 会明确报缺模型/ffmpeg。

## P3 怎么工作

```
本地视频/音频
  → ffmpeg 抽 16 kHz 单声道 WAV（work/<slug>/audio.wav）
  → SenseVoice + Silero VAD（复用实时 lane 的 worker）
  → OpenCC 简体（中文/粤语段）
  → transcript.md / .srt / .txt / segments.json
  → subtitles.srt / .ass（字幕级重切）
  → 默认软字幕成片 <原名>.soft.mp4；可选硬字幕 <原名>.hardsub.mp4
  → out/<slug>/session.json
```

窗口文件 tab：选择文件 → 字幕形态（软/硬/软+硬/仅字幕）→ 开始处理；进度来自 `native/file.json`，可取消、可打开输出目录。

CLI（技能与批处理用）：

```powershell
cd <仓库目录>

# 文件 → 逐字稿 + 软字幕（默认）
node scripts\cli.mjs file --input "D:\videos\a.mp4" --language zh

# 硬字幕、只抽内嵌字幕、保留音频
node scripts\cli.mjs file --input "D:\videos\a.mkv" --subtitle burn
node scripts\cli.mjs file --input "D:\videos\a.mp4" --subs-only
node scripts\cli.mjs file --input "D:\videos\a.mp4" --keep-audio

# agent 写好 translation.<target>.json 后应用：默认双语，可选重建软/硬字幕成片
node scripts\cli.mjs apply-translation --session out\<slug> --target zh-CN --format bi --mux soft
node scripts\cli.mjs apply-translation --session out\<slug> --target zh-CN --format target

# 纪要繁体兜底
node scripts\cli.mjs simplify --file out\<slug>\notes.md
```

产物：

```
out\<slug>\
  session.json
  transcript.md / .srt / .txt
  segments.json
  subtitles.srt / .ass
  <原名>.soft.mp4          # 软字幕成片
  <原名>.hardsub.mp4       # 硬字幕成片
  translation.<target>.json  # agent 译文（可选）
  transcript.<target>.md     # 双语逐字稿（apply 后）
  subtitled.<target>.mp4     # 译文重建成片（apply 后）
work\<slug>\
  audio.wav                # 默认成功后删除，--keep-audio 保留
```

## P4 技能怎么用

技能已安装为全局技能：`~\.dsh\skills\capture-notes\`（`SKILL.md` + `references\notes-template.md`）。

```powershell
# 重装/升级（默认装到全局；-Target 可改到别处）
pwsh -File scripts\install-skill.ps1
```

典型对话：

- **「给最近这次录制出纪要」** → 技能定位 `sessions/` 或 `out/` 的最新会话，读 `transcript.md` / `segments.json`，按模板写 `notes.md`，跑 `simplify` 兜底。
- **「把这段录屏翻译成英文」** → 逐段写 `translation.en.json`，`apply-translation` 校验并重建双语成片。
- **「把这个视频出字幕」** → `file` 命令；默认软字幕，可选硬字幕/只抽字幕。

本地演示会话（不随仓库提交）：`sessions\p4-demo\`（90 秒，8 段）：

- `notes.md`：简体、带时间戳、行动项与「片段未提及」口径。
- `translation.en.json` → `subtitles.srt` / `subtitled.en.mp4`（25 条双语 cue）。
- `session.json.artifacts.notes = notes.md`。

注意：纪要质量由 agent 写，模块不做自动摘要；技能安装需要写 `~\.dsh\skills`，其它已打开的 DSH 会话可能需要重启才会加载新技能。

## P5 打包与独立性

- 本地安装自带 `models\`（229 MB）与 `runtime\node_modules\`（167 MB：sherpa 原生库、ffmpeg/ffprobe、opencc），合计约 **396 MB**；GitHub clone 不包含这两块，见「从源码运行」。
- `node scripts\doctor.mjs` → `ready: true`、`selfContained: true`、`runtimeSource: module`。
- 把 `VIDEO_NOTES_HOME` 指到空目录后，文件流水线仍能完成识别、字幕与成片（已实测）。
- 已接入 desktop profile：
  - `C:\Users\<user>\.dsh\profiles\desktop\package.json` 的 `dependencies` 与 `bundles` 加入 `dsh-capture-notes`（`link:<仓库目录>`）。
  - 由模块自己的 `cordis.patch.yml` 插入 `id: capture-notes`；pnpm 已生成 junction。
  - **重启 DSH 后生效**；默认 `openOnStart: true`，启动时会自动打开小窗。
- 升级模块后无需改 profile；重跑 doctor 与测试即可。
- 重启验收清单：[`docs/capture-notes-restart-verification.md`](docs/capture-notes-restart-verification.md)（preflight / after 检查、手动验收、失败处理、回滚）。
- 本次重启结果：[`docs/capture-notes-restart-report.md`](docs/capture-notes-restart-report.md)（Host 实时/文件/录屏+后处理、双音轨、文件三形态与译文烧录已通过）。
- 0.7.0 需求：[`docs/capture-notes-v0.7.0-requirements.md`](docs/capture-notes-v0.7.0-requirements.md)；实施记录：[`docs/capture-notes-v0.7.0-report.md`](docs/capture-notes-v0.7.0-report.md)。
- `models\`、`runtime\` 已在 `.gitignore`；npm `files` 不包含它们，当前是本地 link 安装，不是 npm 发布包。

## 运行与自检

```powershell
cd <仓库目录>

node scripts\doctor.mjs
node scripts\verify-install.mjs          # 重启前
# 重启 DSH 后：
node scripts\verify-install.mjs --after
node tests\file-e2e.mjs
node tests\file-host-e2e.mjs
node tests\file-window-e2e.mjs
```

窗口预览：

```powershell
pwsh -STA -File lib\window.ps1 -PreviewPath p0\.tmp\preview.png -DataDir p0\.tmp\window-data
pwsh -STA -File lib\window.ps1 -PreviewPath p0\.tmp\record.png -PreviewMode record -DataDir p0\.tmp\window-data
pwsh -STA -File lib\window.ps1 -PreviewPath p0\.tmp\post.png -PreviewMode record -PreviewPost -DataDir p0\.tmp\window-data
pwsh -STA -File lib\window.ps1 -PreviewPath p0\.tmp\file.png -PreviewMode file -DataDir p0\.tmp\window-data
```

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `runtimeDir` / `modelDir` / `vadModelPath` | 自动探测 | P3 借用 `.video-notes`；P5 改为自带 |
| `sessionsDir` | `<模块>\sessions` | 实时/录屏会话 |
| `fileOutRoot` / `fileWorkRoot` | `<模块>\out` / `<模块>\work` | 文件模式产物与中间文件 |
| `windowDataDir` | `<模块>\runtime-data` | 窗口/分片/归档/任务状态（放模块内，避开 `%LOCALAPPDATA%` 写入限制） |
| `threads` | 6 | 双 lane 时每路 3；文件任务单 lane |
| `idleStopMs` | 180000 | 无音频自动停止 |
| `nativeWindow` / `openOnStart` | true | 是否开独立小窗 |

## 已知限制（P3/P4/P5/0.7）

- **profile 生效**：已写入 desktop profile 并完成 pnpm link，但需要重启 DSH 才会加载插件；首次启动会自动打开小窗。
- **发布形态**：`models\` 与 `runtime\` 在 `.gitignore` 中，npm `files` 也不包含；当前是本地 `link:` 安装，不是可直接分发的 npm 包。
- **纪要**：由 agent 按模板写，模块不做自动摘要；质量取决于模型与逐字稿质量。
- **技能安装**：需要写 `~\.dsh\skills`；其它已打开的 DSH 会话可能需要重启才会加载新技能。
- **P4 演示**：本地 `sessions\p4-demo` 是合成会话（90 秒 testsrc + 手写逐字稿），用于验证技能流程，不是真实会议；它不提交到仓库。
- **麦克风**：需在 Windows 隐私设置中允许桌面应用访问麦克风；本机已于 2026-11-10 实测系统+麦克风双音轨通过。
- **长媒体**：文件流水线已实测 88 分钟、814 段、成片 10.9 GB；60 分钟长**录屏**仍未压测（0.8.0）。
- **取消**：文件任务在 ASR/mux/burn 阶段均已实测可取消；取消时清理最终半成品，临时目录可能保留供排查。
- **译文**：模块不内置文件翻译，必须由 agent 写 `translation.<target>.json`；id 缺失/多余/重复会拒绝。文件 tab 只显示译文状态。
- **硬字幕**：重编码耗时约 6–12 分钟/小时，画质有一次损失。
- **托盘**：0.7.0 已实现关闭到托盘、显示/退出菜单；托盘菜单的人工点击验收待补。
- **多显示器**：当前只有单屏环境，未做多屏/负坐标/DPI 适配验收。
- **沙箱**：窗口数据默认在模块 `runtime-data\`（避开 `%LOCALAPPDATA%` 的写入限制）；可用 `windowDataDir` 改到别处。

## License

本项目采用 **Apache License 2.0**。完整文本见 [`LICENSE`](LICENSE)，版权与第三方组件声明见 [`NOTICE`](NOTICE)、[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

`models/` 与 `runtime/` 不随仓库分发；如果重新打包包含 ffmpeg/ffprobe 或模型文件，请保留并遵守其上游许可（ffmpeg/ffprobe 为 LGPL-2.1）。

## 边界

- 不改动 `live-translate` 与 `.video-notes`。
- 不注册 DSH 页面内悬浮 UI。
- 所有媒体只落本机；实时翻译会把文本发往 Bing/Google（可只识别不翻译）。

