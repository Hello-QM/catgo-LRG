export interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => string | Promise<string>

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // Visibility tools
  {
    name: `toggle_atoms`,
    description: `Show or hide atoms in the 3D structure viewer.`,
    input_schema: {
      type: `object`,
      properties: {
        visible: {
          type: `boolean`,
          description: `Whether atoms should be visible.`,
        },
      },
      required: [`visible`],
    },
  },
  {
    name: `toggle_bonds`,
    description: `Show or hide bonds between atoms. When visible, bonds are always shown regardless of structure type.`,
    input_schema: {
      type: `object`,
      properties: {
        visible: {
          type: `boolean`,
          description: `Whether bonds should be visible.`,
        },
      },
      required: [`visible`],
    },
  },
  {
    name: `toggle_unit_cell`,
    description: `Show or hide the unit cell box for periodic structures.`,
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
  {
    name: `toggle_labels`,
    description: `Show or hide atom site labels (element symbols) on each atom.`,
    input_schema: {
      type: `object`,
      properties: {
        visible: {
          type: `boolean`,
          description: `Whether labels should be visible.`,
        },
      },
      required: [`visible`],
    },
  },
  {
    name: `toggle_force_vectors`,
    description: `Show or hide force vectors on atoms (if force data is available).`,
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
  // Camera tools
  {
    name: `reset_camera`,
    description: `Reset the camera to the default position and zoom level.`,
    input_schema: {
      type: `object`,
      properties: {},
    },
  },
  {
    name: `set_rotation`,
    description: `Set the structure rotation to specific angles (in degrees). Use this to view the structure from specific crystallographic directions.`,
    input_schema: {
      type: `object`,
      properties: {
        x: {
          type: `number`,
          description: `Rotation around x-axis in degrees.`,
        },
        y: {
          type: `number`,
          description: `Rotation around y-axis in degrees.`,
        },
        z: {
          type: `number`,
          description: `Rotation around z-axis in degrees.`,
        },
      },
      required: [`x`, `y`, `z`],
    },
  },
  // Selection tools
  {
    name: `select_atoms`,
    description: `Select specific atoms by their site indices (0-based).`,
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
  {
    name: `select_by_element`,
    description: `Select all atoms of a given element (e.g. "O" for oxygen, "Si" for silicon).`,
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
  {
    name: `clear_selection`,
    description: `Clear the current atom selection.`,
    input_schema: {
      type: `object`,
      properties: {},
    },
  },
  // Appearance tools
  {
    name: `set_atom_radius`,
    description: `Set the atom display radius (scaling factor). Default is 0.2, range 0.1 to 2.0.`,
    input_schema: {
      type: `object`,
      properties: {
        radius: {
          type: `number`,
          description: `Atom radius scaling factor (0.1 to 2.0).`,
          minimum: 0.1,
          maximum: 2.0,
        },
      },
      required: [`radius`],
    },
  },
  {
    name: `set_bond_color`,
    description: `Set the color of bonds. Use CSS color values like hex codes or named colors.`,
    input_schema: {
      type: `object`,
      properties: {
        color: {
          type: `string`,
          description: `CSS color value for bonds (e.g. "#ffffff", "red", "rgb(0,128,255)").`,
        },
      },
      required: [`color`],
    },
  },
]
