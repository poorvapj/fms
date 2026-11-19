// Renders the legacy-format job card table (see reports.ts' legacyAllSection/legacyPendingSection)
// as a landscape PDF that mirrors the old "FMS - Pending Complaint" sheet printout.
import PDFDocument from 'pdfkit';
import type { Column } from './reports.ts';

const COL_WIDTHS: Record<string, number> = {
  row_no: 40, time: 85, site: 95, work_category: 80, image: 220, narration: 190, remark: 130,
};

export function renderLegacyPdf(columns: Column[], rows: Record<string, unknown>[], title: string): InstanceType<typeof PDFDocument> {
  const doc = new PDFDocument({ layout: 'landscape', margin: 24, size: 'A3', bufferPages: true });
  const widths = columns.map((c) => COL_WIDTHS[c.key] ?? 80);
  const startX = doc.page.margins.left;
  const tableWidth = widths.reduce((a, b) => a + b, 0);

  doc.fontSize(18).font('Helvetica-Bold').text(title, startX, doc.y);
  doc.moveDown(0.5);

  const drawHeader = () => {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(11);
    let x = startX;
    for (let i = 0; i < columns.length; i++) {
      doc.rect(x, y, widths[i], 26).stroke();
      doc.text(columns[i].label, x + 4, y + 7, { width: widths[i] - 8, height: 18, ellipsis: true });
      x += widths[i];
    }
    doc.y = y + 26;
  };

  const rowHeight = (r: Record<string, unknown>) => {
    doc.font('Helvetica').fontSize(10);
    let maxLines = 1;
    for (let i = 0; i < columns.length; i++) {
      const text = String(r[columns[i].key] ?? '');
      const h = doc.heightOfString(text, { width: widths[i] - 8 });
      maxLines = Math.max(maxLines, Math.ceil(h / 12));
    }
    return Math.max(24, maxLines * 12 + 8);
  };

  drawHeader();
  for (const r of rows) {
    const h = rowHeight(r);
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) {
      doc.addPage({ layout: 'landscape', margin: 24, size: 'A3' });
      drawHeader();
    }
    const y = doc.y;
    const bg = r._bg as string | null | undefined;
    if (bg) doc.rect(startX, y, tableWidth, h).fill(bg);
    let x = startX;
    doc.font('Helvetica').fontSize(10).fillColor('black');
    for (let i = 0; i < columns.length; i++) {
      doc.rect(x, y, widths[i], h).stroke();
      doc.text(String(r[columns[i].key] ?? ''), x + 4, y + 4, { width: widths[i] - 8, height: h - 8 });
      x += widths[i];
    }
    doc.y = y + h;
  }
  return doc;
}
