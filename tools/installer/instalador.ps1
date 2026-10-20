# Instalador único do Rhythm (roda de dentro do Rhythm-<versão>.exe).
#   sem argumento   janela: Instalar / Atualizar / Reinstalar · Desinstalar · Cancelar
#   /aguardar       (botão "Atualizar" do painel) espera o Premiere fechar, instala sozinho e oferece reabrir
#   /silencioso     instala sem janela — sai com 0 (ok), 1 (erro) ou 2 (Premiere aberto)
#   /desinstalar /silencioso   remove sem janela
# Nunca fecha o Premiere: com ele aberto, pede para a pessoa fechar.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$versao = (Get-Content (Join-Path $here 'versao.txt') -Raw).Trim()
$opts = @($args | ForEach-Object { "$_".ToLower() })
$modo = if ($opts -contains '/aguardar') { 'aguardar' } elseif ($opts -contains '/silencioso') { 'silencioso' } else { 'janela' }
$desinstalar = $opts -contains '/desinstalar'

# Tudo o que instala/remove fica aqui: roda também num runspace separado (a janela não trava)
$core = {
    $upia = 'C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe'
    $cepDir = Join-Path ${env:ProgramFiles(x86)} 'Common Files\Adobe\CEP\extensions'
    # o UPIA remove pelo nome exibido; "Automação de Edição" é o nome até a 2.1.0 (mesmo bundle id)
    $nomes = @('Rhythm', 'Automação de Edição')
    $userDir = if ($env:AE_TEST_TARGET) { $env:AE_TEST_TARGET } else { Join-Path $env:APPDATA 'Adobe\CEP\extensions\AutomacaoEdicao' }
    $ffDir = if ($env:AE_TEST_FFDIR) { $env:AE_TEST_FFDIR } else { 'C:\ProgramData\Rhythm\ffmpeg' }

    function Get-ManifestVersion($dir) {
        $m = Join-Path $dir 'CSXS\manifest.xml'
        if (-not (Test-Path -LiteralPath $m)) { return $null }
        $x = [IO.File]::ReadAllText($m)
        if ($x -match 'ExtensionBundleVersion="([\d.]+)"') { return [version]$Matches[1] }
        return $null
    }

    function Get-InstalledVersion {
        $dirs = if ($env:AE_TEST_TARGET) { @($userDir) } else { @($nomes | ForEach-Object { Join-Path $cepDir $_ }) + @($userDir) }
        $dirs | ForEach-Object { Get-ManifestVersion $_ } | Where-Object { $_ } | Sort-Object -Descending | Select-Object -First 1
    }

    function Get-Premiere {
        if ($env:AE_TEST_PREMIERE -eq '0') { return @() }   # só nos testes
        if ($env:AE_TEST_PREMIERE -eq '1') { return @(Get-Process -Id $PID) }
        @(Get-Process -Name 'Adobe Premiere Pro*' -ErrorAction SilentlyContinue)
    }

    function Remove-UserDir {
        if (-not (Test-Path $userDir)) { return $false }
        $item = Get-Item $userDir -Force
        if ($item.LinkType) { $item.Delete() } else { Remove-Item -Recurse -Force $userDir }
        return $true
    }

    function Test-Ffmpeg($exe) {
        if (-not $exe -or -not (Test-Path $exe)) { return $false }
        try { $d = (& $exe -hide_banner -decoders 2>$null) -join "`n" } catch { return $false }
        return ($d -match '(?m)^\s*V\S{5}\s+h264\s' -and $d -match '(?m)^\s*V\S{5}\s+hevc\s')
    }

    # 1) instalador oficial da Adobe; 2) se não der, ZXP assinado extraído na pasta do usuário
    #    (o Premiere aceita porque a assinatura vai junto, sem modo desenvolvedor). Depois o ffmpeg.
    function Install-Rhythm($here, $versao) {
        $zxp = Join-Path $here 'Rhythm.zxp'
        if (-not (Test-Path $zxp)) { throw 'Pacote Rhythm.zxp não encontrado dentro do instalador.' }
        $how = $null
        if (-not $env:AE_TEST_TARGET -and (Test-Path $upia)) {
            foreach ($n in $nomes) { Start-Process -FilePath $upia -ArgumentList @('/remove', "`"$n`"") -Wait -WindowStyle Hidden | Out-Null }
            # o UPIA sai com 0 mesmo falhando: confere pela mensagem e pela versão instalada
            $out = & $upia /install "$zxp" 2>&1 | Out-String
            if ($out -match 'Installation Successful' -or (Get-ManifestVersion (Join-Path $cepDir 'Rhythm')) -eq [version]$versao) {
                $how = 'pelo instalador oficial da Adobe'
                # uma cópia manual antiga na pasta do usuário teria o mesmo id e competiria com esta
                if (-not (Get-Item $userDir -Force -ErrorAction SilentlyContinue).LinkType) { Remove-UserDir | Out-Null }
            }
        }
        if (-not $how) {
            Remove-UserDir | Out-Null
            New-Item -ItemType Directory -Force $userDir | Out-Null
            $zip = Join-Path $env:TEMP "Rhythm-$([guid]::NewGuid()).zip"
            Copy-Item $zxp $zip
            Expand-Archive -Path $zip -DestinationPath $userDir -Force
            Remove-Item $zip -Force
            if (-not (Test-Path (Join-Path $userDir 'CSXS\manifest.xml'))) { throw 'A extração não gerou o manifest da extensão.' }
            $how = 'por cópia direta na pasta de extensões do usuário'
        }

        # ffmpeg da sincronização por imagem: pula se já houver um que decodifique H.264 e HEVC
        $ffNote = ''
        $ffSrc = Join-Path $here 'ffmpeg.exe'
        $existing = @((Join-Path $ffDir 'ffmpeg.exe')) + @(Get-Command ffmpeg -All -ErrorAction SilentlyContinue | ForEach-Object Source)
        $okFf = $existing | Where-Object { Test-Ffmpeg $_ } | Select-Object -First 1
        if (-not $okFf -and (Test-Path $ffSrc)) {
            try {
                New-Item -ItemType Directory -Force $ffDir | Out-Null
                Copy-Item $ffSrc (Join-Path $ffDir 'ffmpeg.exe') -Force
                $lic = Join-Path $here 'ffmpeg-LICENSE.txt'
                if (Test-Path $lic) { Copy-Item $lic (Join-Path $ffDir 'LICENSE.txt') -Force }
                $ffNote = "`nffmpeg instalado (sincronização por imagem)."
            } catch { $ffNote = "`nAviso: não deu para instalar o ffmpeg ($($_.Exception.Message)). A sincronização por imagem fica indisponível; o resto funciona." }
        }
        return "Instalado $how.$ffNote"
    }

    # Remove a extensão e o ffmpeg do Rhythm; as configurações da pessoa ficam (%APPDATA%\AutomacaoEdicao)
    function Uninstall-Rhythm {
        $removed = @()
        if (-not $env:AE_TEST_TARGET -and (Test-Path $upia)) {
            foreach ($n in $nomes) {
                $had = Test-Path -LiteralPath (Join-Path $cepDir $n)
                Start-Process -FilePath $upia -ArgumentList @('/remove', "`"$n`"") -Wait -WindowStyle Hidden | Out-Null
                if ($had -and (Test-Path -LiteralPath (Join-Path $cepDir $n))) { throw "O instalador da Adobe não conseguiu remover a pasta `"$n`"." }
                if ($had) { $removed += 'extensão' }
            }
        }
        if (Remove-UserDir) { $removed += 'extensão' }
        # só a pasta que o nosso instalador cria (um ffmpeg do usuário em outro lugar fica)
        $ffRoot = Split-Path $ffDir
        if (Test-Path $ffRoot) { Remove-Item -Recurse -Force $ffRoot; $removed += 'ffmpeg' }
        return @($removed | Select-Object -Unique)
    }
}
. $core

function Short($v) { $p = "$v".Split('.'); if ($p.Count -ge 3 -and $p[2] -eq '0') { "$($p[0]).$($p[1])" } else { "$v" } }
$vs = Short $versao

# ------------------------------------------------------------------ sem janela
if ($modo -eq 'silencioso') {
    if ((Get-Premiere).Count) { Write-Output 'Premiere aberto'; exit 2 }
    try {
        if ($desinstalar) { $r = Uninstall-Rhythm; Write-Output ("removido: " + ($r -join ', ')) }
        else { Write-Output (Install-Rhythm $here $versao) }
        exit 0
    } catch { Write-Output "erro: $($_.Exception.Message)"; exit 1 }
}

# ------------------------------------------------------------------ /aguardar
$premierePath = $null
if ($modo -eq 'aguardar') {
    # um só esperando por vez (clicar duas vezes em Atualizar não instala duas vezes)
    $mutex = New-Object Threading.Mutex($false, 'Local\RhythmAtualizacao')
    if (-not $mutex.WaitOne(0)) { exit 0 }
    $inst = Get-InstalledVersion
    if ($inst -and $inst -ge [version]$versao) { exit 0 }
    while (($p = Get-Premiere).Count) {
        foreach ($x in $p) { try { if ($x.Path) { $premierePath = $x.Path } } catch {} }
        Start-Sleep -Seconds 2
    }
    Start-Sleep -Seconds 3   # o Premiere solta os arquivos da extensão um pouco depois de sumir
}
if (-not $premierePath) {
    $premierePath = Get-ChildItem 'C:\Program Files\Adobe\Adobe Premiere Pro*\Adobe Premiere Pro.exe' -ErrorAction SilentlyContinue |
        Sort-Object { $_.VersionInfo.FileVersionRaw } -Descending | Select-Object -First 1 -ExpandProperty FullName
}

# ------------------------------------------------------------------ janela
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Rhythm" Width="460" SizeToContent="Height" ResizeMode="NoResize"
        WindowStartupLocation="CenterScreen" Background="#070010" FontFamily="Segoe UI">
  <Window.Resources>
    <Style x:Key="Base" TargetType="Button">
      <Setter Property="MinWidth" Value="104"/>
      <Setter Property="Height" Value="34"/>
      <Setter Property="Margin" Value="8,0,0,0"/>
      <Setter Property="Padding" Value="16,0"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="FontWeight" Value="Bold"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" CornerRadius="17" Background="{TemplateBinding Background}"
                    BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1.5" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.85"/></Trigger>
              <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="b" Property="BorderBrush" Value="#F5F2FA"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="Primario" TargetType="Button" BasedOn="{StaticResource Base}">
      <Setter Property="Background" Value="#8C4EDB"/><Setter Property="BorderBrush" Value="#8C4EDB"/><Setter Property="Foreground" Value="White"/>
    </Style>
    <Style x:Key="Secundario" TargetType="Button" BasedOn="{StaticResource Base}">
      <Setter Property="Background" Value="Transparent"/><Setter Property="BorderBrush" Value="#55FFFFFF"/><Setter Property="Foreground" Value="#F5F2FA"/>
    </Style>
    <Style x:Key="Perigo" TargetType="Button" BasedOn="{StaticResource Base}">
      <Setter Property="Background" Value="Transparent"/><Setter Property="BorderBrush" Value="#D2425A"/><Setter Property="Foreground" Value="#F08A9B"/>
    </Style>
  </Window.Resources>
  <Border Padding="28,24,28,24">
    <Border.Background>
      <RadialGradientBrush Center="0.3,0" GradientOrigin="0.3,0" RadiusX="1.2" RadiusY="0.9">
        <GradientStop Color="#2A1450" Offset="0"/><GradientStop Color="#120626" Offset="0.45"/><GradientStop Color="#070010" Offset="1"/>
      </RadialGradientBrush>
    </Border.Background>
    <StackPanel>
      <StackPanel Orientation="Horizontal" Margin="0,0,0,18">
        <Image x:Name="Logo" Width="24" Height="24" Margin="0,0,10,0"/>
        <TextBlock Text="RHYTHM" FontSize="17" FontWeight="Black" Foreground="#F5F2FA" VerticalAlignment="Center"/>
        <TextBlock x:Name="Ver" FontSize="12" Foreground="#857C9C" VerticalAlignment="Center" Margin="10,2,0,0"/>
      </StackPanel>
      <TextBlock x:Name="Msg" FontSize="15" FontWeight="SemiBold" Foreground="#F5F2FA" TextWrapping="Wrap"/>
      <TextBlock x:Name="Detail" FontSize="12" Foreground="#B9B1CC" TextWrapping="Wrap" Margin="0,8,0,0" LineHeight="18"/>
      <ProgressBar x:Name="Bar" Height="4" Margin="0,18,0,0" IsIndeterminate="True" Foreground="#8C4EDB" Background="#1E1236" BorderThickness="0" Visibility="Collapsed"/>
      <StackPanel x:Name="Buttons" Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,24,0,0"/>
    </StackPanel>
  </Border>
</Window>
'@
$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$ui = @{}
foreach ($n in 'Logo', 'Ver', 'Msg', 'Detail', 'Bar', 'Buttons') { $ui[$n] = $win.FindName($n) }
$ui.Ver.Text = "instalador $vs"
$ico = Join-Path $here 'rhythm.ico'
if (Test-Path $ico) {
    $img = New-Object Windows.Media.Imaging.BitmapImage (New-Object Uri $ico)
    $win.Icon = $img; $ui.Logo.Source = $img
}
$script:exitCode = 0

function Show-State($msg, $detail, $buttons, [switch]$Busy) {
    $ui.Msg.Text = $msg
    $ui.Detail.Text = "$detail"
    $ui.Detail.Visibility = if ($detail) { 'Visible' } else { 'Collapsed' }
    $ui.Bar.Visibility = if ($Busy) { 'Visible' } else { 'Collapsed' }
    $ui.Buttons.Children.Clear()
    $first = $null
    foreach ($b in $buttons) {
        $btn = New-Object Windows.Controls.Button
        $btn.Content = $b.Text
        $btn.Style = $win.FindResource($b.Kind)
        $btn.Add_Click($b.Action)
        [void]$ui.Buttons.Children.Add($btn)
        if ($b.Kind -eq 'Primario' -and -not $first) { $first = $btn }
    }
    if ($first) { [void]$first.Focus() }
}

$close = { $win.Close() }

# Com o Premiere aberto não instala nem remove: pede para fechar (nunca fecha sozinho)
function Invoke-WhenPremiereClosed($next) {
    $script:pending = $next
    if ((Get-Premiere).Count) {
        Show-State 'Feche o Premiere Pro para continuar.' 'Salve seu projeto antes. O instalador não fecha o Premiere sozinho.' @(
            @{ Text = 'Cancelar'; Kind = 'Secundario'; Action = $close },
            @{ Text = 'Tentar de novo'; Kind = 'Primario'; Action = { Invoke-WhenPremiereClosed $script:pending } })
        return
    }
    & $next
}

# Roda o trabalho num runspace e acompanha por um timer (a janela continua respondendo)
function Start-Work($label, $call, $onDone) {
    Show-State $label '' @() -Busy
    $ps = [powershell]::Create()
    # um script só: as funções do $core precisam estar no mesmo escopo da chamada
    [void]$ps.AddScript("`$ErrorActionPreference = 'Stop'`n" + $core.ToString() + "`n" + $call)
    $script:job = @{ ps = $ps; h = $ps.BeginInvoke(); done = $onDone }
    $t = New-Object Windows.Threading.DispatcherTimer
    $t.Interval = [TimeSpan]::FromMilliseconds(300)
    $t.Add_Tick({
        if (-not $script:job.h.IsCompleted) { return }
        $this.Stop()
        $res = $null; $err = $null
        try {
            $res = $script:job.ps.EndInvoke($script:job.h)
            if ($script:job.ps.Streams.Error.Count) { $err = $script:job.ps.Streams.Error[0].Exception.Message }
        } catch { $err = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message } }
        $script:job.ps.Dispose()
        & $script:job.done $res $err
    })
    $t.Start()
}

function Show-Error($titulo, $err) {
    $script:exitCode = 1
    $extra = if ($modo -eq 'aguardar') { "`n`nBaixe o instalador em github.com/audiovisualpecege/ChiraroRhythm/releases e instale à mão." } else { '' }
    Show-State $titulo ($err + $extra) @(@{ Text = 'Fechar'; Kind = 'Primario'; Action = $close })
}

function Do-Install {
    Start-Work "Instalando o Rhythm $vs…" "Install-Rhythm '$($here -replace "'", "''")' '$versao'" {
        param($res, $err)
        if ($err) { Show-Error 'Não foi possível instalar.' $err; return }
        $btns = @(@{ Text = 'Concluir'; Kind = $(if ($premierePath) { 'Secundario' } else { 'Primario' }); Action = $close })
        if ($premierePath) {
            $btns += @{ Text = 'Abrir o Premiere'; Kind = 'Primario'; Action = { Start-Process -FilePath $premierePath; $win.Close() } }
        }
        Show-State "Rhythm $vs instalado." ("$($res -join '')`n`nNo Premiere Pro: Janela › Extensões › Rhythm.") $btns
    }
}

