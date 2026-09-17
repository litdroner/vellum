// In-app updates ([Code], included by Vellum.iss and by the end-to-end test installer).
// Vellum runs Setup with /VERYSILENT /SUPPRESSMSGBOXES /relaunch=1 (Services/Updater.cs), so there is no
// Setup window: Vellum's own dialog shows the progress, then Vellum closes and Setup starts it again.
// Installed: the [Run] entry checked by RelaunchAfterUpdate starts the new version. Failed or cancelled:
// Setup rolls back, and RelaunchIfUpdateFailed starts the version that was already installed, which
// tells the user the update didn't install (it compares its version with the one in relaunch.json).

#ifndef UpdateRelaunchExe
  #define UpdateRelaunchExe "{app}\Vellum.exe"
#endif

var
  UpdateInstalled: Boolean;

function RelaunchAfterUpdate(): Boolean;
begin
  Result := ExpandConstant('{param:relaunch|0}') = '1';
end;

// Vellum starts Setup, then closes: give it time to finish closing (it holds this mutex while running;
// see SingleInstance.cs), so no file is still in use when they're replaced.
procedure WaitForVellumToClose();
var
  Waited: Integer;
begin
  if not RelaunchAfterUpdate() then Exit;
  Waited := 0;
  while CheckForMutexes('Local\Vellum.Running') and (Waited < 30000) do
  begin
    Sleep(200);
    Waited := Waited + 200;
  end;
end;

procedure NoteUpdateStep(CurStep: TSetupStep);
begin
  if CurStep = ssDone then UpdateInstalled := True;
end;

procedure RelaunchIfUpdateFailed();
var
  Exe: String;
  Code: Integer;
begin
  if UpdateInstalled or not RelaunchAfterUpdate() then Exit;
  try
    Exe := ExpandConstant('{#UpdateRelaunchExe}');
  except
    Exit;
  end;
  if FileExists(Exe) then
    Exec(Exe, '', '', SW_SHOWNORMAL, ewNoWait, Code);
end;
