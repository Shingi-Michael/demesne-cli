# Installs the assistant's two always-on programs for your Windows user: the
# model (llama-server) and Demesne's daemon. Each becomes a scheduled task
# that starts hidden when you log in and restarts its program if it exits.
# Run it from the repository in PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File scripts\assistant\install.ps1 -Model C:\models\Qwen3.8-27B-Q5_K_M.gguf
#
#   -Model PATH        the GGUF file to serve (required)
#   -LlamaServer PATH  llama-server.exe from a HIP (Radeon) build of llama.cpp (default: the one on PATH)
#   -Demesned PATH     a built daemon (default: dist\demesned.exe, else bun from source)
#   -Config            also write assistant.toml to %USERPROFILE%\.demesne\config.toml (backs up the old one)
#   -DryRun            print what would be installed, and change nothing

param(
  [Parameter(Mandatory)] [string] $Model,
  [string] $LlamaServer,
  [string] $Demesned,
  [switch] $Config,
  [switch] $DryRun
)
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $here '..\..')).Path
$state = Join-Path $HOME '.demesne\assistant'

if (-not (Test-Path -LiteralPath $Model -PathType Leaf)) { throw "No model file at $Model." }
$Model = (Resolve-Path -LiteralPath $Model).Path
if (-not $LlamaServer) { $LlamaServer = (Get-Command llama-server -ErrorAction SilentlyContinue).Source }
if (-not $LlamaServer -or -not (Test-Path -LiteralPath $LlamaServer)) {
  throw "llama-server isn't on PATH. Download a HIP (Radeon) build of llama.cpp and pass -LlamaServer C:\path\to\llama-server.exe."
}

# The daemon: the compiled one if you built it, otherwise bun running the source.
$daemonArgs = @()
if ($Demesned) { $daemonProgram = $Demesned }
elseif (Test-Path (Join-Path $repo 'dist\demesned.exe')) { $daemonProgram = Join-Path $repo 'dist\demesned.exe' }
else {
  $daemonProgram = (Get-Command bun -ErrorAction SilentlyContinue).Source
  if (-not $daemonProgram) { throw "No built daemon and no bun. Run 'bun run build:daemon' or pass -Demesned PATH." }
  $daemonArgs = @('run', (Join-Path $repo 'apps\daemon\src\main.ts'))
}

$llamaArgs = (Get-Content -LiteralPath (Join-Path $here 'llama-server.args')) -replace '@MODEL@', $Model
$tasks = @(
  @{ Name = 'llama-server'; Program = $LlamaServer; Args = $llamaArgs },
  @{ Name = 'demesned'; Program = $daemonProgram; Args = $daemonArgs }
)

if ($DryRun) {
  foreach ($task in $tasks) {
    "# Task \Demesne\$($task.Name), at logon: $($task.Program)"
    $task.Args | Where-Object { $_ -and -not $_.StartsWith('#') }
    ''
  }
  if ($Config) { "# Would copy assistant.toml to $(Join-Path $HOME '.demesne\config.toml')" }
  return
}

New-Item -ItemType Directory -Force -Path $state | Out-Null
$keepRunning = Join-Path $state 'keep-running.ps1'
Copy-Item -LiteralPath (Join-Path $here 'keep-running.ps1') -Destination $keepRunning -Force

foreach ($task in $tasks) {
  $argsFile = Join-Path $state "$($task.Name).args"
  Set-Content -LiteralPath $argsFile -Value (@("# Arguments for $($task.Program)") + $task.Args)
  $log = Join-Path $state "$($task.Name).log"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
    "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$keepRunning`" " +
    "-Program `"$($task.Program)`" -ArgsFile `"$argsFile`" -Log `"$log`"")
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  # No time limit (the default stops a task after three days), and keep
  # running on battery.
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskPath '\Demesne\' -TaskName $task.Name -Action $action -Trigger $trigger `
    -Settings $settings -Description 'Demesne assistant: always-on' -Force | Out-Null
}

if ($Config) {
  $configPath = Join-Path $HOME '.demesne\config.toml'
  if (Test-Path -LiteralPath $configPath) {
    Copy-Item -LiteralPath $configPath -Destination "$configPath.bak.$(Get-Date -Format yyyyMMddHHmmss)"
    'Backed up your old config next to it.'
  }
  Copy-Item -LiteralPath (Join-Path $here 'assistant.toml') -Destination $configPath -Force
}

Start-ScheduledTask -TaskPath '\Demesne\' -TaskName 'llama-server'
Start-ScheduledTask -TaskPath '\Demesne\' -TaskName 'demesned'
"Started. Check them with: Get-ScheduledTask -TaskPath \Demesne\"
"Logs are in $state"
