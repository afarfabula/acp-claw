/** 终端配色。全部走 256 色 ANSI；不支持颜色时自动退化成原文。 */

export function supportsColor(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(stream?.isTTY);
}

export function createStyle(enabled = true) {
  const wrap = (open, close) => (text) =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : String(text);
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    italic: wrap(3, 23),
    red: wrap('38;5;203', 39),
    green: wrap('38;5;114', 39),
    yellow: wrap('38;5;221', 39),
    blue: wrap('38;5;111', 39),
    magenta: wrap('38;5;176', 39),
    cyan: wrap('38;5;116', 39),
    gray: wrap('38;5;245', 39),
    /** 选中行的底色（只改背景，不覆盖前景色） */
    selected: wrap('48;5;236', 49),
    /** 强调按钮/关键值 */
    key: wrap('38;5;222', 39),
    ok: wrap('38;5;114', 39),
    warn: wrap('38;5;214', 39),
  };
}

/** 会话/持有者按「能不能清、是不是你正在用的」分红黄绿蓝灰。 */
export function holderStyle(style, kind) {
  switch (kind) {
    case 'current':
      return style.green;
    case 'bot':
      return style.blue;
    case 'other-user':
      return style.gray;
    default:
      return style.red;
  }
}