function Do-Uninstall {
    Start-Work 'Removendo o Rhythm…' 'Uninstall-Rhythm' {
        param($res, $err)
        if ($err) { Show-Error 'Não foi possível desinstalar.' $err; return }
        $msg = if (@($res).Count) { 'Rhythm removido.' } else { 'O Rhythm não estava instalado neste computador.' }
        Show-State $msg 'Suas configurações ficaram guardadas: se instalar de novo, elas voltam.' @(@{ Text = 'Concluir'; Kind = 'Primario'; Action = $close })
    }
}

function Show-Main {
    $inst = Get-InstalledVersion
    $install = { Invoke-WhenPremiereClosed { Do-Install } }
    $remove = { Invoke-WhenPremiereClosed { Do-Uninstall } }
    if (-not $inst) {
        Show-State "Instalar o Rhythm ${vs}?" 'Painel para o Premiere Pro: Silêncios, Zoom, Intercalado e Sincronizar.' @(
            @{ Text = 'Cancelar'; Kind = 'Secundario'; Action = $close },
            @{ Text = 'Instalar'; Kind = 'Primario'; Action = $install })
        return
    }
    $is = Short "$inst"
    $cmp = $inst.CompareTo([version]$versao)
    $titulo, $acao = switch ([math]::Sign($cmp)) {
        -1 { "Atualizar o Rhythm para ${vs}?", 'Atualizar' }
        0 { "O Rhythm $vs já está instalado.", 'Reinstalar' }
        1 { "Este computador tem uma versão mais nova ($is).", "Instalar a $vs" }
    }
    Show-State $titulo "Instalada: $is  ·  este instalador: $vs" @(
        @{ Text = 'Desinstalar'; Kind = 'Perigo'; Action = $remove },
        @{ Text = 'Cancelar'; Kind = 'Secundario'; Action = $close },
        @{ Text = $acao; Kind = 'Primario'; Action = $install })
}

