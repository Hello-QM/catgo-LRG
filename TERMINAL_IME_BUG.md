# Terminal IME Bug

更新时间: 2026-03-13

状态:

- open
- 已有第二版前端修复尝试，但根据当前实现和你的现测反馈，这个问题仍未彻底解决

现象:

- 在内置终端输入中文时，拼音输入过程中的字符会 duplicated / multiplied
- 典型表现仍然是中间拼音、候选确认后的汉字，或两者混杂重复出现在终端里
- 当前还出现了新的可复现残留症状:
  - 如果前一次中文输入是用空格确认，下一次输入时会夹带空格
  - 表现为词组之间被莫名插入空格，像是上一次 IME confirmation key 泄漏到了下一次提交

## 当前代码状态

仓库里已经存在一段 IME 相关保护逻辑，但它不在旧文档写的 `TerminalWindow.svelte`，而是在:

- `src/lib/structure/TerminalPanel.svelte`

当前实现可直接确认:

- 监听了 `term.textarea` 的 `compositionstart`
- 监听了 `term.textarea` 的 `compositionupdate`
- 监听了 `term.textarea` 的 `compositionend`
- 在 `beforeinput(insertFromComposition)` 上做了 `preventDefault()`
- 在 `compositionend` 中手动把 committed text 写入 PTY
- 在 `term.onData(...)` 中保留了 `is_composing` 拦截
- 还额外尝试拦截 `compositionend` 后 80ms 内的 `insertText(" ")`

关键位置:

- `src/lib/structure/TerminalPanel.svelte:296`
- `src/lib/structure/TerminalPanel.svelte:323`
- `src/lib/structure/TerminalPanel.svelte:351`
- `src/lib/structure/TerminalPanel.svelte:373`

因此，旧文档里“还没有做 composition lock”以及“尚未拦截 beforeinput”的说法都已经过时。

## 为什么这条 bug 仍然应视为未解决

虽然实现已经从“只拦 `onData`”推进到了“拦 `beforeinput(insertFromComposition)` + `compositionend` 手动写 PTY”，但它仍没有彻底闭环。

当前更准确的问题是:

- 旧的主重复路径已经被重新建模
- 但 IME confirmation key，尤其是空格确认，仍然会以残留 `insertText(" ")` 或 textarea 遗留状态的形式泄漏
- 现有的 `80ms` 时间窗拦截还不足以稳定消除这种空格泄漏

再结合你现在的实测反馈:

- 你在 terminal 上输入中文仍然 duplicated or multiplied
- 并且当上一次输入用空格确认后，下一次输入会莫名带出空格

可以把这条问题明确标记为:

- 仍然存在
- 旧修复思路不足
- 旧文档状态过于乐观

## 旧文档里已经过时的部分

以下内容不再准确:

- “高优先级前端文件是 `src/lib/structure/TerminalWindow.svelte`”
  - 当前真正处理 xterm 输入的是 `src/lib/structure/TerminalPanel.svelte`
- “推荐修复是增加 composition lock”
  - 这一步现在已经做了
  - 但问题仍在，说明不能再把它当成完整修复方案
- “当前还没有 beforeinput 级别处理”
  - 这一步现在也已经做了
  - 但残留 bug 说明 `insertFromComposition` 拦截本身还不够

## 当前更准确的判断

这不是“完全未修”的 bug，而是:

- 已经尝试过至少两版前端 IME 修复
- 当前版本已经显式拦 `beforeinput(insertFromComposition)`，并在 `compositionend` 手动单发 committed text
- 但 confirmation-space / textarea residue 相关问题仍未被稳定消除
- 因此 bug 仍是 open

## 后续排查建议

如果后面继续只做文档或分析，下一步应该重点核对这些链路:

1. 空格确认时，`compositionend` 之后究竟还会触发几次 `beforeinput(inputType="insertText", data=" ")`
2. 这些空格事件的实际时间分布是否稳定落在 `80ms` 内
3. `xt_textarea.value` 是否在 composition 结束后仍残留未清空内容
4. 是否存在:
   - 手动 `compositionend -> PTY write`
   - shell echo
   - textarea 残留 / confirmation key
   三者中的两条或三条叠加
5. 是否需要把当前“时间窗拦截”升级为“状态机式清空与确认键消费”

## 结论

`TERMINAL_IME_BUG.md` 之前的修复建议已经大部分落地，但 bug 仍未解决。  
按当前代码和你的实际反馈，这条问题应继续保留为 `open`，而且当前最显著的残留问题已经从“纯重复提交”收敛成“confirmation space 泄漏 + 残留重复”。 
