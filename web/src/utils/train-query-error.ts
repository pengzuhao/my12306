/** Older local services may still return Playwright errors; never show their stack in the UI. */
export function trainSearchErrorMessage(error: unknown): string {
  const message = (error as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  if (typeof message !== 'string' || /page\.|browserContext\.|TypeError|SyntaxError|Failed to fetch|<anonymous>|Call log:|ECONN|ENOTFOUND|TimeoutError/.test(message)) {
    return '暂时无法获取 12306 余票，请稍后刷新重试';
  }
  return message;
}
