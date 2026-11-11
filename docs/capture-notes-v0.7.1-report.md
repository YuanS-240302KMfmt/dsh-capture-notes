# dsh-capture-notes 0.7.1

> 日期：2026-11-11 · 版本：`0.7.1`

## 改动

### 选项按钮改为下拉框

- 源语言、目标语言、字幕形态、显示器选择由循环 Button 改为 ComboBox；
- 深色 ComboBox 模板（`#222B3A` 背景、`#C9D6EA` 文字），避免默认白底；
- 字幕形态宽度 96、目标语言 100，预览不再截断；
- 选择变化直接更新 `sourceIndex` / `targetIndex` / `fileSubtitleIndex` / `monitorIndex`；
- 录制/文件处理中禁用下拉框。

### 文件 tab 支持拖拽

- 整个窗口 `AllowDrop=True`；
- 仅文件 tab 接受拖拽，拖入单个视频/音频后自动填入文件名并清除旧输出；
- 支持 mp4/mkv/mov/avi/webm/mp3/wav/m4a/flac；
- 多文件、非文件 tab、不支持格式分别给出提示。

## 验证

- `tests/window-e2e.mjs` PASS
- `tests/file-window-e2e.mjs` PASS
- `tests/tray-e2e.ps1` PASS
- `tests/recent-e2e.ps1` PASS
- 文件/live 预览图：下拉框深色、布局正常

待手动确认：从资源管理器把文件拖入文件 tab 的实际鼠标操作。

## 版本

- `package.json` → `0.7.1`
- 建议 tag：`v0.7.1`
