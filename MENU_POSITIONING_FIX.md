# Context Menu Positioning Fix

## Problem

The context menu was appearing at the correct position **on the page**, but not **within the viewer**.

### Example:

- Viewer starts at position (200, 100) on the page
- You click at position (300, 200) within the viewer
- Click position on page: (500, 300) = (200 + 300, 100 + 200)
- Menu appeared at (500, 300) on the **page** (outside viewer)
- But should appear at (300, 200) **within the viewer**

---

## Root Cause

1. **Menu was rendered outside `.structure` div**
   - Positioned relative to page body
   - Used absolute page coordinates

2. **Used `event.clientX` and `event.clientY` directly**
   - These are positions from top-left of **window**
   - Not relative to the viewer

---

## Solution

### Change 1: Move Menu Inside Viewer (Lines 1121-1182)

**Before:**

```svelte
</div> <!-- Close structure div -->

<!-- Menu outside viewer -->
<ContextMenu ... />
```

**After:**

```svelte
    <!-- Menu inside structure div -->
    <ContextMenu ... />
  {:else if structure}
    <p class="warn">No sites found in structure</p>
</div>  <!-- Close structure div -->
```

**Why this works:**

- `.structure` div has `position: relative` (line 1209)
- ContextMenu uses `position: absolute`
- Absolute elements position relative to nearest positioned ancestor
- Now menu positions relative to viewer, not page!

---

### Change 2: Calculate Position Relative to Viewer (Lines 765-774)

**Before:**

```typescript
context_menu_position = { x: event.clientX, y: event.clientY }
```

**After:**

```typescript
// Calculate position relative to viewer, not page
if (wrapper) {
  const rect = wrapper.getBoundingClientRect()
  context_menu_position = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  }
} else {
  context_menu_position = { x: event.clientX, y: event.clientY }
}
```

**Line-by-line breakdown:**

**Line 766: Check wrapper exists**

```typescript
if (wrapper) {
```

- `wrapper` is the `.structure` div element
- Bound on line 897: `bind:this={wrapper}`
- Need it to get viewer position/size

**Line 767: Get viewer dimensions**

```typescript
const rect = wrapper.getBoundingClientRect()
```

- Returns viewer's position and size on page
- Example: `{ left: 200, top: 100, width: 800, height: 600 }`

**Lines 768-771: Convert to viewer-relative coordinates**

```typescript
context_menu_position = {
  x: event.clientX - rect.left,
  y: event.clientY - rect.top,
}
```

**Math example:**

```
Page coordinates (clientX/Y):
  Click at (500, 300) on page

Viewer position (rect):
  left: 200, top: 100

Viewer-relative position:
  x = 500 - 200 = 300  (300px from left edge of viewer)
  y = 300 - 100 = 200  (200px from top edge of viewer)

Result: Menu appears at (300, 200) within viewer
```

**Lines 772-774: Fallback**

```typescript
} else {
  context_menu_position = { x: event.clientX, y: event.clientY }
}
```

- If wrapper not available yet, use page coordinates
- Better than crashing
- Rare edge case (viewer loads before wrapper binds)

---

### Change 3: Same Fix for Atom Handler (Lines 813-822)

Updated `on_atom_context_menu` function with identical logic:

```typescript
// Calculate position relative to viewer, not page
if (wrapper) {
  const rect = wrapper.getBoundingClientRect()
  context_menu_position = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  }
} else {
  context_menu_position = { x: event.clientX, y: event.clientY }
}
```

Same conversion for when you right-click on an atom.

---

## Visual Explanation

### Before Fix:

```
Browser Window
┌─────────────────────────────────────────────┐
│ Page Header                                 │
├─────────────────────────────────────────────┤
│                                             │
│   ┌─────────────────────────┐              │
│   │ Viewer (200, 100)       │              │
│   │                         │              │
│   │     👆 Click (300, 200) │              │
│   │        in viewer        │              │
│   │                         │              │
│   └─────────────────────────┘              │
│                                             │
│                     ┌──────────┐            │
│                     │ Menu at  │ ← Wrong!  │
│                     │ (500,300)│            │
│                     └──────────┘            │
│   On page, not in viewer                   │
└─────────────────────────────────────────────┘
```

Menu appeared at **page coordinates** (500, 300), which is outside the viewer!

### After Fix:

