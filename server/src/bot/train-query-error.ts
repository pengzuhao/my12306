/** Only these errors are suitable for display in the train picker. */
export class TrainQueryError extends Error {}

export function trainQueryErrorMessage(error: unknown): string {
  if (error instanceof TrainQueryError) return error.message;
  return '暂时无法获取 12306 余票，请稍后刷新重试';
}
