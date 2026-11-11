# dsh-capture-notes 0.8.0 内容纪要需求

> 状态：实现中 · 2026-11-12

## 目标

把「视频内容总结」接进面板：录屏或文件任务完成后，用户点一次按钮，用**当前 DSH 配置的模型**生成结构化的 `notes.md`，并在面板内直接阅读。

## 交互

- 实时 tab 不提供总结；
- 录屏/文件 tab 在存在 `transcript.md`（或可用的 `segments.json`）后，底部显示「生成纪要」；
- 点击后先弹一次隐私确认：逐字稿会发送给当前模型；
- 生成中可取消；完成后面板显示纪要，提供「打开 notes.md」「重新生成」「关闭」；
- 失败显示错误条，不清空旧 `notes.md`。

## 输出

- 写入目标目录的 `notes.md`；
- 更新 `session.json.artifacts.notes = "notes.md"`，并记录 `summary` 元数据；
- 简体中文 Markdown：标题、概览、带 `[HH:MM:SS]` 的要点、结论/行动项；
- 会议/课程/访谈由模型自动判断；
- 只使用逐字稿内容，推断标注「（推断）」，缺失写「片段未提及」。

## Host 协议

```text
native/summary.request   { "dir": "<会话或 out 目录绝对路径>" }
native/summary.cancel    <任意内容；取消当前任务>
native/summary.json      { status, stage, percent, dir, output?, error? }
```

- 只允许 `sessionsDir` 或 `fileOutRoot` 下的目录；
- 长逐字稿按约 18k 字符分段生成中间摘要，再合并；
- 模型通过 `ctx.get('llm').stream()`，provider/model 取 `ctx.agentDefaultModel.currentSelection()`；
- 录制/文件任务进行中不允许开始总结。

## 验收

- `tests/summary-e2e.mjs`：mock 模型，验证 request → notes.md → manifest；
- 真实模型手动验收：录屏/文件完成后按钮出现、隐私确认、生成成功、面板显示、打开 notes.md；
- 长文件（>18k 字）分段合并。

## 不在本轮

- 实时 tab 的阶段总结；
- 自动生成（不点按钮就调用模型）；
- 长录屏/后处理中退出的验收仍按原计划另行完成。
