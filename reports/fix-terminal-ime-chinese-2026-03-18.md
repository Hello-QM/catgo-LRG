# Fix: Terminal Chinese IME Input (WebKit/Tauri)

**日期:** 2026-03-18
**状态:** 已修复

---

## 问题

在 Tauri 桌面应用的终端中，中文输入法（IME）存在多个问题：
- 输入"你好"后再输入"你好"，第二次只显示"你"，"好"丢失
- 确认键（空格）残留泄漏到终端
- 非断空格 (NBSP, U+00A0) 被发送到 PTY

## 根因

Tauri 使用 **WebKitGTK**（Linux/macOS），其 IME 事件模型和 Chromium 不同。xterm.js 的内置 `CompositionHelper` 是为 Chromium 设计的，在 WebKit 中行为异常。

### 具体根因链

1. **WebKit 不可靠地触发 `compositionstart`** — xterm 内部的 `_compositionPosition.start` 可能保持旧值

2. **xterm `_finalizeComposition` 读取 textarea 旧内容** — compositionend 后，xterm 的 `setTimeout(0)` 从 textarea 读取全部内容并发送到 PTY，导致重复/乱码

3. **同步清空 textarea 触发假 DEL** — 清空 textarea 后，xterm 的 `_handleAnyTextareaChanges` 检测到长度缩短，发送 DEL (0x7F) 到 PTY，删除最后一个已提交的中文字符

4. **IME 确认键产生 NBSP** — WebKit 中 IME 确认空格有时产生 U+00A0 (NBSP) 而非 U+0020 (普通空格)

### 参考

- xterm.js PR [#5704](https://github.com/xtermjs/xterm.js/pull/5704) — 修复 WKWebView 韩语 IME，处理 `insertReplacementText` 事件（尚未合并）
- xterm.js issue [#3639](https://github.com/xtermjs/xterm.js/issues/3639) — Safari/WebKit 中搜狗拼音无法输入
- [Tabby](https://github.com/Eugeny/tabby) 终端不做任何 IME 特殊处理，完全依赖 xterm.js 内置 `CompositionHelper`（在 Chromium/Electron 中工作正常）

## 修复方案

**文件:** `src/lib/structure/TerminalPanel.svelte`

基于 xterm.js PR #5704 的架构，在 CatGo 前端层实现 WKWebView IME 兼容。当 PR #5704 合并并升级 xterm.js 后，可删除此代码。

### 架构

```
beforeinput 事件拦截:
├── insertFromComposition → preventDefault (阻止 xterm 内部处理)
├── insertReplacementText → 缓冲 (WKWebView 韩语组字)
└── insertText + CJK → 缓冲 (WKWebView 单字符)

compositionend:
├── 手动写入 PTY (committed text，单次)
├── 同步清空 textarea (防止 xterm 读到旧内容)
└── 设置 80ms post-composition 窗口

onData 过滤:
├── composing 期间 → 全部抑制
├── post-composition 80ms 内 → 抑制确认键残留
│   ├── 空格 (0x20)
│   ├── 换行 (0x0A, 0x0D)
│   ├── DEL (0x7F) ← xterm 检测到 textarea 缩短产生的假删除
│   └── NBSP (0xA0) ← WebKit IME 确认键变体
└── 其他 → 正常发送到 PTY
```

### 关键发现（调试过程）

| 尝试 | 结果 | 原因 |
|------|------|------|
| `beforeinput(insertText)` 也 preventDefault | "好"丢失 | 破坏 IME/textarea 内部状态 |
| 延迟清空 textarea (setTimeout 4ms) | 3个空格泄漏到 PTY | xterm `_finalizeComposition` 的 setTimeout(0) 先于我们的清空运行 |
| 同步清空 + DEL/NBSP 抑制 | ✅ 工作 | 清空阻止 xterm 读旧内容，post-composition 窗口拦截假 DEL |

### 调试方法

Console 输入 `window.__CATGO_IME_DEBUG = true` 可开启详细 IME 事件日志，记录每个 `beforeinput`、`compositionend`、`onData` 的数据和 hex 编码。

## 测试

1. 启动 `pnpm tauri:dev` 或 `pnpm desktop:serve`
2. 打开终端，切换到中文输入法
3. 输入"你好"→ 空格 → 输入"你好" → 两次都应完整显示
4. 连续快速输入多个中文词组 → 不应有字符丢失或多余空格
5. 退格键正常工作（不受 post-composition 抑制影响）
