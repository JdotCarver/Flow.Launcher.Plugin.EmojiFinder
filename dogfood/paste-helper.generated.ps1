$ErrorActionPreference = 'SilentlyContinue'

$targetEmoji = '🙈'
$logPath = '/home/user/Flow.Launcher.Plugin.EmojiFinder/dogfood/paste-helper-check.log'
$timeoutMilliseconds = 2500
$pollMilliseconds = 20

$logDirectoryReady = $false
function Write-Trace([string] $message) {
  if ([string]::IsNullOrEmpty($logPath)) { return }
  # The plugin creates this folder too, but the helper can win the race: without this,
  # the first lines would be silently dropped.
  if (-not $logDirectoryReady) {
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) -ErrorAction SilentlyContinue
    $logDirectoryReady = $true
  }
  $line = '{0} | helper | {1}' -f (Get-Date).ToString('o'), $message
  Add-Content -LiteralPath $logPath -Value $line -ErrorAction SilentlyContinue
}

# Variation selectors and zero-width joiners are invisible and are dropped by some
# clipboard producers, so they are ignored when comparing.
function Get-ComparableText([string] $text) {
  if ([string]::IsNullOrEmpty($text)) { return '' }
  return ($text -replace '[\uFE0E\uFE0F\u200D]', '')
}

Write-Trace ('start pid={0} ps={1} apartment={2} policy={3} user={4}' -f $PID, $PSVersionTable.PSVersion.ToString(), [Threading.Thread]::CurrentThread.GetApartmentState().ToString(), (Get-ExecutionPolicy).ToString(), $env:USERNAME)

try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  Write-Trace 'winforms loaded'
} catch {
  Write-Trace ('winforms-error: ' + $_.Exception.Message)
}

# Focus detection: an assembly load, not a compilation, so it is cheap. Kept optional.
$focusProbeAvailable = $false
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  $focusProbeAvailable = $true
  Write-Trace 'uiautomation loaded'
} catch {
  Write-Trace ('uiautomation-error: ' + $_.Exception.Message)
}

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$shouldPaste = $false
$lastState = ''
$loggedMismatch = $false

while ($stopwatch.ElapsedMilliseconds -lt $timeoutMilliseconds) {
  $flowProcessIds = @()
  $flowVisible = $false
  foreach ($flowProcess in @(Get-Process -Name 'Flow.Launcher*' -ErrorAction SilentlyContinue)) {
    $flowProcessIds += $flowProcess.Id
    if ($flowProcess.MainWindowHandle -ne 0) { $flowVisible = $true }
  }

  $focusedProcessId = -1
  if ($focusProbeAvailable) {
    try {
      $focusedElement = [System.Windows.Automation.AutomationElement]::FocusedElement
      if ($null -ne $focusedElement) { $focusedProcessId = $focusedElement.Current.ProcessId }
    } catch { }
  }
  $flowHasFocus = ($focusedProcessId -ne -1) -and ($flowProcessIds -contains $focusedProcessId)

  $clipboardText = ''
  $clipboardError = ''
  try {
    if ([System.Windows.Forms.Clipboard]::ContainsText()) {
      $clipboardText = [System.Windows.Forms.Clipboard]::GetText()
    }
  } catch {
    $clipboardError = $_.Exception.Message
  }

  $clipboardMatches = $false
  if ($clipboardText -ne '') {
    $clipboardMatches = ((Get-ComparableText $clipboardText) -eq (Get-ComparableText $targetEmoji))
  }

  $state = 'flowProcesses={0} flowVisible={1} flowHasFocus={2} focusedProcess={3} clipboardMatches={4} clipboardEmpty={5} clipboardError=[{6}]' -f $flowProcessIds.Count, $flowVisible, $flowHasFocus, $focusedProcessId, $clipboardMatches, ($clipboardText -eq ''), $clipboardError
  if ($state -ne $lastState) {
    Write-Trace ('poll ' + $state)
    $lastState = $state
  }

  if ((-not $clipboardMatches) -and (-not $loggedMismatch) -and ($clipboardText -ne '')) {
    $clipboardCodes = ($clipboardText.ToCharArray() | ForEach-Object { [int]$_ }) -join ','
    $targetCodes = ($targetEmoji.ToCharArray() | ForEach-Object { [int]$_ }) -join ','
    Write-Trace ('mismatch clipboardCodes=[{0}] targetCodes=[{1}]' -f $clipboardCodes, $targetCodes)
    $loggedMismatch = $true
  }

  # Either signal is enough: "no visible window" or "focus went elsewhere".
  if ((-not $flowVisible -or -not $flowHasFocus) -and $clipboardMatches) {
    $shouldPaste = $true
    break
  }

  Start-Sleep -Milliseconds $pollMilliseconds
}

Write-Trace ('decision paste={0} elapsedMs={1}' -f $shouldPaste, $stopwatch.ElapsedMilliseconds)

if ($shouldPaste) {
  Start-Sleep -Milliseconds 20
  try {
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Write-Trace 'sendkeys sent'
  } catch {
    Write-Trace ('sendkeys-error: ' + $_.Exception.Message)
  }
}

Write-Trace 'exit'