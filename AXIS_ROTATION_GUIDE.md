# Axis-Locked Rotation Feature - Implementation Guide

This document explains the axis-locked rotation feature added to the 3D structure viewer with detailed line-by-line code breakdowns.

---

## Table of Contents

1. [Overview](#overview)
2. [What Was Added](#what-was-added)
3. [How It Works](#how-it-works)
4. [Code Changes Explained](#code-changes-explained)
5. [Testing the Feature](#testing-the-feature)

---

## Overview

### What This Feature Does

Allows users to rotate a 3D molecular structure around a **single axis** (X, Y, or Z) by:

1. Holding down the X, Y, or Z key
2. Dragging the mouse to rotate around that axis only
3. Pressing R or clicking "Reset" to return to the initial rotation

This provides precise control over viewing angles when analyzing molecular structures.

---

## What Was Added

### New User Controls

1. **Keyboard-based axis locking**: Press and hold X/Y/Z keys
2. **Mouse-based rotation**: While holding a key, drag to rotate
3. **Visual feedback**: On-screen indicator showing which axis is locked
4. **Reset button**: In the controls panel + keyboard shortcut (R)

### Files Modified

1. `src/lib/structure/Structure.svelte` - Main viewer component
2. `src/lib/structure/StructureScene.svelte` - 3D rendering scene
3. `src/lib/structure/StructureControls.svelte` - UI controls panel

---

## How It Works

### The Flow

```javascript
// State variables
let axis_locked = null // 'x', 'y', 'z', or null
let is_rotating = false
let rotation = [0, 0, 0] // [x_angle, y_angle, z_angle] in radians

// When user presses X/Y/Z key:
function onKeyPress(key) {
  if (key === 'x' || key === 'y' || key === 'z') {
    axis_locked = key
    console.log('Rotating on', key.toUpperCase(), '-axis')
  }
}

// When user releases key:
function onKeyRelease(key) {
  if (key === axis_locked) {
    axis_locked = null
    is_rotating = false
  }
}

// When user clicks mouse (while key held):
function onMouseDown(x, y) {
  if (axis_locked !== null) {
    is_rotating = true
    start_position = [x, y]
    start_rotation = [...rotation] // Copy current rotation
  }
}

// When user moves mouse (while rotating):
function onMouseMove(x, y) {
  if (is_rotating) {
    let delta = x - start_position[0] // or y, depending on larger movement
    let angle_change = delta * 0.01 // sensitivity factor

    // Update only the locked axis
    if (axis_locked === 'x') {
      rotation[0] = start_rotation[0] + angle_change
    } else if (axis_locked === 'y') {
      rotation[1] = start_rotation[1] + angle_change
    } else { // 'z'
      rotation[2] = start_rotation[2] + angle_change
    }
  }
}
```

---

## Code Changes Explained

This section breaks down each code change line-by-line across the three modified files.

---

### 1. Structure.svelte - State Variables (Lines ~45-50)

Added five new reactive state variables to track the axis-lock rotation feature:

```javascript
let axis_lock_key = $state < 'x' | 'y' | 'z' | null > (null)
```

- Stores which axis key (X, Y, or Z) is currently being held down
- `$state()` makes it reactive - UI automatically updates when this changes
- TypeScript type restricts it to only 'x', 'y', 'z', or null

```javascript
let is_rotating = $state(false)
```

- Boolean flag tracking whether user is actively dragging the mouse to rotate
- Starts as `false`, becomes `true` when mouse is clicked while an axis key is held

```javascript
let rotation_start_x = $state(0)
let rotation_start_y = $state(0)
```

- Store the mouse cursor's X and Y pixel positions when rotation drag begins
- Used to calculate how far the mouse has moved during dragging

```javascript
let rotation_start_values = $state < [number, number, number] > [0, 0, 0]
```

- Stores the rotation angles [x, y, z] at the moment dragging started
- New rotation = start rotation + mouse movement delta
- Type enforces it's always an array of exactly 3 numbers

---

### 2. Structure.svelte - Keyboard Event Handlers (Lines ~607-697)

**Function: `onkeydown` - Handles key press events**

```javascript
function onkeydown(event: KeyboardEvent) {
```

- Triggered whenever user presses any key on keyboard
- `event: KeyboardEvent` contains information about which key was pressed

```javascript
const target = event.target as HTMLElement
const is_input_focused = target.tagName === `INPUT` || target.tagName === `TEXTAREA`
if (is_input_focused) return
```

- Check if user is currently typing in a text input or textarea
- If so, exit early - don't interfere with normal typing
- Prevents axis keys from triggering when user is typing in a form field

```javascript
const key_lower = event.key.toLowerCase()
```

- Get the pressed key and convert to lowercase ('X' becomes 'x')
- Allows both uppercase and lowercase keys to work

```javascript
if ([`x`, `y`, `z`].includes(key_lower) && !event.repeat) {
```

- Check if pressed key is X, Y, or Z
- `!event.repeat` - ignore if key is being held (prevents repeated triggers)
- Only activate on the initial key press, not while holding

```javascript
    event.preventDefault()
    axis_lock_key = key_lower as 'x' | 'y' | 'z'
    console.log('Axis lock activated:', axis_lock_key)
    return
}
```

- `event.preventDefault()` - stop browser from doing its default action with this key
- Set `axis_lock_key` to the pressed axis ('x', 'y', or 'z')
- Log for debugging purposes
- Exit the function early

```javascript
if (event.key === `r` && !event.ctrlKey && !event.metaKey) {
```

- Check if 'R' key was pressed (case-sensitive)
- Make sure Ctrl+R or Cmd+R weren't pressed (those are for browser refresh)

```javascript
        event.preventDefault()
        scene_props.rotation = [0, 0, 0]
    }
}
```

- Stop browser's default action
- Reset all three rotation axes to zero (return to initial view)

**Function: `onkeyup` - Handles key release events**

```javascript
function onkeyup(event: KeyboardEvent) {
    const key_lower = event.key.toLowerCase()
    if ([`x`, `y`, `z`].includes(key_lower)) {
        axis_lock_key = null
        is_rotating = false
    }
}
```

- Triggered when user releases a key
- Convert key to lowercase
- If it's an axis key (X, Y, or Z), deactivate axis lock mode
- Clear `axis_lock_key` (no axis locked anymore)
- Stop rotating (even if mouse is still held down)

---

### 3. Structure.svelte - Mouse Event Handlers (Lines ~607-697)

**Function: `onmousedown` - Handles mouse click**

```javascript
function onmousedown(event: MouseEvent) {
    console.log('Mouse down, axis_lock_key:', axis_lock_key)
```

- Triggered when user presses a mouse button
- Log the current axis lock state for debugging

```javascript
if (axis_lock_key && event.button === 0) {
```

- Only proceed if an axis key is held AND left mouse button was clicked
- `event.button === 0` checks for left mouse button (0=left, 1=middle, 2=right)

```javascript
is_rotating = true
rotation_start_x = event.clientX
rotation_start_y = event.clientY
```

- Mark that rotation has begun
- Save the current mouse cursor position in pixels
- `clientX`/`clientY` are pixel coordinates relative to browser window

```javascript
rotation_start_values = [...(scene_props.rotation || [0, 0, 0])]
```

- Save the current rotation angles as the starting point
- `...` spreads values to create a copy (not a reference)
- `|| [0, 0, 0]` provides fallback if rotation is undefined

```javascript
        console.log('Started rotating on', axis_lock_key, 'from', rotation_start_values)
        event.preventDefault()
    }
}
```

- Log for debugging
- Prevent default browser mouse behavior

**Function: `onmousemove` - Handles mouse movement**

```javascript
function onmousemove(event: MouseEvent) {
    if (!is_rotating || !axis_lock_key) return
```

- Triggered whenever mouse moves
- Exit early if not currently rotating or no axis is locked
- This function only does work during active axis-locked rotation

```javascript
const delta_x = event.clientX - rotation_start_x
const delta_y = event.clientY - rotation_start_y
```

- Calculate how many pixels the mouse has moved from start position
- Positive `delta_x` = moved right, negative = moved left
- Positive `delta_y` = moved down, negative = moved up

```javascript
const sensitivity = 0.01
```

- Conversion factor from pixels to radians
- 100 pixels of mouse movement = 1 radian of rotation
- Tune this value to make rotation faster or slower

```javascript
const delta = Math.abs(delta_x) > Math.abs(delta_y) ? delta_x : -delta_y
```

- Choose which mouse movement direction to use
- If horizontal movement is larger, use that
- If vertical movement is larger, use that (negated so up = positive rotation)
- Makes rotation feel natural regardless of drag direction

```javascript
const rotation_delta = delta * sensitivity
```

- Convert pixel movement to rotation angle in radians
- E.g., 50 pixels × 0.01 = 0.5 radians of rotation

```javascript
scene_props.rotation = scene_props.rotation || [0, 0, 0]
const axis_index = { x: 0, y: 1, z: 2 }[axis_lock_key]
```

- Ensure rotation array exists
- Map axis key to array index: 'x'→0, 'y'→1, 'z'→2
- This tells us which element of the array to update

```javascript
    const new_rotation = [...rotation_start_values]
    new_rotation[axis_index] = rotation_start_values[axis_index] + rotation_delta
    scene_props.rotation = new_rotation
}
```

- Create a copy of the starting rotation values
- Update only the locked axis by adding the rotation delta
- Assign the new rotation array to trigger UI update

**Function: `onmouseup` - Handles mouse release**

```javascript
function onmouseup() {
  if (is_rotating) {
    is_rotating = false
  }
}
```

- Triggered when user releases mouse button
- Stop rotating (but keep axis locked if key still held)
- User can release mouse, move it, and click again to continue rotating

---

### 4. Structure.svelte - Event Handler Attachment (Lines ~738)

```svelte
<svelte:document
  {onkeydown}
  {onkeyup}
  {onmousemove}
  {onmouseup}
/>
```

- Attaches event handlers to the entire document (whole page)
- Keyboard events work regardless of which element has focus
- Mouse move/up work even if cursor leaves the 3D viewer area
- `{onkeydown}` is shorthand for `onkeydown={onkeydown}`

```svelte
<div
  {onmousedown}
  ...
>
```

- Attaches mousedown handler specifically to the viewer div
- Rotation only starts when clicking inside the 3D viewer
- Other mouse events are on document so they work anywhere

---

### 5. Structure.svelte - Visual Feedback Indicator (Lines ~947-951)

```svelte
{#if axis_lock_key}
  <div class="axis-lock-indicator" style="color: {({ x: 'red', y: 'green', z: 'blue' })[axis_lock_key]}">
    Rotating on {axis_lock_key.toUpperCase()}-axis
  </div>
{/if}
```

- `{#if axis_lock_key}` - only show this div when an axis key is held
- `class="axis-lock-indicator"` - applies CSS styling (defined below)
- `style="color: ..."` - sets text color based on which axis:
  - X-axis = red
  - Y-axis = green
  - Z-axis = blue
- `{axis_lock_key.toUpperCase()}` - displays "X", "Y", or "Z" in the message
- Entire block disappears when key is released (axis_lock_key becomes null)

---

### 6. Structure.svelte - CSS Styling (Lines ~1007-1027)

```css
.axis-lock-indicator {
```

- Defines styles for the on-screen indicator

```css
position: absolute;
top: 50%;
left: 50%;
transform: translate(-50%, -50%);
```

- Position absolutely within parent container
- `top: 50%; left: 50%` places top-left corner at center
- `transform: translate(-50%, -50%)` shifts it back to truly center it
- Standard CSS centering technique

```css
background: rgba(0, 0, 0, 0.7);
```

- Black background with 70% opacity
- Semi-transparent so structure is visible behind it

```css
padding: 12px 24px;
border-radius: 8px;
```

- `padding` - 12px vertical spacing, 24px horizontal spacing inside box
- `border-radius` - rounded corners (8px radius)

```css
font-size: 1.5em;
font-weight: bold;
```

- Text size 1.5× the default
- Bold font weight for emphasis

```css
pointer-events: none;
```

- Critical: makes indicator "invisible" to mouse clicks
- Clicks pass through to the 3D scene below
- Prevents indicator from blocking user interaction

```css
z-index: 100000001;
```

- Layer ordering - very high number ensures it appears on top
- Higher z-index = closer to user

```css
text-shadow: 0 0 10px currentColor;
```

- Glow effect around text
- Blur radius of 10px in the same color as the text
- Makes text stand out more

```css
    border: 2px solid currentColor;
}
```

- 2px border around the box
- `currentColor` uses the text color (red/green/blue depending on axis)
- Creates color-coordinated border

---

### 7. StructureScene.svelte - Axis Lock Prop (Line ~94)

```typescript
axis_lock_active = false,
```

- New prop added to component interface
- Receives boolean indicating if axis lock is currently active
- Defaults to `false` if not provided

**Line ~157:**

```javascript
let { ..., axis_lock_active = false }: Props = $props()
```

- Destructures the new prop from component props
- Sets default value of `false` in case parent doesn't provide it

---

### 8. StructureScene.svelte - Disable OrbitControls (Lines ~438-448)

```javascript
let orbit_controls_props = $derived({
    position: [0, 0, 0],
    enableRotate: rotate_speed > 0 && !axis_lock_active,
```

- `$derived` creates a computed value that auto-updates when dependencies change
- `enableRotate` is true only if:
  - `rotate_speed > 0` (rotation is enabled in settings) AND
  - `!axis_lock_active` (no axis is locked)
- When axis is locked, this becomes `false` and disables default orbit rotation

```javascript
rotateSpeed: rotate_speed,
enableZoom: zoom_speed > 0 && !axis_lock_active,
```

- Also disable zoom when axis is locked
- Prevents conflicting interactions

```javascript
zoomSpeed: camera_projection === `orthographic` ? zoom_speed * 2 : zoom_speed,
enablePan: pan_speed > 0 && !axis_lock_active,
```

- Also disable panning when axis is locked
- Ensures only axis-locked rotation can happen during that mode

---

### 9. StructureControls.svelte - Reset Button UI (Lines ~365-377)

```svelte
<div class="axis-rotation-header">
  <span>Axis Rotation</span>
```

- Header section for the axis rotation controls
- Shows "Axis Rotation" label

```svelte
<button
  class="reset-rotation-btn"
  onclick={() => { scene_props.rotation = [0, 0, 0] }}
```

- Button element with styling class
- `onclick` - arrow function that runs when clicked
- Sets all rotation angles back to zero

```svelte
title="Reset rotation to initial position" > Reset
</button>
</div>
```

- `title` attribute creates tooltip on hover
- Button displays "Reset" text

---

### 10. StructureControls.svelte - Button CSS (Lines ~865-886)

```css
.axis-rotation-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}
```

- Flexbox layout to space out label and button
- `justify-content: space-between` pushes items to opposite ends
- `align-items: center` vertically centers them
- Small margin below the header

```css
.reset-rotation-btn {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
```

- Small padding for compact button
- Smaller font size than default

```css
background: var(--sqd-primary-bg);
color: var(--sqd-primary-fg);
border: 1px solid var(--sqd-border-color);
```

- Uses CSS variables for theming
- Primary background/foreground colors
- 1px border with theme-defined color

```css
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
}
```

- Slightly rounded corners
- Cursor changes to pointer on hover
- Smooth 0.2 second transition for all property changes

```css
.reset-rotation-btn:hover {
  background: var(--sqd-primary-hover-bg);
}
```

- Different background color when hovering
- Provides visual feedback for interactivity

---

## Testing the Feature

### 1. Start the Development Server

```bash
npm run dev
```

### 2. Open the Application

Navigate to `http://localhost:3001/` (or whatever port is shown)

### 3. Load a Structure

Use the file drop or load an example structure

### 4. Test Axis-Locked Rotation

1. Press and hold **X** key
2. You should see: "Rotating on X-axis" (in red) in the center
3. Click and drag mouse left/right or up/down
4. Structure should rotate around X-axis only
5. Release X key to exit axis-lock mode

### 5. Test Reset

1. Rotate the structure on multiple axes
2. Click the **Reset** button in the Controls panel (under Camera → Axis Rotation)
3. OR press **R** key
4. All rotations should return to [0, 0, 0]

---

## Debugging Tips

### 1. Console Logging

```javascript
console.log('Variable value:', my_variable)
console.log('Axis lock:', axis_lock_key, 'Rotating:', is_rotating)
```

**View logs:** Press F12 in browser → Console tab

### 2. Breakpoints

1. Open browser DevTools (F12)
2. Go to Sources tab
3. Find your file
4. Click line number to add breakpoint
5. Code will pause when it hits that line

### 3. Check State in Real-Time

With Svelte DevTools extension, you can inspect all `$state` variables live

---

## Summary of Changes

| File                       | Lines Changed                           | What Changed                                                                  |
| -------------------------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| `Structure.svelte`         | 45-50, 607-697, 738, 947-951, 1007-1027 | Added state variables, keyboard/mouse handlers, visual indicator, CSS styling |
| `StructureScene.svelte`    | 94, 157, 438-448                        | Added `axis_lock_active` prop, disabled OrbitControls when axis locked        |
| `StructureControls.svelte` | 365-377, 865-886                        | Added reset button and styling                                                |

**Total:** ~100 lines of new code across 3 files

---

## Next Steps / Possible Enhancements

1. **Add rotation speed control** - adjust the `sensitivity` parameter
2. **Add rotation limits** - prevent rotation beyond certain angles
3. **Add animation** - smooth transition when resetting
4. **Add rotation display** - show current rotation angles in degrees
5. **Add snap to angles** - snap to 0°, 90°, 180°, 270° when close

---

## Questions?

If you're stuck, check:

1. Browser console (F12) for errors or logs
2. Network tab to see if files are loading
3. Elements tab to inspect the HTML structure

This feature demonstrates core web development concepts:

- State management with reactive variables
- Event handling for user interactions
- Conditional rendering for dynamic UI
- Coordinate transformations for 3D rotations
- Mouse and keyboard event processing
