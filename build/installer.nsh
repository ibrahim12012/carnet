; Sharp installer on high-resolution screens (otherwise Windows scales it up and it gets blurry).
ManifestDPIAware true

; Phone camera: lets the phone reach Carnet on the local network (port 28451).
; If the installation has no administrator rights, the command fails without blocking, and Windows
; asks for permission the first time the QR code is shown.
!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Carnet"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Carnet" dir=in action=allow program="$INSTDIR\Carnet.exe" enable=yes profile=any description="Lets the phone act as a camera for Carnet on the local network"'
!macroend
; Update: the rule is kept (only a real uninstall removes it).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Carnet"'
    ; Daily reminder: Carnet no longer starts with Windows once uninstalled.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Carnet"
  ${endIf}
!macroend
