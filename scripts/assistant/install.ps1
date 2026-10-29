# Installs the assistant's two always-on programs for your Windows user: the
# model (llama-server) and Demesne's daemon. Each becomes a scheduled task
# that starts hidden when you log in and restarts its program if it exits.
# Run it from the repository in PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File scripts\assistant\install.ps1 -Model C:\models\Qwen3.8-27B-Q5_K_M.gguf
#
#   -Model PATH        the GGUF file to serve (required, unless -NoModel or your -LlamaArgs names it)
#   -LlamaServer PATH  llama-server.exe from a HIP or Vulkan build of llama.cpp (default: the one on PATH)
#   -LlamaArgs PATH    your own arguments file instead of llama-server.args, in the same
#                      one-flag-per-line form, for example to pick a GPU (--device Vulkan1)
#   -NoModel           don't install the llama-server task: you start the model yourself,
#                      and only the daemon becomes a task
#   -Demesned PATH     a built daemon (default: dist\demesned.exe, else bun from source)
#   -Config            also write assistant.toml to %USERPROFILE%\.demesne\config.toml (backs up the old one);
#                      without it, only [daemon] auto_start is set to "never" in your config
#   -AssistantHome PATH  the assistant's own folder (default: %USERPROFILE%\Assistant); its DEMESNE.md is
#                      created from home\DEMESNE.md if missing, and never overwritten
#   -DryRun            print what would be installed, and change nothing

param(
  [string] $Model,
  [string] $LlamaServer,
  [string] $LlamaArgs,
  [switch] $NoModel,
  [string] $Demesned,
  [switch] $Config,
  [string] $AssistantHome = (Join-Path $HOME 'Assistant'),
  [switch] $DryRun
)
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $here '..\..')).Path
$state = Join-Path $HOME '.demesne\assistant'

# Where Demesne's config expects the model (assistant.toml's [provider] url).
$modelUrl = 'http://127.0.0.1:8081/v1/models'

