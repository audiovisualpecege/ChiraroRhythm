# Desinstalador do Rhythm (roda de dentro do .exe gerado pelo IExpress).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
function Msg($text, $icon) { [System.Windows.MessageBox]::Show($text, 'Rhythm', 'OK', $icon) | Out-Null }

$bundleId = 'com.automacaoedicao.premiere'
$upia = 'C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe'
$removed = @()
try {
    if (Test-Path $upia) {
        # O UPIA remove pelo nome exibido (não pelo id) e sai com 0 mesmo falhando: confere pela pasta
        $cep = 'C:\Program Files (x86)\Common Files\Adobe\CEP\extensions'
        foreach ($n in @('Rhythm', 'Automação de Edição')) {
            $had = Test-Path -LiteralPath (Join-Path $cep $n)
            Start-Process -FilePath $upia -ArgumentList @('/remove', "`"$n`"") -Wait -WindowStyle Hidden | Out-Null
            if ($had -and -not (Test-Path -LiteralPath (Join-Path $cep $n))) { $removed += "$n (instalador da Adobe)" }
        }
    }
    $userDir = Join-Path $env:APPDATA 'Adobe\CEP\extensions\AutomacaoEdicao'
    if (Test-Path $userDir) {
        $item = Get-Item $userDir -Force
        if ($item.LinkType) { $item.Delete() } else { Remove-Item -Recurse -Force $userDir }
        $removed += 'pasta de extensões do usuário'
    }
    # só a pasta que o nosso instalador cria (um ffmpeg do usuário em outro lugar fica)
    $ffDir = 'C:\ProgramData\Rhythm'
    if (Test-Path $ffDir) {
        Remove-Item -Recurse -Force $ffDir
        $removed += 'ffmpeg do Rhythm'
    }
    if ($removed.Count) { Msg ("Rhythm removido (" + ($removed -join ', ') + ").`nReabra o Premiere.") 'Information' }
    else { Msg 'O Rhythm não estava instalado neste computador.' 'Information' }
}
catch {
    Msg ("Não foi possível desinstalar:`n`n" + $_.Exception.Message) 'Error'
    exit 1
}
