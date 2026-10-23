# tools/paste-selftest.ps1
#
# Answers one question: can this machine paste an emoji into a window at all?
#
# It removes Flow Launcher from the equation completely. It puts an emoji on the
# clipboard, waits while you click into Notepad, then sends Ctrl+V and reports what the
# target window received.
#
# Run through `npm run paste:selftest` (which writes dogfood/selftest.log), or by hand:
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\paste-selftest.ps1
#
# How to read the result:
#   window title empty  -> nothing was focused when the key was sent
#   title is a terminal -> focus never left the console; click into Notepad during the countdown
#   pasted = true       -> SendKeys and the clipboard work; any paste failure is then about
#                          Flow's timing or window state, not about this machine
#   pasted = false      -> synthetic input reaches the window but the clipboard did not, or
#                          the target refuses input (try an elevated window to compare)

param(
    [string] $Emoji = ([char]::ConvertFromUtf32(0x1F648)),
    [int] $DelaySeconds = 5,
    [Parameter(Mandatory = $true)]
    [string] $OutFile
)

$ErrorActionPreference = 'Continue'

$result = [ordered]@{
    generatedAt   = (Get-Date).ToString('o')
    emoji         = $Emoji
    emojiCodes    = ''
    clipboardOk   = $false
    clipboardRead = ''
    delaySeconds  = $DelaySeconds
    focusedBefore = [ordered]@{ processId = 0; title = ''; className = '' }
    focusedAfter  = [ordered]@{ processId = 0; title = ''; className = '' }
    sendKeysSent  = $false
    error         = ''
}

$null = Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

# Same Win32 helpers as the diagnostic, so the report can name the window it typed into.
$null = Add-Type -ErrorAction SilentlyContinue -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class PasteSelfTestWin32
{
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr window, StringBuilder name, int maximum);
}
'@

function Get-FocusedWindow {
    $window = [PasteSelfTestWin32]::GetForegroundWindow()
    $processId = [uint32]0
    [void][PasteSelfTestWin32]::GetWindowThreadProcessId($window, [ref]$processId)

    $title = New-Object System.Text.StringBuilder 512
    [void][PasteSelfTestWin32]::GetWindowText($window, $title, 512)
    $className = New-Object System.Text.StringBuilder 256
    [void][PasteSelfTestWin32]::GetClassName($window, $className, 256)

    return [ordered]@{
        processId = [int]$processId
        title     = $title.ToString()
        className = $className.ToString()
    }
}

try {
    $result.emojiCodes = ($Emoji.ToCharArray() | ForEach-Object { [int]$_ }) -join ','

    [System.Windows.Forms.Clipboard]::SetText($Emoji)
    Start-Sleep -Milliseconds 80
    $result.clipboardRead = [string][System.Windows.Forms.Clipboard]::GetText()
    $result.clipboardOk = ($result.clipboardRead -eq $Emoji)

    $result.focusedBefore = Get-FocusedWindow

    Write-Output ''
    Write-Output "  Emoji $Emoji is on the clipboard."
    Write-Output "  Click into Notepad now. Pasting in $DelaySeconds seconds..."
    for ($remaining = $DelaySeconds; $remaining -gt 0; $remaining--) {
        Write-Output "    $remaining"
        Start-Sleep -Seconds 1
    }

    $result.focusedAfter = Get-FocusedWindow
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    $result.sendKeysSent = $true
} catch {
    $result.error = $_.Exception.Message
}

try {
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($OutFile, ($result | ConvertTo-Json -Depth 6), $utf8WithoutBom)
} catch {
    Write-Output ('selftest-write-failed: ' + $_.Exception.Message)
}

Write-Output ''
Write-Output ("  Sent Ctrl+V to: " + $result.focusedAfter.title + " [" + $result.focusedAfter.className + "]")
Write-Output ("  Clipboard round-trip: " + $(if ($result.clipboardOk) { 'ok' } else { 'MISMATCH' }))
Write-Output ''
Write-Output '  Did the emoji appear in Notepad? (y/n) is not needed:'
Write-Output '  true/false goes in the report as clipboardOk; the visual result is what matters.'
