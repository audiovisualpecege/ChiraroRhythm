<#
  Instala (ou remove) o .zxp com o instalador oficial da Adobe que vem com o
  Creative Cloud (UnifiedPluginInstallerAgent) — o mesmo caminho das
  extensões da Adobe Exchange. Depois é só reabrir o Premiere.

  Uso:
    powershell -ExecutionPolicy Bypass -File tools\install.ps1 [-Zxp caminho.zxp]
    powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Uninstall
#>
param([string]$Zxp, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$bundleId = 'com.automacaoedicao.premiere'
$upia = 'C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe'
if (-not (Test-Path $upia)) { throw 'Instalador da Adobe não encontrado. Ele vem com o app Creative Cloud.' }

$dev = Join-Path $env:APPDATA 'Adobe\CEP\extensions\AutomacaoEdicao'
if ((Test-Path $dev) -and (Get-Item $dev -Force).LinkType -eq 'Junction') {
    (Get-Item $dev -Force).Delete()
    Write-Host 'Link de desenvolvimento removido (evita duas cópias da extensão).'
}

# O UPIA remove pelo NOME exibido em "/list all" (pelo id dá erro -406).
# Nome antigo incluído: a pasta de instalação leva o nome, e o id é o mesmo.
$names = @('Rhythm', 'Automação de Edição')

if ($Uninstall) {
    foreach ($n in $names) { & $upia /remove $n }
    Write-Host 'Extensão removida. Reabra o Premiere.'
    return
}

if (-not $Zxp) {
    $Zxp = Get-ChildItem (Join-Path $PSScriptRoot '..\dist') -Filter *.zxp | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Zxp -or -not (Test-Path $Zxp)) { throw 'Nenhum .zxp encontrado. Rode tools\build-zxp.ps1 primeiro.' }
$Zxp = (Resolve-Path $Zxp).Path   # o UPIA falha (-160) com caminho relativo

foreach ($n in $names) { & $upia /remove $n | Out-Null }
# O UPIA sai com 0 mesmo quando falha: confere pela mensagem
$out = & $upia /install $Zxp | Out-String
Write-Host $out.Trim()
if ($out -notmatch 'Installation Successful') { throw 'O instalador da Adobe não conseguiu instalar (veja a mensagem acima).' }
Write-Host 'Instalado! Reabra o Premiere: Janela > Extensões > Rhythm'
