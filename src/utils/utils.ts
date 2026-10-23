// src/utils/utils.ts

// @ts-expect-error The lib does not support ESM.
import emojiUnicode from 'emoji-unicode';

/**
 * Maps an emoji to the PNG shipped in the plugin's icons folder.
 *
 * Flow Launcher resolves IcoPath relative to the plugin directory, so the returned
 * path starts at `icons`. Returns undefined for anything `emoji-unicode` does not
 * recognise; callers fall back to the plugin icon.
 */
export function getIconFileName (emoji: string): string | undefined {
  const codes = emojiUnicode(emoji);
  if (typeof codes === 'string') {
    return 'icons\\' + codes.toLowerCase().split(' ').join('-') + '.png';
  }
}
