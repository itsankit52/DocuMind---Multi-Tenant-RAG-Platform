const mammoth = require('mammoth');

/**
 * Extracts raw text from a DOCX buffer.
 * @param {Buffer} buffer
 * @returns {Promise<{ fullText: string, pages: Array<{ pageNumber: number, text: string }>, numPages: number }>}
 */
async function extractDocxText(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('DOCX buffer is empty or invalid.');
  }

  try {
    const result = await mammoth.extractRawText({ buffer });
    const fullText = (result.value || '').trim();

    return {
      fullText,
      pages: [
        {
          pageNumber: 1,
          text: fullText,
        },
      ],
      numPages: 1,
      messages: result.messages,
    };
  } catch (err) {
    throw new Error(`DOCX extraction failed: ${err.message}`);
  }
}

module.exports = {
  extractDocxText,
};
