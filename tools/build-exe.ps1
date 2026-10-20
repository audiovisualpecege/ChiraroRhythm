<#
  Gera dist\Rhythm-<versão>.exe — instalador ÚNICO (instala, atualiza, reinstala e desinstala).
  É um executável pequeno (tools\installer\stub.cs, compilado com o csc do .NET Framework que vem
  no Windows) com um pacote embutido: instalador.ps1 + Rhythm.zxp + ffmpeg + versão + ícone.
  Nome: 3.0.0 → Rhythm-3.0.exe; 3.0.1 → Rhythm-3.0.1.exe.

  Uso:  powershell -ExecutionPolicy Bypass -File tools\build-exe.ps1 [-Teste]
  (rode tools\build-zxp.ps1 antes, se mudou o código)
    -Teste  usa o .zxp de dist\teste (gerado por build-zxp -Teste) e gera o .exe lá
#>
param([switch]$Teste)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dist = Join-Path $root 'dist'
$inst = Join-Path $PSScriptRoot 'installer'
if ($Teste) {
    $dist = Join-Path $dist 'teste'
    $zxp = Get-ChildItem $dist -Filter 'Rhythm-*.zxp' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $zxp) { throw 'Nenhum .zxp em dist\teste. Rode tools\build-zxp.ps1 -Teste -Versao X primeiro.' }
} else {
    [xml]$manifest = Get-Content (Join-Path $root 'extension\CSXS\manifest.xml') -Encoding UTF8
    $zxp = Get-Item (Join-Path $dist "Rhythm-$($manifest.ExtensionManifest.ExtensionBundleVersion).zxp") -ErrorAction SilentlyContinue
    if (-not $zxp) { throw "Não achei o .zxp da versão do manifest em dist\. Rode tools\build-zxp.ps1 primeiro." }
}
$version = $zxp.BaseName -replace '^Rhythm-', ''
$p = $version.Split('.')
$short = if ($p.Count -ge 3 -and $p[2] -eq '0') { "$($p[0]).$($p[1])" } else { $version }

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'Não achei o csc.exe do .NET Framework 4.' }
$ff = Join-Path $PSScriptRoot 'bin\ffmpeg\ffmpeg.exe'
if (-not (Test-Path $ff)) { throw "Coloque o ffmpeg.exe (build essentials do gyan.dev) em $ff" }

