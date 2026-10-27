'use strict';

/**
 * 有线手机接入（Windows WPD）。
 *
 * 手机在 Windows 上以「可移植设备」出现，没有盘符，Node 的 fs 无法直接读取，
 * 因此这里通过 PowerShell 的 Shell.Application COM 接口：
 *   1. 枚举手机 DCIM 目录下的照片 / 视频，并把同主名的图片 + 视频合并为一个「实况」条目；
 *   2. 把用户选中的文件通过 Shell 的 CopyHere 复制到调用方给定的暂存目录
 *      （现为照片库根内的 .photo-repo/phone-incoming，与目标存储同卷，
 *       入库时直接改名就位，不产生第二份数据，也不占用系统盘）。
 * 复制过程完全静默：不弹系统「正在复制…」对话框，进度由 Write-CopyProgress 回报。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// 供两个脚本共用的 DCIM 定位逻辑
const PS_HELPERS = String.raw`
function Find-Dcim {
  $shell = New-Object -ComObject Shell.Application
  $pc = $shell.NameSpace(17)
  foreach ($item in $pc.Items()) {
    if (-not $item.IsFolder) { continue }
    if ($item.Path -match '^[A-Za-z]:') { continue }
    if ($item.Path.StartsWith('\\')) { continue }
    $root = $null
    try { $root = $item.GetFolder() } catch {}
    if (-not $root) { continue }
    $dcim = $null
    foreach ($child in $root.Items()) {
      if ($child.Name -ieq 'DCIM') { $dcim = $child; break }
    }
    if (-not $dcim) {
      foreach ($child in $root.Items()) {
        if (-not $child.IsFolder) { continue }
        $sub = $null
        try { $sub = $child.GetFolder() } catch {}
        if (-not $sub) { continue }
        foreach ($f in $sub.Items()) {
          if ($f.IsFolder -and ($f.Name -ieq 'DCIM')) { $dcim = $f; break }
        }
        if ($dcim) { break }
      }
    }
    if ($dcim) { return @{ shell = $shell; device = $item; dcim = $dcim } }
  }
  return $null
}
`;

// 只判断是否已连接手机（不做媒体枚举，用于快速给出检测状态）
const PS_DETECT = 'param([string]$Out)\n' + PS_HELPERS + String.raw`
$result = @{ found = $false; name = ''; error = '' }
try {
  $found = Find-Dcim
  if ($found) {
    $result.found = $true
    $result.name = $found.device.Name
  }
} catch {
  $result.error = $_.Exception.Message
}
$json = $result | ConvertTo-Json -Depth 4 -Compress
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
`;

// 列出手机相册中的媒体（按图片 + 同主名视频合并为实况）
const PS_LIST = 'param([string]$Out)\n' + PS_HELPERS + String.raw`
$ErrorActionPreference = 'Stop'
$result = @{ found = $false; name = ''; error = 'NO_DEVICE'; groups = @() }
try {
  $found = Find-Dcim
  if ($found) {
    $result.found = $true
    $result.name = $found.device.Name
    $result.error = ''
    $dcim = $found.dcim
    $imgExt = @('.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.dng')
    $vidExt = @('.mov', '.mp4', '.m4v', '.3gp', '.avi', '.mkv', '.wmv', '.webm')
    $map = @{}
    $folder = $dcim.GetFolder()
    if ($folder) {
      foreach ($child in $folder.Items()) {
        $dirName = ''
        $target = $folder
        if ($child.IsFolder) {
          $dirName = $child.Name
          $target = $null
          try { $target = $child.GetFolder() } catch {}
          if (-not $target) { continue }
        }
        foreach ($f in $target.Items()) {
          if ($f.IsFolder) { continue }
          $ext = [System.IO.Path]::GetExtension($f.Name).ToLower()
          $isImg = $imgExt -contains $ext
          $isVid = $vidExt -contains $ext
          if (-not ($isImg -or $isVid)) { continue }
          $stem = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
          $key = if ($dirName) { "$dirName/$stem" } else { $stem }
          if (-not $map.ContainsKey($key)) {
            $map[$key] = [pscustomobject]@{ key = $key; image = $null; video = $null }
          }
          $size = 0
          try { if ($f.Size) { $size = [int64]$f.Size } } catch {}
          $entry = [pscustomobject]@{
            rel = $(if ($dirName) { "$dirName/$($f.Name)" } else { $f.Name });
            name = $f.Name;
            size = $size
          }
          if ($isImg) { $map[$key].image = $entry } else { $map[$key].video = $entry }
        }
      }
    }
    $groups = @()
    foreach ($k in $map.Keys) {
      $g = $map[$k]
      $files = @()
      $entries = @()
      $label = ''
      $size = 0
      $kind = ''
      if ($g.image -and $g.video) {
        $kind = 'live'
        $label = $g.image.name
        $files = @($g.image.rel, $g.video.rel)
        $entries = @(
          [pscustomobject]@{ name = $g.image.name; size = $g.image.size },
          [pscustomobject]@{ name = $g.video.name; size = $g.video.size }
        )
        $size = $g.image.size + $g.video.size
      } elseif ($g.image) {
        $kind = 'image'
        $label = $g.image.name
        $files = @($g.image.rel)
        $entries = @([pscustomobject]@{ name = $g.image.name; size = $g.image.size })
        $size = $g.image.size
      } else {
        $kind = 'video'
        $label = $g.video.name
        $files = @($g.video.rel)
        $entries = @([pscustomobject]@{ name = $g.video.name; size = $g.video.size })
        $size = $g.video.size
      }
      $groups += [pscustomobject]@{ id = $k; kind = $kind; label = $label; size = $size; files = $files; entries = $entries }
    }
    $result.groups = @($groups | Sort-Object label)
  }
} catch {
  $result.error = $_.Exception.Message
}
$json = $result | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
`;

// 把选中的文件从手机复制到暂存目录
const PS_COPY = 'param([string]$Out, [string]$Dest, [string]$Plan, [string]$Progress, [string]$Cancel)\n' + PS_HELPERS + String.raw`
$ErrorActionPreference = 'Stop'
$result = @{ ok = $false; copied = @(); failed = @(); error = ''; cancelled = $false }

# 复制进度：每完成一个文件（或等待落地期间按字节）增量写 JSON 到 $Progress，Node 侧轮询转发给前端
$progTotal = 0
$progDone = 0
$progItems = 0
$progItemDone = 0
$progFile = ''
$progLast = [DateTime]::MinValue
function Write-CopyProgress([int64]$fileDone, [int64]$fileTotal, [bool]$force) {
  if (-not $Progress) { return }
  $now = Get-Date
  if (-not $force -and ($now - $progLast).TotalMilliseconds -lt 250) { return }
  $script:progLast = $now
  $obj = [pscustomobject]@{ phase = 'copy'; done = $progDone; total = $progTotal; itemDone = $progItemDone; itemTotal = $progItems; current = $progFile; fileDone = $fileDone; fileTotal = $fileTotal }
  try {
    $json = $obj | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($Progress, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch {}
}

# 等待异步复制落地：文件出现后按体积判断完成；长时间无增长视为结束，避免无限等待
function Wait-Copy([string]$Target, [int64]$Expected, [string]$Cancel = '') {
  $start = Get-Date
  $lastLen = [int64]-1
  $lastChange = $start
  $started = $false
  while ($true) {
    [System.Windows.Forms.Application]::DoEvents()
    # 允许取消在单个文件等待期间生效：用户点取消后不再等这个文件落地
    if ($Cancel -and (Test-Path -LiteralPath $Cancel)) { return 'CANCELLED' }
    $has = Test-Path -LiteralPath $Target
    $len = [int64]0
    if ($has) {
      try { $len = [int64](Get-Item -LiteralPath $Target).Length } catch { $has = $false }
    }
    $now = Get-Date
    if ($has) {
      $started = $true
      Write-CopyProgress $len $Expected $false
      if ($Expected -gt 0 -and $len -ge $Expected) { return 'OK' }
      if ($Expected -le 0 -and $len -gt 0) { return 'OK' }
      if ($len -ne $lastLen) { $lastLen = $len; $lastChange = $now }
    }
    if ($started) {
      $idle = if ($lastLen -gt 0) { 15 } else { 45 }
      if (($now - $lastChange).TotalSeconds -ge $idle) {
        if ($Expected -gt 0) { if ($len -ge $Expected) { return 'OK' } else { return 'PARTIAL' } }
        if ($len -gt 0) { return 'OK' }
        return 'NONE'
      }
    } elseif (($now - $start).TotalSeconds -ge 20) {
      return 'NONE'
    }
    if (($now - $start).TotalSeconds -ge 120) { return 'TIMEOUT' }
    Start-Sleep -Milliseconds 120
  }
}

try {
  # 复制全程泵消息循环：WPD/MTP 的传输是异步的，不泵消息就不会落地
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class PhoneCopy
{
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem
  {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(int sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperation
  {
    [PreserveSig] int Advise([MarshalAs(UnmanagedType.Interface)] object pfops, out uint pdwCookie);
    [PreserveSig] int Unadvise(uint dwCookie);
    [PreserveSig] int SetOperationFlags(uint dwOperationFlags);
    [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string pszMessage);
    [PreserveSig] int SetProgressDialog(IntPtr popd);
    [PreserveSig] int SetProperties([MarshalAs(UnmanagedType.Interface)] object pproparray);
    [PreserveSig] int SetOwnerWindow(IntPtr hwndOwner);
    [PreserveSig] int ApplyPropertiesToItem(IShellItem psiItem);
    [PreserveSig] int ApplyPropertiesToItems([MarshalAs(UnmanagedType.Interface)] object punkItems);
    [PreserveSig] int RenameItem(IShellItem psiItem, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, [MarshalAs(UnmanagedType.Interface)] object pfopsItem);
    [PreserveSig] int RenameItems([MarshalAs(UnmanagedType.Interface)] object pUnkItems, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
    [PreserveSig] int MoveItem(IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, [MarshalAs(UnmanagedType.Interface)] object pfopsItem);
    [PreserveSig] int MoveItems([MarshalAs(UnmanagedType.Interface)] object punkItems, IShellItem psiDestinationFolder);
    [PreserveSig] int CopyItem(IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszCopyName, [MarshalAs(UnmanagedType.Interface)] object pfopsItem);
    [PreserveSig] int CopyItems([MarshalAs(UnmanagedType.Interface)] object punkItems, IShellItem psiDestinationFolder);
    [PreserveSig] int DeleteItem(IShellItem psiItem, [MarshalAs(UnmanagedType.Interface)] object pfopsItem);
    [PreserveSig] int DeleteItems([MarshalAs(UnmanagedType.Interface)] object punkItems);
    [PreserveSig] int NewItem(IShellItem psiDestinationFolder, uint dwFileAttributes, [MarshalAs(UnmanagedType.LPWStr)] string pszName, [MarshalAs(UnmanagedType.LPWStr)] string pszTemplateName, [MarshalAs(UnmanagedType.Interface)] object pfopsItem);
    [PreserveSig] int PerformOperations();
    [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool pfAnyOperationsAborted);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);

  [DllImport("shell32.dll")]
  static extern int SHGetIDListFromObject([MarshalAs(UnmanagedType.IUnknown)] object punk, out IntPtr ppidl);

  [DllImport("shell32.dll")]
  static extern int SHCreateItemFromIDList(IntPtr pidl, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);

  [DllImport("shell32.dll")]
  static extern void ILFree(IntPtr pidl);

  static IShellItem ToItem(object folderItem)
  {
    if (folderItem == null) return null;
    IntPtr pidl = IntPtr.Zero;
    try
    {
      object obj;
      Guid iid = typeof(IShellItem).GUID;
      if (SHGetIDListFromObject(folderItem, out pidl) == 0 && pidl != IntPtr.Zero
          && SHCreateItemFromIDList(pidl, ref iid, out obj) == 0)
      {
        IShellItem si = obj as IShellItem;
        if (si != null) return si;
      }
    }
    catch { }
    finally { if (pidl != IntPtr.Zero) ILFree(pidl); }
    try { return folderItem as IShellItem; } catch { return null; }
  }

  // Shell's modern copy engine (IFileOperation), used as a fallback for CopyHere
  public static bool Copy(object folderItem, string destDir, string destName)
  {
    try
    {
      IShellItem src = ToItem(folderItem);
      if (src == null) return false;
      object destObj;
      Guid diid = typeof(IShellItem).GUID;
      if (SHCreateItemFromParsingName(destDir, IntPtr.Zero, ref diid, out destObj) != 0) return false;
      IShellItem dest = destObj as IShellItem;
      if (dest == null) return false;

      Type t = Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09"));
      IFileOperation op = (IFileOperation)Activator.CreateInstance(t);
      // FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOCONFIRMMKDIR | FOF_NOERRORUI
      op.SetOperationFlags(0x4 | 0x10 | 0x200 | 0x400);
      if (op.CopyItem(src, dest, destName, null) != 0) return false;
      if (op.PerformOperations() != 0) return false;
      bool aborted = false;
      op.GetAnyOperationsAborted(out aborted);
      return !aborted;
    }
    catch { return false; }
  }
}
"@
  $mediaPlan = Get-Content -Raw -Path $Plan -Encoding UTF8 | ConvertFrom-Json
  if ($mediaPlan -isnot [array]) { $mediaPlan = @($mediaPlan) }
  # 计划按「条目」分组：实况照片的图片 + 视频同属一组，取消只在条目边界生效
  $groups = @()
  foreach ($g in $mediaPlan) {
    if ($g -is [array]) { $groups += ,@($g | ForEach-Object { [string]$_ }) }
    else { $groups += ,@([string]$g) }
  }
  $progTotal = 0
  foreach ($g in $groups) { $progTotal += $g.Count }
  $progItems = $groups.Count
  Write-CopyProgress 0 0 $true
  $found = Find-Dcim
  if (-not $found) {
    $result.error = 'NO_DEVICE'
  } else {
    $shell = $found.shell
    $dcim = $found.dcim
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    # 枚举设备文件建索引；定位单个文件时依次尝试：枚举精确匹配 → ParseName → 按文件名扫描
    $items = @{}
    $folder = $null
    try { $folder = $dcim.GetFolder() } catch {}
    if ($folder) {
      foreach ($child in $folder.Items()) {
        if ($child.IsFolder) {
          $dirName = $child.Name
          $sub = $null
          try { $sub = $child.GetFolder() } catch {}
          if (-not $sub) { continue }
          foreach ($f in $sub.Items()) {
            if ($f.IsFolder) { continue }
            $key = "$dirName/$($f.Name)"
            $items[$key] = $f
          }
        } else {
          $items[$child.Name] = $child
        }
      }
    }
    function Resolve-PhoneItem([string]$rel) {
      if ($items.ContainsKey($rel)) { return $items[$rel] }
      # 兜底1：ParseName（部分 WPD 设备只支持这种定位）
      $parts = @($rel -split '/')
      try {
        if ($parts.Count -gt 1) {
          $sub = $folder.ParseName($parts[0])
          if ($sub -and $sub.IsFolder) {
            $sf = $null; try { $sf = $sub.GetFolder() } catch {}
            if ($sf) { $parsed = $sf.ParseName($parts[1]); if ($parsed) { return $parsed } }
          }
        } else {
          $parsed = $folder.ParseName($parts[0])
          if ($parsed) { return $parsed }
        }
      } catch {}
      # 兜底2：按文件名扫描所有已枚举条目
      $baseName = [System.IO.Path]::GetFileName($rel)
      foreach ($k in $items.Keys) {
        if ([System.IO.Path]::GetFileName($k) -ieq $baseName) { return $items[$k] }
      }
      return $null
    }

    foreach ($group in $groups) {
      # 取消只在「条目」边界生效：已开始的条目继续复制完，未开始的条目立即截止
      if ($Cancel -and (Test-Path -LiteralPath $Cancel)) { $result.cancelled = $true; break }
      $groupOk = $true
      foreach ($rawRel in $group) {
        $rel = [string]$rawRel
        if (-not $rel) { continue }
        $parts = @($rel -split '/')
        $fileName = $parts[$parts.Count - 1]
        $progFile = $fileName
        $dirRel = if ($parts.Count -gt 1) { $parts[0] } else { '' }
        $destDir = if ($dirRel) { Join-Path $Dest $dirRel } else { $Dest }
        New-Item -ItemType Directory -Force -Path $destDir | Out-Null
        $target = Join-Path $destDir $fileName

        $item = Resolve-PhoneItem $rel
        if (-not $item) {
          $groupOk = $false
          $result.failed += [pscustomobject]@{ rel = $rel; error = 'NOT_FOUND' }
          $progDone += 1
          Write-CopyProgress 0 0 $true
          if ($result.copied.Count -eq 0 -and $result.failed.Count -ge 3) { $result.error = 'COPY_BLOCKED'; break }
          continue
        }

        $expected = [int64]0
        try { if ($item.Size) { $expected = [int64]$item.Size } } catch {}
        Write-CopyProgress 0 $expected $true
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue }

        # 策略一（首选）：IFileOperation.PerformOperations
        # 真遵守 FOF_NOERRORUI：WPD 设备错误不会弹系统对话框阻塞，而是同步返回错误码
        try { [PhoneCopy]::Copy($item, $destDir, $fileName) | Out-Null } catch {}
        $state = Wait-Copy $target $Expected $Cancel

        # 策略二（兜底）：Shell 命名空间 CopyHere
        # CopyHere 是异步的，理论上静默，但 WPD 设备遇到 COM 错误时 Shell.Application 偶尔会
        # 绕过 FOF_NOERRORUI 弹出系统级错误对话框，阻塞 PowerShell 进程直到用户手动关闭。
        # 因此只在 IFileOperation 失败时作为最后手段。
        if ($state -eq 'NONE' -or $state -eq 'TIMEOUT') {
          try { if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue } } catch {}
          try {
            $destNS = $shell.NameSpace($destDir)
            if ($destNS) { $destNS.CopyHere($item, 1556) }
          } catch {}
          $state = Wait-Copy $target $Expected $Cancel
        }

        # 取消检测：用户点了取消，不等当前条目了，跳到下一组边界处理
        if ($state -eq 'CANCELLED') { $result.cancelled = $true; break }

        $done = ($state -eq 'OK')
        if (-not $done -and (Test-Path -LiteralPath $target)) {
          # 设备端可能改写了文件名：按主文件名找回刚复制好的文件
          try {
            $stem = [System.IO.Path]::GetFileNameWithoutExtension($fileName)
            $cand = Get-ChildItem -LiteralPath $destDir -File -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -ne $fileName -and $_.BaseName.StartsWith($stem) } |
              Select-Object -First 1
            if ($cand -and ($expected -le 0 -or $cand.Length -ge $expected)) {
              Move-Item -LiteralPath $cand.FullName -Destination $target -Force
              $done = $true
            }
          } catch {}
        }

        if ($done) {
          $result.copied += $rel
        } else {
          $groupOk = $false
          try { if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue } } catch {}
          $err = if ($state -eq 'PARTIAL') { 'COPY_INCOMPLETE' } else { 'COPY_TIMEOUT' }
          $result.failed += [pscustomobject]@{ rel = $rel; error = $err }
          # 一个都复制不出来时直接中止，避免逐个等待拖到超时
          if ($result.copied.Count -eq 0 -and $result.failed.Count -ge 3) {
            $result.error = 'COPY_BLOCKED'
            break
          }
        }
        $progDone += 1
        Write-CopyProgress 0 0 $true
      }
      if ($groupOk) { $progItemDone += 1 }
      Write-CopyProgress 0 0 $true
      if ($result.error -eq 'COPY_BLOCKED') { break }
    }
    $result.ok = ($result.failed.Count -eq 0)
  }
} catch {
  $result.error = $_.Exception.Message
}
$json = $result | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
`;

// 生成手机媒体封面：走 Windows Shell 缩略图接口，失败时由前端显示类型封面占位
const PS_THUMB = 'param([string]$Out, [string]$Dest, [string]$Plan, [int]$Size, [int]$Budget)\n' + PS_HELPERS + String.raw`
$ErrorActionPreference = 'Stop'
$result = @{ ok = $false; written = @(); failed = @(); error = '' }
try {
  Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class PhoneThumb
{
  [StructLayout(LayoutKind.Sequential)]
  public struct SIZE { public int cx; public int cy; public SIZE(int w, int h) { cx = w; cy = h; } }

  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItemImageFactory
  {
    void GetImage(SIZE size, int flags, out IntPtr phbm);
  }

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem
  {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(int sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);

  [DllImport("shell32.dll")]
  static extern int SHGetIDListFromObject([MarshalAs(UnmanagedType.IUnknown)] object punk, out IntPtr ppidl);

  [DllImport("shell32.dll")]
  static extern int SHCreateItemFromIDList(IntPtr pidl, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);

  [DllImport("shell32.dll")]
  static extern void ILFree(IntPtr pidl);

  [DllImport("gdi32.dll")]
  static extern bool DeleteObject(IntPtr hObject);

  const int SIIGBF_BIGGEROK = 0x1;
  const int SIIGBF_THUMBNAILONLY = 0x8;

  static void AddFactory(System.Collections.Generic.List<IShellItemImageFactory> list, object src)
  {
    if (src == null) return;
    try { IShellItemImageFactory f = src as IShellItemImageFactory; if (f != null) { list.Add(f); return; } } catch { }
    try { IShellItem si = src as IShellItem; if (si != null) { IShellItemImageFactory f2 = si as IShellItemImageFactory; if (f2 != null) list.Add(f2); } } catch { }
  }

  // WPD folder items do not implement IShellItemImageFactory, so try several routes
  public static bool Save(object folderItem, string parsingName, string outPath, int size)
  {
    var list = new System.Collections.Generic.List<IShellItemImageFactory>();
    AddFactory(list, folderItem);
    if (folderItem != null)
    {
      IntPtr pidl = IntPtr.Zero;
      try
      {
        if (SHGetIDListFromObject(folderItem, out pidl) == 0 && pidl != IntPtr.Zero)
        {
          object obj;
          Guid iid = typeof(IShellItemImageFactory).GUID;
          if (SHCreateItemFromIDList(pidl, ref iid, out obj) == 0) AddFactory(list, obj);
        }
      }
      catch { }
      finally { if (pidl != IntPtr.Zero) ILFree(pidl); }
    }
    if (!String.IsNullOrEmpty(parsingName))
    {
      try
      {
        object obj;
        Guid iid = typeof(IShellItemImageFactory).GUID;
        if (SHCreateItemFromParsingName(parsingName, IntPtr.Zero, ref iid, out obj) == 0) AddFactory(list, obj);
      }
      catch { }
    }
    foreach (IShellItemImageFactory factory in list)
    {
      if (Write(factory, outPath, size, SIIGBF_THUMBNAILONLY | SIIGBF_BIGGEROK)) return true;
      if (Write(factory, outPath, size, SIIGBF_BIGGEROK)) return true;
    }
    try { if (System.IO.File.Exists(outPath)) System.IO.File.Delete(outPath); } catch { }
    return false;
  }

  static bool Write(IShellItemImageFactory factory, string outPath, int size, int flags)
  {
    IntPtr hbm = IntPtr.Zero;
    try
    {
      factory.GetImage(new SIZE(size, size), flags, out hbm);
      if (hbm == IntPtr.Zero) return false;
      using (Bitmap bmp = Bitmap.FromHbitmap(hbm)) { bmp.Save(outPath, ImageFormat.Jpeg); }
      return true;
    }
    catch { return false; }
    finally { if (hbm != IntPtr.Zero) DeleteObject(hbm); }
  }
}
"@
  $mediaPlan = Get-Content -Raw -Path $Plan -Encoding UTF8 | ConvertFrom-Json
  if ($mediaPlan -isnot [array]) { $mediaPlan = @($mediaPlan) }
  $dev = Find-Dcim
  if (-not $dev) {
    $result.error = 'NO_DEVICE'
  } else {
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    $dcim = $dev.dcim
    # 枚举设备文件建索引；定位单个文件时依次尝试：枚举精确匹配 → ParseName → 按文件名扫描
    $items = @{}
    $folder = $null
    try { $folder = $dcim.GetFolder() } catch {}
    if ($folder) {
      foreach ($child in $folder.Items()) {
        if ($child.IsFolder) {
          $dirName = $child.Name
          $sub = $null
          try { $sub = $child.GetFolder() } catch {}
          if (-not $sub) { continue }
          foreach ($f in $sub.Items()) {
            if ($f.IsFolder) { continue }
            $key = "$dirName/$($f.Name)"
            $items[$key] = $f
          }
        } else {
          $items[$child.Name] = $child
        }
      }
    }
    function Resolve-PhoneItem([string]$rel) {
      if ($items.ContainsKey($rel)) { return $items[$rel] }
      $parts = @($rel -split '/')
      try {
        if ($parts.Count -gt 1) {
          $sub = $folder.ParseName($parts[0])
          if ($sub -and $sub.IsFolder) {
            $sf = $null; try { $sf = $sub.GetFolder() } catch {}
            if ($sf) { $parsed = $sf.ParseName($parts[1]); if ($parsed) { return $parsed } }
          }
        } else {
          $parsed = $folder.ParseName($parts[0])
          if ($parsed) { return $parsed }
        }
      } catch {}
      $baseName = [System.IO.Path]::GetFileName($rel)
      foreach ($k in $items.Keys) {
        if ([System.IO.Path]::GetFileName($k) -ieq $baseName) { return $items[$k] }
      }
      return $null
    }
    # Shell 取缩略图可能很慢，超过预算的先跳过，交给本地兜底生成
    $deadline = (Get-Date).AddSeconds($Budget)
    # Windows Shell 对这些格式通常没有缩略图处理器，且 WPD 上 GetImage 可能长时间阻塞，
    # 直接跳过 Shell 尝试，交给本地兜底（sharp/ffmpeg 解码生成）
    $noShellExt = @('.webp', '.heic', '.heif', '.dng', '.avif')
    foreach ($p in $mediaPlan) {
      $rel = [string]$p.rel
      $thumbOut = [string]$p.out
      if (-not $rel -or -not $thumbOut) { continue }
      $target = Join-Path $Dest $thumbOut
      if (Test-Path -LiteralPath $target) { $result.written += $rel; continue }
      $ext = [System.IO.Path]::GetExtension($rel).ToLower()
      if ($noShellExt -contains $ext) {
        $result.failed += [pscustomobject]@{ rel = $rel; error = 'NO_THUMB' }
        continue
      }
      if ($Budget -gt 0 -and (Get-Date) -gt $deadline) {
        $result.failed += [pscustomobject]@{ rel = $rel; error = 'TIME_BUDGET' }
        continue
      }
      $item = Resolve-PhoneItem $rel
      if (-not $item) {
        $result.failed += [pscustomobject]@{ rel = $rel; error = 'NOT_FOUND' }
        continue
      }
      $parsing = ''
      try { $parsing = [string]$item.Path } catch {}
      if ([PhoneThumb]::Save($item, $parsing, $target, $Size)) {
        $result.written += $rel
      } else {
        $result.failed += [pscustomobject]@{ rel = $rel; error = 'NO_THUMB' }
      }
    }
    $result.ok = $true
  }
} catch {
  $result.error = $_.Exception.Message
}
$json = $result | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
`;

function runPowerShell(script, extraArgs, timeout) {
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const scriptPath = path.join(os.tmpdir(), `pr-phone-${tag}.ps1`);
  const cleanupFiles = [scriptPath];
  // 必须带 BOM：PowerShell 5 会把无 BOM 的 UTF-8 当 ANSI 读，中文注释可能吞掉换行导致语法错误
  fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    ...extraArgs,
  ];
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { windowsHide: true, timeout }, (err) => {
      for (const f of cleanupFiles) { try { fs.unlinkSync(f); } catch {} }
      if (err) reject(err); else resolve();
    });
  });
}

/** 运行 PowerShell 脚本，返回 { cp, promise }。允许调用方直接管理子进程（kill） */
function spawnPowerShell(script, extraArgs) {
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const scriptPath = path.join(os.tmpdir(), `pr-phone-${tag}.ps1`);
  const cleanupFiles = [scriptPath];
  fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    ...extraArgs,
  ];
  const cp = execFile('powershell.exe', args, { windowsHide: true });
  const promise = new Promise((resolve, reject) => {
    cp.on('error', reject);
    cp.on('exit', (code, signal) => {
      for (const f of cleanupFiles) { try { fs.unlinkSync(f); } catch {} }
      if (code === 0) resolve(); else {
        const err = new Error(`PowerShell 退出码 ${code}`);
        err.code = code; err.signal = signal;
        reject(err);
      }
    });
  });
  return { cp, promise };
}

