# Live rate-limit probe against the smoke/prod API on localhost:3000.
# Expectation (defaults): RATE_LIMIT_IP_MAX=600, RATE_LIMIT_FAILED_AUTH_MAX=30,
# RATE_LIMIT_ACCOUNT_MAX=300.
# Does not print secrets — Bearer values are random garbage (or a PAT when provided).
param(
  [string]$BaseUrl = "http://127.0.0.1:3000",
  [int]$ValidPatAttempts = 200,
  [int]$GarbageAttempts = 80,
  [string]$PatToken = ""
)

$ErrorActionPreference = "Stop"

function New-GarbageBearer {
  return "Bearer garbage-" + [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
}

function Invoke-CountedRequest {
  param([scriptblock]$Request)
  try {
    return & $Request
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
    return [pscustomobject]@{
      StatusCode = [int]$resp.StatusCode
      Headers = $headerTable
      Content = $content
    }
  }
}

function Invoke-ProbeCount {
  param(
    [string]$Name,
    [scriptblock]$Request,
    [int]$Count
  )
  $counts = @{ 200 = 0; 401 = 0; 429 = 0; 500 = 0; other = 0 }
  $sample429 = $null
  for ($i = 0; $i -lt $Count; $i++) {
    $res = Invoke-CountedRequest -Request $Request
    $code = [int]$res.StatusCode
    if ($counts.ContainsKey($code)) { $counts[$code]++ } else { $counts.other++ }
    if ($code -eq 429 -and $null -eq $sample429) { $sample429 = $res }
  }
  Write-Host ""
  Write-Host "=== $Name ==="
  Write-Host ("200={0} 401={1} 429={2} 500={3} other={4}" -f $counts[200], $counts[401], $counts[429], $counts[500], $counts.other)
  if ($null -ne $sample429) {
    Write-Host "--- sample 429 ---"
    Write-Host ("StatusCode: {0}" -f $sample429.StatusCode)
    Write-Host "Headers:"
    foreach ($key in $sample429.Headers.Keys) {
      Write-Host ("  {0}: {1}" -f $key, $sample429.Headers[$key])
    }
    Write-Host "Body:"
    Write-Host $sample429.Content
  }
  return $counts
}

Write-Host "Rate-limit probe against $BaseUrl"

if ($PatToken) {
  $patCounts = Invoke-ProbeCount -Name "GET /api/v1/sessions valid PAT x$ValidPatAttempts" -Count $ValidPatAttempts -Request {
    $headers = @{ Authorization = "Bearer $PatToken" }
    try {
      Invoke-WebRequest -Uri "$BaseUrl/api/v1/sessions" -Method GET -Headers $headers -UseBasicParsing
    } catch { throw }
  }
  if ($patCounts[200] -ne $ValidPatAttempts -or $patCounts[500] -gt 0) {
    Write-Error "Expected all $ValidPatAttempts valid PAT requests to return 200"
    exit 1
  }
}

$garbageCounts = Invoke-ProbeCount -Name "GET /api/v1/sessions garbage bearer x$GarbageAttempts" -Count $GarbageAttempts -Request {
  $headers = @{ Authorization = (New-GarbageBearer) }
  try {
    Invoke-WebRequest -Uri "$BaseUrl/api/v1/sessions" -Method GET -Headers $headers -UseBasicParsing
  } catch { throw }
}

Write-Host ""
Write-Host "PROBE_SUMMARY garbage 401=$($garbageCounts[401]) 429=$($garbageCounts[429]) 500=$($garbageCounts[500])"
if ($garbageCounts[500] -gt 0) {
  Write-Error "Probe observed 500 responses"
  exit 1
}
if ($garbageCounts[401] -lt 30 -or $garbageCounts[429] -lt 1) {
  Write-Error "Probe expected ~30x401 then 429 for garbage tokens"
  exit 1
}
Write-Host "PROBE_OK"
