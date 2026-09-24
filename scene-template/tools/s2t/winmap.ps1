# tools/s2t/winmap.ps1
# 用 Windows 的 LCMapString(LCMAP_TRADITIONAL_CHINESE) 为"目标文件里出现的每个汉字"
# 生成 简→繁 字表(tools/s2t/winmap.json)。它是字级全量的兜底，用来补齐
# zhtw-traditional-chinese bundle 里那张不全的字表(缺 数/触/达/点/题/线/评/价 …)。
#
# 用法:
#   pwsh tools/s2t/winmap.ps1 -Files lib/client.js   # 在 bundle 根目录下跑
# 注意: 必须在"还是简体"的时候跑 —— 生成的是简→繁映射。

param(
  [Parameter(Mandatory = $true)][string[]]$Files,
  [string]$Out = "tools/s2t/winmap.json"
)

$ErrorActionPreference = 'Stop'

$code = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class S2TWin {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern int LCMapStringW(int Locale, uint dwMapFlags, string lpSrcStr, int cchSrc, StringBuilder lpDestStr, int cchDest);
  const uint LCMAP_TRADITIONAL_CHINESE = 0x04000000;
  public static string Conv(string s) {
    var sb = new StringBuilder(s.Length * 4 + 8);
    int n = LCMapStringW(0x0804, LCMAP_TRADITIONAL_CHINESE, s, s.Length, sb, sb.Capacity);
    if (n == 0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return sb.ToString(0, n);
  }
}
'@
Add-Type -TypeDefinition $code

$text = ($Files | ForEach-Object { Get-Content -Raw -Encoding UTF8 $_ }) -join "`n"

$chars = [System.Collections.Generic.HashSet[string]]::new()
foreach ($ch in $text.ToCharArray()) {
  $cp = [int][char]$ch
  if (($cp -ge 0x3400 -and $cp -le 0x9FFF) -or ($cp -ge 0xF900 -and $cp -le 0xFAFF)) {
    [void]$chars.Add([string]$ch)
  }
}

$map = [ordered]@{}
foreach ($c in ($chars | Sort-Object)) {
  $t = [S2TWin]::Conv($c)
  if ($t -ne $c) { $map[$c] = $t }
}

$json = $map | ConvertTo-Json -Compress
# 不带 BOM 的 UTF-8 (Windows PowerShell 5.1 的 Set-Content -Encoding UTF8 会加 BOM，Node 端 JSON.parse 会炸)
[System.IO.File]::WriteAllText((Resolve-Path -LiteralPath (Split-Path -Parent $Out)).Path + '\' + (Split-Path -Leaf $Out), $json, (New-Object System.Text.UTF8Encoding($false)))
"scanned chars = $($chars.Count); mapped (S!=T) = $($map.Count) -> $Out"
