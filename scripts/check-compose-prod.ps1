# Fails if prod-profile compose publishes postgres/redis ports, or api is not 127.0.0.1-bound.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

$json = docker compose -f docker-compose.yml --profile prod config --format json 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "docker compose config failed:`n$json"
  exit 1
}

$config = $json | ConvertFrom-Json
$services = $config.services
$failures = @()

function Get-PublishedPorts($svc) {
  if (-not $svc.ports) { return @() }
  $out = @()
  foreach ($p in $svc.ports) {
    if ($p -is [string]) {
      $out += $p
    } elseif ($p.published) {
      $hostIp = if ($p.host_ip) { $p.host_ip } else { "0.0.0.0" }
      $out += "${hostIp}:$($p.published):$($p.target)"
    } elseif ($p.Published) {
      $hostIp = if ($p.HostIP) { $p.HostIP } elseif ($p.host_ip) { $p.host_ip } else { "0.0.0.0" }
      $out += "${hostIp}:$($p.Published):$($p.Target)"
    }
  }
  return $out
}

foreach ($name in @("postgres", "redis")) {
  $svc = $services.$name
  if (-not $svc) { continue }
  $ports = @(Get-PublishedPorts $svc)
  if ($ports.Count -gt 0) {
    $failures += "$name publishes ports: $($ports -join ', ')"
  }
}

$api = $services.api
if ($api) {
  $ports = @(Get-PublishedPorts $api)
  if ($ports.Count -eq 0) {
    $failures += "api publishes no ports (expected 127.0.0.1:3000)"
  }
  foreach ($p in $ports) {
    if ($p -notmatch '^127\.0\.0\.1:') {
      $failures += "api publishes non-loopback port: $p"
    }
  }
} else {
  $failures += "api service missing from prod profile config"
}

if ($failures.Count -gt 0) {
  Write-Host "FAIL check-compose-prod:" -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}

Write-Host "OK check-compose-prod: postgres/redis unpublished; api bound to 127.0.0.1" -ForegroundColor Green
exit 0
