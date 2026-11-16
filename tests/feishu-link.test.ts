import { describe, expect, it } from '@rstest/core';
import { linkifyBareUrls } from '../src/channel/feishu';

describe('linkifyBareUrls', () => {
  it('converts bare Feishu OAuth URLs into clickable markdown links', () => {
    const url =
      'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=abc&user_code=XYZ';
    expect(linkifyBareUrls(`授权链接：\n${url}`)).toBe(
      `授权链接：\n[打开链接](${url})`,
    );
  });

  it('does not double-convert markdown links, code, or fenced code', () => {
    const input = [
      '[现有链接](https://example.com/a)',
      '`https://example.com/raw`',
      '```text',
      'https://example.com/code',
      '```',
    ].join('\n');
    expect(linkifyBareUrls(input)).toBe(input);
  });
});
