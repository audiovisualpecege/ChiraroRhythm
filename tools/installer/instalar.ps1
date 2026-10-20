# Instalador do Rhythm (roda de dentro do .exe gerado pelo IExpress).
# 1) tenta o instalador oficial da Adobe (vem com o Creative Cloud);
# 2) se não der, extrai o ZXP assinado na pasta de extensões do usuário
#    (o Premiere aceita porque a assinatura vai junto, sem modo desenvolvedor).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
function Msg($text, $icon) { if ($env:AE_TEST_TARGET) { Write-Output "[$icon] $text"; return }; [System.Windows.MessageBox]::Show($text, 'Rhythm', 'OK', $icon) | Out-Null }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$zxp = Join-Path $here 'AutomacaoEdicao.zxp'
$bundleId = 'com.automacaoedicao.premiere'
$userDir = if ($env:AE_TEST_TARGET) { $env:AE_TEST_TARGET } else { Join-Path $env:APPDATA 'Adobe\CEP\extensions\AutomacaoEdicao' }
$upia = 'C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe'

try {
    if (-not (Test-Path $zxp)) { throw 'Pacote AutomacaoEdicao.zxp não encontrado dentro do instalador.' }
    $how = $null

    if (-not $env:AE_TEST_TARGET -and (Test-Path $upia)) {
        # Remove a versão anterior (a pasta leva o nome do pacote, que mudou para "Rhythm"; o id é o mesmo)
        # (o UPIA remove pelo nome exibido, não pelo id)
        foreach ($n in @('Rhythm', 'Automação de Edição')) { Start-Process -FilePath $upia -ArgumentList @('/remove', "`"$n`"") -Wait -WindowStyle Hidden | Out-Null }
        $p = Start-Process -FilePath $upia -ArgumentList @('/install', "`"$zxp`"") -Wait -PassThru -WindowStyle Hidden
        if ($p.ExitCode -eq 0) { $how = 'instalador oficial da Adobe' }
    }

    if (-not $how) {
        # Substitui uma instalação manual anterior
        if (Test-Path $userDir) {
            $item = Get-Item $userDir -Force
            if ($item.LinkType) { $item.Delete() } else { Remove-Item -Recurse -Force $userDir }
        }
        New-Item -ItemType Directory -Force $userDir | Out-Null
        $zip = Join-Path $env:TEMP "AutomacaoEdicao-$([guid]::NewGuid()).zip"
        Copy-Item $zxp $zip
        Expand-Archive -Path $zip -DestinationPath $userDir -Force
        Remove-Item $zip -Force
        if (-not (Test-Path (Join-Path $userDir 'CSXS\manifest.xml'))) { throw 'A extração não gerou o manifest da extensão.' }
        $how = "cópia direta em $userDir"
    }

    # ffmpeg da sincronização por imagem: pula se já houver um que decodifique H.264 e HEVC
    # (o nosso, de uma instalação anterior, ou um no PATH)
    $ffNote = ''
    $ffSrc = Join-Path $here 'ffmpeg.exe'
    $ffDir = if ($env:AE_TEST_FFDIR) { $env:AE_TEST_FFDIR } else { 'C:\ProgramData\Rhythm\ffmpeg' }
    function Test-Ffmpeg($exe) {
        if (-not $exe -or -not (Test-Path $exe)) { return $false }
        try { $d = (& $exe -hide_banner -decoders 2>$null) -join "`n" } catch { return $false }
        return ($d -match '(?m)^\s*V\S{5}\s+h264\s' -and $d -match '(?m)^\s*V\S{5}\s+hevc\s')
    }
    $existing = @((Join-Path $ffDir 'ffmpeg.exe')) + @(Get-Command ffmpeg -All -ErrorAction SilentlyContinue | ForEach-Object Source)
    $okFf = $existing | Where-Object { Test-Ffmpeg $_ } | Select-Object -First 1
    if ($okFf) { $ffNote = "`nffmpeg já instalado ($okFf) — mantido." }
    elseif (Test-Path $ffSrc) {
        try {
            New-Item -ItemType Directory -Force $ffDir | Out-Null
            Copy-Item $ffSrc (Join-Path $ffDir 'ffmpeg.exe') -Force
            $lic = Join-Path $here 'ffmpeg-LICENSE.txt'
            if (Test-Path $lic) { Copy-Item $lic (Join-Path $ffDir 'LICENSE.txt') -Force }
            $ffNote = "`nffmpeg instalado em $ffDir (sincronização por imagem)."
        } catch { $ffNote = "`nAviso: não deu para instalar o ffmpeg ($($_.Exception.Message)). A sincronização por imagem fica indisponível; o resto funciona." }
    }

    $running = Get-Process -Name 'Adobe Premiere Pro*' -ErrorAction SilentlyContinue
    $tail = if ($running) { "`n`nO Premiere está aberto: feche e abra de novo para a extensão aparecer." } else { '' }
    Msg ("Rhythm instalado ($how).$ffNote`n`nNo Premiere Pro: Janela › Extensões › Rhythm." + $tail) 'Information'
}
catch {
    Msg ("Não foi possível instalar:`n`n" + $_.Exception.Message) 'Error'
    exit 1
}
