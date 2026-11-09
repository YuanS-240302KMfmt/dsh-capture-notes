# P0 技术验证

三个脚本，只验证「能不能做」，不产出用户功能。结果与结论见 [`REPORT.md`](REPORT.md)。

## 前置

- Windows 10/11，已登录的交互桌面（gdigrab 需要桌面会话）。
- PowerShell 7（`pwsh` 在 PATH）。
- `..\..\.video-notes` 或在 `VIDEO_NOTES_HOME` 指定的目录存在（提供 ffmpeg/ffprobe 与 SenseVoice 模型）；仅在本地验证时使用，不属于本仓库。
- 模块 `lib\NAudio.dll` 已就位。

P0 不读写 `.video-notes` 的产物目录，只读它的 `node_modules` 与 `models`。

## 脚本

### `v1-record.mjs` — 录屏 + 双音轨封装

```powershell
node v1-record.mjs [--seconds 15] [--no-player]
```

1. `capture-audio.ps1` 双路采集（系统回环 + 麦克风）→ `audio\system.wav`、`audio\mic.wav` + 16 k 分片。
2. `ffmpeg -f gdigrab -i desktop` 录 N 秒无声视频。
3. 停止后封装成 `muxed.mp4`（2 条 AAC 音轨）。

`--no-player` 不自动播放测试语音；此时系统回环可能没有声音，需要自己放点音频。

判定：1 条视频 + 2 条音频；三轨时长差 ≤ 200 ms；`ffmpeg -f null -` 解码通过。

麦克风被系统拒绝时，自动用 `live-translate\tests\speech.wav` 作为替身第二轨，并在报告里标 `mic.source = "stand-in"`。

### `v2-dual-asr.mjs` — 双路 ASR 并发

```powershell
node v2-dual-asr.mjs [--threads 3] [--clip path\to\16k-mono.wav]
```

- 单路基线 vs 双路并发（两个 worker，各自 SenseVoice + VAD）。
- 判定：两路都出段、合计 RTF ≤ 0.20、无错误。
- 报告含墙钟、RTF、吞吐、段解码 p50/p95、RSS 增量、两路文本。

### `v3-audio-tap.mjs` — 归档 + 识别流并行

```powershell
node v3-audio-tap.mjs [--seconds 10]
```

- 一次采集同时写 48 kHz 归档 WAV 与 500 ms / 16 kHz 分片。
- 判定：分片数足够、每个 16 000 字节、节奏均值 400–650 ms、最大间隔 ≤ 800 ms、WAV 与分片总时长差 ≤ 0.7 s、PCM 格式为 16 kHz mono PCM16。
- 麦克风可用时同样检查；不可用则整体标 `partial`。

## 产物

```
p0\.tmp\<v1|v2|v3>\
  report.json
  ...
```

清理：`Remove-Item p0\.tmp -Recurse -Force`。

## 已知环境限制

- **麦克风**：本机 `WaveInEvent` / `WasapiCapture` 均返回 `E_ACCESSDENIED`，`dshow` 也列不出音频设备。需要在 Windows「设置 → 隐私和安全性 → 麦克风」里允许桌面应用访问，并确认没有会议软件独占麦克风，然后重跑 v1/v3。
- **ffmpeg**：来自 `.video-notes` 的 2018 构建；`-devices` 不列 gdigrab，但实际可用。P5 换现代构建。
- **播放测试音**：脚本用 `System.Media.SoundPlayer` 循环播放 `speech.wav`；系统静音时回环可能录到静音，报告会显示 0 分片。
