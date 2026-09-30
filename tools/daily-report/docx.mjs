// 把（我们自己的子集）Markdown 渲染成 .docx，再交给飞书导入。
//
// 为什么不用飞书的 Markdown 导入：实测它**不下载外链图片**，只插一张占位图
// （12 张图全是同一张 22.7KB PNG），而且图片块的显示框被固定成 1460x220（6.64:1），
// 换成真图后会被压扁；`replace_image` 也不会更新尺寸，接口又不允许改 width/height。
// 导入 docx 则完全正常：图片按原始比例、表格变原生表格。
import { deflateRawSync } from 'node:zlib';

// ------------------------------------------------------------------ ZIP
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 极简 ZIP 打包（deflate）——OOXML 就是个 zip，不需要额外依赖 */
export function zipFiles(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf-8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf-8');
    const comp = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 文件名用 UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, comp);
    central.push({ name, crc: crc32(data), comp: comp.length, raw: data.length, offset });
    offset += local.length + name.length + comp.length;
  }
  const cd = [];
  for (const e of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(8, 10);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.comp, 20);
    h.writeUInt32LE(e.raw, 24);
    h.writeUInt16LE(e.name.length, 28);
    h.writeUInt32LE(e.offset, 42);
    cd.push(h, e.name);
  }
  const cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ------------------------------------------------------------------ 图片尺寸
/** 从图片字节里读出宽高（PNG / JPEG） */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), ext: 'png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), ext: 'jpg' };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return { width: 1200, height: 800, ext: 'png' };
}

// ------------------------------------------------------------------ OOXML
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const EMU_PER_IN = 914400;
const CONTENT_W_EMU = Math.round(6.5 * EMU_PER_IN);

/** 把一行里的 **粗体** 和 [文字](链接) 变成 runs */
function inlineRuns(text, rels, { bold = false, color = null } = {}) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m;
  const pushText = (t, opts = {}) => {
    if (!t) return;
    const props = [
      opts.bold || bold ? '<w:b/>' : '',
      color ? `<w:color w:val="${color}"/>` : '',
    ].join('');
    out.push(`<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`);
  };
  while ((m = re.exec(text)) !== null) {
    pushText(text.slice(last, m.index));
    if (m[2] !== undefined) {
      pushText(m[2], { bold: true });
    } else {
      const rid = `link${rels.links.length + 1}`;
      rels.links.push({ rid, url: m[5] });
      out.push(
        `<w:hyperlink r:id="${rid}"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>` +
          `<w:t xml:space="preserve">${esc(m[4])}</w:t></w:r></w:hyperlink>`,
      );
    }
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  return out.join('');
}

const para = (runs, { style, indent, spacing } = {}) =>
  `<w:p>${style || indent || spacing ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${indent ? `<w:ind w:left="${indent}"/>` : ''}${spacing ?? ''}</w:pPr>` : ''}${runs}</w:p>`;

function tableXml(rows, rels) {
  const cols = Math.max(...rows.map((r) => r.length));
  const grid = Array.from({ length: cols }, () => `<w:gridCol w:w="${Math.floor(9600 / cols)}"/>`).join('');
  const body = rows
    .map((r, ri) => {
      const cells = r
        .map(
          (c) =>
            `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9600 / cols)}" w:type="dxa"/>` +
            `${ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F3F5"/>' : ''}</w:tcPr>` +
            `${para(inlineRuns(c, rels, { bold: ri === 0 }))}</w:tc>`,
        )
        .join('');
      return `<w:tr>${cells}</w:tr>`;
    })
    .join('');
  return (
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="D0D3D6"/>`)
      .join('') +
    '</w:tblBorders></w:tblPr>' +
    `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`
  );
}

function imageXml(rid, wPx, hPx, idx, { maxWidthEmu = CONTENT_W_EMU } = {}) {
  const ratio = hPx / Math.max(wPx, 1);
  const cx = maxWidthEmu;
  const cy = Math.round(cx * ratio);
  return (
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>' +
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${idx}" name="Picture ${idx}"/><wp:cNvGraphicFramePr/>` +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:nvPicPr><pic:cNvPr id="${idx}" name="Picture ${idx}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  );
}

