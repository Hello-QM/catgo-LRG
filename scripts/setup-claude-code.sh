#!/bin/bash
# Setup Claude Code MCP integration for CatGO development.
# Usage: bash scripts/setup-claude-code.sh
#
# Prerequisites:
#   - Claude Code CLI installed (https://docs.anthropic.com/en/docs/claude-code)
#   - Python conda env "catgo" with CatGO server dependencies
#   - jq and curl (for SessionStart hook)
#
# What this does:
#   1. Registers catgo MCP server in ~/.claude/mcp.json
#   2. Installs SessionStart hook in ~/.claude/hooks/
#   3. Adds hook config to ~/.claude/settings.json

set -euo pipefail

# Resolve project root (where this script lives)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# --- Detect Python ---
PYTHON=""
if command -v conda &>/dev/null; then
  CONDA_BASE="$(conda info --base 2>/dev/null)"
  if [ -x "$CONDA_BASE/envs/catgo/bin/python" ]; then
    PYTHON="$CONDA_BASE/envs/catgo/bin/python"
  fi
fi
if [ -z "$PYTHON" ]; then
  # Fallback: try system python with mcp import
  for py in python3 python; do
    if command -v "$py" &>/dev/null && "$py" -c "import mcp" 2>/dev/null; then
      PYTHON="$(command -v "$py")"
      break
    fi
  done
fi
if [ -z "$PYTHON" ]; then
  echo "Error: Could not find Python with MCP SDK installed."
  echo "  Install: conda activate catgo && pip install mcp"
  exit 1
fi
echo "Using Python: $PYTHON"

# --- Directories ---
CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/hooks"
mkdir -p "$HOOKS_DIR"

MCP_JSON="$CLAUDE_DIR/mcp.json"
SETTINGS_JSON="$CLAUDE_DIR/settings.json"
HOOK_SCRIPT="$HOOKS_DIR/catgo-session-start.sh"
SERVER_SCRIPT="$PROJECT_DIR/server/mcp_tools/server_claude_code.py"

# Verify server script exists
if [ ! -f "$SERVER_SCRIPT" ]; then
  echo "Error: MCP server not found at $SERVER_SCRIPT"
  echo "  Are you running this from the CatGO project root?"
  exit 1
fi

# --- 1. Configure mcp.json ---
echo "Configuring $MCP_JSON ..."
if [ -f "$MCP_JSON" ]; then
  # Merge into existing mcp.json using jq
  if command -v jq &>/dev/null; then
    TEMP=$(mktemp)
    jq --arg py "$PYTHON" --arg srv "$SERVER_SCRIPT" \
      '.mcpServers.catgo = {
        "command": $py,
        "args": [$srv],
        "env": {"CATGO_API": "http://localhost:8000/api"}
      }' "$MCP_JSON" > "$TEMP" && mv "$TEMP" "$MCP_JSON"
  else
    echo "Warning: jq not found, cannot merge. Writing fresh mcp.json."
    cat > "$MCP_JSON" <<MCPEOF
{
  "mcpServers": {
    "catgo": {
      "command": "$PYTHON",
      "args": ["$SERVER_SCRIPT"],
      "env": {
        "CATGO_API": "http://localhost:8000/api"
      }
    }
  }
}
MCPEOF
  fi
else
  cat > "$MCP_JSON" <<MCPEOF
{
  "mcpServers": {
    "catgo": {
      "command": "$PYTHON",
      "args": ["$SERVER_SCRIPT"],
      "env": {
        "CATGO_API": "http://localhost:8000/api"
      }
    }
  }
}
MCPEOF
fi
echo "  Done."

# --- 2. Install hook script ---
echo "Installing hook: $HOOK_SCRIPT ..."
cp "$PROJECT_DIR/scripts/catgo-session-start.sh" "$HOOK_SCRIPT"
chmod +x "$HOOK_SCRIPT"
echo "  Done."

# --- 3. Configure settings.json (add SessionStart hook) ---
echo "Configuring $SETTINGS_JSON ..."
HOOK_CMD="bash $HOOK_SCRIPT"

if [ -f "$SETTINGS_JSON" ] && command -v jq &>/dev/null; then
  # Check if hook already configured
  EXISTING=$(jq -r '.hooks.SessionStart // empty' "$SETTINGS_JSON" 2>/dev/null)
  if [ -z "$EXISTING" ]; then
    TEMP=$(mktemp)
    jq --arg cmd "$HOOK_CMD" \
      '.hooks.SessionStart = [{
        "matcher": "startup",
        "hooks": [{"type": "command", "command": $cmd, "timeout": 5}]
      }]' "$SETTINGS_JSON" > "$TEMP" && mv "$TEMP" "$SETTINGS_JSON"
    echo "  Added SessionStart hook."
  else
    echo "  SessionStart hook already configured, skipping."
  fi
elif [ ! -f "$SETTINGS_JSON" ]; then
  cat > "$SETTINGS_JSON" <<SETEOF
{
  "permissions": {
    "allow": []
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "$HOOK_CMD",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
SETEOF
  echo "  Created settings.json with hook."
else
  echo "  Warning: jq not found and settings.json exists. Please add hook manually."
  echo "  See: scripts/catgo-session-start.sh"
fi

# --- Summary ---
echo ""
echo "=== CatGO Claude Code integration ready ==="
echo ""
echo "To use:"
echo "  1. Start CatGO backend:  cd $PROJECT_DIR && pnpm desktop:serve"
echo "  2. Open Claude Code:     claude"
echo "  3. Try:                  catgo_view(action=\"get_state\")"
echo ""
echo "5 MCP tools available: catgo_structure, catgo_fetch, catgo_workflow, catgo_analyze, catgo_view"
