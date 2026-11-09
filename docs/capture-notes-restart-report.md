# 录屏字幕台 · 重启验证报告

> 日期：2026-11-08 20:13–20:31 · 模块：`dsh-capture-notes` 0.6.0
> 结论：**插件已随 DSH 加载，实时 / 文件 / 录屏封装 + 后处理在真实 Host 进程内全部通过。**
> 未覆盖：窗口按钮的自动点击与文件选择框（宿主提权，当前 shell 无法控制该窗口）。

## 1. 环境

| 项 | 值 |
|---|---|
| DSH 重启时间 | 2026-11-08 20:13:54 |
| 小窗进程 | PID 144320，标题「录屏字幕台」 |
| 窗口数据目录 | `<仓库目录>\runtime-data`（初版为 `%LOCALAPPDATA%\DshCaptureNotes`，见第 9 节） |
| 初始快照 | `live.json`：`status=idle`、`lanes.system.active=true` |
| 窗口错误日志 | 仅 launch 一行，无异常 |

## 2. 自动检查

```powershell
node scripts\verify-install.mjs --after
```

结果：`ready: true`（30 项；窗口进程、`live.json`、`native`、日志均通过）。

> 首次运行时 `window process` 误判失败：Node 对提权进程 `process.kill(pid, 0)` 返回 `EPERM`。
> 已修正校验脚本：`EPERM` 视为进程存在；复跑 PASS。

## 3. 生产 Host 功能验证

为了不依赖窗口点击，通过真实 DSH Host 的 native 文件协议驱动同一条链路。

### 3.1 实时（系统音频 → 识别 → 归档）

| 项 | 结果 |
|---|---|
| 会话 | `cn-20261108-202703-454c` |
| 状态 | listening → stopped |
| 识别 | 1 段「开饭时间早上9点至下午5点。」 |
| 产物 | `transcript.md`、`transcript.srt`、`segments.json`、`audio\system.wav`（178,988 B） |

### 3.2 文件模式（8 秒 mp4 → 逐字稿 + 软字幕成片）

