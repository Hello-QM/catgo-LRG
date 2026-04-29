"""CatGo Workflow State Machine Engine.

Usage:
    from catgo.workflow.engine import WorkflowEngine
    from catgo.workflow.db import WorkflowDB
    from catgo.workflow.config import load_config

    db = WorkflowDB("~/.catgo/catgo.db")
    config = load_config()
    engine = WorkflowEngine(db=db, config=config)

    # Run once (for testing):
    engine.scan_cycle()

    # Run forever (for production):
    await engine.run_forever()
"""

from catgo.workflow.engine.scanner import WorkflowEngine
import catgo.workflow.engine.engine_builtins  # noqa: F401 — trigger registrations

__all__ = ["WorkflowEngine"]
