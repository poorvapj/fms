// Renders the legacy-format job card table (see reports.ts' legacyAllSection/legacyPendingSection)
// as a landscape PDF that mirrors the old "FMS - Pending Complaint" sheet printout.
import PDFDocument from 'pdfkit';
import type { Column } from './reports.ts';

const COL_WIDTHS: Record<string, number> = {
  row_no: 35, time: 75, site: 85, work_category: 70, image_1: 150, image_2: 150, narration: 170, sheet_row_no: 45, remark: 110,
};

export function renderLegacyPdf(columns: Column[], rows: Record<string, unknown>[], title: string): InstanceType<typeof PDFDocument> {
  const doc = new PDFDocument({ layout: 'landscape', margin: 24, size: 'A3', bufferPages: true });
  const widths = columns.map((c) => COL_WIDTHS[c.key] ?? 80);
  const startX = doc.page.margins.left;
  const tableWidth = widths.reduce((a, b) => a + b, 0);

  doc.fontSize(14).font('Helvetica-Bold').text(title, startX, doc.y);
  doc.moveDown(0.5);

  const drawHeader = () => {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8);
    let x = startX;
    for (let i = 0; i < columns.length; i++) {
      doc.rect(x, y, widths[i], 20).stroke();
      doc.text(columns[i].label, x + 3, y + 6, { width: widths[i] - 6, height: 14, ellipsis: true });
      x += widths[i];
    }
    doc.y = y + 20;
  };

  const rowHeight = (r: Record<string, unknown>) => {
    doc.font('Helvetica').fontSize(7);
    let maxLines = 1;
    for (let i = 0; i < columns.length; i++) {
      const text = String(r[columns[i].key] ?? '');
      const h = doc.heightOfString(text, { width: widths[i] - 6 });
      maxLines = Math.max(maxLines, Math.ceil(h / 9));
    }
    return Math.max(18, maxLines * 9 + 6);
  };

  drawHeader();
  for (const r of rows) {
    const h = rowHeight(r);
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) {
      doc.addPage({ layout: 'landscape', margin: 24, size: 'A3' });
      drawHeader();
    }
    const y = doc.y;
    let x = startX;
    doc.font('Helvetica').fontSize(7);
    for (let i = 0; i < columns.length; i++) {
      doc.rect(x, y, widths[i], h).stroke();
      doc.text(String(r[columns[i].key] ?? ''), x + 3, y + 3, { width: widths[i] - 6, height: h - 6 });
      x += widths[i];
    }
    doc.y = y + h;
  }
  void tableWidth;
  return doc;
}
