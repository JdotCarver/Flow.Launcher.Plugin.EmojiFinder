# tools/windows-diagnostic.ps1
#
# Environment probe for the paste-at-cursor feature.
#
# Run through `npm run diagnose` (which wraps the result in dogfood/diagnose.json), or
# directly:
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\windows-diagnostic.ps1
#
# It prints ONE JSON object on stdout and nothing else, answers the questions a Linux
# sandbox cannot answer, and never fails the caller: any probe that throws reports its
# error inside the JSON.
#
# What it establishes, and why each matters:
#   * whether `Add-Type -AssemblyName System.Windows.Forms` works at all (the paste
#     helper cannot read the clipboard without it);
#   * what the clipboard gives back after writing an emoji (variation selectors are
#     silently dropped by some producers, which would make the helper wait forever);
#   * whether SendKeys actually delivers a keystroke (self-test against a throwaway form);
#   * how Flow Launcher's processes and windows look from the outside (the helper waits
#     for `MainWindowHandle -eq 0`, so we need to know if that ever happens, and what the
#     process is really called);
#   * how long compiling P/Invoke with Add-Type takes, which decides whether the cheap
#     window detection is worth keeping.
#
# A small window flashes while the SendKeys self-test runs. That is the test.

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
}

# --- WinForms (clipboard + SendKeys live there) -------------------------------------
$winFormsStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$report.winForms = [ordered]@{ ok = $false; milliseconds = 0; error = '' }
try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  $report.winForms.ok = $true
} catch {
  $report.winForms.error = $_.Exception.Message
}
$winFormsStopwatch.Stop()
$report.winForms.milliseconds = $winFormsStopwatch.ElapsedMilliseconds

# --- Clipboard round-trip -----------------------------------------------------------
# The emoji that failed on the maintainer's machine is included on purpose.
$report.clipboard = [ordered]@{ tests = @(); error = '' }

if ($report.winForms.ok) {
  $samples = @('hello', [char]::ConvertFromUtf32(0x1F648), [char]::ConvertFromUtf32(0x2764) + [char]0xFE0F)

  foreach ($sample in $samples) {
    $test = [ordered]@{
      written      = ''
      read         = ''
      matches      = $false
      writtenCodes = ''
      readCodes    = ''
      error        = ''
    }

    try {
      [System.Windows.Forms.Clipboard]::SetText($sample)
      Start-Sleep -Milliseconds 50
      $read = [System.Windows.Forms.Clipboard]::GetText()

      $test.written = $sample
      $test.read = $read
      $test.matches = ($read -eq $sample)
      $test.writtenCodes = (($sample.ToCharArray() | ForEach-Object { [int]$_ }) -join ',')
      $test.readCodes = (($read.ToCharArray() | ForEach-Object { [int]$_ }) -join ',')
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
  try {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Emoji Finder diagnostic'
    $form.Width = 320
    $form.Height = 140
    $form.StartPosition = 'CenterScreen'
    $form.TopMost = $true

    $input = New-Object System.Windows.Forms.TextBox
    $input.Dock = 'Fill'
    $form.Controls.Add($input)

    $form.Show()
    $form.Activate()
    $input.Focus()
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.Application]::DoEvents()

    [System.Windows.Forms.SendKeys]::SendWait('abc')
    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.Application]::DoEvents()

    $report.sendKeys.typed = $input.Text
    $report.sendKeys.ok = ($input.Text -eq $report.sendKeys.expected)

    $form.Close()
  } catch {
    $report.sendKeys.error = $_.Exception.Message
    if ($null -ne $form) { try { $form.Close() } catch { } }
  }
} else {
  $report.sendKeys.error = 'skipped: System.Windows.Forms did not load'
}

# --- UI Automation: the helper's cheaper focus signal --------------------------------
# The paste helper uses this to decide whether the user's window has focus again. It is
# an assembly load, not a compilation, so if it works it is nearly free.
$report.uiAutomation = [ordered]@{ ok = $false; milliseconds = 0; focusedProcessId = -1; focusedName = ''; error = '' }

$uiAutomationStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  $report.uiAutomation.ok = $true

  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -ne $focused) {
    $report.uiAutomation.focusedProcessId = $focused.Current.ProcessId
    $report.uiAutomation.focusedName = $focused.Current.Name
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
  Add-Type -ErrorAction Stop -TypeDefinition @'
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

foreach ($name in @('Flow.Launcher', 'Flow Launcher')) {
  foreach ($candidate in @(Get-Process -Name ($name + '*') -ErrorAction SilentlyContinue)) {
    $report.flowProcesses += [ordered]@{
      name             = $candidate.ProcessName
      id               = $candidate.Id
      mainWindowHandle = [int64]$candidate.MainWindowHandle
      mainWindowTitle  = $candidate.MainWindowTitle
      responding       = $candidate.Responding
      startTime        = try { $candidate.StartTime.ToString('o') } catch { '' }
    }
  }
}

# Any process whose name looks like Flow, in case it was renamed or is a dev build.
$report.flowLikeProcesses = @()
foreach ($candidate in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*flow*' })) {
  $report.flowLikeProcesses += [ordered]@{
    name             = $candidate.ProcessName
    id               = $candidate.Id
    mainWindowHandle = [int64]$candidate.MainWindowHandle
    mainWindowTitle  = $candidate.MainWindowTitle
  }
}

# --- Foreground window and visible top-level windows --------------------------------
$report.foregroundWindow = [ordered]@{ id = 0; title = ''; className = '' }
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
      processId = $foregroundProcessId
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
              processId = $windowProcessId
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
$report | ConvertTo-Json -Depth 8
