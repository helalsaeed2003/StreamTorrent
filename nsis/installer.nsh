; The extra page the installer shows, the one every Windows installer has:
; which shortcuts to make, and what StreamTorrent should open.
;
; Nothing here does the work. The answers are written to
; HKCU\Software\StreamTorrent\Setup and the app carries them out the first
; time it runs (src/main/setup-answers.js). The shortcuts have to be named and
; pointed the way the app does it, and a file association needs a signed
; UserChoice entry that only a program running as the user can write, so the
; installer asks and the app acts.

!ifndef BUILD_UNINSTALLER

!include nsDialogs.nsh
!include LogicLib.nsh
!include WinMessages.nsh

Var StOptionsDialog
Var StCbDesktop
Var StCbStartMenu
Var StCbTorrent
Var StCbMagnet

Var StWantDesktop
Var StWantStartMenu
Var StWantTorrent
Var StWantMagnet

; Whether the page was ever drawn. An update installs silently, with no pages
; at all, and must not be read as four answers of "no".
Var StAsked

Function stOptionsPage
  ; An update installs silently, with no pages at all, so there is nothing to
  ; skip here: this page is only ever drawn for someone installing by hand.
  ; The two lines at the top of the window are set by hand: this file is
  ; included before the interface macros are defined, so MUI_HEADER_TEXT
  ; cannot be used here. 1037 and 1038 are the title and subtitle.
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Select Additional Tasks"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Which additional tasks should be performed?"

  ; Everything on the first time the page is drawn, which is what the boxes on
  ; an installer's tasks page normally are. Going back to the page keeps
  ; whatever was ticked.
  ${If} $StAsked != 1
    StrCpy $StWantDesktop 1
    StrCpy $StWantStartMenu 1
    StrCpy $StWantTorrent 1
    StrCpy $StWantMagnet 1
  ${EndIf}

  nsDialogs::Create 1018
  Pop $StOptionsDialog
  ${If} $StOptionsDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u "Select the additional tasks you would like Setup to perform while installing StreamTorrent, then click Next."
  Pop $0

  ${NSD_CreateLabel} 0 26u 100% 10u "Shortcuts:"
  Pop $0

  ${NSD_CreateCheckbox} 8u 38u 100% 12u "Create a &desktop shortcut"
  Pop $StCbDesktop
  ${If} $StWantDesktop == 1
    ${NSD_Check} $StCbDesktop
  ${EndIf}

  ${NSD_CreateCheckbox} 8u 52u 100% 12u "Create a &Start menu shortcut"
  Pop $StCbStartMenu
  ${If} $StWantStartMenu == 1
    ${NSD_Check} $StCbStartMenu
  ${EndIf}

  ${NSD_CreateLabel} 0 72u 100% 10u "Open these with StreamTorrent:"
  Pop $0

  ${NSD_CreateCheckbox} 8u 84u 100% 12u "&.torrent files"
  Pop $StCbTorrent
  ${If} $StWantTorrent == 1
    ${NSD_Check} $StCbTorrent
  ${EndIf}

  ${NSD_CreateCheckbox} 8u 98u 100% 12u "&magnet: links"
  Pop $StCbMagnet
  ${If} $StWantMagnet == 1
    ${NSD_Check} $StCbMagnet
  ${EndIf}

  ${NSD_CreateLabel} 0 116u 100% 20u "You can change any of this later in Preferences, or in Windows Settings under Apps > Default apps."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function stOptionsLeave
  StrCpy $StAsked 1
  ${NSD_GetState} $StCbDesktop $StWantDesktop
  ${NSD_GetState} $StCbStartMenu $StWantStartMenu
  ${NSD_GetState} $StCbTorrent $StWantTorrent
  ${NSD_GetState} $StCbMagnet $StWantMagnet
FunctionEnd

; Shown after the folder has been chosen, where an installer's tasks page goes
!macro customPageAfterChangeDir
  Page custom stOptionsPage stOptionsLeave
!macroend

!endif

!macro customInstall
  ; Nothing is recorded when the page was never shown: a silent update must
  ; not be taken for someone unticking every box
  ${If} $StAsked == 1
    ; Pending is written last and read first, so a key half written by an
    ; installer that was stopped partway is ignored rather than acted on
    WriteRegDWORD HKCU "Software\StreamTorrent\Setup" "DesktopShortcut" $StWantDesktop
    WriteRegDWORD HKCU "Software\StreamTorrent\Setup" "StartMenuShortcut" $StWantStartMenu
    WriteRegDWORD HKCU "Software\StreamTorrent\Setup" "TorrentFiles" $StWantTorrent
    WriteRegDWORD HKCU "Software\StreamTorrent\Setup" "MagnetLinks" $StWantMagnet
    WriteRegDWORD HKCU "Software\StreamTorrent\Setup" "Pending" 1
  ${EndIf}
!macroend

; The shortcuts and the registry entries are the app's, so the uninstaller has
; to take them: nothing else will. The torrent list and watch progress live in
; %LOCALAPPDATA%\StreamTorrentData and are left alone.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    Delete "$DESKTOP\Stream Torrent.lnk"
    Delete "$SMPROGRAMS\Stream Torrent.lnk"

    DeleteRegKey HKCU "Software\StreamTorrent"
    DeleteRegValue HKCU "Software\RegisteredApplications" "StreamTorrent"

    DeleteRegKey HKCU "Software\Classes\com.streamtorrent.torrent"
    DeleteRegKey HKCU "Software\Classes\com.streamtorrent.magnet"
    DeleteRegKey HKCU "Software\Classes\com.streamtorrent.stream-magnet"

    ; Only ours is taken away. Another program may have registered these since.
    ReadRegStr $0 HKCU "Software\Classes\.torrent" ""
    ${If} $0 == "com.streamtorrent.torrent"
      DeleteRegKey HKCU "Software\Classes\.torrent"
    ${Else}
      DeleteRegValue HKCU "Software\Classes\.torrent\OpenWithProgids" "com.streamtorrent.torrent"
    ${EndIf}

    ; Exactly what the app writes there, so an entry left behind by another
    ; program is not touched
    StrCpy $1 '"$INSTDIR\StreamTorrent.exe" "--" "%1"'

    ReadRegStr $0 HKCU "Software\Classes\magnet\shell\open\command" ""
    ${If} $0 == $1
      DeleteRegKey HKCU "Software\Classes\magnet"
    ${EndIf}

    ReadRegStr $0 HKCU "Software\Classes\stream-magnet\shell\open\command" ""
    ${If} $0 == $1
      DeleteRegKey HKCU "Software\Classes\stream-magnet"
    ${EndIf}
  ${EndIf}
!macroend
