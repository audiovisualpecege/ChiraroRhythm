<#
  Modo desenvolvimento: liga a pasta extension/ direto na pasta de extensões
  CEP do usuário (junction). Toda mudança no código aparece ao fechar e abrir
  o painel no Premiere. Requer o PlayerDebugMode ligado (modo desenvolvedor).

  Uso:  powershell -ExecutionPolicy Bypass -File tools\dev-link.ps1 [-Remove]
#>
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$src = (Resolve-Path (Join-Path $PSScriptRoot '..\extension')).Path
$dst = Join-Path $env:APPDATA 'Adobe\CEP\extensions\AutomacaoEdicao'

if (Test-Path $dst) {
    $item = Get-Item $dst -Force
    if ($item.LinkType -eq 'Junction') { $item.Delete() }
    else { throw "Já existe uma pasta (não-link) em $dst. Remova a instalação antiga primeiro (tools\install.ps1 -Uninstall)." }
}
if ($Remove) { Write-Host 'Link de desenvolvimento removido.'; return }

New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
New-Item -ItemType Junction -Path $dst -Target $src | Out-Null
Write-Host "Ligado: $dst -> $src"

$debug = 9..15 | Where-Object { (Get-ItemProperty "HKCU:\Software\Adobe\CSXS.$_" -ErrorAction SilentlyContinue).PlayerDebugMode -eq '1' }
if (-not $debug) { Write-Warning 'PlayerDebugMode não está ligado: o Premiere não carrega extensões sem assinatura. Use tools\install.ps1 (ZXP assinado) ou ligue o modo desenvolvedor.' }
Write-Host 'Abra no Premiere: Janela > Extensões > Rhythm'
