/**
 * Normalizes extracted document text.
 * - Converts CRLF and CR to LF
 * - Removes non-printable control characters (preserving newlines and tabs)
 * - Collapses redundant horizontal spaces/tabs
 * - Collapses 3+ consecutive newlines to 2 (preserving paragraph breaks)
 * - Trims leading/trailing whitespaces
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  return text
    // 1. Normalize line endings
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // 2. Remove control characters (except \n, \t)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // 3. Normalize horizontal whitespace (spaces & tabs)
    .replace(/[^\S\n]+/g, ' ')
    // 4. Normalize lines (trim each line)
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    // 5. Collapse multiple blank lines to at most two newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Normalizes an array of page objects.
 * @param {Array<{ pageNumber: number, text: string }>} pages
 * @returns {Array<{ pageNumber: number, text: string }>}
 */
function normalizePages(pages) {
  if (!Array.isArray(pages)) return [];

  return pages
    .map((page) => ({
      pageNumber: page.pageNumber,
      text: normalizeText(page.text),
    }))
    .filter((page) => page.text.length > 0);
}

module.exports = {
  normalizeText,
  normalizePages,
};
