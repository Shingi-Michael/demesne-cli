/// Desktop notifications through the terminal.
///
/// OSC 9 is understood by iTerm2, WezTerm, Windows Terminal, Ghostty, and
/// others; unsupported terminals ignore the sequence. There is no portable way
/// to detect window focus, so completion notifications are gated by a minimum
/// turn duration and can be disabled in configuration or with
/// `DEMESNE_NO_NOTIFICATIONS=1`. Approval requests notify immediately because
/// the turn is blocked on the user.

export interface NotificationOptions {
  enabled: boolean;
  isTTY: boolean;
  env?: Record<string, string | undefined>;
}

export interface CompletionNotificationOptions extends NotificationOptions {
  durationMs: number;
  minimumDurationMs: number;
}

export function formatDesktopNotification(message: string): string {
  const safe = message.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return `\x1b]9;Demesne: ${safe}\x07`;
}

export function shouldNotifyApproval(options: NotificationOptions): boolean {
  return notificationAllowed(options);
}

export function shouldNotifyCompletion(options: CompletionNotificationOptions): boolean {
  return notificationAllowed(options) && options.durationMs >= options.minimumDurationMs;
}

export function notify(message: string, options: NotificationOptions): boolean {
  if (!notificationAllowed(options)) return false;
  process.stdout.write(formatDesktopNotification(message));
  return true;
}

function notificationAllowed(options: NotificationOptions): boolean {
  const env = options.env ?? process.env;
  if (!options.enabled) return false;
  if (env.DEMESNE_NO_NOTIFICATIONS === "1" || env.DEMESNE_NO_NOTIFICATIONS === "true") return false;
  return options.isTTY;
}
