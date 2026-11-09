# 录屏字幕台 · 重启验证清单（P5）

> 日期：2026-11-08 · 模块：`<仓库目录>`（0.6.0）
> 目的：确认 desktop profile 重启后能加载插件，并逐项验收实时 / 录屏 / 文件 / 技能。
> 说明：重启会中断当前 DSH 会话，请先保存工作。本文只做准备，不替你执行重启。

## 0. 当前已就绪（重启前）

| 项 | 结果 |
|---|---|
| `node scripts\doctor.mjs` | `ready: true`、`selfContained: true`、`runtimeSource: module` |
| `node scripts\verify-install.mjs` | `ready: true`（24 项全过） |
| 自带运行时 | `models\` 229 MB + `runtime\` 167 MB |
| profile 依赖 | `dsh-capture-notes: link:D:/dsh_mod/capture-notes` |
| profile bundles | 已包含 `dsh-capture-notes` |
| 插件插入 | 模块 `cordis.patch.yml` 插入 `capture-notes`；profile patch **没有**重复插入 |
| 全局技能 | `~\.dsh\skills\capture-notes\`，与源文件哈希一致 |
| 全量测试 | P1/P2/P3 + 独立性测试全部 PASS |

## 1. 重启前（1 分钟）

```powershell
cd <仓库目录>

