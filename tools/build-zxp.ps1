<#
  Empacota a extensão num .zxp assinado — o formato que o Premiere instala
  como extensão de verdade (sem modo desenvolvedor, sem copiar pasta).

  Precisa do ZXPSignCmd da Adobe em tools\bin\ZXPSignCmd.exe
  (https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD).
  Na primeira vez cria um certificado autoassinado em tools\cert\ (NÃO
  versione essa pasta). A senha fica em tools\cert\senha.txt.

  Uso:  powershell -ExecutionPolicy Bypass -File tools\build-zxp.ps1 [-Teste -Versao 2.9.0]
    -Teste -Versao X  pacote de TESTE com outra versão no manifest (ex.: uma "2.9.0" com o botão de
                      atualizar, para testar a atualização para a versão publicada); vai para dist\teste
#>
param([switch]$Teste, [string]$Versao = '')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sign = Join-Path $PSScriptRoot 'bin\ZXPSignCmd.exe'
if (-not (Test-Path $sign)) { throw "Coloque o ZXPSignCmd.exe da Adobe em $sign" }

[xml]$manifest = Get-Content (Join-Path $root 'extension\CSXS\manifest.xml') -Encoding UTF8
$version = $manifest.ExtensionManifest.ExtensionBundleVersion
if ($Teste) { if (-not $Versao) { throw '-Teste precisa de -Versao' }; $version = $Versao }
$certDir = Join-Path $PSScriptRoot 'cert'
$cert = Join-Path $certDir 'automacao-edicao.p12'
$passFile = Join-Path $certDir 'senha.txt'

if (-not (Test-Path $cert)) {
    New-Item -ItemType Directory -Force $certDir | Out-Null
    $pass = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
    Set-Content -Path $passFile -Value $pass -NoNewline -Encoding ASCII
    & $sign -selfSignedCert BR SP 'Automacao de Edicao' 'Automacao de Edicao' $pass $cert -validityDays 3650
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o certificado.' }
}
$pass = Get-Content $passFile -Raw

# Copia só o que vai para o usuário final (sem .debug)
$stage = Join-Path $env:TEMP "automacao-edicao-zxp-$version"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
Copy-Item -Recurse (Join-Path $root 'extension') $stage
Remove-Item -Force (Join-Path $stage '.debug') -ErrorAction SilentlyContinue
if ($Teste) {
    $mf = Join-Path $stage 'CSXS\manifest.xml'
    $x = [IO.File]::ReadAllText($mf) -replace 'ExtensionBundleVersion="[^"]+"', "ExtensionBundleVersion=`"$version`"" -replace '(<Extension Id="[^"]+" Version=")[^"]+"', "`${1}$version`""
    [IO.File]::WriteAllText($mf, $x)
}

$dist = Join-Path $root 'dist'
if ($Teste) { $dist = Join-Path $dist 'teste' }
New-Item -ItemType Directory -Force $dist | Out-Null
$out = Join-Path $dist "Rhythm-$version.zxp"
if (Test-Path $out) { Remove-Item -Force $out }

& $sign -sign $stage $out $cert $pass -tsa http://timestamp.digicert.com
if ($LASTEXITCODE -ne 0) {
    Write-Warning 'Assinatura com carimbo de tempo falhou (sem internet?). Assinando sem carimbo.'
    & $sign -sign $stage $out $cert $pass
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao assinar o ZXP.' }
}
& $sign -verify $out
Remove-Item -Recurse -Force $stage
Write-Host "Pronto: $out"
