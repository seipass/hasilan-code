import { spawn } from "node:child_process";
import type { ScreenBounds } from "./backend.ts";

export interface AccessibleTarget {
	name: string;
	role: string;
	x: number;
	y: number;
	focused: boolean;
	windowId?: string;
	windowName?: string;
}

export class AccessibleScopeError extends Error {
	readonly code: "foreground_off_monitor" | "foreground_changed" | "no_foreground";
	constructor(code: AccessibleScopeError["code"]) {
		super(
			{
				foreground_off_monitor:
					"The foreground window is not on the selected monitor; focus the target window and retry",
				foreground_changed:
					"The foreground window changed while inspecting controls; focus the target window and retry",
				no_foreground: "No foreground window is available on the selected monitor",
			}[code],
		);
		this.code = code;
	}
}

// Monitor scope includes visible controls in unfocused windows; every target is hit-tested.
const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
}
'@
[void][ForegroundWindow]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
$inputData = [Console]::In.ReadLine() | ConvertFrom-Json
$window = [ForegroundWindow]::GetForegroundWindow()
$roots = [System.Collections.Generic.List[System.Windows.Automation.AutomationElement]]::new()
if ($inputData.scope -eq 'monitor') {
  $desktop = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($candidate in $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      $current = $candidate.Current
      $rect = $current.BoundingRectangle
      if ($current.IsOffscreen -or !$current.IsEnabled -or !$current.NativeWindowHandle -or $current.ClassName -in @('Progman','WorkerW','Shell_TrayWnd','Shell_SecondaryTrayWnd')) { continue }
      if ($rect.Right -le $inputData.left -or $rect.Bottom -le $inputData.top -or $rect.Left -ge ($inputData.left + $inputData.width) -or $rect.Top -ge ($inputData.top + $inputData.height)) { continue }
      $roots.Add($candidate)
    } catch { continue }
  }
} else {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
  if (!$root) { [Console]::Write('{"status":"no_foreground","targets":[]}'); exit }
  $windowRect = $root.Current.BoundingRectangle
  if ($windowRect.Right -le $inputData.left -or $windowRect.Bottom -le $inputData.top -or $windowRect.Left -ge ($inputData.left + $inputData.width) -or $windowRect.Top -ge ($inputData.top + $inputData.height)) {
    [Console]::Write('{"status":"foreground_off_monitor","targets":[]}'); exit
  }
  $roots.Add($root)
}
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$queue = [System.Collections.Generic.Queue[object]]::new()
foreach ($root in $roots) {
  try {
    $current = $root.Current
    $queue.Enqueue(@{ element = $root; windowId = [string]$current.NativeWindowHandle; windowName = $current.Name.Substring(0, [Math]::Min(160, $current.Name.Length)) })
  } catch { continue }
}
$results = [System.Collections.Generic.List[object]]::new()
$seen = 0
while ($queue.Count -gt 0 -and $seen -lt 2000 -and $results.Count -lt 100) {
  $entry = $queue.Dequeue(); $item = $entry.element; $seen++
  try {
    $current = $item.Current
    $child = $walker.GetFirstChild($item)
    while ($child) { $queue.Enqueue(@{ element = $child; windowId = $entry.windowId; windowName = $entry.windowName }); $child = $walker.GetNextSibling($child) }
    if ($current.IsOffscreen -or !$current.IsEnabled -or !$current.Name) { continue }
    $role = $current.ControlType.ProgrammaticName
    if ($role -notin @('ControlType.Button','ControlType.Edit','ControlType.Hyperlink','ControlType.MenuItem','ControlType.TabItem','ControlType.ListItem','ControlType.CheckBox','ControlType.RadioButton','ControlType.ComboBox','ControlType.TreeItem')) { continue }
    $rect = $current.BoundingRectangle
    $x = $rect.X + $rect.Width / 2; $y = $rect.Y + $rect.Height / 2
    if ($rect.Width -lt 2 -or $rect.Height -lt 2 -or $x -lt $inputData.left -or $y -lt $inputData.top -or $x -ge ($inputData.left + $inputData.width) -or $y -ge ($inputData.top + $inputData.height)) { continue }
    $hit = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new($x, $y))
    $inside = $false
    while ($hit) { if ($hit.Equals($item)) { $inside = $true; break }; $hit = $walker.GetParent($hit) }
    if (!$inside) { continue }
    $results.Add(@{ name = $current.Name.Substring(0, [Math]::Min(160, $current.Name.Length)); role = $role; focused = $current.HasKeyboardFocus; x = [Math]::Floor($x - $inputData.left); y = [Math]::Floor($y - $inputData.top); windowId = $entry.windowId; windowName = $entry.windowName })
  } catch { continue }
}
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($inputData.scope -ne 'monitor' -and $window -ne [ForegroundWindow]::GetForegroundWindow()) { [Console]::Write('{"status":"foreground_changed","targets":[]}'); exit }
[Console]::Write((ConvertTo-Json -InputObject @{ status = 'ok'; targets = @($results) } -Compress -Depth 4))
`;

export async function accessibleTargets(
	bounds: ScreenBounds,
	signal?: AbortSignal,
	scope: "monitor" | "foreground" = "foreground",
): Promise<AccessibleTarget[]> {
	if (process.platform !== "win32") return [];
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	return await new Promise((resolve, reject) => {
		const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
			windowsHide: true,
			stdio: ["pipe", "pipe", "ignore"],
			signal,
		});
		const output: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) return reject(new Error("Could not inspect accessible desktop controls"));
			try {
				const value: unknown = JSON.parse(Buffer.concat(output).toString("utf8"));
				if (
					!value ||
					typeof value !== "object" ||
					!("status" in value) ||
					!("targets" in value) ||
					!Array.isArray(value.targets)
				)
					throw new Error();
				if (
					value.status === "foreground_off_monitor" ||
					value.status === "foreground_changed" ||
					value.status === "no_foreground"
				)
					throw new AccessibleScopeError(value.status);
				if (value.status !== "ok") throw new Error();
				resolve(
					value.targets.filter(
						(item): item is AccessibleTarget =>
							item &&
							typeof item.name === "string" &&
							typeof item.role === "string" &&
							typeof item.focused === "boolean" &&
							(item.windowId === undefined || typeof item.windowId === "string") &&
							(item.windowName === undefined || typeof item.windowName === "string") &&
							Number.isFinite(item.x) &&
							Number.isFinite(item.y) &&
							item.x >= 0 &&
							item.y >= 0 &&
							item.x < bounds.width &&
							item.y < bounds.height,
					),
				);
			} catch (error) {
				if (error instanceof AccessibleScopeError) return reject(error);
				reject(new Error("Invalid accessible desktop controls"));
			}
		});
		child.stdin.on("error", () => undefined);
		child.stdin.end(`${JSON.stringify({ ...bounds, scope })}\n`);
	});
}
