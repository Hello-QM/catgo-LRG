# Terminal IME Investigation

Date: 2026-03-13

Scope:

- investigate the current Chinese IME duplication bug in CatGo terminal
- compare CatGo's implementation with xterm.js integration guidance and VS Code terminal notes
- no source-code changes made

## Executive Conclusion

The bug should still be treated as `open`.

CatGo already contains one frontend mitigation in `src/lib/structure/TerminalPanel.svelte`:

- `compositionstart` sets `is_composing = true`
- `compositionend` sets `is_composing = false`
- `term.onData(...)` is suppressed while composing

This report was originally written before the newer `beforeinput(insertFromComposition)` interception landed.  
Current code has moved further than that first pass, but the bug still remains in a narrower form.

That mitigation is real, but it is not a complete IME-safe input pipeline.

The most likely reason the bug still reproduces is that the current code only guards one event path:

- xterm `onData`

but IME commit behavior can also involve:

- browser composition lifecycle
- `beforeinput` / `input`
- xterm internal textarea handling
- shell / PTY echo

So the current implementation can still end up sending or rendering the same logical text more than once.

## Current Local Findings

### Frontend terminal wiring

Current terminal input is handled in:

- `src/lib/structure/TerminalPanel.svelte`

Relevant current behavior:

- xterm is opened with `term.open(container_el!)`
- keystrokes are forwarded through `term.onData((data) => pty_session?.write(data))`
- PTY output is rendered through `session.onData((data) => term.write(data))`

This is the classic xterm bridge shape:

- frontend input -> PTY
- PTY output -> frontend terminal

That shape is normal, but it is also exactly where IME duplication tends to happen if composition is not modeled correctly.

### Existing IME mitigation

The current code now adds more than the first-pass composition lock:

- `compositionstart`
- `compositionupdate`
- `compositionend`
- `beforeinput(insertFromComposition)` -> `preventDefault()`
- manual PTY write on `compositionend`
- an `is_composing` gate around `term.onData(...)`
- a short window intended to swallow trailing confirmation-space events

This means the old diagnosis "there is no composition lock" is no longer accurate.

### Revised local finding after the newer patch

The current implementation explicitly assumes the following Tauri/WebKit path:

- `beforeinput(insertFromComposition)` -> xterm textarea path
- `input(insertFromComposition)`
- `compositionend`
- no meaningful IME commit data arriving via xterm `onData`

That model is consistent with the event logs already observed in local testing.

### Why the current mitigation is still insufficient

The bug has changed shape.

The main remaining symptom is no longer just "committed text duplicates".  
The newer residual symptom is:

- if one IME commit is confirmed with space,
- the next Chinese input can inherit or leak that space into the shell output

This strongly suggests at least one of the following is still happening:

1. the IME confirmation key (`space`) survives as a later `insertText(" ")` event outside the current suppression window
2. xterm's textarea still retains stale content across compositions
3. the frontend now correctly single-sends committed Chinese text, but confirmation-space cleanup is still incomplete

## Why VS Code Often Looks Better

The short answer is: VS Code is not magically immune, but its terminal stack is much more mature.

VS Code’s terminal sits on a heavily exercised integration path:

- `xterm.js`
- `node-pty`
- platform-specific backend handling
- dedicated terminal logging and prompt/shell integration diagnostics

Relevant source:

- VS Code terminal issue wiki: https://github.com/microsoft/vscode/wiki/Terminal-Issues

Important nuance:

- VS Code itself documents `Non-English characters duplicated on Windows` as a long-standing known issue.

So the correct comparison is **not**:

- "VS Code solved this class of bug once and for all"

The correct comparison is:

- VS Code has a more mature terminal stack and more diagnostics
- but even VS Code still acknowledges this category of issue, especially on Windows

## What the Public Sources Say

### 1. VS Code explicitly lists non-English duplication as a known issue

VS Code’s terminal wiki lists:

- `Non-English characters duplicated on Windows`

and also explains that some terminal bugs are really upstream/backend issues involving:

- `xterm.js`
- `node-pty`
- `conpty`

Source:

