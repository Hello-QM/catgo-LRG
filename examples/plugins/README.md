# CatGo Example Plugins

This directory contains example plugins demonstrating how to extend CatGo.

## Frontend Plugin: Charge Coloring

**Location:** `charge-coloring/`

A frontend plugin that colorizes atoms based on their oxidation state or computed charge.

### Features:
- Atom coloring based on charge/oxidation state
- Multiple color schemes (diverging, sequential, viridis)
- Settings panel in structure sidebar
- Persistent settings

### Installation:
1. ZIP the `charge-coloring` directory
2. In CatGo, go to Plugins > Add Plugin
3. Upload the ZIP file

### Plugin Structure:
```
charge-coloring/
├── catgo-plugin.json    # Plugin manifest
└── dist/
    └── index.js         # Main plugin code
```

## Backend Plugin: Lennard-Jones Calculator

**Location:** `lennard-jones-calculator/`

A backend plugin providing a simple Lennard-Jones potential calculator for noble gases.

### Features:
- ASE-compatible calculator
- Support for He, Ne, Ar, Kr, Xe
- Configurable cutoff radius

### Installation:
1. Copy `lennard-jones-calculator` to `plugins/` directory
2. Restart the CatGo server
3. The calculator will appear in the optimization options

### Plugin Structure:
```
lennard-jones-calculator/
├── catgo-plugin.json    # Plugin manifest
└── plugin.py            # Python calculator class
```

## Creating Your Own Plugin

### Frontend Plugin

1. Create a `catgo-plugin.json` manifest:
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "displayName": "My Plugin",
  "catgo": {
    "apiVersion": "1.0",
    "frontend": {
      "main": "dist/index.js",
      "contributions": {
        "views": [...],
        "panels": [...],
        "structureHooks": [...]
      }
    },
    "permissions": ["structure:read"]
  }
}
```

2. Export your plugin components and hooks:
```javascript
// dist/index.js
export function activate(context) {
  console.log('Plugin activated!')
}

export function deactivate() {
  console.log('Plugin deactivated!')
}

export function atomColorsHook(sites, currentColors) {
  // Return custom colors
}
```

### Backend Plugin

1. Create a `catgo-plugin.json` manifest:
```json
{
  "name": "my-calculator",
  "version": "1.0.0",
  "catgo": {
    "apiVersion": "1.0",
    "backend": {
      "main": "plugin.py"
    }
  }
}
```

2. Implement your calculator:
```python
# plugin.py
from plugins.base import CalculatorPlugin

class MyCalculatorPlugin(CalculatorPlugin):
    name = "my-calculator"
    calculator_id = "my_calc"
    display_name = "My Calculator"
    version = "1.0.0"
    author = "Your Name"

    def get_calculator(self, **kwargs):
        # Return ASE-compatible calculator
        pass
```

## Documentation

For detailed documentation, see the main CatGo plugin development guide.