# Ícone (moldura Chiaro + timeline, o mesmo desenho do rhythm-icon.svg) — gerado uma vez
$ico = Join-Path $inst 'rhythm.ico'
if (-not (Test-Path $ico)) {
    Add-Type -AssemblyName System.Drawing
    function Pill($g, $col, $x, $y, $w, $h) {
        $pp = New-Object Drawing.Drawing2D.GraphicsPath
        $pp.AddArc($x, $y, $h, $h, 90, 180); $pp.AddArc($x + $w - $h, $y, $h, $h, 270, 180); $pp.CloseFigure()
        $g.FillPath((New-Object Drawing.SolidBrush $col), $pp)
    }
    $c = { param($h) [Drawing.ColorTranslator]::FromHtml($h) }
    $pngs = foreach ($size in 256, 48, 32, 16) {
        $bmp = New-Object Drawing.Bitmap $size, $size
        $g = [Drawing.Graphics]::FromImage($bmp)
        $g.SmoothingMode = 'AntiAlias'
        $g.Clear([Drawing.Color]::Transparent)
        $s = $size / 128.0
        $bg = New-Object Drawing.Drawing2D.GraphicsPath
        $r = 26 * $s; $w = 128 * $s - 1
        $bg.AddArc(0, 0, $r, $r, 180, 90); $bg.AddArc($w - $r, 0, $r, $r, 270, 90)
        $bg.AddArc($w - $r, $w - $r, $r, $r, 0, 90); $bg.AddArc(0, $w - $r, $r, $r, 90, 90); $bg.CloseFigure()
        $g.FillPath((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(7, 0, 16))), $bg)
        $g.TranslateTransform(10 * $s, 13 * $s); $g.ScaleTransform($s, $s)
        $pen = New-Object Drawing.Pen (& $c '#F5F2FA'), 6.4
        $pts = @(@(97.7, 17.6), @(97.7, 3.2), @(3.2, 3.2), @(3.2, 98.8), @(97.7, 98.8), @(97.7, 82.7)) | ForEach-Object { New-Object Drawing.PointF $_[0], $_[1] }
        $g.DrawLines($pen, [Drawing.PointF[]]$pts)
        Pill $g (& $c '#8C4EDB') 17 33 38 13; Pill $g (& $c '#8C4EDB') 61 33 47 13
        Pill $g (& $c '#F5F2FA') 17 56 52 13; Pill $g (& $c '#F5F2FA') 75 56 33 13
        $pen2 = New-Object Drawing.Pen (& $c '#FACE95'), 6
        $pen2.StartCap = 'Round'; $pen2.EndCap = 'Round'
        $g.DrawLine($pen2, 44, 24, 44, 80)
        $g.FillEllipse((New-Object Drawing.SolidBrush (& $c '#FACE95')), 37.5, 15.5, 13, 13)
        $g.Dispose()
        $ms = New-Object IO.MemoryStream
        $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
        , @($size, $ms.ToArray())
    }
    # .ico com as imagens em PNG (aceito desde o Vista)
    $out = New-Object IO.MemoryStream
    $bw = New-Object IO.BinaryWriter $out
    $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$pngs.Count)
    $offset = 6 + 16 * $pngs.Count
    foreach ($e in $pngs) {
        $sz = if ($e[0] -ge 256) { 0 } else { $e[0] }
        $bw.Write([byte]$sz); $bw.Write([byte]$sz); $bw.Write([byte]0); $bw.Write([byte]0)
        $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$e[1].Length); $bw.Write([uint32]$offset)
        $offset += $e[1].Length
    }
    foreach ($e in $pngs) { $bw.Write([byte[]]$e[1]) }
    [IO.File]::WriteAllBytes($ico, $out.ToArray())
    Write-Host "Ícone gerado: $ico"
}

# Pacote: tudo numa pasta temporária SEM acentos no caminho, zipado e embutido no .exe
$stage = Join-Path $env:TEMP "rhythm-exe-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$pay = Join-Path $stage 'payload'
New-Item -ItemType Directory -Force $pay | Out-Null
try {
    Copy-Item (Join-Path $inst 'instalador.ps1') $pay
    Copy-Item $ico $pay
    Copy-Item $zxp.FullName (Join-Path $pay 'Rhythm.zxp')
    Copy-Item $ff $pay
    $ffLic = Join-Path $PSScriptRoot 'bin\ffmpeg\LICENSE.txt'
    if (Test-Path $ffLic) { Copy-Item $ffLic (Join-Path $pay 'ffmpeg-LICENSE.txt') }
    Set-Content -Path (Join-Path $pay 'versao.txt') -Value $version -Encoding ASCII -NoNewline
    $zip = Join-Path $stage 'payload.zip'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($pay, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)

    Copy-Item $ico (Join-Path $stage 'i.ico')
    Copy-Item (Join-Path $inst 'stub.cs') (Join-Path $stage 'stub.cs')
    $tmpExe = Join-Path $stage 'out.exe'
    $fw = Split-Path $csc
    & $csc /nologo /target:winexe /optimize+ /codepage:65001 "/out:$tmpExe" "/win32icon:$stage\i.ico" "/resource:$zip,payload.zip" `
        "/reference:$fw\System.IO.Compression.dll" "/reference:$fw\System.IO.Compression.FileSystem.dll" `
        /reference:System.Windows.Forms.dll /reference:System.Core.dll "$stage\stub.cs"
    if ($LASTEXITCODE -ne 0) { throw 'O csc não compilou o instalador.' }

    $out = Join-Path $dist "Rhythm-$short.exe"
    if (Test-Path $out) { Remove-Item -Force $out }
    Move-Item $tmpExe $out
    Write-Host ("Gerado: $out ({0:N1} MB, Rhythm $version)" -f ((Get-Item $out).Length / 1MB))
} finally {
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}
