const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

/**
 * Extracts text page-by-page from a PDF buffer using pdfjs-dist legacy build.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ fullText: string, pages: Array<{ pageNumber: number, text: string }>, numPages: number }>}
 */
async function extractPdfText(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('PDF buffer is empty or invalid.');
  }

  try {
    const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const loadingTask = pdfjsLib.getDocument({
      data: uint8,
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: true,
    });

    const doc = await loadingTask.promise;
    const numPages = doc.numPages;
    const pages = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => (item.str !== undefined ? item.str : ''))
        .join(' ')
        .trim();

      if (pageText.length > 0) {
        pages.push({
          pageNumber: pageNum,
          text: pageText,
        });
      }
    }

    const fullText = pages.map((p) => p.text).join('\n\n').trim();

    return {
      fullText,
      pages: pages.length > 0 ? pages : [{ pageNumber: 1, text: fullText }],
      numPages: numPages || 1,
    };
  } catch (err) {
    throw new Error(`PDF extraction failed: ${err.message}`);
  }
}

module.exports = {
  extractPdfText,
};
