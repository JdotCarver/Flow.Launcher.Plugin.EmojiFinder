import type { JsonRpcRequest, JsonRpcResponse } from '../types.js';

export const FlowLauncher = {
  /**
   * Shows a desktop notification.
   * @param title The notification title.
   * @param subtitle The notification text content.
   */
  showMessage: function (title: string, subtitle: string) {
    sendJsonRpcRequest({
      method: 'Flow.Launcher.ShowMsg',
      parameters: [
        title,
        subtitle,
        ''
      ]
    });
  }
};

/**
 * JSON with every non-ASCII character escaped as \uXXXX.
 *
 * Flow Launcher reads a plugin's stdout with `ProcessStartInfo.RedirectStandardOutput` and no
 * `StandardOutputEncoding`, so .NET decodes our bytes with the machine's console code page -
 * not UTF-8. An emoji written literally therefore arrives as mojibake in the result list
 * (measured: the "Add an alias for 💪" menu entry). JSON escapes are pure ASCII, survive any
 * code page, and are decoded back to the real characters by the JSON parser on Flow's side.
 */
export function toAsciiEscapedJson (value: unknown): string {
  return JSON.stringify(value).replace(/[^\x20-\x7E]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function sendJsonRpcRequest (req: JsonRpcRequest | JsonRpcResponse): void {
  console.log(toAsciiEscapedJson(req));
}
