# One real Windows file dialog (#32770), driven from outside the app for the end-to-end tests.
#
#   -Mode fill    -Title '<dialog title>' -Text '<path>' [-TimeoutMs n] [-Dump <file>]
#   -Mode dismiss -Title '<title>|<title>'                [-Dump <file>]
#
# The dialog is driven by window handle, not by UI Automation and not by keystrokes. UI Automation is
# no use here: on this Windows the shell dialog's Win32 controls come back through the bare HWND
# provider as ControlType.Pane with no patterns at all, so there is no File name box to find by its
# automation id and nothing to invoke - which is what left the earlier attempt with only SendKeys, and
# so at the mercy of which window happened to have the keyboard focus. The window handles are always
# there: the dialog is found by class and title, its File name edit and its Open/Save button by
# control id, the path goes in with WM_SETTEXT and the button is pressed with a posted BM_CLICK.
#
# Nothing here can block: every send is SendMessageTimeout with SMTO_ABORTIFHUNG and a millisecond
# budget, every click is posted rather than sent, and every wait has a deadline. Only a dialog whose
# title the test named is ever touched, so a window of the person's own is left alone. Every failure
# exits with a code the test turns into one FAIL and writes the state of the desktop to -Dump.
#
# Exit codes: 0 done, 2 bad arguments, 3 no dialog with that title, 4 no File name box,
# 5 the box wouldn't take the path, 6 no Open/Save button, 7 the dialog was still there afterwards.

param(
  [Parameter(Mandatory = $true)][ValidateSet('fill', 'dismiss')][string]$Mode,
  [string]$Title = '',
  [string]$Text = '',
  [int]$TimeoutMs = 15000,
  [string]$Dump = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace VellumTest -Name Win -MemberDefinition @'
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  // PowerShell coerces a bare $null into "" when it binds a `string` parameter on a plain static-method
  // call (the $null-means-null trick only works for cmdlet parameter binding), so a wildcard class or
  // title needs a signature that takes a real IntPtr instead - IntPtr.Zero there is the genuine Win32
  // NULL these searches mean by "any".
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "FindWindowEx")]
  public static extern IntPtr FindWindowExTitleAny(IntPtr parent, IntPtr after, string cls, IntPtr title);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "FindWindowEx")]
  public static extern IntPtr FindWindowExAny(IntPtr parent, IntPtr after, IntPtr cls, IntPtr title);
  [DllImport("user32.dll")]
  public static extern IntPtr GetDlgItem(IntPtr dialog, int id);
  [DllImport("user32.dll")]
  public static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr window, System.Text.StringBuilder text, int max);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint msg, IntPtr wParam, string lParam, uint flags, uint ms, out IntPtr result);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint msg, IntPtr wParam, System.Text.StringBuilder lParam, uint flags, uint ms, out IntPtr result);
  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr window, uint msg, IntPtr wParam, IntPtr lParam);
'@

$W = [VellumTest.Win]
$WM_SETTEXT = 0x000C
$WM_GETTEXT = 0x000D
$WM_CLOSE = 0x0010
$BM_CLICK = 0x00F5
$ABORT_IF_HUNG = 0x0002
$SEND_MS = 4000
$NONE = [IntPtr]::Zero

function Note([string]$line) {
  if ($Dump) { Add-Content -LiteralPath $Dump -Value $line -Encoding utf8 }
}

function ClassOf([IntPtr]$window) {
  $text = New-Object System.Text.StringBuilder 256
  [void]$W::GetClassName($window, $text, 256)
  return $text.ToString()
}

function TextOf([IntPtr]$window) {
  $buffer = New-Object System.Text.StringBuilder 1024
  $answer = $NONE
  if ($W::SendMessageTimeout($window, $WM_GETTEXT, [IntPtr]1024, $buffer, $ABORT_IF_HUNG, $SEND_MS, [ref]$answer) -eq $NONE) { return $null }
  return $buffer.ToString()
}

# Every visible top-level window with exactly this title, in the order Windows keeps them. Nothing
# here ever looks at a window the test didn't name.
function EachDialog([string]$name) {
  $found = New-Object System.Collections.ArrayList
  $window = $W::FindWindowEx($NONE, $NONE, '#32770', $name)
  while ($window -ne $NONE) {
    if ($W::IsWindowVisible($window)) { [void]$found.Add($window) }
    $window = $W::FindWindowEx($NONE, $window, '#32770', $name)
  }
  return $found.ToArray()
}


# A window matching `match` anywhere under `root`, not only among its immediate children - the Save
# dialog nests its ComboBoxEx32 a level deeper than the Open dialog does on this Windows, so a search
# that only looked at direct children (GetDlgItem, or FindWindowEx against the dialog itself) found
# nothing there even though the box was on screen.
function FindDescendant([IntPtr]$root, [scriptblock]$match, [int]$depth) {
  if ($depth -le 0) { return $NONE }
  $child = $W::FindWindowExAny($root, $NONE, $NONE, $NONE)
  while ($child -ne $NONE) {
    if (& $match $child) { return $child }
    $found = FindDescendant $child $match ($depth - 1)
    if ($found -ne $NONE) { return $found }
    $child = $W::FindWindowExAny($root, $child, $NONE, $NONE)
  }
  return $NONE
}

