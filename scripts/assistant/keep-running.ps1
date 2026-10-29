# Runs one program and starts it again whenever it exits, so a crash costs
# seconds, not the rest of the day. The scheduled tasks install.ps1 makes
# start this at login, hidden. Stopping the task stops this loop, and the
# program with it.
#
#   keep-running.ps1 -Program C:\llama\llama-server.exe -ArgsFile ...\llama-server.args -Log ...\llama-server.log

param(
  [Parameter(Mandatory)] [string] $Program,
  [string] $ArgsFile,
  [Parameter(Mandatory)] [string] $Log
)

# One argument per line, "--flag value"; blank lines and # comments are
# skipped. Only the first space splits, so a value can be a path with spaces.
function Read-Arguments([string] $Path) {
  $arguments = @()
  if (-not $Path) { return $arguments }
  foreach ($line in Get-Content -LiteralPath $Path) {
    $line = $line.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $parts = $line -split '\s+', 2
    $arguments += $parts
  }
  return $arguments
}

# Stopping the task ends this PowerShell, and on its own Windows would leave
# the program it started running, holding its port and data directory. A job
# object with "kill on close" ties the two together: processes join their
# parent's job, and when this process ends, for any reason, Windows ends every
# process in the job with it.
function Join-KillOnCloseJob {
  Add-Type -Namespace Demesne -Name Job -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
[StructLayout(LayoutKind.Sequential)] public struct BasicLimits { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
[StructLayout(LayoutKind.Sequential)] public struct IoCounters { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
[StructLayout(LayoutKind.Sequential)] public struct ExtendedLimits { public BasicLimits BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
'@
  $job = [Demesne.Job]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }
  $limits = New-Object 'Demesne.Job+ExtendedLimits'
  # A struct read from a field is a copy: set the flag on it and put it back.
  $basic = $limits.BasicLimitInformation
  $basic.LimitFlags = 0x2000   # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  $limits.BasicLimitInformation = $basic
  $size = [Runtime.InteropServices.Marshal]::SizeOf($limits)
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    [Runtime.InteropServices.Marshal]::StructureToPtr($limits, $buffer, $false)
    # 9 is JobObjectExtendedLimitInformation.
    if (-not [Demesne.Job]::SetInformationJobObject($job, 9, $buffer, $size)) { throw 'SetInformationJobObject failed' }
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
  if (-not [Demesne.Job]::AssignProcessToJobObject($job, (Get-Process -Id $PID).Handle)) { throw 'AssignProcessToJobObject failed' }
  # The job lasts as long as this handle, which this process holds until it ends.
  return $job
}

# A copy from before this script tied programs to their task, or left by a
# loop that was killed some other way, can still hold the port or the data
# directory. Stop one left without its loop: same program, same arguments,
# no live parent.
function Stop-LeftOver([string] $Path, [string[]] $Arguments) {
  $full = (Resolve-Path -LiteralPath $Path).Path
  foreach ($process in Get-CimInstance Win32_Process) {
    if (-not $process.ExecutablePath -or $process.ExecutablePath -ne $full) { continue }
    $line = [string] $process.CommandLine
    if (@($Arguments | Where-Object { -not $line.Contains($_) }).Count) { continue }
    if (Get-Process -Id $process.ParentProcessId -ErrorAction SilentlyContinue) { continue }
    Add-Content -LiteralPath $Log -Value "--- $(Get-Date -Format s) stopping PID $($process.ProcessId) left from an earlier run"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

$arguments = Read-Arguments $ArgsFile
try { $script:job = Join-KillOnCloseJob }
catch { Add-Content -LiteralPath $Log -Value "--- $(Get-Date -Format s) could not tie $Program to this task ($_); stopping the task may leave it running" }
Stop-LeftOver $Program $arguments
while ($true) {
  # Keep the log from growing without end: start over past 20 MB.
  if ((Test-Path -LiteralPath $Log) -and (Get-Item -LiteralPath $Log).Length -gt 20MB) {
    Move-Item -LiteralPath $Log -Destination "$Log.old" -Force
  }
  Add-Content -LiteralPath $Log -Value "--- $(Get-Date -Format s) starting $Program"
  & $Program @arguments *>> $Log
  Add-Content -LiteralPath $Log -Value "--- $(Get-Date -Format s) exited with code $LASTEXITCODE; restarting in 5 seconds"
  Start-Sleep -Seconds 5
}
