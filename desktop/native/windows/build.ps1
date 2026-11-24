$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "[FoldStage] Building Windows Audio & Now Playing Helper (foldstage-audio-win.exe)..."
dotnet publish FoldStageAudioWin.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o publish
Get-Item publish\foldstage-audio-win.exe | Format-Table Name, Length, LastWriteTime
