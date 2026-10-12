/**
 * The first line of an error, which is the only line worth showing.
 *
 * viem builds a whole report: the message, then the URL, then the entire JSON request body, then
 * its own version. That is right for a console and wrong for a banner. Loading the board under a
 * rate limit painted the full body across the page in red — and this text also goes into a
 * `role="alert"`, so a screen reader read the request out, category hash and all. The rest is a
 * console's job; `console.error` still has it.
 *
 * **The URL is the part that must not reach the screen.** An endpoint with a key in its path is a
 * credential, and a caught error carries the whole path. Redact at the print, every time — this
 * function is that redaction, and it lives here rather than in one view because the board view
 * had it and the exclusive-quote views did not.
 */
export const firstLine = (message: string) => redactUrls((message.split('\n')[0] ?? message).trim())

/**
 * Every URL cut to its origin. A key can sit in any path segment or query, and a host is enough
 * to say which endpoint failed. Credentials before the host go too.
 */
export const redactUrls = (text: string) =>
  text.replace(/\b(https?|wss?):\/\/(?:[^/@\s]+@)?([^/?#\s]+)[^\s"'<>)]*/gi, '$1://$2/…')

/** The first line of whatever was thrown, however it was thrown. */
export const errorLine = (e: unknown): string =>
  firstLine((e as Error)?.message ?? String(e))
