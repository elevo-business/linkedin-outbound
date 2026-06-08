// Dependency-free PDF writer for lead magnets. Renders the Claude-written magnet
// markdown into a clean, multi-page A4 PDF (Helvetica, headings, bullets, wrapped
// paragraphs). Not a full markdown engine — handles the structure magnets use:
// `# H1`, `## H2`, `- bullet`, `1. numbered`, blank-line paragraph breaks.
//
// For richer, designed PDFs (cover art, columns) a Chromium/HTML renderer can be
// swapped in later; this gives a real, professional-enough PDF everywhere with
// zero install.

const PAGE_W = 595.28; // A4 points
const PAGE_H = 841.89;
const MARGIN = 56;
const MAXW = PAGE_W - 2 * MARGIN;

const escapePdf = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
// Approximate Helvetica advance width (avg ~0.5em) for wrapping.
const fits = (text, size) => text.length * size * 0.5 <= MAXW;

function wrap(text, size) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (fits(candidate, size) || !line) line = candidate;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

// Turn the markdown into a flat list of { text, size, gap, font } render ops.
function layout(title, author, markdown) {
  const ops = [];
  ops.push({ text: title, size: 22, font: 'F2', gap: 10 });
  if (author) ops.push({ text: author, size: 11, font: 'F1', gap: 16, color: '0.4 0.4 0.4' });

  for (const raw of String(markdown || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      ops.push({ spacer: 8 });
      continue;
    }
    let text = line;
    let size = 11.5;
    let font = 'F1';
    let gap = 5;
    if (/^#\s+/.test(line)) { text = line.replace(/^#\s+/, ''); size = 17; font = 'F2'; gap = 8; }
    else if (/^##\s+/.test(line)) { text = line.replace(/^##\s+/, ''); size = 14; font = 'F2'; gap = 7; }
    else if (/^(\d+\.|[-*•])\s+/.test(line)) { text = '•  ' + line.replace(/^(\d+\.|[-*•])\s+/, ''); }
    for (const wl of wrap(text, size)) ops.push({ text: wl, size, font, gap });
  }
  return ops;
}

export function magnetToPdf({ title, author, markdown }) {
  const ops = layout(title, author, markdown);

  // Paginate into content streams.
  const pages = [];
  let stream = '';
  let y = PAGE_H - MARGIN;
  const flush = () => { if (stream) pages.push(stream); stream = ''; y = PAGE_H - MARGIN; };
  for (const op of ops) {
    if (op.spacer) { y -= op.spacer; continue; }
    const lineH = op.size * 1.4;
    if (y - lineH < MARGIN) flush();
    const color = op.color || '0 0 0';
    stream +=
      `BT /${op.font} ${op.size} Tf ${color} rg 1 0 0 1 ${MARGIN} ${(y - op.size).toFixed(2)} Tm (${escapePdf(op.text)}) Tj ET\n`;
    y -= lineH + (op.gap || 0);
  }
  flush();
  if (!pages.length) pages.push('');

  // Assemble PDF objects.
  const objs = [];
  const add = (s) => objs.push(s);
  // 1 catalog, 2 pages, fonts, then page+content pairs.
  const fontReg = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const fontBold = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';

  const nPages = pages.length;
  // object numbering: 1=catalog 2=pages 3=F1 4=F2 then for each page: content, page
  const kids = [];
  const pageObjNums = [];
  let nextObj = 5;
  const contentObjs = [];
  for (let i = 0; i < nPages; i++) {
    const contentNum = nextObj++;
    const pageNum = nextObj++;
    contentObjs.push({ contentNum, pageNum, body: pages[i] });
    kids.push(`${pageNum} 0 R`);
    pageObjNums.push(pageNum);
  }

  add(`<< /Type /Catalog /Pages 2 0 R >>`); // 1
  add(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${nPages} >>`); // 2
  add(fontReg); // 3
  add(fontBold); // 4
  for (const c of contentObjs) {
    const bytes = Buffer.byteLength(c.body, 'utf8');
    objs[c.contentNum - 1] = `<< /Length ${bytes} >>\nstream\n${c.body}endstream`;
    objs[c.pageNum - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${c.contentNum} 0 R >>`;
  }

  // Serialize with xref.
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'utf8');
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(out, 'utf8');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 0; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, 'utf8');
}
