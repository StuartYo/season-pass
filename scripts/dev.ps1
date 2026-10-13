# Starts the dev server with ANTHROPIC_API_KEY taken from the Windows user environment (never printed).
param([int]$Port = 3210)
if (-not $env:ANTHROPIC_API_KEY) { $env:ANTHROPIC_API_KEY = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'User') }
if (-not $env:DAILY_COST_CAP_USD) { $env:DAILY_COST_CAP_USD = '1' }
Set-Location (Split-Path $PSScriptRoot -Parent)
npx next dev -p $Port
