; CatGo NSIS installer hooks — expose the `catgo` CLI on PATH so commands like
; `catgo view structure.cif` work from a terminal after installing the app.
;
; The bundled `catgo-server.exe` sidecar contains the full `catgo` Python
; package and dispatches CLI subcommands (view/gui/slab/dos/…) to catgo.cli.
; We drop a tiny `catgo.cmd` shim that forwards to it, in a dedicated `cli`
; subfolder that we add to the per-user PATH. The shim lives in its own folder
; (NOT $INSTDIR) so its name never collides with the GUI `CatGo.exe` in $INSTDIR
; (Windows PATH resolves `.exe` before `.cmd`).
;
; Implemented with core NSIS only — no EnVar/StrFunc plugins (Tauri's bundled
; NSIS toolchain does not ship them). PATH is appended via a direct HKCU
; Environment registry write + a settings-change broadcast.
;
; Only the NSIS (`-setup.exe`) installer runs these hooks; the `.msi` (WiX)
; build does not, so the release notes point CLI users at the `.exe`.

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$INSTDIR\cli"
  FileOpen $9 "$INSTDIR\cli\catgo.cmd" w
  FileWrite $9 "@echo off$\r$\n"
  FileWrite $9 '"%~dp0..\catgo-server.exe" %*$\r$\n'
  FileClose $9
  ; Append the shim folder to the current user's PATH.
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCmp $0 "" 0 +3
    WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR\cli"
    Goto +2
  WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR\cli"
  ; Broadcast WM_SETTINGCHANGE so new terminals pick up the PATH change.
  SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\cli\catgo.cmd"
  RMDir "$INSTDIR\cli"
!macroend
