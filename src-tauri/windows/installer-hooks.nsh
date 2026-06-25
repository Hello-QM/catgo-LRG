; CatGo NSIS installer hooks — expose the `catgo` CLI on PATH so commands like
; `catgo view structure.cif` work from a terminal after installing the app.
;
; The bundled `catgo-server.exe` sidecar contains the full `catgo` Python
; package and dispatches CLI subcommands (view/gui/slab/dos/…) to catgo.cli.
; We drop a tiny `catgo.cmd` shim that forwards to it, in a dedicated `cli`
; subdirectory that we add to the per-user PATH. The shim lives in its own
; folder (NOT $INSTDIR) so its name never collides with the GUI `CatGo.exe`
; that sits in $INSTDIR (Windows PATH resolves `.exe` before `.cmd`).
;
; Only the NSIS (`-setup.exe`) installer runs these hooks; the `.msi` (WiX)
; build does not, so the release notes point CLI users at the `.exe`.

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$INSTDIR\cli"
  FileOpen $9 "$INSTDIR\cli\catgo.cmd" w
  FileWrite $9 "@echo off$\r$\n"
  FileWrite $9 '"%~dp0..\catgo-server.exe" %*$\r$\n'
  FileClose $9
  ; Add the shim folder to the current user's PATH (EnVar ships with Tauri NSIS).
  EnVar::SetHKCU
  EnVar::AddValue "Path" "$INSTDIR\cli"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  EnVar::SetHKCU
  EnVar::DeleteValue "Path" "$INSTDIR\cli"
  Delete "$INSTDIR\cli\catgo.cmd"
  RMDir "$INSTDIR\cli"
!macroend