- https://github.com/microsoft/vscode/wiki/Terminal-Issues

This matters because it invalidates the simplistic assumption that "VS Code never has this problem".

### 2. xterm.js’s documented integration pattern is intentionally simple

xterm.js documents the common bridge as:

- `pty.onData(recv => terminal.write(recv))`
- `terminal.onData(send => pty.write(send))`

Source:

- https://xtermjs.org/docs/guides/encoding/

This is the same high-level pattern CatGo uses now.

That means the remaining bug is not caused by using a fundamentally wrong architecture.  
It is more likely caused by missing IME-specific handling around that otherwise standard bridge.

### 3. Browser IME handling is broader than compositionstart/compositionend

MDN documents:

- `KeyboardEvent.isComposing`
- `beforeinput`
- `InputEvent.isComposing`

and explicitly notes that IME-related edits may require handling both `beforeinput` and `input`, because browser behavior varies.

Sources:

- https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing
- https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event

This is the strongest public signal that CatGo’s current implementation is probably too narrow:

- it only watches composition events
- it does not reason about `beforeinput` / `input`

## Most Likely Root Cause in CatGo

Based on current code, the new logs, and the latest symptom, the strongest hypothesis is:

CatGo now controls the committed-text path more explicitly, but it still does not fully control the IME confirmation-key residue path.

The remaining race / leakage window is probably between:

- browser IME confirmation key handling
- post-`compositionend` `beforeinput(insertText, data=" ")`
- textarea residual state
- shell-side echo after manual commit write

This would explain the newly observed behavior:

- previous composition confirmed with space
- next composition output starts containing unexpected spaces

## Why This Bug May Be Worse in CatGo Than in VS Code

CatGo currently has:

- a thinner terminal integration layer
- no equivalent of VS Code’s frontend terminal trace + PTY host trace workflow
- no visible IME-specific event instrumentation

So even if the underlying issue class is shared, CatGo has fewer guardrails and fewer diagnostics.

In addition, CatGo has two PTY backends:

- Tauri Rust PTY: `src-tauri/src/pty.rs`
- Python WebSocket PTY: `server/routers/pty.py`

That increases the test surface:

- one frontend
- two backend transports
- potentially different echo behavior

## Recommended Debugging Direction

The previous recommendation to add event-level tracing was correct and has already paid off.  
The next useful validation is narrower:

The most useful signals to capture are:

1. `compositionstart`
2. `compositionupdate`
3. `compositionend`
4. `beforeinput`
5. `input`
6. whether each event has `isComposing`
7. what exact payload arrives in `term.onData(...)`
8. what exact payload comes back from PTY echo
9. exactly how many `insertText(" ")` events occur after `compositionend`
10. whether `xt_textarea.value` is non-empty before the next composition starts

Without that trace, it is easy to guess wrong and "fix" only one duplicate path while another remains.

## Practical Engineering Recommendation

If this is fixed later, the repair should probably move from:

- "one boolean around `term.onData`"

to:

- explicit separation between:
  - committed composition text
  - confirmation-key residue
- event-aware handling using `beforeinput` / `input` and `isComposing`
- verification that the final committed string is forwarded to PTY exactly once
- explicit cleanup of post-composition textarea / confirmation-key state
- verification that stray confirmation spaces cannot survive into the next composition

## Bottom Line

The current terminal IME bug is **not** a documentation-only problem.

The repository now contains a more advanced IME patch than this report originally assumed:

- `beforeinput(insertFromComposition)` interception
- manual single PTY write on `compositionend`

But the latest user-visible symptom shows that the bug is still unresolved in a narrower form:

- committed Chinese text handling improved
- confirmation-space leakage still remains

VS Code does not disprove that; its own terminal documentation acknowledges this issue class, especially on Windows.

## Sources

- VS Code terminal issue wiki: https://github.com/microsoft/vscode/wiki/Terminal-Issues
- xterm.js encoding / PTY integration guide: https://xtermjs.org/docs/guides/encoding/
- MDN `KeyboardEvent.isComposing`: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing
- MDN `beforeinput`: https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event
