import { spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * Desktop notifications for runs that finished where nobody was watching.
 *
 * Deliberately dependency-free. The project ships as a single `bun --compile`
 * binary and has no native-binding dependencies, so a notifier package would
 * break that. Each platform's own mechanism is invoked instead:
 *
 * | Platform | Mechanism |
 * | --- | --- |
 * | macOS | `osascript` (`display notification`) |
 * | Windows | PowerShell toast via `Windows.UI.Notifications` |
 * | Linux | `notify-send`, falling back to `zenity` |
 *
 * Every path is best-effort. A headless box with no notification daemon must
 * never turn a finished run into a failure, so failures are swallowed and the
 * durable `notifications.log` remains the source of truth.
 */

export interface DesktopNotification {
  title: string;
  message: string;
  /** Passed to the platform's own urgency hint where one exists. */
  urgent?: boolean;
}

export type NotifyResult =
  | { delivered: true; via: string }
  | { delivered: false; reason: string };

/** Escape a string for embedding in a PowerShell single-quoted literal. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Escape a string for embedding in an AppleScript double-quoted literal. */
function osaQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function runCommand(command: string, args: string[], timeoutMs = 5000): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, stderr: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stderr });
    };

    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (err) => finish(false, String(err)));
    child.on("close", (code) => finish(code === 0, stderr));

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(false, "timed out");
    }, timeoutMs);
    timer.unref?.();
  });
}

async function notifyMacos(note: DesktopNotification): Promise<NotifyResult> {
  // `display notification` requires a script; passing the text inline avoids a
  // temp file and its cleanup.
  const script = `display notification ${osaQuote(note.message)} with title ${osaQuote(note.title)}`;
  const result = await runCommand("osascript", ["-e", script]);
  return result.ok ? { delivered: true, via: "osascript" } : { delivered: false, reason: result.stderr.trim() || "osascript failed" };
}

async function notifyWindows(note: DesktopNotification): Promise<NotifyResult> {
  // The WinRT toast API. A plain balloon tip is used instead on builds where
  // WinRT is unavailable, because it works without an AppUserModelID.
  const escapedTitle = psQuote(note.title);
  const escapedBody = psQuote(note.message);
  const script = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] > $null",
    "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$n = $t.GetElementsByTagName(\"text\")",
    "$n.Item(0).AppendChild($t.CreateTextNode(" + escapedTitle + ")) > $null",
    "$n.Item(1).AppendChild($t.CreateTextNode(" + escapedBody + ")) > $null",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('agav').Show([Windows.UI.Notifications.ToastNotification]::new($t))",
  ].join("; ");

  const winrt = await runCommand(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    8000,
  );
  if (winrt.ok) return { delivered: true, via: "winrt-toast" };

  // Fallback: a balloon tip via WScript.Shell, which needs no WinRT at all.
  const balloon = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$n = New-Object System.Windows.Forms.NotifyIcon",
    "$n.Icon = [System.Drawing.SystemIcons]::Information",
    "$n.Visible = $true",
    "$n.ShowBalloonTip(10000, " + escapedTitle + ", " + escapedBody + ", [System.Windows.Forms.ToolTipIcon]::Info)",
  ].join("; ");
  const fallback = await runCommand(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", balloon],
    8000,
  );
  return fallback.ok
    ? { delivered: true, via: "balloon-tip" }
    : { delivered: false, reason: winrt.stderr.trim() || fallback.stderr.trim() || "no notification method available" };
}

async function notifyLinux(note: DesktopNotification): Promise<NotifyResult> {
  const args = [note.title, note.message, "--app-name=agav"];
  if (note.urgent) args.push("--urgency=critical");

  const primary = await runCommand("notify-send", args);
  if (primary.ok) return { delivered: true, via: "notify-send" };

  // notify-send is the common case, but a minimal desktop may only have zenity.
  const zenity = await runCommand("zenity", ["--notification", "--text", `${note.title}\n${note.message}`]);
  return zenity.ok
    ? { delivered: true, via: "zenity" }
    : { delivered: false, reason: primary.stderr.trim() || "no notification daemon available" };
}

/**
 * Show a desktop notification, if the platform supports one.
 *
 * Never throws. A machine with no notification daemon, or a session without
 * permission to show one, resolves to `delivered: false` so the caller can fall
 * back to the log rather than treating it as an error.
 */
export async function notifyDesktop(note: DesktopNotification): Promise<NotifyResult> {
  try {
    switch (platform()) {
      case "darwin":
        return await notifyMacos(note);
      case "win32":
        return await notifyWindows(note);
      default:
        return await notifyLinux(note);
    }
  } catch (err) {
    return { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Title and body for a finished run, shaped for a desktop banner. */
export function formatDesktopNotification(event: {
  workflowName: string;
  status: string;
  error?: string;
}): { title: string; message: string; urgent: boolean } {
  const ok = event.status === "passed";
  return {
    // Failure leads the title so it is legible at a glance in a crowded tray.
    title: ok ? "Workflow finished" : `Workflow ${event.status}`,
    message: event.error
      ? `${event.workflowName}: ${event.error}`
      : `${event.workflowName} — ${event.status}`,
    urgent: !ok,
  };
}
