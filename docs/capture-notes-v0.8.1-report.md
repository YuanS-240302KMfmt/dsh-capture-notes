# dsh-capture-notes 0.8.1

> 日期：2026-11-12 · 版本：`0.8.1` · 0.8.0 的长文件补丁

## 修复

- 纪要模型输出预算从 4096 提升到 8192 token；
- 检测 `finish=max-tokens`，不再把截断内容写成 `notes.md`；
- 截断时自动用“1800 汉字以内、必须写完结论”的压缩 prompt 重试一次；
- 空响应保留 `finish` / reasoning / text 字符数，便于定位。

## 长文件实测

输入：`out\long-88`，88 分钟、814 段、43,733 字符。

首次（0.8.0）：

- 分段 1/3、2/3、3/3 成功；
- 合并阶段返回空文本或截断，`notes.md` 结尾停在句中。

0.8.1 复测：

- 3 个分段全部完成；
- 合并完成，耗时 112.6 秒；
- `notes.md` 10,681 字节 / 4,117 字符；
- 结尾有完整“结论”和“行动项”，最后一行：`- 其他明确行动项：片段未提及。`；
- `session.json.artifacts.notes = notes.md`，`summary.chunks = 3`；
- 模型：`deepseek-official / deepseek-flash`，reasoning `high`。

## 验证

- `node tests/summary-e2e.mjs` PASS
- 长文件真实模型验收 PASS

## 说明

0.8.0 已发布的 tag 保留不动；0.8.1 只包含长文件纪要修复。
