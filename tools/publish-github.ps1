<#
  Publica a versão atual do Rhythm no GitHub (repositório PÚBLICO audiovisualpecege/ChiraroRhythm).

  Antes de enviar, confere:
    - nenhum arquivo proibido na lista de envio (CONTEXTO.md, fontes Altivo, certificado, ffmpeg, instaladores, .claude);
    - nenhum termo da lista de bloqueio (_contexto\github-bloqueio.txt — clientes, pessoas, projetos) em nenhum arquivo.
  Se algo aparecer, para sem enviar nada.

  Uso:
    powershell -ExecutionPolicy Bypass -File tools\publish-github.ps1 -Notas "o que mudou" [-SemRelease] [-Ensaio]
      -Ensaio     só confere e mostra o que seria enviado
      -SemRelease envia o código e a tag, sem criar o Release
      -Anexos     arquivos para anexar ao Release (só os que não levam a fonte Altivo)
      -NotasArquivo  lê as notas de um arquivo (.md)
      -Substituir    SÓ NA 1ª PUBLICAÇÃO: troca o histórico do GitHub pelo daqui (force push) — apaga o que havia lá
#>
param([string]$Notas = "", [string]$NotasArquivo = "", [switch]$SemRelease, [switch]$Ensaio, [switch]$Substituir, [string[]]$Anexos = @())
if ($NotasArquivo) { $Notas = [IO.File]::ReadAllText((Resolve-Path $NotasArquivo), [Text.Encoding]::UTF8).Trim() }
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$git = 'C:\Program Files\Git\cmd\git.exe'
$gh = 'C:\Program Files\GitHub CLI\gh.exe'
$repo = 'audiovisualpecege/ChiraroRhythm'
$bloqueio = Join-Path (Split-Path $root) '_contexto\github-bloqueio.txt'
foreach ($exe in $git, $gh) { if (-not (Test-Path $exe)) { throw "não achei $exe" } }

Push-Location $root
try {
  $manifest = [xml](Get-Content (Join-Path $root 'extension\CSXS\manifest.xml') -Raw -Encoding UTF8)
  $versao = $manifest.ExtensionManifest.ExtensionBundleVersion
  $tag = "v$versao"
  Write-Host "Rhythm $versao → $repo"

  if (-not (Test-Path (Join-Path $root '.git'))) {
    & $git init -b main | Out-Null
    & $git remote add origin "https://github.com/$repo.git"
  }
  & $git config user.name 'audiovisualpecege'
  & $git config user.email 'audiovisualpecege@users.noreply.github.com'
  & $git config core.autocrlf false
  & $git config core.quotepath false

  & $git add -A
  $arquivos = @(& $git diff --cached --name-only) + @(& $git ls-files) | Sort-Object -Unique

  # 1) arquivos proibidos
  # imagens e binários podem conter dados que a busca de texto não vê (ex.: a claquete tem o nome da produção)
  $proibidos = $arquivos | Where-Object { $_ -match '(^|/)CONTEXTO\.md$|Altivo-.*\.otf$|^tools/(cert|bin)/|^dist/|^\.claude/|\.(zxp|exe|p12|pfx|slt|debug)$|(^|/)\.debug$' }
  $imagens = $arquivos | Where-Object { $_ -match '\.(png|jpe?g|gif|bmp|tiff?|webp)$' -and $_ -notmatch '^extension/img/rhythm-icon' }
  if ($imagens) { & $git reset -q; throw "imagens novas precisam ser conferidas à mão antes de publicar (podem mostrar clientes):`n  $($imagens -join "`n  ")" }
  if ($proibidos) { & $git reset -q; throw "arquivos proibidos na lista de envio:`n  $($proibidos -join "`n  ")" }

  # 2) termos bloqueados (clientes, pessoas, projetos)
  if (-not (Test-Path $bloqueio)) { & $git reset -q; throw "lista de bloqueio não encontrada: $bloqueio" }
  $termos = Get-Content $bloqueio -Encoding UTF8 | Where-Object { $_.Trim() -and -not $_.StartsWith('#') }
  $achados = @()
  foreach ($a in $arquivos) {
    $p = Join-Path $root $a
    if (-not (Test-Path $p -PathType Leaf)) { continue }
    if ((Get-Item $p).Length -gt 5MB) { continue }
    if ($a -match '\.(png|jpg|wasm|task|ttf|otf|tflite|binarypb|slt)$') { continue }
    $texto = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
    foreach ($t in $termos) {
      $m = [regex]::Match($texto, $t, 'IgnoreCase')
      if ($m.Success) { $achados += "$a → '$($m.Value)'" }
    }
  }
  if ($achados) { & $git reset -q; throw "termos bloqueados encontrados (nada foi enviado):`n  $($achados -join "`n  ")" }

  $novos = @(& $git diff --cached --name-status)
  Write-Host "conferido: $($arquivos.Count) arquivos, nenhum proibido, nenhum termo bloqueado · mudanças: $($novos.Count)"
  if ($Ensaio) { $novos | Select-Object -First 60 | ForEach-Object { Write-Host "  $_" }; & $git reset -q; Write-Host 'ensaio: nada enviado'; return }

  if ($novos.Count) {
    $msg = "Rhythm $versao"
    if ($Notas) { $msg += "`n`n$Notas" }
    & $git commit -q -m $msg
  }
  if (-not (& $git tag --list $tag)) { & $git tag $tag }
  if ($Substituir) { & $git push --force -u origin main } else { & $git push -u origin main }
  if ($LASTEXITCODE) { throw 'o envio para o GitHub falhou (nada mais foi feito)' }
  & $git push origin $tag
  if (-not $SemRelease) {
    $titulo = "Chiaro Rhythm $tag"
    $args2 = @('release', 'create', $tag, '-R', $repo, '--title', $titulo, '--notes', ($(if ($Notas) { $Notas } else { "Rhythm $versao" })))
    foreach ($an in $Anexos) { if (-not (Test-Path $an)) { throw "anexo não existe: $an" }; $args2 += $an }
    & $gh @args2
  }
  Write-Host "publicado: https://github.com/$repo/releases/tag/$tag"
} finally { Pop-Location }
