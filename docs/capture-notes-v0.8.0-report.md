# dsh-capture-notes 0.8.0 实施记录

> 日期：2026-11-12 · 版本：`0.8.0`

## 已实现

### Host

- 监听 `native/summary.request` / `summary.cancel`，回写 `summary.json`；
- 校验目标目录必须位于 `sessionsDir` 或 `fileOutRoot`；
- 读取 `transcript.md`，缺失时从 `segments.json` 拼时间戳文本；
- 通过 `ctx.get('llm').stream()` 调用当前 DSH 模型：
  - provider/model 来自 `ctx.agentDefaultModel.currentSelection()`；
  - `system` 固定为简体中文纪要规则；
  - 长逐字稿按约 18k 字符分段，先出中间摘要再合并；
- 成功写 `notes.md`，更新 `session.json.artifacts.notes` 和 `summary` 元数据；
- 有取消信号时停止并写 `cancelled`，不覆盖旧 notes。

### 面板

- 底部新增「生成纪要」；实时 tab 隐藏，录屏/文件完成后出现；
- 首次点击隐私确认：逐字稿发送给当前模型；
- `SummaryPanel` 覆盖层显示进度、错误、最终纪要；
- 「打开 notes.md」「重新生成」「关闭」；
- 生成中按钮变为「取消纪要」，写入 `summary.cancel`。

## 测试

- `node tests/summary-e2e.mjs`：mock 模型，`summary.request` → `notes.md` → manifest；PASS；
- `node tests/window-e2e.mjs`：PASS；
- `node tests/file-window-e2e.mjs`：PASS。

## 真实测试记录

- 2026-11-12 首次真实点击：`cannot get property "agentDefaultModel" without inject`；
- 已给插件补 `inject = ['connection', 'agentDefaultModel']`，并优先用 `ctx.get('agentDefaultModel')` 读取；需重启 DSH 复测。

## 待验收

- 真实 DSH 模型调用（mock 只验证协议和流水线）；
- 录屏/文件完成后的按钮可见性；
- 长文件分段合并；
- 隐私确认与取消。

## 说明

本轮 0.8.0 的目标是内容纪要；此前的长录屏、后处理中退出验收仍待补。
