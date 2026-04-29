#!/bin/bash
# CatGO SessionStart hook — detect backend and inject one-line status.
# Cost: ~30 tokens, fires once per session.
STATE=$(curl -s --max-time 2 http://localhost:8000/api/view/state 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$STATE" ]; then
  exit 0
fi
HAS=$(echo "$STATE" | jq -r '.has_structure // false')
if [ "$HAS" = "true" ]; then
  FORMULA=$(echo "$STATE" | jq -r '.formula // "?"')
  NSITES=$(echo "$STATE" | jq -r '.num_sites // 0')
  echo "{\"additionalContext\": \"[CatGO] Backend online. Loaded: ${FORMULA}, ${NSITES} atoms. Use catgo_* MCP tools to interact.\"}"
else
  echo "{\"additionalContext\": \"[CatGO] Backend online, no structure loaded. Use catgo_fetch to load one.\"}"
fi
