# dsh-capture-notes 0.7.0 实施记录

> 日期：2026-11-10 · 版本：`0.7.0`（进行中）
> 需求：[`capture-notes-v0.7.0-requirements.md`](capture-notes-v0.7.0-requirements.md)

## M1：长时文件与格式

### 60/88 分钟长文件

用户提供的真实素材：

- 88 分 03 秒（5283.39 s），2416×1440，11.4 GB，H.264 + AAC；
- 完整文件流水线（软字幕）通过：

| 指标 | 结果 |
|---|---|
| 端到端耗时 | 174.2 s |
| 峰值内存 | 590.6 MB |
| CPU 时间 | 852.3 s |
| 识别段数 | 814 |
| 成片 | 10.9 GB，`*.soft.mp4` |
| 成片/源时长 | 5283.37 s vs 5283.39 s（差 0.02 s） |
| 字幕 | 936 条，最后一条到 01:28:00 |
| 抽样解码 | 600/1800/3600/4800 s 四段均 0 error |

第一次 88 分钟运行在 ASR 结束时报「识别进程未正常结束」：Host 一次性把所有 30 s 分片塞进 worker，只等 30 s 收尾，worker 还在处理队列。已改为 **逐块 ack 背压**，worker 处理完一块才发下一块；10 分钟预热与 88 分钟完整运行均通过。

### 格式边界

已实测：

- 纯音频 M4A：出逐字稿/字幕，不生成 mp4，`stats.mediaKind=audio`；
- MKV：软字幕成片为 `.soft.mkv`，字幕轨正常；
- 无音轨 MP4：在抽音前报「文件没有音频流」，不写 `session.json`；
- 内嵌字幕：`--subs-only` 抽出 SRT；无字幕时明确报错；
- 长中文文件名：slug 正常，不覆盖其他任务；
- 指标：`session.json.stats` 新增 `mediaKind`、`elapsedSeconds`、`peakMemoryMB`、`cpuSeconds`。

测试：`tests/file-e2e.mjs`、`tests/formats-e2e.mjs` 均 PASS。

## M2：恢复与取消

- `runToFile` 支持 AbortSignal；`muxSubtitles` / `burnSubtitles` 取消时杀掉 ffmpeg、删除半成品、抛「已取消」；
- 文件 ASR 取消改为**协作停止**：不直接 terminate 正在 native decode 的 worker，先让当前块结束、发 `stop`、等 `stopped` 再 terminate；避免 sherpa 原生崩溃（之前 `0xC0000409`）。
- `tests/cancel-e2e.mjs`：burn/mux/ASR 三段取消均 PASS，无残留最终输出；
- `tests/recovery-e2e.mjs` PASS（有效分片 + 损坏尾片；恢复 3.07 s，解码 0 error）。

待补：真实强杀 DSH/窗口后的恢复演练、退出后孤儿进程检查。

**2026-11-11 崩溃恢复测试结果（未命中恢复路径）**：两次测试分别是结束窗口和正常关闭 DSH，Host 都还来得及正常收尾，所以没有 `sessions/recovered-*`。

- `cn-20261111-074431-a7dd`：`status=completed`、`crashRecovered=false`、`stopReason=timeout`，`screen.mp4` 26 s；
- `cn-20261111-075340-0d8b`：`status=completed`、`crashRecovered=false`、`stopReason=timeout`，`screen.mp4` 24 s。

这里的 `stopReason=timeout` 是 Host `finalizeStop` 等待 worker 的 4 秒超时，不是“会话崩溃”或“30 秒空闲超时”。正常关闭 DSH 会先走收尾，因此不会触发恢复。

真正触发恢复必须**强杀 DeepSeek Harness 主进程**（Task Manager「结束任务」或 `Stop-Process -Name 'DeepSeek Harness' -Force`），且要在 Host 正常收尾之前；重启后才会从 `native\video\part-*.ts` 生成 `recovered-*`。

**2026-11-11 强杀 DSH 恢复成功**：生成 `recovered-20261111-075614`：

- `status=aborted`、`crashRecovered=true`；
- `screen.mp4` 21.0 s，2560×1600，1 条 AAC 音轨（mic），无 `ffmpeg` 残留；
- `RECOVERY.md` 记录了分片数与音轨。

发现的瑕疵：恢复成片解码时有一个宏块错误（`MB 9 79`），原因是恢复路径没有丢弃损坏尾片。已把正常收尾的 `dropCorruptTail` 复用到 `recoverOrphanRecording`；`recovery-e2e` 增加了“有效分片 + 损坏尾片”用例，并断言恢复成片解码 0 error，测试 PASS。当前这份 `recovered-20261111-075614/screen.mp4` 是修复前生成的，保留原样；下一次 DSH 重启后的恢复会使用修复代码。

**文件任务中退出实测（2026-11-11）**：`file.json` 最终 `status=cancelled`、`stage=cancelled`、67%、12.3 s；`out\<slug>` 无任何 mp4/半成品；窗口进程退出，无 `ffmpeg` 残留。`work\<slug>\audio.wav`（13 MB）仍保留用于排查，作为已知临时文件清理限制记录。

## M3：托盘与文件 tab

- 窗口从 `ShowDialog()` 改为 `Show() + Dispatcher.Run()`；`Hide()` 不再结束消息循环；
- 托盘：NotifyIcon、显示窗口/退出菜单、关闭到托盘、退出前收尾；
- `tests/tray-e2e.ps1` PASS：WM_CLOSE 后进程存活（隐藏到托盘），`quit.request` 后退出；
- 错误条新增「打开麦克风设置」按钮，麦克风类错误自动显示；
- 文件 tab 新增「最近」菜单（最近 10 个会话，打开目录；录屏会话可重跑软/硬/仅字幕）；
- 文件完成状态显示「译文：未生成/已生成/已应用」；纯音频显示「音频（无视频）」。
- 修复「最近」闪退：`ContextMenuStrip.Show(Control,...)` 没有这个重载，异常导致窗口退出（exit code 1）；改为按 `Cursor.Position` 显示，并给点击加 try/catch。`tests/recent-e2e.ps1` PASS。
- 录制中托盘退出实测：会话 `cn-20261111-064712-3359` 收尾为 `completed`，`screen.mp4` 15.8 s / 3.6 MB，窗口和 `ffmpeg` 均退出。
- 鼠标入口：桌面/开始菜单快捷方式 + 根目录 `.cmd`，通过 `wscript` 隐藏启动，避免空白终端；快捷方式已实测能打开 WPF 窗口。

待补：托盘菜单“显示窗口”人工点击、最近会话菜单人工点击、麦克风错误按钮人工点击。

## 回归

```powershell
node tests\file-e2e.mjs
node tests\formats-e2e.mjs
node tests\cancel-e2e.mjs
node tests\file-window-e2e.mjs
pwsh -NoProfile -File tests\tray-e2e.ps1
node tests\recovery-e2e.mjs
```

全部 PASS（截至本文）。

## 未完成/不在 0.7.0

- 60 分钟长时**录屏**验收：推迟到 0.8.0；
- 后处理中退出：暂无条件测试，与长录屏一起放到 0.8.0；
- 多显示器：无硬件，保持单屏；
- 真实强杀 DSH 的恢复演练；
- 托盘菜单/最近会话/错误按钮的人工交互验收；
- 版本 tag 与最终 README/发布说明。