if (-not $NoModel) {
  # PowerShell names ignore case: $llamaArgs would be the -LlamaArgs path itself.
  $argsTemplate = if ($LlamaArgs) { $LlamaArgs } else { Join-Path $here 'llama-server.args' }
  if (-not (Test-Path -LiteralPath $argsTemplate -PathType Leaf)) { throw "No arguments file at $argsTemplate." }
  $serverArgs = Get-Content -LiteralPath $argsTemplate
  if ($serverArgs -match '@MODEL@') {
    if (-not $Model) { throw "Pass -Model C:\path\to\model.gguf (or -NoModel if you start llama-server yourself)." }
    if (-not (Test-Path -LiteralPath $Model -PathType Leaf)) { throw "No model file at $Model." }
    $serverArgs = $serverArgs -replace '@MODEL@', (Resolve-Path -LiteralPath $Model).Path
  }
  if (-not $LlamaServer) { $LlamaServer = (Get-Command llama-server -ErrorAction SilentlyContinue).Source }
  if (-not $LlamaServer -or -not (Test-Path -LiteralPath $LlamaServer)) {
    throw "llama-server isn't on PATH. Download a HIP or Vulkan build of llama.cpp and pass -LlamaServer C:\path\to\llama-server.exe."
  }
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

$configPath = Join-Path $HOME '.demesne\config.toml'

# The task owns the daemon, so the window must never start one of its own: it
# would take the data directory while the task restarts, and the task's daemon
# would then fail on the lock until the window's one stopped. Returns the
# config with [daemon] auto_start = "never", or $null when it already says so.
function Set-AutoStartNever($Text) {
  $lines = [System.Collections.Generic.List[string]]::new()
  if ($Text) { $lines.AddRange([string[]] ($Text -split "`r?`n")) }
  if ($lines.Count -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
  $start = -1
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*\[daemon\]\s*(#.*)?$') { $start = $i; break } }
  if ($start -lt 0) {
    if ($lines.Count) { $lines.Add('') }
    $lines.Add('[daemon]')
    $lines.Add('auto_start = "never"')
  } else {
    $end = $lines.Count
    for ($i = $start + 1; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*\[') { $end = $i; break } }
    $found = $false
    for ($i = $start + 1; $i -lt $end; $i++) {
      if ($lines[$i] -match '^\s*auto_start\s*=') {
        if ($lines[$i] -match '^\s*auto_start\s*=\s*"never"') { return $null }
        $lines[$i] = 'auto_start = "never"'
        $found = $true
      }
    }
    if (-not $found) { $lines.Insert($start + 1, 'auto_start = "never"') }
  }
  return ($lines -join "`n") + "`n"
}
$configText = if (Test-Path -LiteralPath $configPath) { [IO.File]::ReadAllText($configPath) } else { '' }
$autoStartConfig = if (-not $Config) { Set-AutoStartNever $configText }

$tasks = @()
if (-not $NoModel) { $tasks += @{ Name = 'llama-server'; Program = $LlamaServer; Args = $serverArgs } }
$tasks += @{ Name = 'demesned'; Program = $daemonProgram; Args = $daemonArgs }
# A task from an earlier install keeps starting the model at login.
$oldModelTask = if ($NoModel) { Get-ScheduledTask -TaskPath '\Demesne\' -TaskName 'llama-server' -ErrorAction SilentlyContinue }

if ($DryRun) {
  foreach ($task in $tasks) {
    "# Task \Demesne\$($task.Name), at logon: $($task.Program)"
    $task.Args | Where-Object { $_ -and -not $_.StartsWith('#') }
    ''
  }
  if ($NoModel) { "# No llama-server task: Demesne expects your model at $modelUrl" }
  if ($oldModelTask) { "# A \Demesne\llama-server task from an earlier install is still there; this leaves it alone" }
  if ($Config) { "# Would copy assistant.toml to $configPath" }
  if ($autoStartConfig) { "# Would set [daemon] auto_start = `"never`" in $configPath, so the window doesn't start a second daemon" }
  "# The assistant's folder: $AssistantHome"
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
  if (Test-Path -LiteralPath $configPath) {
    Copy-Item -LiteralPath $configPath -Destination "$configPath.bak.$(Get-Date -Format yyyyMMddHHmmss)"
    'Backed up your old config next to it.'
  }
  Copy-Item -LiteralPath (Join-Path $here 'assistant.toml') -Destination $configPath -Force
} elseif ($autoStartConfig) {
  New-Item -ItemType Directory -Force -Path (Split-Path $configPath) | Out-Null
  if (Test-Path -LiteralPath $configPath) {
    Copy-Item -LiteralPath $configPath -Destination "$configPath.bak.$(Get-Date -Format yyyyMMddHHmmss)"
  }
  [IO.File]::WriteAllText($configPath, $autoStartConfig, [Text.UTF8Encoding]::new($false))
  'Set [daemon] auto_start = "never" in your config (the old one is backed up next to it), so the window uses the task''s daemon.'
}

# The assistant's own folder, with its instructions. Yours to edit, so an
# existing DEMESNE.md is left alone.
New-Item -ItemType Directory -Force -Path $AssistantHome | Out-Null
$instructions = Join-Path $AssistantHome 'DEMESNE.md'
if (-not (Test-Path -LiteralPath $instructions)) { Copy-Item -LiteralPath (Join-Path $here 'home\DEMESNE.md') -Destination $instructions }

foreach ($task in $tasks) { Start-ScheduledTask -TaskPath '\Demesne\' -TaskName $task.Name }
"Started. Check them with: Get-ScheduledTask -TaskPath \Demesne\"
if ($oldModelTask) {
  "A \Demesne\llama-server task from an earlier install is still there and starts a model at login."
  "Remove it if you start your own: Unregister-ScheduledTask -TaskPath \Demesne\ -TaskName llama-server"
}

# The model takes a minute to load; say whether Demesne can reach it.
$served = $null
$tries = if ($NoModel) { 1 } else { 24 }
foreach ($attempt in 1..$tries) {
  try { $served = (Invoke-RestMethod -Uri $modelUrl -TimeoutSec 5).data.id; break } catch { if (-not $NoModel) { Start-Sleep -Seconds 5 } }
}
if ($served) { "The model answers at $modelUrl as: $($served -join ', ')" }
else { "Nothing answers at $modelUrl yet. Demesne's config looks for the model there, so start it on 127.0.0.1 port 8081 (or change [provider] url)." }
"Logs are in $state"
"The assistant's folder is $AssistantHome. Open it as a project in Demesne and fill in DEMESNE.md."
