/**
 * Turns what the person typed into a URL: a URL as given (http, https or
 * about only), a bare host made https, anything else a web search.
 */
export function toUrl(text: string): string {
  const typed = text.trim()
  if (/^https?:\/\//i.test(typed) || /^about:/i.test(typed)) return typed
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/i.test(typed)) return `http://${typed}`
  if (/^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(typed)) return `https://${typed}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(typed)}`
}
