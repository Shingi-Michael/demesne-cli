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

$arguments = Read-Arguments $ArgsFile
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
