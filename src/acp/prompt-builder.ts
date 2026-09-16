import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * 格式化用户消息，包含渠道和发送者信息
 */
export function formatUserMessage(
  channel: string,
  userId: string,
  text: string,
): string {
  return `[${channel}] from ${userId}: ${text}`;
}

export function buildPrompt(
  text: string,
  filePaths?: string[],
  files?: Array<{ bytes?: string; mimeType?: string; name?: string }>,
): ContentBlock[] {
  let fullText = '';

  if (filePaths && filePaths.length > 0) {
    const fileContents = filePaths.map((filePath) => {
      const content = readFileSync(filePath, 'utf-8');
      const name = basename(filePath);
      return `<file path="${name}">\n${content}\n</file>`;
    });
    fullText = fileContents.join('\n\n') + '\n\n---\n\n' + text;
  } else {
    fullText = text;
  }

  const blocks: ContentBlock[] = [{ type: 'text', text: fullText }];
  for (const file of files ?? []) {
    if (!file.bytes) continue;
    blocks.push({
      type: 'image',
      data: file.bytes,
      mimeType: file.mimeType ?? 'image/png',
    });
  }
  return blocks;
}
