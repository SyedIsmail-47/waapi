# Live rate-limit probe against the smoke/prod API on localhost:3000.
# Expectation (defaults): RATE_LIMIT_LOGIN=10, RATE_LIMIT_MAX=100.
# Does not print secrets — Bearer values are random garbage.
param(
  [string]$BaseUrl = "http://127.0.0.1:3000",
  [int]$LoginAttempts = 150,
  [int]$SessionAttempts = 300
)

$ErrorActionPreference = "Stop"

function New-GarbageBearer {
  return "Bearer garbage-" + [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
}

function Invoke-ProbeCount {
  param(
    [string]$Name,
    [scriptblock]$Request,
    [int]$Count
  )
  $counts = @{ 401 = 0; 429 = 0; 500 = 0; other = 0 }
  $sample429 = $null
  for ($i = 0; $i -lt $Count; $i++) {
    $res = & $Request
    $code = [int]$res.StatusCode
    if ($counts.ContainsKey($code)) { $counts[$code]++ } else { $counts.other++ }
    if ($code -eq 429 -and $null -eq $sample429) {
      $sample429 = $res
    }
  }
  Write-Host ""
  Write-Host "=== $Name ==="
  Write-Host ("401={0} 429={1} 500={2} other={3}" -f $counts[401], $counts[429], $counts[500], $counts.other)
  if ($null -ne $sample429) {
    Write-Host "--- sample 429 ---"
    Write-Host ("StatusCode: {0}" -f $sample429.StatusCode)
    Write-Host "Headers:"
    foreach ($key in $sample429.Headers.Keys) {
      Write-Host ("  {0}: {1}" -f $key, $sample429.Headers[$key])
    }
    Write-Host "Body:"
    Write-Host $sample429.Content
  } else {
    Write-Host "No 429 observed."
  }
  return $counts
}

Write-Host "Rate-limit probe against $BaseUrl"

$loginCounts = Invoke-ProbeCount -Name "POST /api/v1/auth/login x$LoginAttempts" -Count $LoginAttempts -Request {
  $headers = @{
    "Content-Type" = "application/json"
    "Authorization" = (New-GarbageBearer)
  }
  $body = @{
    email = ("probe-{0}@example.test" -f [guid]::NewGuid().ToString("n").Substring(0, 12))
    password = "not-a-real-password"
  } | ConvertTo-Json
  try {
    Invoke-WebRequest -Uri "$BaseUrl/api/v1/auth/login" -Method POST -Headers $headers -Body $body -UseBasicParsing
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { throw }
    $content = $_.ErrorDetails.Message
    if (-not $content -and $resp -is [System.Net.HttpWebResponse]) {
      $stream = $resp.GetResponseStream()
      if ($null -ne $stream) {
        $reader = New-Object System.IO.StreamReader($stream)
        $content = $reader.ReadToEnd()
        $reader.Close()
      }
    }
    $headerTable = @{}
    foreach ($h in $resp.Headers.AllKeys) { $headerTable[$h] = $resp.Headers[$h] }
    [pscustomobject]@{
      StatusCode = [int]$resp.StatusCode
      Headers = $headerTable
      Content = $content
    }
  }
}

$sessionCounts = Invoke-ProbeCount -Name "GET /api/v1/sessions x$SessionAttempts" -Count $SessionAttempts -Request {
  $headers = @{ Authorization = (New-GarbageBearer) }
  try {
    Invoke-WebRequest -Uri "$BaseUrl/api/v1/sessions" -Method GET -Headers $headers -UseBasicParsing
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { throw }
    $content = $_.ErrorDetails.Message
    if (-not $content -and $resp -is [System.Net.HttpWebResponse]) {
      $stream = $resp.GetResponseStream()
      if ($null -ne $stream) {
        $reader = New-Object System.IO.StreamReader($stream)
        $content = $reader.ReadToEnd()
        $reader.Close()
      }
    }
    $headerTable = @{}
    foreach ($h in $resp.Headers.AllKeys) { $headerTable[$h] = $resp.Headers[$h] }
    [pscustomobject]@{
      StatusCode = [int]$resp.StatusCode
      Headers = $headerTable
      Content = $content
    }
  }
}

Write-Host ""
Write-Host "PROBE_SUMMARY login 401=$($loginCounts[401]) 429=$($loginCounts[429]) 500=$($loginCounts[500])"
Write-Host "PROBE_SUMMARY sessions 401=$($sessionCounts[401]) 429=$($sessionCounts[429]) 500=$($sessionCounts[500])"

if ($loginCounts[500] -gt 0 -or $sessionCounts[500] -gt 0) {
  Write-Error "Probe observed 500 responses"
  exit 1
}
if ($loginCounts[429] -lt 1 -or $sessionCounts[429] -lt 1) {
  Write-Error "Probe expected 429 responses"
  exit 1
}
Write-Host "PROBE_OK"
