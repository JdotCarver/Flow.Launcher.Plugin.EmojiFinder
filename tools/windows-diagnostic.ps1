# tools/windows-diagnostic.ps1
#
# Environment probe for the paste-at-cursor feature.
#
# Run through `npm run diagnose` (which reads the file this writes), or by hand:
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\windows-diagnostic.ps1 -OutFile out.json
#
# Why the result goes to a file rather than stdout
# ------------------------------------------------
# The first version printed one JSON object on stdout and it came back corrupt: a single
# `True` (from Control.Focus(), which returns a bool) landed in front of the JSON. Any
# .NET call can leak output like that, so stdout is no longer trusted with the payload;
# the report is written to -OutFile and the console only carries a one-line status.
#
# A small window flashes while the SendKeys self-test runs. That is the test.

param(
    [Parameter(Mandatory = $true)]
    [string] $OutFile
)

$ErrorActionPreference = 'Continue'

$report = [ordered]@{}
$report.generatedAt = (Get-Date).ToString('o')
$report.computer = $env:COMPUTERNAME
$report.user = $env:USERNAME

# --- PowerShell itself --------------------------------------------------------------
$report.powerShell = [ordered]@{
    version         = $PSVersionTable.PSVersion.ToString()
    edition         = $PSVersionTable.PSEdition
    apartment       = [System.Threading.Thread]::CurrentThread.GetApartmentState().ToString()
    is64BitProcess  = [Environment]::Is64BitProcess
    executionPolicy = (Get-ExecutionPolicy).ToString()
    osVersion       = [Environment]::OSVersion.VersionString
    culture         = (Get-Culture).Name
}

# --- WinForms (clipboard + SendKeys live there) -------------------------------------
# Every .NET call below is wrapped in $null = or [void]: PowerShell writes the return
# value of an unassigned expression to the pipeline, which is how the previous version
# polluted its own output.
$winFormsStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$report.winForms = [ordered]@{ ok = $false; milliseconds = 0; error = '' }
try {
    $null = Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $report.winForms.ok = $true
} catch {
    $report.winForms.error = $_.Exception.Message
}
$winFormsStopwatch.Stop()
$report.winForms.milliseconds = $winFormsStopwatch.ElapsedMilliseconds

# --- Clipboard round-trip -----------------------------------------------------------
# The emoji that matters is the one that has to survive a trip through the clipboard
# exactly as sent: a surrogate pair (U+1F648) and a character plus variation selector
# (U+2764 U+FE0F). Samples are built with explicit string concatenation because array
# literals containing [char] expressions do not compose the way they read.
$report.clipboard = [ordered]@{ tests = @(); error = '' }

if ($report.winForms.ok) {
    $samples = @(
        'hello'
        [char]::ConvertFromUtf32(0x1F648)
        ([string][char]0x2764) + ([string][char]0xFE0F)
        ([string][char]0x1F469) + ([string][char]0x200D) + ([string][char]0x1F4BB)
    )

    foreach ($sample in $samples) {
        $test = [ordered]@{
            written      = [string]$sample
            read         = ''
            matches      = $false
            writtenCodes = ''
            readCodes    = ''
            error        = ''
        }

        try {
            $test.writtenCodes = (([string]$sample).ToCharArray() | ForEach-Object { [int]$_ }) -join ','

            [System.Windows.Forms.Clipboard]::SetText([string]$sample)
            Start-Sleep -Milliseconds 60
            $readText = [System.Windows.Forms.Clipboard]::GetText()

            $test.read = [string]$readText
            $test.readCodes = (([string]$readText).ToCharArray() | ForEach-Object { [int]$_ }) -join ','
            $test.matches = ($test.read -eq $test.written)
        } catch {
            $test.error = $_.Exception.Message
        }

        $report.clipboard.tests += $test
    }
} else {
    $report.clipboard.error = 'skipped: System.Windows.Forms did not load'
}

# --- SendKeys self-test -------------------------------------------------------------
# Proves that synthetic input works at all, without touching any of the user's windows.
$report.sendKeys = [ordered]@{ ok = $false; typed = ''; expected = 'abc'; error = '' }

if ($report.winForms.ok) {
    $form = $null
    try {
        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'Emoji Finder diagnostic'
        $form.Width = 320
        $form.Height = 140
        $form.StartPosition = 'CenterScreen'
        $form.TopMost = $true

        $typedInto = New-Object System.Windows.Forms.TextBox
        $typedInto.Dock = 'Fill'
        $null = $form.Controls.Add($typedInto)

        [void]$form.Show()
        [void]$form.Activate()
        # Control.Focus() returns a bool; assigning it is what leaked `True` before.
        $null = $typedInto.Focus()
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 200
        [System.Windows.Forms.Application]::DoEvents()

        [System.Windows.Forms.SendKeys]::SendWait('abc')
        Start-Sleep -Milliseconds 200
        [System.Windows.Forms.Application]::DoEvents()

        $report.sendKeys.typed = [string]$typedInto.Text
        $report.sendKeys.ok = ($typedInto.Text -eq $report.sendKeys.expected)
    } catch {
        $report.sendKeys.error = $_.Exception.Message
    } finally {
        if ($null -ne $form) { [void]$form.Close() }
    }
} else {
    $report.sendKeys.error = 'skipped: System.Windows.Forms did not load'
}