# 最后一次静态检查，必须 ready: true
node scripts\doctor.mjs
node scripts\verify-install.mjs
```

确认：

- [ ] 模块窗口没有在运行；任务管理器里没有本模块的 `ffmpeg.exe`。
- [ ] 没有未保存的 DSH 对话。
- [ ] 知道如何完全退出 DSH（托盘 → 退出；不是只关窗口）。

## 2. 重启 DSH

1. 完全退出 DSH（含托盘图标）。
2. 确认进程列表里没有残留的 DSH 主进程。
3. 重新启动 DSH。
4. 等待 10–20 秒（插件加载 + 小窗启动）。

预期：任务栏/桌面出现「录屏字幕台」小窗，显示「等待开始」，没有红色错误条。

## 3. 重启后自动检查

```powershell
cd <仓库目录>
node scripts\verify-install.mjs --after
```

必须 `ready: true`，重点看：

| 检查 | 通过标准 |
|---|---|
| `live.json` | 存在，`status` 为 `idle` 或当前会话状态 |
| `window process` | `window.pid` 存在且进程存活 |
| `window log has no fatal error` | 没有 `Exception` / `not recognized` / `EACCES` |
| `native dir` | `<仓库目录>\runtime-data\native` 存在 |

失败时先看：

```powershell
Get-Content "<仓库目录>\runtime-data\window-error.log" -Tail 40
Get-Content "<仓库目录>\runtime-data\live.json" -Raw
```

## 4. 手动验收项

逐项打勾；每项失败都记下现象与日志。

### A. 插件加载

- [ ] DSH 设置/插件页出现「录屏字幕台」/ `dsh-capture-notes`。
- [ ] 没有激活错误、没有 duplicate id 报错。
- [ ] 小窗标题正确，实时 tab 为选中态。

### B. 实时字幕（约 2 分钟）

- [ ] 小窗勾选「系统音频」，源语言「自动」或「日本語」，目标「简体中文」。
- [ ] 播放一段有声音的本地视频/直播。
- [ ] 点「开始」→ 状态变为「正在聆听」。
- [ ] 2–5 秒内出现带 `[系统]` 徽标的字幕；有译文。
- [ ] 点「停止」→ 状态「已保存 · cn-...」。
- [ ] `sessions\<id>\` 下有 `transcript.md`、`transcript.srt`、`segments.json`、`audio\system.wav`。

### C. 录屏（约 1 分钟）

- [ ] 切到「录屏」tab，显示器按钮显示当前屏幕。
- [ ] 点「开始」→ 状态「录制中 · 画面 + 音频」。
- [ ] 录 10 秒，点「停止」→「收尾中…」→「已保存」。
- [ ] 停止后弹出「这段录屏要加字幕吗？」。
- [ ] 选「软字幕」→ 状态「字幕完成」。
- [ ] 会话目录有 `screen.mp4`、`screen.soft.mp4`、`subtitles.srt`。
- [ ] `screen.mp4` 可用播放器打开；若麦克风已放行，应有 2 条音轨。

快速核对：

```powershell
$ff='<仓库目录>\runtime\node_modules\@ffprobe-installer\win32-x64\ffprobe.exe'
$dir=(Get-ChildItem <仓库目录>\sessions -Directory | Sort-Object LastWriteTime -Desc | Select-Object -First 1).FullName
& $ff -v error -show_entries stream=codec_type,codec_name -of csv=p=0 "$dir\screen.soft.mp4"
```

预期：`video,h264`、`audio,aac`、`subtitle,mov_text`。

### D. 文件模式（约 2 分钟）

- [ ] 切到「文件」tab →「选择文件」，选一个 10–60 秒的 mp4。
- [ ] 字幕形态选「软字幕」→「开始处理」。
- [ ] 状态依次出现「抽音/识别/生成字幕/封装」，进度增长。
- [ ] 完成 →「打开目录」能打开 `out\<slug>\`。
- [ ] 目录有 `transcript.md`、`subtitles.srt`、`<原名>.soft.mp4`、`session.json`。
- [ ] 播放 `<原名>.soft.mp4`，字幕可开关。

### E. 技能（新会话）

- [ ] 新开一个 DSH 会话，说「给最近这次录制出纪要」。
- [ ] 技能被识别为 `capture-notes`（而不是通用回答）。
- [ ] 生成 `notes.md`：简体、带 `[HH:MM:SS]`、有行动项或结论。
- [ ] 纪要写在对应 `sessions\<id>\` 或 `out\<slug>\`，不覆盖逐字稿。

### F. 退出与收尾

- [ ] 关闭小窗（或退出 DSH）→ 窗口退出，没有残留 `pwsh.exe`（本模块的）。
- [ ] 没有残留 `ffmpeg.exe`。
- [ ] 已保存的会话/产物仍可打开。
- [ ] 再次启动 DSH，小窗能重新出现。

## 5. 路径与日志速查

| 内容 | 路径 |
|---|---|
| 实时/录屏会话 | `<仓库目录>\sessions\<id>\` |
| 文件产物 | `<仓库目录>\out\<slug>\` |
| 窗口交换目录 | `<仓库目录>\runtime-data\` |
| 小窗错误日志 | `<仓库目录>\runtime-data\window-error.log` |
| 当前快照 | `<仓库目录>\runtime-data\live.json` |
| 录制分片/归档 | `<仓库目录>\runtime-data\native\` |
| 技能 | `C:\Users\<user>\.dsh\skills\capture-notes\` |
| profile | `C:\Users\<user>\.dsh\profiles\desktop\` |

## 6. 失败处理

| 现象 | 处理 |
|---|---|
| 插件列表没有「录屏字幕台」 | 检查 profile `package.json` 的 dependency/bundles；在 profile 里 `pnpm install`；重启 |
| 启动报 duplicate id | 确认 profile `cordis.patch.yml` **没有** `capture-notes` 的 insert；只保留 bundles |
| 小窗没出现 | 跑 `pwsh -STA -File lib\window.ps1 -Diagnose`；看 `window-error.log`；确认 `openOnStart` 未被设为 false |
| 小窗出现但红色错误条 | 多数是模型/运行时路径；跑 `node scripts\doctor.mjs` |
| 实时没有字幕 | 确认系统有声音；播放设备是默认设备；点停止后看 `sessions\<id>\audio\system.wav` 是否为空 |
| 麦克风不可用 | Windows「设置 → 隐私和安全性 → 麦克风」允许桌面应用；关闭占用麦克风的应用 |
| 录屏没有 `screen.mp4` | 看 `sessions\<id>\mux.log`；确认 `native\video\part-*.ts` 是否残留 |
| 后处理卡住/失败 | 看 `<仓库目录>\runtime-data\native\post.json` 与 `subtitles.*`；重试另一种形态 |
| 文件任务卡住 | 看 `native\file.json`；点「取消」；必要时重启 DSH |
| 技能不触发 | 确认 `~\.dsh\skills\capture-notes\SKILL.md` 存在；重启 DSH 后新开会话 |

## 7. 回滚

不需要删除模块或技能，先让插件不加载：

1. 编辑 `C:\Users\<user>\.dsh\profiles\desktop\package.json`：
   - 从 `dependencies` 删除 `"dsh-capture-notes"`；
   - 从 `dsh.profile.bundles` 删除 `"dsh-capture-notes"`。
2. 在 profile 目录执行 `pnpm install`。
3. 重启 DSH。

模块自身仍可单独运行（CLI/测试），只是不再随 DSH 启动。若只想暂时不弹窗，可在 profile patch 给 `capture-notes` 加：

```yaml
- id: capture-notes
  config:
    openOnStart: false
```

## 8. 验收记录

| 项目 | 结果 | 备注 |
|---|---|---|
| preflight `ready` | ☐ PASS / ☐ FAIL | |
| after-restart `ready` | ☐ PASS / ☐ FAIL | |
| 插件加载 | ☐ PASS / ☐ FAIL | |
| 小窗自动打开 | ☐ PASS / ☐ FAIL | |
| 实时字幕 + 保存 | ☐ PASS / ☐ FAIL | |
| 录屏 + 软字幕 | ☐ PASS / ☐ FAIL | |
| 文件模式 | ☐ PASS / ☐ FAIL | |
| 技能纪要 | ☐ PASS / ☐ FAIL | |
| 退出无残留 | ☐ PASS / ☐ FAIL | |

失败项请附：时间、操作、`window-error.log` 尾部、`session.json` 或 `file.json` 的相关片段。
