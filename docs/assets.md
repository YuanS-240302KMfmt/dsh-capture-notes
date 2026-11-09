# 模型与运行时准备

本仓库**不提交** `models\` 与 `runtime\`（约 396 MB）。首次运行前按下面任一方式准备；完成后 `node scripts\doctor.mjs` 应为 `ready: true`。

## 期望目录

```
models\
  sensevoice\model.int8.onnx
  sensevoice\tokens.txt
  silero_vad.onnx
runtime\
  node_modules\
    sherpa-onnx-node\
    sherpa-onnx-win-x64\
    opencc-js\
    @ffmpeg-installer\win32-x64\ffmpeg.exe
    @ffprobe-installer\win32-x64\ffprobe.exe
```

## 方式 A：从已有安装复制

如果本机已有 `.video-notes` 或 `live-translate` 的运行时：

```powershell
# 在仓库根目录执行；按实际参考目录调整
Copy-Item -Recurse -Force ..\.video-notes\models .\models
Copy-Item -Recurse -Force ..\.video-notes\node_modules .\runtime\node_modules
```

只需 `sherpa-onnx-node`、`sherpa-onnx-win-x64`、`opencc-js`、`@ffmpeg-installer`、`@ffprobe-installer` 五项；多复制不影响运行。

## 方式 B：下载模型 + npm 装运行时

- SenseVoice int8 与 `tokens.txt`：从 [sherpa-onnx asr-models release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) 取 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` 包，放到 `models\sensevoice\`。
- Silero VAD：从同一 release 的 VAD 模型包取 `silero_vad.onnx`，放到 `models\`。
- 运行时：

```powershell
npm install --prefix runtime --no-save `
  sherpa-onnx-node sherpa-onnx-win-x64 opencc-js `
  @ffmpeg-installer/ffmpeg @ffprobe-installer/ffprobe
```

## 校验

```powershell
node scripts\doctor.mjs
node tests\e2e.mjs
```

`doctor` 会检查模型、sherpa 原生库、ffmpeg/ffprobe、NAudio、PowerShell 和写权限；缺什么会直接给出路径。