# --- UI Automation: the helper's cheaper focus signal -------------------------------
# The paste helper uses this to decide whether the user's window has focus again. It is
# an assembly load, not a compilation, so if it works it is nearly free.
$report.uiAutomation = [ordered]@{ ok = $false; milliseconds = 0; focusedProcessId = -1; focusedName = ''; error = '' }

$uiAutomationStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $null = Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    $report.uiAutomation.ok = $true

    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -ne $focused) {
        $report.uiAutomation.focusedProcessId = [int]$focused.Current.ProcessId
        $report.uiAutomation.focusedName = [string]$focused.Current.Name
    }
} catch {
    $report.uiAutomation.error = $_.Exception.Message
}
$uiAutomationStopwatch.Stop()
$report.uiAutomation.milliseconds = $uiAutomationStopwatch.ElapsedMilliseconds

# --- P/Invoke: foreground window and window enumeration -----------------------------
$report.win32 = [ordered]@{ ok = $false; milliseconds = 0; error = '' }

$win32Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

try {
    $null = Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class EmojiFinderWin32Probe
{
    public delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr window, StringBuilder name, int maximum);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
}
'@
    $report.win32.ok = $true
} catch {
    $report.win32.error = $_.Exception.Message
}

$win32Stopwatch.Stop()
$report.win32.milliseconds = $win32Stopwatch.ElapsedMilliseconds

# --- Flow Launcher processes --------------------------------------------------------
$report.flowProcesses = @()

foreach ($candidate in @(Get-Process -Name 'Flow.Launcher*' -ErrorAction SilentlyContinue)) {
    $report.flowProcesses += [ordered]@{
        name             = $candidate.ProcessName
        id               = $candidate.Id
        mainWindowHandle = [int64]$candidate.MainWindowHandle
        mainWindowTitle  = [string]$candidate.MainWindowTitle
        responding       = $candidate.Responding
        startTime        = try { $candidate.StartTime.ToString('o') } catch { '' }
    }
}

# Any process whose name looks like Flow, in case it was renamed or is a dev build.
$report.flowLikeProcesses = @()
foreach ($candidate in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*flow*' })) {
    $report.flowLikeProcesses += [ordered]@{
        name             = $candidate.ProcessName
        id               = $candidate.Id
        mainWindowHandle = [int64]$candidate.MainWindowHandle
        mainWindowTitle  = [string]$candidate.MainWindowTitle
    }
}

# --- Foreground window and visible top-level windows --------------------------------
$report.foregroundWindow = [ordered]@{ processId = 0; title = ''; className = '' }
$report.visibleWindows = @()

if ($report.win32.ok) {
    try {
        $foreground = [EmojiFinderWin32Probe]::GetForegroundWindow()
        $foregroundProcessId = [uint32]0
        [void][EmojiFinderWin32Probe]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)

        $titleBuilder = New-Object System.Text.StringBuilder 512
        [void][EmojiFinderWin32Probe]::GetWindowText($foreground, $titleBuilder, 512)
        $classBuilder = New-Object System.Text.StringBuilder 256
        [void][EmojiFinderWin32Probe]::GetClassName($foreground, $classBuilder, 256)

        $report.foregroundWindow = [ordered]@{
            processId = [int]$foregroundProcessId
            title     = $titleBuilder.ToString()
            className = $classBuilder.ToString()
        }

        $collected = New-Object System.Collections.ArrayList
        $callback = [EmojiFinderWin32Probe+EnumWindowsProc]{
            param([IntPtr] $window, [IntPtr] $parameter)

            try {
                if ([EmojiFinderWin32Probe]::IsWindowVisible($window)) {
                    $text = New-Object System.Text.StringBuilder 512
                    [void][EmojiFinderWin32Probe]::GetWindowText($window, $text, 512)

                    if ($text.Length -gt 0) {
                        $windowProcessId = [uint32]0
                        [void][EmojiFinderWin32Probe]::GetWindowThreadProcessId($window, [ref]$windowProcessId)

                        $windowClass = New-Object System.Text.StringBuilder 256
                        [void][EmojiFinderWin32Probe]::GetClassName($window, $windowClass, 256)

                        [void]$collected.Add([ordered]@{
                            processId = [int]$windowProcessId
                            title     = $text.ToString()
                            className = $windowClass.ToString()
                        })
                    }
                }
            } catch { }

            return $true
        }

        [void][EmojiFinderWin32Probe]::EnumWindows($callback, [IntPtr]::Zero)
        $report.visibleWindows = @($collected | Select-Object -First 40)
    } catch {
        $report.win32.error = $_.Exception.Message
    }
}

# --- Emit ---------------------------------------------------------------------------
# Written as UTF-8 without a BOM: a BOM makes JSON.parse fail in Node.
try {
    $json = $report | ConvertTo-Json -Depth 8
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($OutFile, $json, $utf8WithoutBom)
    Write-Output ('diagnostic-written: ' + $OutFile)
} catch {
    Write-Output ('diagnostic-write-failed: ' + $_.Exception.Message)
    exit 1
}