/** 我们的 Markdown 子集 → docx body 元素 */
export function markdownToDocxBody(markdown, images) {
  const rels = { links: [], images: [] };
  const body = [];
  const lines = String(markdown).replace(/\r/g, '').split('\n');
  let i = 0;
  let picId = 0;
  const pushImage = (url, alt) => {
    const img = images.get(url);
    if (!img) return;
    rels.images.push({ rid: `rIdImg${rels.images.length + 1}`, ...img });
    picId += 1;
    body.push(imageXml(`rIdImg${rels.images.length}`, img.width, img.height, picId));
    void alt;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('---')) {
      body.push(
        '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="D0D3D6"/></w:pBdr></w:pPr></w:p>',
      );
      i += 1;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      body.push(para(inlineRuns(h[2], rels), { style: `Heading${Math.min(lvl, 4)}` }));
      i += 1;
      continue;
    }
    // 表格
    if (line.startsWith('|') && lines[i + 1]?.match(/^\|[\s:|-]+\|$/)) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        if (!/^\|[\s:|-]+\|$/.test(lines[i])) {
          rows.push(
            lines[i]
              .replace(/^\||\|$/g, '')
              .split('|')
              .map((c) => c.trim()),
          );
        }
        i += 1;
      }
      body.push(tableXml(rows, rels));
      body.push(para(''));
      continue;
    }
    // 引用块（连续的 > 行合并成一段）
    if (line.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      // 每个非空行单独成段（引用块里常有 "- " 列表，合并成一段会糊成一坨）
      for (const raw of buf) {
        const t = raw.trim();
        if (!t) continue;
        const bullet = /^[-*]\s+/.test(t);
        const bodyText = bullet ? `• ${t.replace(/^[-*]\s+/, '')}` : t;
        body.push(
          para(inlineRuns(bodyText, rels), {
            indent: bullet ? 320 : 200,
            spacing: '<w:spacing w:before="40" w:after="40"/>',
          }),
        );
      }
      continue;
    }
    // 单独一行图片
    const imgOnly = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (imgOnly) {
      pushImage(imgOnly[2], imgOnly[1]);
      i += 1;
      continue;
    }
    // 列表
    const li = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (li) {
      body.push(para(inlineRuns(`• ${li[2]}`, rels), { indent: 240 }));
      i += 1;
      continue;
    }
    // 普通段落（行内可能夹图片，先处理图片）
    const parts = line.split(/(!\[[^\]]*\]\([^)\s]+\))/g);
    for (const part of parts) {
      const m = part.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
      if (m) pushImage(m[2], m[1]);
      else if (part.trim()) body.push(para(inlineRuns(part, rels)));
    }
    i += 1;
  }
  return { body, rels };
}

/** 组装成完整 .docx（Buffer） */
export function buildDocx(markdown, images) {
  const { body, rels } = markdownToDocxBody(markdown, images);
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
    ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
    `<w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';

  const mediaEntries = rels.images.map((im, idx) => ({
    name: `word/media/image${idx + 1}.${im.ext}`,
    data: im.data,
  }));
  const imageRels = rels.images
    .map(
      (im, idx) =>
        `<Relationship Id="${im.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${idx + 1}.${im.ext}"/>`,
    )
    .join('');
  const linkRels = rels.links
    .map(
      (l) =>
        `<Relationship Id="${l.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(l.url)}" TargetMode="External"/>`,
    )
    .join('');

  const exts = [...new Set(rels.images.map((i) => i.ext))];
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    exts.map((e) => `<Default Extension="${e}" ContentType="image/${e === 'jpg' ? 'jpeg' : e}"/>`).join('') +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>';

  const styleDefs = [
    ['Heading1', 1, 32],
    ['Heading2', 2, 26],
    ['Heading3', 3, 23],
    ['Heading4', 4, 21],
  ]
    .map(
      ([id, lvl, sz]) =>
        `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="heading ${lvl}"/><w:basedOn w:val="Normal"/>` +
        `<w:pPr><w:outlineLvl w:val="${lvl - 1}"/><w:spacing w:before="240" w:after="120"/></w:pPr>` +
        `<w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`,
    )
    .join('');
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Helvetica" w:eastAsia="PingFang SC" w:hAnsi="Helvetica"/><w:sz w:val="21"/>' +
    '</w:rPr></w:rPrDefault></w:docDefaults>' +
    styleDefs +
    '</w:styles>';

  return zipFiles([
    { name: '[Content_Types].xml', data: contentTypes },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    { name: 'word/document.xml', data: documentXml },
    {
      name: 'word/_rels/document.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        imageRels +
        linkRels +
        '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    },
    { name: 'word/styles.xml', data: styles },
    ...mediaEntries,
  ]);
}

/** 把 Markdown 里用到的图片全部下载下来（供 buildDocx 用） */
export async function downloadImages(markdown, { onLog = () => {} } = {}) {
  const urls = [...String(markdown).matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const map = new Map();
  for (const url of [...new Set(urls)]) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'acp-claw-daily-report/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      const { width, height, ext } = imageSize(data);
      map.set(url, { data, width, height, ext, url });
      onLog(`  ${url.split('/').pop()} → ${width}x${height} ${Math.round(data.length / 1024)}KB`);
    } catch (err) {
      onLog(`  图片下载失败 ${url}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return map;
}
