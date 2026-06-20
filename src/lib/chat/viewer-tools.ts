// CatBot viewer-control tools: drive the live 3D viewer (visibility, camera,
// rotation, selection, appearance) through the action-handler registry. Pure
// data module (no import from structure-tools — avoids a circular init); the
// `VIEWER_TOOLS` array is registered into CLIENT_TOOLS by structure-tools.ts.
//
// All 12 are kind:'read' — they only change reversible, client-only VIEW state
// (no compute, no data loss). kind:'mutate' would render a permission card on
// EVERY call (tool-loop.ts), which would make routine view toggles unusable.
import type { ClientTool } from './types'
import { get_viewer_action_handler } from './viewer-tool-executor'

type ViewerToolRun = (input: Record<string, unknown>) => unknown

/** Coerce a model-supplied "boolean" to a real boolean. The schema says boolean,
 *  but weaker models (e.g. Ollama qwen2.5) often send the STRING `"false"` —
 *  which is truthy, so `!!"false"` would WRONGLY show what the user asked to
 *  hide. Treat `false`/`"false"`/`0`/`"no"` as false; everything else by its
 *  natural truthiness. */
function as_bool(v: unknown): boolean {
  if (typeof v === `string`) {
    const s = v.trim().toLowerCase()
    return !(s === `false` || s === `0` || s === `no` || s === ``)
  }
  return !!v
}

// Graceful degradation: no viewer mounted/active (headless, SSR, or chat open
// with no structure pane). Return structured JSON, never throw — the model can
// report it and retry once a viewer is focused. View tools are idempotent, so a
// no-op here is safe.
const NO_VIEWER = {
  status: `no_viewer`,
  applied: false,
  message: `No active 3D structure viewer is open, so I can't change the view. ` +
    `Open or focus a structure pane and try again.`,
} as const

const NO_STRUCTURE = {
  status: `no_structure`,
  applied: false,
  message: `A 3D viewer is open but no structure is loaded.`,
} as const

/** Boolean scene-prop toggle (show_atoms / show_cell / show_site_labels / …).
 *  `subject` is the sentence subject incl. verb ("Atoms are", "The unit cell
 *  is") so the human-readable `message` reads naturally. Small local models
 *  (e.g. Ollama qwen2.5) reliably ECHO a result's `message` but misread terse
 *  flag JSON as "a function call that doesn't match" — so every result carries
 *  one. */
function toggle(scene_key: string, subject: string): ViewerToolRun {
  return (input) => {
    const h = get_viewer_action_handler(String(input.viewer_id ?? ``) || undefined)
    if (!h) return NO_VIEWER
    const visible = as_bool(input.visible)
    h.set_scene_prop(scene_key, visible)
    return {
      ok: true,
      [scene_key]: visible,
      message: `${subject} now ${visible ? `shown` : `hidden`}.`,
    }
  }
}

