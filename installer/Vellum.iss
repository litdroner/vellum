; Vellum installer (Inno Setup 6). Built by tools/publish.ps1 from the self-contained output in dist\Vellum.
; Installs per user (no admin prompt), optionally registers Vellum as a PDF handler, and keeps the
; user's data (%LOCALAPPDATA%\Vellum: settings, recent files, saved annotations) on uninstall.

#define AppName "Vellum"
#ifndef AppVersion
  #define AppVersion "0.4.0"
#endif

[Setup]
AppId={{8C1B7E0A-6F7C-4A57-9E3D-3F1D5B8A2C11}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Pankaj Manhas, Homelabs
AppCopyright=© 2026 Pankaj Manhas, Homelabs. Made in India.
VersionInfoCompany=Homelabs
VersionInfoDescription=Vellum setup
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Vellum-Setup
SetupIconFile=..\src\Vellum\Assets\Vellum.ico
UninstallDisplayIcon={app}\Vellum.exe
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ChangesAssociations=yes
CloseApplications=yes
; An in-app update restarts Vellum itself (see [Run]), so Windows mustn't restart it a second time.
RestartApplications=no

[Tasks]
Name: "associate"; Description: "Register Vellum as a PDF app (you confirm the default in Windows Settings)"
Name: "desktopicon"; Description: "Create a &desktop shortcut"; Flags: unchecked

[Files]
Source: "..\dist\Vellum\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{userprograms}\{#AppName}"; Filename: "{app}\Vellum.exe"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\Vellum.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Vellum.exe"; Parameters: "--register-association"; Flags: runhidden waituntilterminated; Tasks: associate
Filename: "{app}\Vellum.exe"; Description: "Open Vellum"; Flags: nowait postinstall skipifsilent
; In-app updates run Setup with no window and /relaunch=1: start the new version when done (InAppUpdate.iss).
Filename: "{app}\Vellum.exe"; Flags: nowait; Check: RelaunchAfterUpdate

[UninstallRun]
Filename: "{app}\Vellum.exe"; Parameters: "--unregister-association"; Flags: runhidden waituntilterminated; RunOnceId: "UnregisterPdf"

[Code]
const
  WebView2Key = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasVersion(Root: Integer; Key: String): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(Root, Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
end;

function WebView2Installed(): Boolean;
begin
  Result := HasVersion(HKLM, 'SOFTWARE\WOW6432Node\' + WebView2Key)
    or HasVersion(HKLM, 'SOFTWARE\' + WebView2Key)
    or HasVersion(HKCU, 'Software\' + WebView2Key);
end;

#include "InAppUpdate.iss"

function InitializeSetup(): Boolean;
begin
  Result := True;
  WaitForVellumToClose();
  if not WebView2Installed() then
    SuppressibleMsgBox('Vellum needs the Microsoft Edge WebView2 Runtime, which isn''t installed on this PC.' + #13#10#13#10 +
      'Setup will continue. Before starting Vellum, install the runtime from:' + #13#10 +
      'https://go.microsoft.com/fwlink/p/?LinkId=2124703', mbInformation, MB_OK, IDOK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  NoteUpdateStep(CurStep);
end;

procedure DeinitializeSetup();
begin
  RelaunchIfUpdateFailed();
end;
