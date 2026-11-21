const { PDFDocument, StandardFonts } = require('pdf-lib');

/**
 * Creates a valid synthetic multi-page PDF buffer for testing.
 * @param {string[]} pageTexts
 * @returns {Promise<Buffer>}
 */
async function createTestPdf(pageTexts = ['Page 1: DocuMind Architecture Overview and Multi-Tenant Security Details', 'Page 2: Worker Processing Pipeline and Chunking Specifications']) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const text of pageTexts) {
    const page = pdfDoc.addPage([600, 400]);
    page.drawText(text, {
      x: 50,
      y: 350,
      size: 12,
      font,
    });
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Creates an empty PDF (no text streams).
 * @returns {Promise<Buffer>}
 */
async function createEmptyPdf() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([600, 400]);
  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = {
  createTestPdf,
  createEmptyPdf,
};
