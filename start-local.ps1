# Chạy toàn bộ trên máy bạn (Windows PowerShell): ONLYOFFICE (Docker) + ứng dụng Node. Dữ liệu nằm trong server\data.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path .env)) {
  $secret = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  (Get-Content .env.example) -replace 'doi-thanh-chuoi-ngau-nhien-dai', $secret | Set-Content .env
  Write-Host 'Đã tạo .env với JWT secret ngẫu nhiên.'
}
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([^#=\s]+)\s*=\s*(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim() }
}
docker compose --env-file .env up -d
npm run build
npm start