| 项 | 结果 |
|---|---|
| 输出 | `out\sample-de0fcc5b\` |
| 进度 | `file.json` running → done 100% |
| 识别 | 2 段（开饭时间… / 开放时间早上） |
| 成片 | `sample.soft.mp4`：`h264,video` + `aac,audio` + `mov_text,subtitle` |
| 其他 | `transcript.md/.srt/.txt`、`segments.json`、`session.json` |

### 3.3 录屏封装 + 后处理

用一段 5 秒 TS 分片 + 系统 WAV + 实时分片驱动 `mode=record` 会话（窗口 gdigrab 采集在重启前已由 `record-e2e` 覆盖）：

| 项 | 结果 |
|---|---|
| 会话 | `cn-20261108-203012-abac` |
| 封装 | `screen.mp4`：`h264,video` + `aac,audio` |
| 后处理 | `post.json` done，1 条 cue |
| 软字幕 | `screen.soft.mp4`：`h264` + `aac` + `mov_text` |
| 清单 | `session.json` 的 `recording.video`、`artifacts.subtitledVideo` 均已更新 |

## 4. 窗口交互（未自动化）

当前 shell 与 DSH 宿主不在同一完整性级别，以下操作被 UIPI/前台锁拒绝：

- `SetForegroundWindow` 返回 False，窗口无法切到前台；
- `UIAutomation` 能识别窗口，但 `Descendants=0`，拿不到按钮；
- `PrintWindow` 返回 False；屏幕抓图只能抓到上层浏览器；
- 合成鼠标/键盘输入不可靠，未执行，避免误点其它应用。

因此以下项目需要人工点一次（窗口本身已确认存在且响应）：

- [ ] 实时 tab：开始 → 播放声音 → 出现 `[系统]` 字幕 → 停止。
- [ ] 录屏 tab：开始 → 10 秒 → 停止 → 弹窗选软字幕。
- [ ] 文件 tab：选择文件 → 开始处理 → 进度 → 打开目录。
- [ ] 新开会话说「给最近这次录制出纪要」，确认 `capture-notes` 技能触发。

技能本身已在重启后的会话目录中加载（`capture-notes` 可用）；P4 演示 `sessions\p4-demo\notes.md` 与 25 条双语字幕仍可打开。

## 5. 本次发现

| # | 现象 | 处理 |
|---|---|---|
| 1 | `verify-install --after` 对提权窗口 `process.kill(pid,0)` 返回 `EPERM`，误判窗口死亡 | 已改为 `EPERM` 视为存在；复跑 PASS |
| 2 | Host 托管窗口的 ffmpeg 写 `%LOCALAPPDATA%\...\native\video` 报 Permission denied；同一 2018 构建写模块内目录正常 | 已将默认窗口数据目录改到模块 `runtime-data`（第 9 节）；字幕额外加了视频时长上限 |
| 3 | 后处理生成 `screen.soft.mp4.log` 落在会话目录 | `runPostProcess` 改为 `post-mux.log` / `post-burn.log`（下次重启生效） |

## 6. 待人工确认

窗口 UI 的四项交互（第 4 节）与真实 gdigrab 录制需要人工点击一次；完成后把结果补进
[`capture-notes-restart-verification.md`](capture-notes-restart-verification.md) 的验收记录表。

如果点击后仍失败，优先看：

- `<仓库目录>\runtime-data\window-error.log`
- `<仓库目录>\runtime-data\live.json`
- 会话目录 `mux.log` / `post-mux.log`

## 7. 2026-11-09 追加修复：点击开始后秒停

用户反馈：实时 tab 点「开始」后约 1 秒自动停止。日志显示连续出现 4 个 0 段会话，每个只存活 1–2 秒。

**原因**：窗口启动采集后，轮询先读到**上一场**留下的 `live.json`（`status=stopped`）。`Update-FromSnapshot` 原逻辑只要「正在采集 + 快照 stopped」就调用 `Stop-Session`，于是新采集被旧快照立刻停掉。

**修复**（`lib/window.ps1`）：

- 启动采集时记下 `captureStartedAt`，并清空 `activeSessionId`。
- 收到 `starting` / `listening` 快照时，记录当前 `sessionId`。
- 只有「快照 sessionId 与当前会话一致」才响应 `stopped`/`error`；启动后 5 秒内还没拿到新 sessionId 时忽略旧停止快照。

**验证**：

- 新增 `tests/window-stale-snapshot.ps1`：先注入旧 `stopped` 快照，启动窗口，断言不误停；再注入同一会话的 `stopped`，断言正常收尾。结果 `ok: true`。
- `tests/window-e2e.mjs`、`tests/record-e2e.mjs` 回归 PASS。

**生效与实测**：

- 旧窗口进程已结束，已用修复后的脚本在同一数据目录重新拉起窗口（PID 53128）。
- 2026-11-09 04:47 实测：实时会话 `cn-20261109-044738-1b2a` 持续 **29.2 秒**、5 段，`auto → ja` 译文正常，停止后 MD/SRT/segments/session 落盘；不再秒停。
- 重启 DSH 后，Host 会用同一份修复脚本重新托管窗口，无需再改配置。

## 8. 2026-11-09 录屏测试说明（非产品 bug）

- **现象**：录屏 tab 点「开始」后很快停止/报错；没有产生新的 `record` 会话，`native\` 下没有 `start.json`、`record.log` 或 `video\part-*.ts`。
- **原因**：为了绕开旧窗口，手动执行 `lib\window.ps1` 时只传了 `-DataDir` / `-ParentPid`，**漏了 Host 通常会传的 `-FfmpegPath`**。窗口在 record 模式的前置检查里发现 `ffmpegAvailable=false`，直接 `Show-Error` 返回，不会写 `start.json`，所以 Host 侧完全没有会话。
- **结论**：录制链路本身没有被触发；这是测试启动方式的问题。Host 托管窗口会从模块 `runtime\node_modules\@ffmpeg-installer` 解析并传入该参数。
- **处理**：已结束手动窗口并清理心跳文件；重启 DSH 让 Host 用正确参数 + 修复脚本重新拉起，再测录屏。

> 注：这次失败还叠加了另一个问题——Host 托管的窗口同样无法让 ffmpeg 写 `%LOCALAPPDATA%`，见第 9 节。

## 9. 2026-11-09 录屏修复：ffmpeg 无法写 LOCALAPPDATA

重启后再次测试录屏，Host 托管窗口的 `record.log` 显示：

```
Failed to open segment 'C:\Users\...\AppData\Local\DshCaptureNotes\native\video\part-000.ts'
Could not write header for output file #0: Permission denied
```

**定位**：用同一份 ffmpeg 做对比：

- 写 `%LOCALAPPDATA%\DshCaptureNotes\probe.ts` → `Permission denied`；
- 写 `<仓库目录>\runtime-data\probe.ts` → 成功。

不是 ACL 问题（`Left_floor` 对两处都有 FullControl），而是该运行环境对 `%LOCALAPPDATA%` 的写入限制只对 ffmpeg 子进程生效；窗口自身的 PowerShell 写入仍正常。

**修复**：

- `windowDataDir` 默认从 `%LOCALAPPDATA%\DshCaptureNotes` 改为模块内 `<仓库目录>\runtime-data`（Host、window、verify-install 三处同步）。
- 录屏分片、WAV、分片、心跳、`live.json` 都在这个目录下，ffmpeg 可写。
- 顺带修复：字幕 cue 支持 `maxDuration`，不会超过视频时长（避免软字幕容器时长被字幕拉长）。

**验证**：

- 自动录屏窗口在 `runtime-data` 下生成 5 个 TS 分片（约 1.9 MB）+ 系统 WAV + 12 个 PCM 分片；
- `record-e2e` 在字幕 clamp 后 PASS（5.03 s 成片，软字幕轨存在）。

**生效条件**：Host 的默认值在代码里，运行中的 Host 仍是旧默认；需要**再重启一次 DSH**。重启后 Host 会使用 `runtime-data`，录屏应正常。

## 10. 2026-11-09 录屏验收（通过）

重启后实测录屏会话 `cn-20261109-062403-ffe6`：

| 项 | 结果 |
|---|---|
| 时长 | 12.03 s |
| 画面 | 2560×1600，H.264 |
| 音频 | AAC 48 kHz，双声道，11.97 s |
| 文件 | `screen.mp4` 4.6 MB；`screen.soft.mp4` 4.6 MB |
| 字幕 | `mov_text` 轨，2 条 cue，12.033 s，与视频等长 |
| 后处理 | `post.json` done，软字幕 0.2 s 完成 |
| 画面抽帧 | 5 s / 11.9 s / 12 s 均为实际全屏画面，窗口与字幕可见 |
| 清单 | `recording.video`、`artifacts.subtitledVideo`、`subtitleCues=2` 均已写入 |

唯一瑕疵：`ffmpeg` 解码时在末尾报一次 `cabac decode of qscale diff failed`，原因是停止时最后一块 TS 分片被截断。画面抽帧正常，不影响观看。

已加收尾保护：`finalizeVideo` 会先用 ffmpeg 解码校验最后一个分片，有错误就丢弃该片；回归 `record-e2e` 输出干净（`dropping truncated last video part: part-005.ts`，成片解码 0 error）。这段保护要下一次 DSH 重启后才会作用于新录屏；当前成片保持原样。

## 11. 2026-11-09 文件模式验收 + 硬字幕边距修复

任务：`runtime-data\file.json` 状态 `done`，输入为 5 分 02 秒、2416×1440 的浏览器录制，选择硬字幕（`subtitleMode=burn`，无 softVideo），耗时 83.7 秒。

| 项 | 结果 |
|---|---|
| 输出 | `out\无所事事夜晚…-9193623b\` |
| 识别 | 34 段，302.8 秒（日语歌曲/直播） |
| 成片 | `.hardsub.mp4` 77.6 MB，H.264 2416×1440 + AAC 48 kHz 双声道 |
| 解码 | 完整解码 0 error |
| 字幕文件 | `subtitles.srt` / `subtitles.ass` 各 34 条 cue |
| 抽帧 | 10 s / 150 s / 290 s 均为实际画面 |

**发现并修复的问题**：第一次硬字幕成片抽帧看不到字幕。`subtitles.ass` 里 `MarginV=7200`，而画面高度只有 1440，字幕被推到画面外。

原因：`toAss` 直接把 UI 的 `marginV=5` 乘高度（`1440×5=7200`），没有把它当百分比。已改为兼容两种输入：

- `marginV > 1` 视为百分比（5 → 5%）；
- 否则视为比例（0.05 → 5%）；
- 最终限制在画面高度的 2%–20%。

修复后重新生成 ASS（`MarginV=72`）并重烧当前成片，抽帧 10 s 已能看到底部日文字幕。当前文件已替换；后续文件任务要等下一次 DSH 重启才会用上新代码。

另外给 `tests\file-e2e.mjs` 加了 ASS 边距断言，防止再次出现字幕跑到画面外。

## 12. 2026-11-09 文件模式译文应用测试（通过）

按 agent 生成译文 → `apply-translation` 的流程实测：

1. 读 `segments.json` 的 34 段，按 `id` 逐段写 `translation.zh-CN.json`（不合并、不拆分）。
2. 执行：

```powershell
node scripts\cli.mjs apply-translation --session "out\无所事事夜晚…-9193623b" --target zh-CN --format bi --mux burn
```

| 项 | 结果 |
|---|---|
| id 校验 | 34 个 id 全部匹配，无缺失/多余/重复 |
| 输出 cue | 39 条双语字幕（长段被拆分换行） |
| 成片 | `subtitled.zh-CN.hardsub.mp4`，77.5 MB，302.87 s |
| 流 | H.264 2416×1440 + AAC 48 kHz 双声道 |
| 解码 | 完整解码 0 error |
| 画面 | 10 s 抽帧可见「日文原文 + 中文译文」两行 |
| 清单 | `artifacts.translations[0] = {target: zh-CN, state: applied}`；`subtitledVideo` 指向新成片 |
| 逐字稿 | 新增 `transcript.zh-CN.md`（原文 + 译文） |

说明：源音频是直播唱歌，ASR 对歌词和哼唱有大量误识别；译文对可读段做了意译，纯拟声/听不清的段落标为「（哼唱）」「（听不清）」。这是识别质量问题，不是翻译链路问题。

## 13. 2026-11-09 P0 复测（重启后）

| 项目 | 结果 |
|---|---|
| `verify-install --after` | PASS；窗口 PID 81540，数据目录 `runtime-data`，`live.json=idle` |
| 生产 Host 尾片校验 | 会话 `cn-20261109-181047-4fbd`：人为损坏 `part-003.ts`，Host 正确丢弃；成片 3.07 s，解码 0 error，`part-check.log` 记录 `Invalid data` |
| 生产 Host 文件硬字幕边距 | `out\sample-de0fcc5b`：ASS `MarginV=18`（360p），解码 0 error，抽帧底部可见字幕 |
| 技能纪要 | `sessions\p4-demo`：生成 6 条带时间戳要点、3 条行动项、简体；`simplify` 返回 `changed:false`；旧纪要备份为 `notes.p4-prev.md` |
| 崩溃恢复回归 | `recovery-e2e` PASS，恢复出 3.07 s 成片 |

环境检查：当前只有 **1 个显示器**（2560×1600），多显示器选择暂时无法测；麦克风仍未放行，双音轨录屏仍待测。

剩余待测：麦克风 + 双音轨、文件软/软+硬/仅字幕的窗口交互、多显示器、30–60 分钟长录、退出/重启清理、回滚。

## 14. 2026-11-09 麦克风被自动取消的排查

用户反馈：勾选麦克风后点录制，麦克风选项被自动取消。

**不是复选框逻辑问题**。现场检测：

- `waveInGetNumDevs()=1`，设备为「麦克风阵列（适用于数字麦克风的英特尔® 智音技术）」，端点状态 `Active`；
- 48000/44100/32000/16000 Hz、单/双声道全部 `waveInOpen` 失败（`UnspecifiedError calling waveInOpen`）；
- 改用 `NAudio.CoreAudioApi.WasapiCapture` 得到明确错误：`E_ACCESSDENIED (0x80070005)`；
- 全局麦克风隐私 `ConsentStore\microphone` 为 `Allow`，音频服务 `Audiosrv`/`AudioEndpointBuilder` 正常。

**窗口行为**：`Start-Session` 打开 mic lane 失败后，会回退到系统音频，并把麦克风复选框取消（`window.ps1` 第 385 行）。随后 Host 的 `listening` 快照不带 error，`Update-FromSnapshot` 调 `Clear-Error` 把「部分音频不可用」清掉，所以看起来像“无故取消”。

**已改**：新增 `$script:localWarning`，麦克风失败/部分音频失败时该提示会在 `listening` 快照期间保留，不再被清掉；下次重启 DSH 后生效。回归 `window-stale-snapshot.ps1` PASS。

**真正要解决的是权限**（按顺序）：

1. Windows 设置 → 隐私和安全性 → 麦克风：打开「麦克风访问」「允许应用访问麦克风」「允许桌面应用访问麦克风」。
2. 声音设置 → 输入：确认默认输入是「麦克风阵列」，用「录音机」录 3 秒；录音机也失败则是设备/驱动/占用问题。
3. 关闭可能独占麦克风的应用：微信、腾讯会议、Teams、VS Code、OBS、浏览器会议页等。
4. DSH 若是管理员/elevated 启动，退出后用普通权限启动再试；Windows 对提权进程的麦克风授权可能不生效。
5. 仍失败时重启 `Audiosrv`/`AudioEndpointBuilder`，或换 USB 耳麦测试。

若录音机正常、只有 DSH 失败，说明是进程级权限/完整性级别问题；下一步可考虑加麦克风设备选择或改用 WMF/WASAPI 采集，但这需要单独实现和重启验证。

## 15. 2026-11-10 麦克风双音轨验收（通过）

权限修复后，普通 `pwsh` 探测已 `wasapi: ok`、`waveIn: ok`。

第一次测试 `cn-20261110-033838-bcf3`（6 秒）只验证了麦克风链路：`mic.wav` 9.06 秒、字幕带 `[麦克风]`；`system.wav` 只有 58 B，因为当时系统端没有播放声音，成片只有 1 条音轨。

第二次测试 `cn-20261110-034031-f258`（22 秒，播放 F1 视频 + 对麦克风说话）：

| 项 | 结果 |
|---|---|
| 音源 | `sources.system=true`、`sources.mic=true` |
| 系统 WAV | `audio\system.wav` 24.64 s，48 kHz 立体声 float，9,461,818 B |
| 麦克风 WAV | `audio\mic.wav` 24.39 s，48 kHz 单声道，2,341,486 B |
| 成片 | `screen.mp4` 22.0 s，**2 条 AAC 音轨**（system 立体声 + mic 单声道），解码 0 error |
| 软字幕 | `screen.soft.mp4` 2 条音轨 + `mov_text` 字幕，解码 0 error |
| 字幕来源 | 8 段，`[系统]` 与 `[麦克风]` 交替出现 |

结论：**双音轨录制、分离 WAV、字幕来源标记全部通过。**

## 16. 2026-11-10 文件模式窗口三形态验收（通过）

用同一 8 秒样本分别从窗口文件 tab 跑三种字幕形态：

| 窗口选项 | 输出目录 | 产物 | 校验 |
|---|---|---|---|
| 软字幕 | `out\ui-soft-fa2c9e22` | `ui-soft.soft.mp4` | `h264 + aac + mov_text`，解码 0 error |
| 软+硬 | `out\ui-both-2cbfbc7f` | `ui-both.soft.mp4`、`ui-both.hardsub.mp4` | soft 带字幕轨；hard 无字幕轨但抽帧可见烧录字幕；均解码 0 error |
| 仅字幕 | `out\ui-none-85b79fb4` | 仅 `transcript.*`、`subtitles.srt/.ass`、`segments.json`、`session.json` | 无 mp4，符合预期 |

`session.json.stats.subtitleMode` 分别为 `soft` / `both` / `none`；`file.json` 最终为 `done`。三种窗口交互全部通过。
