# vibe-term — OS-level keyboard-fidelity probe (French AZERTY).
#
# Sends REAL virtual-key events via Win32 SendInput to the focused vibe-term
# window: direct accent keys (é è à ç on the unshifted digit row) plus the
# DEAD-KEY sequence ^ then e (composes ê through the OS + WebView2
# composition path — the one input path CDP cannot exercise faithfully).
# The CDP harness then reads the terminal buffer and asserts the exact string
# landed once, with no doubled or stray characters.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File sendinput-azerty.ps1

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class VibeInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public KEYBDINPUT ki; public ulong pad; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")]
  public static extern IntPtr FindWindowA(string cls, string title);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  public static void Key(ushort vk) {
    INPUT[] down = new INPUT[1]; down[0].type = 1; down[0].ki.wVk = vk;
    INPUT[] up   = new INPUT[1]; up[0].type = 1;   up[0].ki.wVk = vk; up[0].ki.dwFlags = 2;
    SendInput(1, down, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(18);
    SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(18);
  }
}
"@

$proc = Get-Process vibe-term -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Error "vibe-term window not found"; exit 1 }
[void][VibeInput]::SetForegroundWindow($proc.MainWindowHandle)
Start-Sleep -Milliseconds 400

# FR AZERTY unshifted digit row: 2=é 7=è 0=à 9=ç ; dead ^ = VK_OEM_6 then E → ê
[VibeInput]::Key(0x32)  # é
[VibeInput]::Key(0x37)  # è
[VibeInput]::Key(0x30)  # à
[VibeInput]::Key(0x39)  # ç
[VibeInput]::Key(0xDD)  # dead circumflex (VK_OEM_6 on FR layout)
[VibeInput]::Key(0x45)  # e → composes ê
Write-Host "SENT"