if ($modo -eq 'aguardar') {
    $win.Add_ContentRendered({ $win.Topmost = $true; $win.Activate(); $win.Topmost = $false; Do-Install })
} elseif ($desinstalar) {
    $win.Add_ContentRendered({ Invoke-WhenPremiereClosed { Do-Uninstall } })
} else {
    Show-Main
}
# Testes: AE_TEST_SNAPSHOT=prefixo salva a janela em PNG; AE_TEST_CLICK="Botão|Botão" clica antes de cada foto
if ($env:AE_TEST_SNAPSHOT) {
    $script:shots = @(@('') + @("$env:AE_TEST_CLICK".Split('|') | Where-Object { $_ }))
    $script:shot = 0
    $st = New-Object Windows.Threading.DispatcherTimer
    $st.Interval = [TimeSpan]::FromMilliseconds(1500)
    $st.Add_Tick({
        $rtb = New-Object Windows.Media.Imaging.RenderTargetBitmap ([int]$win.ActualWidth), ([int]$win.ActualHeight), 96, 96, ([Windows.Media.PixelFormats]::Pbgra32)
        $rtb.Render($win.Content)
        $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder
        $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($rtb))
        $fs = [IO.File]::Create("$env:AE_TEST_SNAPSHOT$($script:shot).png"); $enc.Save($fs); $fs.Close()
        $script:shot++
        if ($script:shot -ge $script:shots.Count) { $this.Stop(); $win.Close(); return }
        $b = $ui.Buttons.Children | Where-Object { $_.Content -eq $script:shots[$script:shot] } | Select-Object -First 1
        if ($b) { $b.RaiseEvent((New-Object Windows.RoutedEventArgs ([Windows.Controls.Button]::ClickEvent))) }
    })
    $st.Start()
}
[void]$win.ShowDialog()
exit $script:exitCode
