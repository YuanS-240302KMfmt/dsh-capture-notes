# P0 技术验证报告

> 日期：2026-11-08 · 模块：`<仓库目录>` · 需求基线：[`../docs/capture-notes-requirements.md`](../docs/capture-notes-requirements.md)
> 结论：**三项验证通过**（v3 的麦克风一路当时受系统权限限制，标记为 partial；2026-11-10 已放行桌面麦克风权限并完成双音轨实测）。

## 1. 环境

| 项 | 值 |
|---|---|
| OS | Windows（x64，交互桌面） |
| Node | v24.21.0 |
| PowerShell | 7.6.9 |
| NAudio | 1.10.0（`live-translate\lib\NAudio.dll`，已复制到模块 `lib\`） |
| ffmpeg | N-92722（2018 构建，借自 `.video-notes`），libx264 + aac 可用 |
| 主屏 | 2560×1600 @ 30 fps |
| 模型 | SenseVoice int8（229 MB）+ Silero VAD（0.6 MB），借自 `.video-notes` |

## 2. 结果

### v1 — 录屏 + 双音轨封装：PASS

| 指标 | 实测 |
|---|---|
| 录屏 | 5 s，2560×1600，h264，30 fps，0.7 MB |
| 系统音轨 | 48 kHz 立体声 float，7.12 s，14 个 16 k 分片；实测有真实声音（mean −17.4 dB / max −0.8 dB） |
| 麦克风 | **未获取到**（`E_ACCESSDENIED`）；用 `speech.wav` 作为替身第二轨完成封装验证 |
| 封装成片 | 5.06 s，0.9 MB，1 条视频 + **2 条 AAC 音轨**（48 kHz 立体声 / 16 kHz 单声道） |
| 三轨时长差 | 0 s（`-shortest` + 音频起始裁剪 0.547 s） |
| 完整解码 | `ffmpeg -f null -` 通过 |

判定：`oneVideoStream`、`twoAudioStreams`、`durationSpreadUnder200ms`、`decodesCleanly` 全部为 true。

### v2 — 双路 ASR 并发：PASS

| 指标 | 单路基线 | 双路并发 |
|---|---|---|
| 墙钟时间 | 176 ms | 469 ms |
| RTF（墙钟 / 处理音频） | 0.0315 | **0.0419** |
| 吞吐 | 31.7× | **23.8×** |
| 段数 | 1 | 2（两路各 1 段） |
| 段解码 p50/p95 | — | 415.9 / 415.9 ms（5.6 s 整段） |
| RSS 增量 | — | **+638.1 MB** |

两路文本均为「开饭时间早上9点至下午5点。」，与 `speech.wav` 内容一致；目标线「合计 RTF ≤ 0.20」有约 4.8 倍余量。

### v3 — 同一采集产出归档 WAV + 16 k 分片：PASS（partial）

| 指标 | 实测 |
|---|---|
| 时长 | 6 s |
| 分片 | 12 个，每个恰好 16 000 字节（0.5 s @ 16 kHz mono PCM16） |
| 归档 WAV | 6.08 s（48 kHz 立体声 float） |
| 分片总时长 | 6.00 s；与 WAV 差 **0.08 s** |
| 分片节奏 | 均值 495.1 ms，最大间隔 539 ms |
| 麦克风 | 阻塞（`waveInOpen` E_ACCESSDENIED） |

## 3. 关键发现

1. **gdigrab 可用，但 `-devices` 不列它。** 这个 2018 构建的 `ffmpeg -devices` 只显示 dshow/vfwcap，实际 `-f gdigrab -i desktop` 正常，录到 2560×1600@30。不能靠 `-devices` 判断能力。
2. **ffmpeg 太旧（2018）。** P0 能用，但 P5 应换现代静态构建；老构建的编码器/协议与安全更新都落后。
3. **内联 C# 不能用 `lock`。** `Add-Type -ReferencedAssemblies` 只带 NAudio + netstandard/Collections/Threading 时，`lock` 报 `CS0656 缺少 System.Threading.Monitor`。去掉锁即可（每个采集回调只有一个线程）。
4. **麦克风被系统拒绝。** `WaveInEvent`（48 k 与默认 8 k）、`WasapiCapture` 全部 `E_ACCESSDENIED`；`ffmpeg -f dshow` 列不出任何音频设备；但默认采集端点状态为 Active。判断是 Windows 隐私（桌面应用麦克风权限）或设备被其它应用独占，需要人工在「设置 → 隐私 → 麦克风」里放行后重跑。
5. **双模型内存约 638 MB。** 两条 ASR lane 各自持有完整 SenseVoice，符合预期；叠加录屏编码后仍在 1.5 GB 预算内，但长会话需盯 RSS。
6. **分片节奏稳定。** 500 ms 标称、均值 495 ms、最大 539 ms；40 ms 轮询 + 整块切分足够，不需要更细的定时器。
7. **采集先于录像约 0.5 s。** 用「音频 ready → 起录 → 记墙钟 → 按差值裁剪音频」可以把三轨时长差压到 0；但这是 P0 级对齐，P2 需要更硬的同步（Media Foundation / 统一时钟）。

## 4. 对后续阶段的影响

| 决策 | 说明 |
|---|---|
| 录屏实现 | 保留「gdigrab 录无音轨 MP4 + NAudio 两路 WAV + 停止后封装」；P2 再做多显示器 offset 与暂停（v1 不做暂停） |
| 麦克风 | P1 起做能力探测：失败时 UI 明确提示「Windows 麦克风权限 / 设备占用」，提供重试；不静默降级 |
| 双路 ASR | 每路一个 worker + 3 线程；P1 验证 60 分钟稳定性与 RSS |
| 分片 | P1 起在停止时冲刷最后一个不满 16 k 的分片（P0 直接丢弃余量） |
| 内存 | 双 lane + 录屏 的峰值要进 P2 验收；必要时降到 2 线程/路 |
| ffmpeg | P5 换现代静态构建，并加 `doctor` 自检版本与编码器 |
| 同步 | P2 用统一时钟或录屏内嵌时间戳，目标 ≤ 200 ms |

## 5. 复现

```powershell
cd D:\dsh_mod\capture-notes\p0

node v1-record.mjs --seconds 5      # 录屏 + 双轨封装
node v2-dual-asr.mjs --threads 3    # 双路 ASR
node v3-audio-tap.mjs --seconds 6   # 归档 + 16k 分片
```

产物在 `p0\.tmp\<v1|v2|v3>\`，每个目录有 `report.json`。退出码 0 = 通过。

## 6. P0 未覆盖

- 真实麦克风采集（环境阻塞，需人工放行后重跑 v1/v3）。
- 15 分钟 / 60 分钟长会话、内存与磁盘增长。
- 多显示器选择与偏移。
- 实时翻译、字幕渲染、断网降级。
- 录屏后处理（停止弹窗、复用 segments 生成成片）。
- 文件模式与软/硬字幕烧录。