```
Browser Window
┌─────────────────────────────────────────────┐
│ Page Header                                 │
├─────────────────────────────────────────────┤
│                                             │
│   ┌─────────────────────────┐              │
│   │ Viewer (200, 100)       │              │
│   │                         │              │
│   │     👆 Click (300, 200) │              │
│   │        ┌──────────┐     │              │
│   │        │ Menu at  │     │ ← Correct!   │
│   │        │ (300,200)│     │              │
│   │        └──────────┘     │              │
│   └─────────────────────────┘              │
│                                             │
└─────────────────────────────────────────────┘
```

Menu appears at **viewer coordinates** (300, 200), exactly where you clicked!

---

## The Math

### Coordinate Conversion Formula:

```
viewer_x = page_x - viewer_left
viewer_y = page_y - viewer_top
```

Where:

- `page_x` = `event.clientX` (click position on page)
- `page_y` = `event.clientY` (click position on page)
- `viewer_left` = `rect.left` (viewer's left edge on page)
- `viewer_top` = `rect.top` (viewer's top edge on page)

### Example Calculation:

**Given:**

- Viewer at (200, 100) on page, size 800×600
- Click at (500, 300) on page

**Calculate:**

```javascript
rect = wrapper.getBoundingClientRect()
// Returns: { left: 200, top: 100, width: 800, height: 600 }

viewer_x = event.clientX - rect.left
         = 500 - 200
         = 300

viewer_y = event.clientY - rect.top
         = 300 - 100
         = 200
```

**Result:**

- Menu positioned at (300, 200) within viewer
- This is 300px from left edge, 200px from top edge of viewer
- Exactly where you clicked!

---

## Testing

### How to Verify:

1. **Load a structure** in the viewer

2. **Right-click at different positions**:
   - Top-left corner of viewer
   - Center of viewer
   - Bottom-right corner of viewer

3. **Check menu appears at cursor**:
   - Menu should be exactly at your mouse pointer
   - Menu should stay within viewer boundaries (with smart positioning)
   - Not offset by viewer's position on page

4. **Test with viewer at different page positions**:
   - Scroll page down → Right-click → Menu should still be at cursor
   - Resize window → Right-click → Menu should still be at cursor

### Console Output:

When you right-click, check console (F12):

```javascript
Context menu opened at Object { x: 300, y: 200 }
```

The `x` and `y` values should now be:

- Relative to viewer (not page)
- Match where you clicked within the viewer
- Same values even if you scroll the page

---

## Edge Cases Handled

### 1. Wrapper Not Yet Bound

```typescript
if (wrapper) {
  // Use wrapper-relative coordinates
} else {
  // Fallback to page coordinates
}
```

- Rare case during initial load
- Menu might be misplaced briefly
- Better than crashing

### 2. Menu Goes Off-Screen

The ContextMenu component has `get_smart_position()` that adjusts:

- If menu would go off right edge → shift left
- If menu would go off bottom edge → shift up
- Ensures menu stays visible

### 3. Element Selector Position

The element selector (lines 1165-1182) uses the same `context_menu_position`:

```svelte
<div style="top: {context_menu_position.y}px; left: {context_menu_position.x + 180}px;">
```

- Positioned 180px to the right of menu
- Also now relative to viewer
- Scrolls with viewer, not with page

---

## Summary of Changes

| File             | Lines     | Change                                                             |
| ---------------- | --------- | ------------------------------------------------------------------ |
| Structure.svelte | 1121-1182 | Moved ContextMenu and element selector **inside** `.structure` div |
| Structure.svelte | 765-774   | Convert click position to **viewer-relative** coordinates          |
| Structure.svelte | 813-822   | Same conversion for atom right-click handler                       |

**Total changes:** 3 sections modified

**Result:** Menu now appears exactly where you click **within the viewer**, not on the page!

---

## Before vs After

### Before:

```typescript
// Page coordinates
context_menu_position = { x: event.clientX, y: event.clientY }
// Example: { x: 500, y: 300 } - position on page

// Rendered outside viewer
</div>
<ContextMenu position={...} />
```

### After:

```typescript
// Viewer-relative coordinates
const rect = wrapper.getBoundingClientRect()
context_menu_position = {
  x: event.clientX - rect.left,  // Subtract viewer offset
  y: event.clientY - rect.top,
}
// Example: { x: 300, y: 200 } - position in viewer

// Rendered inside viewer
    <ContextMenu position={...} />
</div>
```

The fix is complete! The menu now appears at your cursor position within the viewer, regardless of where the viewer is positioned on the page.
