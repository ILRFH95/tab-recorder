# 把錄好的 webm 批次轉成 MP4（畫面不重新壓縮，只把聲音轉成 AAC）。
#
# 只處理最後修改時間超過 1 小時的檔案，避免動到還在錄、還在下載的檔案。
# 轉好的 MP4 放到「轉好的MP4」資料夾，轉完的原檔移到「已轉的原檔」資料夾；資料夾不存在會自動建立。
# 轉檔失敗的檔案會留在原地，下次再執行會重試。
#
# 用法：
#   直接執行：處理「下載\ScreenRecorder」
#   -Folder <路徑>：處理別的資料夾
#   -MinAgeMinutes <分鐘>：改變「多久以前的檔案才轉」，預設 60
#   -Cfr：改成重新壓縮成固定每秒 30 格（比較慢；剪輯軟體出現聲音不同步時才用）
param(
  [string]$Folder = (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads\ScreenRecorder'),
  [int]$MinAgeMinutes = 60,
  [switch]$Cfr
)

$ErrorActionPreference = 'Stop'

$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg -and (Test-Path 'C:\ffmpeg\bin\ffmpeg.exe')) { $ffmpeg = 'C:\ffmpeg\bin\ffmpeg.exe' }
if (-not $ffmpeg) { Write-Host '找不到 ffmpeg，請先安裝並加入 PATH。' -ForegroundColor Red; exit 1 }
if (-not (Test-Path -LiteralPath $Folder)) { Write-Host "找不到資料夾：$Folder" -ForegroundColor Red; exit 1 }
# 換成完整路徑：ffmpeg、PowerShell 和 .NET 對相對路徑的解讀可能不同
$Folder = (Resolve-Path -LiteralPath $Folder).ProviderPath
$outDir = Join-Path $Folder '轉好的MP4'
$doneDir = Join-Path $Folder '已轉的原檔'

# 同一時間只允許一個轉檔視窗，避免兩個視窗搶同一批檔案、互刪暫存檔
$mutex = New-Object System.Threading.Mutex($false, 'Local\tab-recorder-convert-to-mp4')
try {
  if (-not $mutex.WaitOne(0)) { Write-Host '已經有另一個轉檔視窗在執行，請等它結束再開。' -ForegroundColor Yellow; exit 1 }
} catch [System.Threading.AbandonedMutexException] {
  # 上一個視窗被直接關掉，鎖已經轉給這次執行
}

$cutoff = (Get-Date).AddMinutes(-$MinAgeMinutes)
$files = @(Get-ChildItem -LiteralPath $Folder -File -Filter *.webm | Where-Object { $_.LastWriteTime -lt $cutoff } | Sort-Object Name)
if ($files.Count -eq 0) { Write-Host "沒有超過 $MinAgeMinutes 分鐘的 webm 檔要轉。"; exit 0 }

New-Item -ItemType Directory -Force -Path $outDir, $doneDir | Out-Null
# 上次執行到一半被關掉留下的暫存檔，對應的原檔還沒搬走，這次會重轉
Get-ChildItem -LiteralPath $outDir -File -Filter '~轉檔中_*' | ForEach-Object {
  try { [IO.File]::Delete($_.FullName) } catch { Write-Host "  無法刪除殘留的暫存檔：$($_.Exception.Message)" -ForegroundColor Yellow }
}
Write-Host "共 $($files.Count) 個檔案要轉。轉好的放在：$outDir" -ForegroundColor Cyan

# 已存在同名檔案時，在檔名後面加 (2)、(3)…
function Get-FreePath([string]$dir, [string]$name) {
  $base = [IO.Path]::GetFileNameWithoutExtension($name)
  $ext = [IO.Path]::GetExtension($name)
  $path = Join-Path $dir $name
  $n = 2
  while (Test-Path -LiteralPath $path) { $path = Join-Path $dir "$base ($n)$ext"; $n++ }
  return $path
}

if ($Cfr) {
  $videoArgs = @('-r', '30', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast')
} else {
  $videoArgs = @('-c:v', 'copy')
}

$ok = 0; $failed = 0; $i = 0
foreach ($f in $files) {
  $i++
  Write-Host ""
  Write-Host "[$i/$($files.Count)] $($f.Name)"
  $final = Get-FreePath $outDir ($f.BaseName + '.mp4')
  # 先寫到暫存檔，成功才改成正式檔名，避免中斷時留下看起來完整的壞檔
  $temp = Join-Path $outDir ('~轉檔中_' + [IO.Path]::GetFileName($final))
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    & $ffmpeg -hide_banner -loglevel error -stats -y -i $f.FullName @videoArgs -c:a aac -b:a 192k -movflags +faststart $temp
    $code = $LASTEXITCODE
    if ($code -ne 0 -or -not (Test-Path -LiteralPath $temp) -or (Get-Item -LiteralPath $temp).Length -eq 0) {
      throw "ffmpeg 結束代碼 $code"
    }
    # 用 .NET 搬檔：PowerShell 的 Move-Item 遇到 8.3 短路徑（例如 LSHPC~1）會出錯
    [IO.File]::Move($temp, $final)
    [IO.File]::Move($f.FullName, (Get-FreePath $doneDir $f.Name))
    Write-Host ("  完成（{0:N0} 秒）" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
    $ok++
  } catch {
    # 一個檔案失敗不影響其他檔案
    if (Test-Path -LiteralPath $temp) { [IO.File]::Delete($temp) }
    Write-Host "  失敗（$($_.Exception.Message)），原檔留在原地，下次執行會重試" -ForegroundColor Red
    $failed++
  }
}

Write-Host ""
Write-Host "全部處理完：成功 $ok 個，失敗 $failed 個。" -ForegroundColor Cyan
if ($failed -gt 0) { exit 2 }