async function readResult(outPath) {
  const raw = fs.readFileSync(outPath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function tempPath(suffix) {
  return path.join(os.tmpdir(), `pr-phone-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${suffix}`);
}

/** 快速检测是否已连接手机（只判断设备是否存在，不枚举媒体） */
async function detectPhone() {
  const outPath = tempPath('json');
  try {
    await runPowerShell(PS_DETECT, ['-Out', outPath], 30000);
    const data = await readResult(outPath);
    return { found: Boolean(data.found), name: data.name || '', error: data.error || '' };
  } catch (e) {
    return { found: false, name: '', error: e.killed ? 'TIMEOUT' : (e.message || 'DETECT_FAILED') };
  } finally {
    try { fs.unlinkSync(outPath); } catch {}
  }
}

/** 检测已连接手机并列出相册媒体 */
async function listPhoneMedia() {
  const outPath = tempPath('json');
  try {
    await runPowerShell(PS_LIST, ['-Out', outPath], 120000);
    const data = await readResult(outPath);
    const groups = Array.isArray(data.groups) ? data.groups : (data.groups ? [data.groups] : []);
    return { ...data, groups };
  } catch (e) {
    return { found: false, name: '', groups: [], error: e.killed ? 'TIMEOUT' : (e.message || 'LIST_FAILED') };
  } finally {
    try { fs.unlinkSync(outPath); } catch {}
  }
}

/**
 * 把手机上的相对路径文件复制到本地暂存目录。
 * items 支持两种形态：string[]（每个文件独立）或 string[][]（按条目分组，实况的图片+视频同组）。
 * 传入 cancelPath 时，取消标记一旦出现，会在「条目」边界截止：已开始的条目复制完，未开始的条目不再复制。
 */
async function copyPhoneFiles(items, destDir, onProgress, opts = {}) {
  const outPath = tempPath('json');
  const planPath = tempPath('json');
  const progPath = typeof onProgress === 'function' ? tempPath('json') : '';
  const cancelPath = opts.cancelPath || '';
  fs.writeFileSync(planPath, JSON.stringify(items), 'utf8');
  const args = ['-Out', outPath, '-Dest', destDir, '-Plan', planPath];
  if (progPath) args.push('-Progress', progPath);
  if (cancelPath) args.push('-Cancel', cancelPath);
  let progTimer = null;
  let watchdogTimer = null;
  let lastProgressAt = Date.now();
  let cp = null;
  let killed = false;
  try {
    const spawned = spawnPowerShell(PS_COPY, args);
    cp = spawned.cp;
    // 看门狗：PowerShell 可能因 Shell.CopyHere 阻塞弹系统错误对话框，
    // 或者设备忙导致长时间无进度。超过 15 秒无任何进度变化 → kill 进程，避免整批卡死
    if (progPath) {
      watchdogTimer = setInterval(() => {
        if (!lastProgressAt || killed) return;
        if (Date.now() - lastProgressAt > 15000) {
          killed = true;
          // 给 PowerShell 一个短暂的窗口把当前已完成的条目写进 outPath
          try { cp.kill('SIGTERM'); } catch {}
        }
      }, 500);
    }
    if (progPath) {
      let lastRaw = '';
      progTimer = setInterval(() => {
        let raw = '';
        try { raw = fs.readFileSync(progPath, 'utf8'); } catch { return; }
        if (!raw) return;
        if (raw !== lastRaw) { lastProgressAt = Date.now(); lastRaw = raw; }
        try { onProgress(JSON.parse(raw.replace(/^\uFEFF/, ''))); } catch {}
      }, 200);
    }
    let promiseResolved = false;
    const race = Promise.race([
      spawned.promise.then(() => { promiseResolved = true; }),
      new Promise((resolve) => setTimeout(resolve, 1200)).then(() => {
        if (!promiseResolved && killed) {
          // 已 kill，给 PowerShell 最后一点时间写出 JSON 结果再放弃
          promiseResolved = true;
          try { cp.kill('SIGKILL'); } catch {}
        }
      }),
    ]);
    await spawned.promise.catch(() => {});
    // 即使 PowerShell 被 kill（异常退出码），也尝试读 outPath 里已有的部分结果
    const data = await (async () => {
      try {
        await new Promise((r) => setTimeout(r, 50));
        const raw = fs.readFileSync(outPath, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })();
    const base = data || {};
    return {
      ok: killed ? false : Boolean(base.ok),
      cancelled: killed ? false : Boolean(base.cancelled),
      copied: Array.isArray(base.copied) ? base.copied : (base.copied ? [base.copied] : []),
      failed: Array.isArray(base.failed) ? base.failed : (base.failed ? [base.failed] : []),
      error: killed ? 'BUSY' : (base.error || ''),
    };
  } catch (e) {
    let err = e.message || 'COPY_FAILED';
    if (killed) err = 'BUSY';
    return { ok: false, cancelled: false, copied: [], failed: [], error: err };
  } finally {
    if (progTimer) clearInterval(progTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    try { fs.unlinkSync(outPath); } catch {}
    try { fs.unlinkSync(planPath); } catch {}
    if (progPath) { try { fs.unlinkSync(progPath); } catch {} }
  }
}

/** 为指定的手机媒体生成封面缩略图（plan: [{ rel, out }]） */
async function thumbPhoneFiles(plan, destDir, size = 480, budget = 20) {
  const outPath = tempPath('json');
  const planPath = tempPath('json');
  fs.writeFileSync(planPath, JSON.stringify(plan), 'utf8');
  try {
    await runPowerShell(
      PS_THUMB,
      ['-Out', outPath, '-Dest', destDir, '-Plan', planPath, '-Size', String(size), '-Budget', String(budget)],
      (budget + 300) * 1000
    );
    const data = await readResult(outPath);
    const arr = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
    return {
      ok: Boolean(data.ok),
      written: arr(data.written),
      failed: arr(data.failed),
      error: data.error || '',
    };
  } catch (e) {
    return { ok: false, written: [], failed: [], error: e.killed ? 'TIMEOUT' : (e.message || 'THUMB_FAILED') };
  } finally {
    try { fs.unlinkSync(outPath); } catch {}
    try { fs.unlinkSync(planPath); } catch {}
  }
}

module.exports = { detectPhone, listPhoneMedia, copyPhoneFiles, thumbPhoneFiles };