export const VIEWER_TOOLS: { def: ClientTool; run: ViewerToolRun }[] = [
  // ── Visibility ──
  {
    def: {
      name: `toggle_atoms`,
      description: `Show or hide atoms in the 3D structure viewer.`,
      kind: `read`,
      input_schema: {
        type: `object`,
        properties: {
          visible: { type: `boolean`, description: `Whether atoms should be visible.` },
        },
        required: [`visible`],
      },
    },
    run: toggle(`show_atoms`, `Atoms are`),
  },
  {
    def: {
      name: `toggle_bonds`,
      description:
        `Show or hide bonds between atoms. When visible, bonds are always shown regardless of structure type.`,
      kind: `read`,
      input_schema: {
        type: `object`,
        properties: {
          visible: { type: `boolean`, description: `Whether bonds should be visible.` },
        },
        required: [`visible`],
      },
    },
    // show_bonds is an ENUM (never|always|crystals|molecules), not a boolean —
    // map the toggle to 'always'/'never' or the bond renderer silently no-ops.
    run: (input) => {
      const h = get_viewer_action_handler(String(input.viewer_id ?? ``) || undefined)
      if (!h) return NO_VIEWER
      const visible = as_bool(input.visible)
      const value = visible ? `always` : `never`
      h.set_scene_prop(`show_bonds`, value)
      return {
        ok: true,
        show_bonds: value,
        message: `Bonds are now ${visible ? `shown` : `hidden`}.`,
      }
    },
  },
  {
    def: {
      name: `toggle_unit_cell`,
      description: `Show or hide the unit cell box for periodic structures.`,
      kind: `read`,
      input_schema: {
        type: `object`,
        properties: {
          visible: {
            type: `boolean`,
            description: `Whether the unit cell should be visible.`,
          },
        },
        required: [`visible`],
      },
    },
    // scene-prop key is show_cell, not show_unit_cell
    run: toggle(`show_cell`, `The unit cell is`),
  },
  {
    def: {
      name: `toggle_labels`,
      description: `Show or hide atom site labels (element symbols) on each atom.`,
      kind: `read`,
      input_schema: {
        type: `object`,
        properties: {
          visible: { type: `boolean`, description: `Whether labels should be visible.` },
        },
        required: [`visible`],
      },
    },
    run: toggle(`show_site_labels`, `Atom labels are`),
  },
  {
    def: {
      name: `toggle_force_vectors`,
      description: `Show or hide force vectors on atoms (if force data is available).`,
      kind: `read`,
      input_schema: {
        type: `object`,
        properties: {
          visible: {
            type: `boolean`,
            description: `Whether force vectors should be visible.`,
          },
        },
        required: [`visible`],
      },
    },
    run: toggle(`show_force_vectors`, `Force vectors are`),
  },
  // ── Camera ──
  {
    def: {
      name: `reset_camera`,
      description: `Reset the camera to the default position and zoom level.`,
      kind: `read`,
      input_schema: { type: `object`, properties: {} },
    },
    run: (input) => {
      const h = get_viewer_action_handler(String(input.viewer_id ?? ``) || undefined)
      if (!h) return NO_VIEWER
      h.reset_camera()
      return { ok: true, message: `Camera reset to the default view.` }
    },
  },
  {
    def: {
      name: `set_rotation`,
      description:
        `Set the structure rotation to specific angles (in degrees). Use this to view the structure from specific crystallographic directions.`,
      kind: `read`,
      input_schema: {
        type: `object`,
        properties: {
          x: { type: `number`, description: `Rotation around x-axis in degrees.` },
          y: { type: `number`, description: `Rotation around y-axis in degrees.` },
          z: { type: `number`, description: `Rotation around z-axis in degrees.` },
        },
        required: [`x`, `y`, `z`],
      },
    },
    // Tool input is DEGREES; scene_props.rotation is RADIANS (the UI does the same
    // to_radians() conversion). Skipping this would be a 57x rotation error.
    run: (input) => {
      const h = get_viewer_action_handler(String(input.viewer_id ?? ``) || undefined)
      if (!h) return NO_VIEWER
      const to_rad = (d: unknown) => ((Number(d) || 0) * Math.PI) / 180
      const rotation: [number, number, number] = [
        to_rad(input.x),
        to_rad(input.y),
        to_rad(input.z),
      ]
      h.set_scene_prop(`rotation`, rotation)
      const deg = {
        x: Number(input.x) || 0,
        y: Number(input.y) || 0,
        z: Number(input.z) || 0,
      }
      return {
        ok: true,
        rotation_deg: deg,
        message: `Rotated the structure to x=${deg.x}°, y=${deg.y}°, z=${deg.z}°.`,
      }
    },
  },
  // ── Selection ──
  {
    def: {
      name: `select_atoms`,
      description: `Select specific atoms by their site indices (0-based).`,
      kind: `read`,
      input_schema: {
        type: `object`,
        properties: {
          indices: {
            type: `array`,
            items: { type: `integer` },
            description: `Array of atom site indices to select (0-based).`,
          },
        },
        required: [`indices`],
      },
    },
    run: (input) => {
      const h = get_viewer_action_handler(String(input.viewer_id ?? ``) || undefined)
      if (!h) return NO_VIEWER
      const n = h.site_count()
      if (n === 0) return NO_STRUCTURE
      const raw = Array.isArray(input.indices) ? input.indices : []
      // Validate against the real site count + dedup so out-of-range model
      // indices don't highlight ghost atoms.
      const valid = [
        ...new Set(raw.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < n)),
      ]
      h.set_selection(valid)
      return {
        ok: true,
        selected: valid.length,
        indices: valid,
        message: valid.length
          ? `Selected ${valid.length} atom${valid.length === 1 ? `` : `s`}.`
          : `No valid atoms to select.`,
      }
    },
  },
  {
    def: {
      name: `select_by_element`,
      description:
        `Select all atoms of a given element (e.g. "O" for oxygen, "Si" for silicon).`,
      kind: `read`,
      input_schema: {
        type: `object`,
        properties: {
          element: {
            type: `string`,
            description: `Element symbol (e.g. "O", "Si", "Fe").`,
          },
        },
        required: [`element`],
      },
    },
    run: (input) => {
      const h = get_viewer_action_handler(String(input.viewer_id ?? ``) || undefined)
      if (!h) return NO_VIEWER
      if (h.site_count() === 0) return NO_STRUCTURE
      const element = String(input.element ?? ``).trim()
      const selected = h.select_by_element(element)
      // Not an error when nothing matches — let the model tell the user.
      return {
        ok: true,
        element,
        selected,
        message: selected
          ? `Selected ${selected} ${element} atom${selected === 1 ? `` : `s`}.`
          : `No ${element} atoms found in this structure.`,
      }
    },
  },
  {
    def: {
      name: `clear_selection`,
      description: `Clear the current atom selection.`,
      kind: `read`,
      input_schema: { type: `object`, properties: {} },
    },
    run: (input) => {
      const h = get_viewer_action_handler(String(input.viewer_id ?? ``) || undefined)
      if (!h) return NO_VIEWER
      h.clear_selection()
      return { ok: true, message: `Cleared the atom selection.` }
    },
  },
  // ── Appearance ──
  {
    def: {
      name: `set_atom_radius`,
      description:
        `Set the atom display radius (scaling factor). Default is 1.5, range 0.1 to 3.0.`,
      kind: `read`,
      input_schema: {
        type: `object`,
        properties: {
          radius: {
            type: `number`,
            description:
              `Atom radius scaling factor (0.1 to 3.0; 1.5 = default, 0.5 = ball-and-stick).`,
            minimum: 0.1,
            maximum: 3.0,
          },
        },
        required: [`radius`],
      },
    },
    run: (input) => {
      const h = get_viewer_action_handler(String(input.viewer_id ?? ``) || undefined)
      if (!h) return NO_VIEWER
      const raw = Number(input.radius)
      if (!Number.isFinite(raw)) {
        return { status: `error`, message: `radius must be a number` }
      }
      const radius = Math.min(3.0, Math.max(0.1, raw)) // clamp to config bounds [0.1, 3.0]
      h.set_scene_prop(`atom_radius`, radius)
      return {
        ok: true,
        atom_radius: radius,
        message: `Set the atom radius to ${radius}.`,
      }
    },
  },
  {
    def: {
      name: `set_bond_color`,
      description:
        `Set the color of bonds. Use CSS color values like hex codes or named colors.`,
      kind: `read`,
      input_schema: {
        type: `object`,
        properties: {
          color: {
            type: `string`,
            description:
              `CSS color value for bonds (e.g. "#ffffff", "red", "rgb(0,128,255)").`,
          },
        },
        required: [`color`],
      },
    },
    run: (input) => {
      const h = get_viewer_action_handler(String(input.viewer_id ?? ``) || undefined)
      if (!h) return NO_VIEWER
      const color = String(input.color ?? ``).trim()
      if (!color) return { status: `error`, message: `color is required` }
      h.set_scene_prop(`bond_color`, color)
      return { ok: true, bond_color: color, message: `Set the bond color to ${color}.` }
    },
  },
]

for (const entry of VIEWER_TOOLS) {
  const schema = entry.def.input_schema as { properties?: Record<string, unknown> }
  schema.properties ??= {}
  schema.properties.viewer_id = {
    type: `string`,
    description: `Target viewer_id or pane position alias, e.g. "bottom-right" or "右下角". Omit for the active pane.`,
  }
}
