# Regenerates the app and extension icons.
# Run from the repository root:  powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
# Only needed when the artwork changes; the PNGs are committed.

Add-Type -AssemblyName System.Drawing

function New-MangaTRIcon {
  param(
    [Parameter(Mandatory = $true)][int]$Size,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  $graphics.Clear([System.Drawing.Color]::Transparent)

  $corner = [single]($Size * 0.22)
  $bounds = New-Object System.Drawing.RectangleF(0, 0, $Size, $Size)
  $pathShape = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = [single]($corner * 2)

  $pathShape.AddArc(0, 0, $diameter, $diameter, 180, 90)
  $pathShape.AddArc($Size - $diameter, 0, $diameter, $diameter, 270, 90)
  $pathShape.AddArc($Size - $diameter, $Size - $diameter, $diameter, $diameter, 0, 90)
  $pathShape.AddArc(0, $Size - $diameter, $diameter, $diameter, 90, 90)
  $pathShape.CloseFigure()

  $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $bounds,
    [System.Drawing.Color]::FromArgb(255, 255, 77, 109),
    [System.Drawing.Color]::FromArgb(255, 255, 138, 91),
    [single]35
  )

  $graphics.FillPath($gradient, $pathShape)

  # Ink-brush underline, the nod to lettering on a page.
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 255, 255, 255))
  $thickness = [single]($Size * 0.045)
  $underlineY = [single]($Size * 0.74)
  $underline = New-Object System.Drawing.RectangleF(
    [single]($Size * 0.28), $underlineY, [single]($Size * 0.44), $thickness)
  $graphics.FillRectangle($brush, $underline)

  $fontSize = [single]($Size * 0.42)
  $font = New-Object System.Drawing.Font("Arial", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center

  $textBounds = New-Object System.Drawing.RectangleF(0, [single]($Size * 0.04), $Size, [single]($Size * 0.68))
  $graphics.DrawString("TR", $font, $brush, $textBounds, $format)

  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }

  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)

  $format.Dispose()
  $font.Dispose()
  $brush.Dispose()
  $gradient.Dispose()
  $pathShape.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()

  Write-Host "wrote $Path ($Size x $Size)"
}

$root = Split-Path -Parent $PSScriptRoot

New-MangaTRIcon -Size 1024 -Path (Join-Path $root "App\Assets.xcassets\AppIcon.appiconset\icon-1024.png")
New-MangaTRIcon -Size 128 -Path (Join-Path $root "Extension\Resources\icon-128.png")
New-MangaTRIcon -Size 96 -Path (Join-Path $root "Extension\Resources\icon-96.png")
New-MangaTRIcon -Size 48 -Path (Join-Path $root "Extension\Resources\icon-48.png")