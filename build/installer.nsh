; Extra NSIS steps for the Autobot Terminal installer (included by electron-builder).

; The bundled console host (OpenConsole.exe) needs icu.dll, which Windows 10 only has from
; version 1903 (build 18362). Stop early with a clear message instead of failing at first launch.
!macro customInit
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  StrCmp $0 "" autobotBuildOk 0
  IntCmp $0 18362 autobotBuildOk autobotBuildTooOld autobotBuildOk
  autobotBuildTooOld:
    MessageBox MB_OK|MB_ICONSTOP "Autobot Terminal needs Windows 10 version 1903 (build 18362) or newer.$\r$\nThis PC runs build $0. Please update Windows and run the installer again." /SD IDOK
    Quit
  autobotBuildOk:
!macroend
