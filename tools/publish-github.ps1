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
      -Anexos     outros arquivos para anexar ao Release
      O instalador dist\Rhythm-<versão>.exe vai anexado sempre (o botão "Atualizar" do painel baixa
      dele; decisão do usuário 20/10/2026: o .exe leva a fonte Altivo e a claquete e fica público)
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
  $pv = $versao.Split('.')
  $instalador = Join-Path $root ("dist\Rhythm-{0}.exe" -f $(if ($pv[2] -eq '0') { "$($pv[0]).$($pv[1])" } else { $versao }))
  if (-not $SemRelease -and -not (Test-Path $instalador)) { throw "falta o instalador $instalador (rode build-zxp e build-exe antes)" }
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
  if (-not $SemRelease) { Write-Host "instalador no Release: $instalador ($([math]::Round((Get-Item $instalador).Length / 1MB, 1)) MB)" }
  Write-Host "conferido: $($arquivos.Count) arquivos, nenhum proibido, nenhum termo bloqueado · mudanças: $($novos.Count)"
  if ($Ensaio) { $novos | Select-Object -First 60 | ForEach-Object { Write-Host "  $_" }; & $git reset -q; Write-Host 'ensaio: nada enviado'; return }

  # mensagem e notas vão por ARQUIVO: o PowerShell 5.1 quebra argumentos com aspas ao chamar git/gh
  $notasFile = Join-Path $env:TEMP "rhythm-notas-$([guid]::NewGuid()).md"
  [IO.File]::WriteAllText($notasFile, $(if ($Notas) { $Notas } else { "Rhythm $versao" }), (New-Object Text.UTF8Encoding $false))
  $msgFile = Join-Path $env:TEMP "rhythm-msg-$([guid]::NewGuid()).txt"
  [IO.File]::WriteAllText($msgFile, "Rhythm $versao" + $(if ($Notas) { "`n`n$Notas" } else { '' }), (New-Object Text.UTF8Encoding $false))
  if ($novos.Count) {
    & $git commit -q -F $msgFile
    if ($LASTEXITCODE) { throw 'o commit falhou (nada foi enviado)' }
  }
  Remove-Item $msgFile -ErrorAction SilentlyContinue
  if (-not (& $git tag --list $tag)) { & $git tag $tag }
  if ((& $git rev-parse "$tag^{commit}") -ne (& $git rev-parse HEAD)) { throw "a tag $tag já existe e não aponta para o commit atual" }
  if ($Substituir) { & $git push --force -u origin main } else { & $git push -u origin main }
  if ($LASTEXITCODE) { throw 'o envio para o GitHub falhou (nada mais foi feito)' }
  & $git push origin $tag
  if (-not $SemRelease) {
    $titulo = "Chiaro Rhythm $tag"
    $args2 = @('release', 'create', $tag, '-R', $repo, '--title', $titulo, '--notes-file', $notasFile)
    $args2 += $instalador
    foreach ($an in $Anexos) { if (-not (Test-Path $an)) { throw "anexo não existe: $an" }; $args2 += $an }
    & $gh @args2
    if ($LASTEXITCODE) { throw 'o código foi enviado, mas o Release não foi criado' }
  }
  Remove-Item $notasFile -ErrorAction SilentlyContinue
  Write-Host "publicado: https://github.com/$repo/releases/tag/$tag"
} finally { Pop-Location }
