// Something only you can fix at the Mac (expired login, broken yt-dlp, bad API
// key). The inbox file is kept for retry and you get a notification.
export class SystemicError extends Error {
  constructor(readonly kind: string, message: string) {
    super(message);
  }
}

// Probably fine on the next try (network blip, 5xx). Retried silently, then
// promoted to systemic after limits.maxTransientAttempts.
export class TransientError extends Error {}

// This one reel can't be fetched (deleted, private). Written as needs-source.
export class ItemError extends Error {}
