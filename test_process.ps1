param(
  [string]$BaseUrl = "http://localhost:3000"
)

function Invoke-TestRequest {
  param(
    [string]$Name,
    [scriptblock]$Request
  )

  try {
    $response = & $Request
    Write-Host "[$Name] status: $($response.StatusCode)"
    Write-Host "[$Name] body: $($response.Content)"
  } catch {
    $statusCode = "N/A"
    $body = $_.Exception.Message

    if ($_.Exception.Response) {
      try {
        $statusCode = [int]$_.Exception.Response.StatusCode
      } catch {}

      try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $reader.BaseStream.Position = 0
        $reader.DiscardBufferedData()
        $body = $reader.ReadToEnd()
        $reader.Close()
      } catch {}
    }

    Write-Host "[$Name] status: $statusCode"
    Write-Host "[$Name] body: $body"
  }

  Write-Host ""
}

$payload = @{
  correlation_id = "corr-local-test-001"
  clinic_id = "00000000-0000-0000-0000-000000000001"
  from = "5511999999999"
  message_text = "Quero marcar consulta amanha de manha"
  phone_number_id = "phone-test-001"
  received_at_iso = (Get-Date).ToString("o")
}

$payloadJson = $payload | ConvertTo-Json -Depth 5 -Compress

Invoke-TestRequest -Name "GET /health" -Request {
  Invoke-WebRequest -Uri "$BaseUrl/health" -Method Get
}

Invoke-TestRequest -Name "POST /process" -Request {
  Invoke-WebRequest -Uri "$BaseUrl/process" -Method Post -ContentType "application/json" -Body $payloadJson
}
