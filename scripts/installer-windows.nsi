; delta-agent Windows 安装器（F-51 AC-51-3）
;
; 输入：build/delta-win32-x64.exe（scripts/build-sea.mjs 的 SEA 产物）
; 输出：build/delta-win32-x64-installer.exe
;
; 设计口径：
;   - 按用户安装（%LOCALAPPDATA%\Programs\delta），不要求管理员权限；
;   - PATH 写入 HKCU Environment，并广播 WM_SETTINGCHANGE（新开终端立即可见）；
;   - 卸载器从 PATH 摘除安装目录并删除文件；用户数据 ~/.delta 默认保留。
;
; CI 用法（windows runner）：
;   choco install nsis -y
;   makensis scripts/installer-windows.nsi

Unicode true
ManifestDPIAware true

!include "MUI2.nsh"
!include "StrFunc.nsh"

; StrFunc：先无参声明注册宏（${Un*} 为卸载段版本）
${StrTok}
${UnStrTok}
${StrStr}
${UnStrStr}

!define APP_NAME "delta-agent"
!define EXE_NAME "delta.exe"
!define INSTALL_ROOT "$LOCALAPPDATA\Programs\delta"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\delta-agent"
!define HWND_BROADCAST 0xFFFF
!define WM_SETTINGCHANGE 0x001A
!define MUI_ABORTWARNING

Name "${APP_NAME}"
OutFile "..\build\delta-win32-x64-installer.exe"
InstallDir "${INSTALL_ROOT}"
RequestExecutionLevel user

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; ── PATH 维护（HKCU Environment；无外部插件） ────────────────────────────

; 追加 $INSTDIR 到用户 PATH（已存在则跳过）
Function AddToPath
  Push $R0
  Push $R1
  ReadRegStr $R0 HKCU "Environment" "Path"
  ; 以 ";" 锚定防部分匹配（delta 与 delta-old 之类）
  ${StrStr} $R1 "$R0;" "${INSTALL_ROOT};"
  StrCmp $R1 "" 0 done
  StrCmp $R0 "" 0 +3
    StrCpy $R0 "${INSTALL_ROOT}"
    Goto write
  StrCpy $R0 "$R0;${INSTALL_ROOT}"
write:
  WriteRegExpandStr HKCU "Environment" "Path" "$R0"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
done:
  Pop $R1
  Pop $R0
FunctionEnd

; 从用户 PATH 摘除 $INSTDIR 段
Function un.RemoveFromPath
  Push $R0 ; 原 PATH
  Push $R1 ; token 下标
  Push $R2 ; 当前 token
  Push $R3 ; 重组结果
  ReadRegStr $R0 HKCU "Environment" "Path"
  StrCpy $R3 ""
  StrCpy $R1 0
loop:
  ${UnStrTok} $R2 $R0 ";" $R1 "+1"
  StrCmp $R2 "" done
  StrCmp $R2 "${INSTALL_ROOT}" next
  StrCmp $R3 "" 0 append
    StrCpy $R3 "$R2"
    Goto next
append:
  StrCpy $R3 "$R3;$R2"
next:
  IntOp $R1 $R1 + 1
  Goto loop
done:
  WriteRegExpandStr HKCU "Environment" "Path" "$R3"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; ── 安装段 ──────────────────────────────────────────────────────────────
Section "Install"
  SetOutPath "$INSTDIR"
  File "..\build\delta-win32-x64.exe"
  ; SEA 产物统一命名为 delta.exe
  Rename "$INSTDIR\delta-win32-x64.exe" "$INSTDIR\${EXE_NAME}"

  WriteUninstaller "$INSTDIR\uninstall.exe"

  Call AddToPath

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\delta.lnk" "$INSTDIR\${EXE_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk" "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "0.1.0"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "delta-agent"
  WriteRegStr HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegStr HKCU "${UNINST_KEY}" "NoRepair" 1

  ; 安装后自检：打印版本（写安装日志，失败不阻断安装）
  nsExec::ExecToLog '"$INSTDIR\${EXE_NAME}" --version'
  Pop $0
SectionEnd

; ── 卸载段 ──────────────────────────────────────────────────────────────
Section "Uninstall"
  Delete "$INSTDIR\${EXE_NAME}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKCU "${UNINST_KEY}"
  Call un.RemoveFromPath
SectionEnd
