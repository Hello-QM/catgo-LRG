@echo off
REM CatGo CLI wrapper (Windows) — forwards to the bundled catgo-server, which
REM dispatches CLI subcommands to catgo.cli. Place next to catgo-server.exe.
"%~dp0catgo-server.exe" %*