# The File name edit: the shell hosts it in a ComboBoxEx32 (control 1148, direct child on most
# dialogs); older ones use a plain edit (control 1152). Both are tried as direct children first, since
# that is cheap and enough for most dialogs, then as a descendant search bounded to a shallow depth -
# never a blind search for any Edit control, which would just as happily find the dialog's search box.
function FileNameBox([IntPtr]$dialog) {
  $box = $W::GetDlgItem($dialog, 1148)
  if ($box -eq $NONE) { $box = $W::FindWindowExTitleAny($dialog, $NONE, 'ComboBoxEx32', $NONE) }
  # PowerShell variable names are case-insensitive, so these scriptblocks' own parameter must not be
  # named $w - it would shadow the script-level $W (the [VellumTest.Win] type) up the dynamic scope
  # chain, and every $W::Method(...) inside a helper they call would resolve $W to a window handle
  # instead of the type and fail with "does not contain a method named ...".
  if ($box -eq $NONE) { $box = FindDescendant $dialog { param($node) (ClassOf $node) -eq 'ComboBoxEx32' } 6 }
  if ($box -ne $NONE) {
    if ((ClassOf $box) -eq 'Edit') { return $box }
    $edit = FindDescendant $box { param($node) (ClassOf $node) -eq 'Edit' } 4
    if ($edit -ne $NONE) { return $edit }
  }
  $plain = $W::GetDlgItem($dialog, 1152)
  if ($plain -ne $NONE -and (ClassOf $plain) -eq 'Edit') { return $plain }
  return FindDescendant $dialog { param($node) (ClassOf $node) -eq 'Edit' -and ($W::GetDlgCtrlID($node) -eq 1152) } 6
}

# The window that really is the dialog - the one with a File name box in it - and that box. A file
# dialog leaves a second window of the same class and title standing beside the real one, with nothing
# in it; taking the first match is how this waits out its whole timeout on the wrong window.
function FindDialog([string]$name) {
  foreach ($window in @(EachDialog $name)) {
    $box = FileNameBox $window
    if ($box -ne $NONE) { return , @($window, $box) }
  }
  return $null
}

function DumpDesktop([string]$why) {
  Note "--- $why"
  $window = $W::FindWindowExTitleAny($NONE, $NONE, '#32770', $NONE)
  while ($window -ne $NONE) {
    if ($W::IsWindowVisible($window)) {
      $owner = 0
      [void]$W::GetWindowThreadProcessId($window, [ref]$owner)
      Note ("dialog | title='" + (TextOf $window) + "' | pid=" + $owner)
    }
    $window = $W::FindWindowExTitleAny($NONE, $window, '#32770', $NONE)
  }
}

function DumpChildren([IntPtr]$dialog, [string]$why) {
  Note "--- $why"
  $child = $W::FindWindowExAny($dialog, $NONE, $NONE, $NONE)
  while ($child -ne $NONE) {
    Note ("  id=" + $W::GetDlgCtrlID($child) + " | class=" + (ClassOf $child) + " | text='" + (TextOf $child) + "'")
    $child = $W::FindWindowExAny($dialog, $child, $NONE, $NONE)
  }
}

if ($Mode -eq 'dismiss') {
  # Cleanup after a failure: close the dialogs this test opened, by name, and nothing else.
  $closed = 0
  foreach ($name in ($Title -split '\|')) {
    if (-not $name) { continue }
    foreach ($window in @(EachDialog $name)) {
      [void]$W::PostMessage($window, $WM_CLOSE, $NONE, $NONE)
      $closed++
    }
  }
  Write-Output "closed $closed dialog(s)"
  exit 0
}

if (-not $Title -or -not $Text) { Write-Output 'fill needs -Title and -Text'; exit 2 }

# The window is there before the rest of it is, and the shell may put up a window of its own before the
# real one, so the dialog is looked up again on every try until its File name box is there too -
# holding on to the first handle is how this waits out the whole timeout on a window already gone.
$end = (Get-Date).AddMilliseconds($TimeoutMs)
do {
  $found = FindDialog $Title
  if (-not $found) { Start-Sleep -Milliseconds 120 }
} while (-not $found -and (Get-Date) -lt $end)

if (-not $found) {
  $windows = @(EachDialog $Title)
  if ($windows.Count -eq 0) {
    DumpDesktop "no '$Title' dialog within $TimeoutMs ms"
    Write-Output "no '$Title' dialog within $TimeoutMs ms"
    exit 3
  }
  foreach ($window in $windows) { DumpChildren $window "no File name box in '$Title'" }
  Write-Output "no File name box in '$Title'"
  exit 4
}
$dialog = $found[0]
$box = $found[1]

$answer = $NONE
if ($W::SendMessageTimeout($box, $WM_SETTEXT, $NONE, $Text, $ABORT_IF_HUNG, $SEND_MS, [ref]$answer) -eq $NONE) {
  DumpChildren $dialog "the File name box in '$Title' did not answer"
  Write-Output "the File name box in '$Title' did not answer"
  exit 5
}
$got = TextOf $box
if ($got -ne $Text) {
  DumpChildren $dialog "'$Title' kept '$got' instead of the path"
  Write-Output "'$Title' kept '$got' instead of the path"
  exit 5
}

$accept = $W::GetDlgItem($dialog, 1)
if ($accept -eq $NONE) {
  DumpChildren $dialog "no Open/Save button in '$Title'"
  Write-Output "no Open/Save button in '$Title'"
  exit 6
}
[void]$W::PostMessage($accept, $BM_CLICK, $NONE, $NONE)

# It took only if the dialog is gone; anything still up (an overwrite prompt, a name it refused) is a
# failure here rather than something the test is left waiting on.
$closing = (Get-Date).AddMilliseconds([Math]::Min($TimeoutMs, 10000))
do {
  $gone = -not (FindDialog $Title)
  if (-not $gone) { Start-Sleep -Milliseconds 120 }
} while (-not $gone -and (Get-Date) -lt $closing)

if (-not $gone) {
  DumpDesktop "'$Title' was still open after Open/Save"
  Write-Output "'$Title' was still open after Open/Save"
  exit 7
}
Write-Output "filled '$Title'"
exit 0
