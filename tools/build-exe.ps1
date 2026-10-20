<#
  Gera dist\Instalar-Rhythm-<versão>.exe e dist\Desinstalar-Rhythm.exe
  com o IExpress (vem no Windows). O instalador leva o .zxp mais recente de dist\.

  Uso:  powershell -ExecutionPolicy Bypass -File tools\build-exe.ps1
  (rode tools\build-zxp.ps1 antes, se mudou o código)
#>
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dist = Join-Path $root 'dist'
$zxp = Get-ChildItem $dist -Filter 'Rhythm-*.zxp' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $zxp) { throw 'Nenhum .zxp em dist\. Rode tools\build-zxp.ps1 primeiro.' }
$version = $zxp.BaseName -replace '^Rhythm-', ''

function Build-Exe($name, $script, $extraFiles, $title) {
    $stage = Join-Path $env:TEMP "ae-iexpress-$([guid]::NewGuid())"
    New-Item -ItemType Directory $stage | Out-Null
    Copy-Item (Join-Path $PSScriptRoot "installer\$script") $stage
    foreach ($f in $extraFiles.Keys) { Copy-Item $extraFiles[$f] (Join-Path $stage $f) }
    $cmd = 'run.cmd'
    Set-Content -Path (Join-Path $stage $cmd) -Encoding ASCII -Value "@powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"%~dp0$script`""
    $files = @($cmd, $script) + @($extraFiles.Keys)
    $out = Join-Path $dist $name
    # O .sed é ASCII: gera no temporário (caminho sem acentos) e move para dist\ depois
    $tmpOut = Join-Path $env:TEMP "ae-iexpress-out-$([guid]::NewGuid()).exe"

    $strings = @("TargetName=$tmpOut", "FriendlyName=$title", "AppLaunched=cmd /c $cmd", 'PostInstallCmd=<None>', 'AdminQuietInstCmd=', 'UserQuietInstCmd=')
    for ($i = 0; $i -lt $files.Count; $i++) { $strings += "FILE$i=`"$($files[$i])`"" }
    $sourceFiles = ($files | ForEach-Object -Begin { $n = 0 } -Process { "%FILE$n%="; $n++ }) -join "`r`n"
    $sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
$($strings -join "`r`n")
[SourceFiles]
SourceFiles0=$stage\
[SourceFiles0]
$sourceFiles
"@
    $sedPath = Join-Path $stage 'build.sed'
    Set-Content -Path $sedPath -Value $sed -Encoding ASCII
    if (Test-Path $out) { Remove-Item -Force $out }
    $p = Start-Process -FilePath "$env:SystemRoot\System32\iexpress.exe" -ArgumentList @('/N', '/Q', $sedPath) -Wait -PassThru
    Remove-Item -Recurse -Force $stage
    if (-not (Test-Path $tmpOut)) { throw "IExpress não gerou $name (código $($p.ExitCode))." }
    Move-Item $tmpOut $out
    Write-Host "Gerado: $out"
}

# ffmpeg (sincronização por imagem) vai junto; o instalador pula a cópia se já houver um que sirva
$ff = Join-Path $PSScriptRoot 'bin\ffmpeg\ffmpeg.exe'
if (-not (Test-Path $ff)) { throw "Coloque o ffmpeg.exe (build essentials do gyan.dev) em $ff" }
$extra = @{ 'AutomacaoEdicao.zxp' = $zxp.FullName; 'ffmpeg.exe' = $ff }
$ffLic = Join-Path $PSScriptRoot 'bin\ffmpeg\LICENSE.txt'
if (Test-Path $ffLic) { $extra['ffmpeg-LICENSE.txt'] = $ffLic }
Build-Exe "Instalar-Rhythm-$version.exe" 'instalar.ps1' $extra 'Rhythm - Instalador'
Build-Exe 'Desinstalar-Rhythm.exe' 'desinstalar.ps1' @{} 'Rhythm - Desinstalador'
