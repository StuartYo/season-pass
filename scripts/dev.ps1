# Starts the dev server. Claude mode turns on only if AMAZON_ANTHROPIC_API_KEY exists in the Windows user environment
# (the key is read, never printed). Without it, the simulator runs in rules mode with no AI calls.
param([int]$Port = 3210)
if (-not $env:AMAZON_ANTHROPIC_API_KEY) {
  $k = [Environment]::GetEnvironmentVariable('AMAZON_ANTHROPIC_API_KEY', 'User')
  if ($k) { $env:AMAZON_ANTHROPIC_API_KEY = $k }
}
if (-not $env:DAILY_COST_CAP_USD) { $env:DAILY_COST_CAP_USD = '1' }
Set-Location (Split-Path $PSScriptRoot -Parent)
npx next dev -p $Port
