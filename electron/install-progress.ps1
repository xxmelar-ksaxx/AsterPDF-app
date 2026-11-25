Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
[xml]$layout = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Title="AsterPDF" Width="392" Height="172" WindowStyle="None" ResizeMode="NoResize" WindowStartupLocation="CenterScreen" AllowsTransparency="True" Background="Transparent" Topmost="True" FontFamily="Segoe UI">
  <Border Name="Card" Margin="10" CornerRadius="18" Background="#FBFCF9" Padding="26,20">
    <Border.Effect><DropShadowEffect BlurRadius="15" ShadowDepth="2" Opacity="0.18" Color="#20352B"/></Border.Effect>
    <Grid>
      <Grid.RowDefinitions><RowDefinition Height="42"/><RowDefinition Height="*"/><RowDefinition Height="6"/></Grid.RowDefinitions>
      <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
        <Image Name="Logo" Width="42" Height="42" RenderOptions.BitmapScalingMode="HighQuality"/>
        <TextBlock VerticalAlignment="Center" Margin="10,0,0,0" FontSize="24" FontWeight="SemiBold" Foreground="#192D28"><Run>Aster</Run><Run Foreground="#739426">PDF</Run></TextBlock>
      </StackPanel>
      <TextBlock Name="Status" Grid.Row="1" VerticalAlignment="Center" FontSize="14" Foreground="#475B50" TextTrimming="CharacterEllipsis"/>
      <Border Grid.Row="2" CornerRadius="3" Background="#E3EBD9">
        <Border Name="Pulse" HorizontalAlignment="Left" Width="92" CornerRadius="3" Background="#A6CC42">
          <Border.RenderTransform><TranslateTransform/></Border.RenderTransform>
        </Border>
      </Border>
    </Grid>
  </Border>
</Window>
"@
$window = [Windows.Markup.XamlReader]::Load([Xml.XmlNodeReader]::new($layout))
$logo = [Windows.Media.Imaging.BitmapImage]::new()
$logo.BeginInit()
$logo.CacheOption = 'OnLoad'
$logo.DecodePixelWidth = 100
$logo.UriSource = [Uri]::new($env:ASTER_INSTALL_LOGO)
$logo.EndInit()
$window.FindName('Logo').Source = $logo
$status = $window.FindName('Status')
$status.Text = $env:ASTER_INSTALL_TEXT
if ($env:ASTER_INSTALL_RTL -eq '1') { $status.FlowDirection = 'RightToLeft' }
$pulse = $window.FindName('Pulse')
$window.Add_ContentRendered({
  if ([Windows.SystemParameters]::ClientAreaAnimation) {
    $motion = [Windows.Media.Animation.DoubleAnimation]::new(0, ($pulse.Parent.ActualWidth - $pulse.Width), [Windows.Duration]::new([TimeSpan]::FromSeconds(1.6)))
    $motion.AutoReverse = $true
    $motion.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::Forever
    $motion.EasingFunction = [Windows.Media.Animation.SineEase]::new()
    $motion.EasingFunction.EasingMode = 'EaseInOut'
    $pulse.RenderTransform.BeginAnimation([Windows.Media.TranslateTransform]::XProperty, $motion)
  }
  [IO.File]::WriteAllText($env:ASTER_INSTALL_READY, "$($env:ASTER_INSTALL_TOKEN):$PID")
})
$timer = [Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromMilliseconds(400)
$deadline = [DateTime]::UtcNow.AddMinutes(5)
$timer.Add_Tick({
  try { $token = [IO.File]::ReadAllText($env:ASTER_INSTALL_MARKER) } catch { $token = $null }
  if ($token -ne $env:ASTER_INSTALL_TOKEN) { $timer.Stop(); $window.Close(); return }
  if ([DateTime]::UtcNow -gt $deadline) {
    $status.Text = $env:ASTER_INSTALL_WAIT
    $window.Topmost = $false
  }
})
$timer.Start()
[void]$window.ShowDialog()
