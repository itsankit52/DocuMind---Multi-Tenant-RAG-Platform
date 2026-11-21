const env = require('../config/env');

/**
 * Splits text or pages into deterministic overlapping chunks with page metadata.
 *
 * @param {Array<{ pageNumber: number, text: string }>} pages - Normalized pages
 * @param {object} [options]
 * @param {number} [options.chunkSize]
 * @param {number} [options.chunkOverlap]
 * @param {number} [options.maxChunks]
 * @returns {Array<{ chunkIndex: number, content: string, pageStart: number, pageEnd: number, characterCount: number }>}
 */
function createChunks(pages, options = {}) {
  const chunkSize = options.chunkSize || env.CHUNK_SIZE || 1000;
  const chunkOverlap = options.chunkOverlap !== undefined ? options.chunkOverlap : (env.CHUNK_OVERLAP || 150);
  const maxChunks = options.maxChunks || env.MAX_CHUNKS_PER_DOCUMENT || 5000;

  if (chunkOverlap >= chunkSize) {
    throw new Error(`Invalid chunk configuration: overlap (${chunkOverlap}) must be less than chunkSize (${chunkSize})`);
  }

  const chunks = [];
  let currentChunkText = '';
  let currentStartPage = null;
  let currentEndPage = null;
  let chunkIndex = 0;

  // Flatten pages with page markers to track pageStart and pageEnd
  const segments = [];
  for (const page of pages) {
    if (!page.text || page.text.trim().length === 0) continue;
    // Split page into paragraphs
    const paragraphs = page.text.split('\n\n').filter(p => p.trim().length > 0);
    for (const para of paragraphs) {
      segments.push({
        text: para.trim(),
        pageNumber: page.pageNumber,
      });
    }
  }

  if (segments.length === 0) {
    return [];
  }

  // Iterate over segments to construct chunks
  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const segment = segments[sIdx];
    const segmentText = segment.text;
    const pageNum = segment.pageNumber;

    if (currentStartPage === null) {
      currentStartPage = pageNum;
    }
    currentEndPage = pageNum;

    if (currentChunkText.length === 0) {
      // If a single segment is larger than chunkSize, sub-split it by sentences/words
      if (segmentText.length > chunkSize) {
        const subParts = splitLargeText(segmentText, chunkSize, chunkOverlap);
        for (const subPart of subParts) {
          if (chunks.length >= maxChunks) {
            throw new Error(`Document exceeded maximum chunk limit of ${maxChunks} chunks.`);
          }
          chunks.push({
            chunkIndex: chunkIndex++,
            content: subPart,
            pageStart: pageNum,
            pageEnd: pageNum,
            characterCount: subPart.length,
          });
        }
        currentChunkText = '';
        currentStartPage = null;
        currentEndPage = null;
      } else {
        currentChunkText = segmentText;
      }
    } else {
      // Check if adding this segment fits within chunkSize
      if (currentChunkText.length + 2 + segmentText.length <= chunkSize) {
        currentChunkText += '\n\n' + segmentText;
        currentEndPage = pageNum;
      } else {
        // Current chunk is full -> save it
        if (chunks.length >= maxChunks) {
          throw new Error(`Document exceeded maximum chunk limit of ${maxChunks} chunks.`);
        }

        chunks.push({
          chunkIndex: chunkIndex++,
          content: currentChunkText,
          pageStart: currentStartPage,
          pageEnd: currentEndPage,
          characterCount: currentChunkText.length,
        });

        // Compute overlap for next chunk
        const overlapText = getOverlapText(currentChunkText, chunkOverlap);
        currentChunkText = overlapText ? overlapText + '\n\n' + segmentText : segmentText;
        currentStartPage = overlapText ? currentStartPage : pageNum;
        currentEndPage = pageNum;

        // If the newly formed chunk is still oversized, handle it
        if (currentChunkText.length > chunkSize) {
          const subParts = splitLargeText(currentChunkText, chunkSize, chunkOverlap);
          for (let i = 0; i < subParts.length - 1; i++) {
            if (chunks.length >= maxChunks) {
              throw new Error(`Document exceeded maximum chunk limit of ${maxChunks} chunks.`);
            }
            chunks.push({
              chunkIndex: chunkIndex++,
              content: subParts[i],
              pageStart: currentStartPage,
              pageEnd: currentEndPage,
              characterCount: subParts[i].length,
            });
          }
          currentChunkText = subParts[subParts.length - 1];
          currentStartPage = pageNum;
        }
      }
    }
  }

  // Push final remaining chunk
  if (currentChunkText.trim().length > 0) {
    if (chunks.length >= maxChunks) {
      throw new Error(`Document exceeded maximum chunk limit of ${maxChunks} chunks.`);
    }
    chunks.push({
      chunkIndex: chunkIndex++,
      content: currentChunkText.trim(),
      pageStart: currentStartPage || 1,
      pageEnd: currentEndPage || 1,
      characterCount: currentChunkText.trim().length,
    });
  }

  return chunks;
}

/**
 * Extracts the tail of a text string up to max overlap characters, breaking at a word boundary.
 */
function getOverlapText(text, overlapSize) {
  if (!text || overlapSize <= 0) return '';
  if (text.length <= overlapSize) return text;

  const slice = text.slice(-overlapSize);
  const firstSpace = slice.indexOf(' ');
  if (firstSpace !== -1 && firstSpace < slice.length - 10) {
    return slice.slice(firstSpace + 1);
  }
  return slice;
}

/**
 * Splits oversized continuous text into chunks with overlap.
 */
function splitLargeText(text, chunkSize, chunkOverlap) {
  const parts = [];
  let start = 0;

  while (start < text.length) {
    let end = start + chunkSize;
    if (end >= text.length) {
      parts.push(text.slice(start).trim());
      break;
    }

    // Try to break at a sentence or word boundary near end
    let breakIdx = text.lastIndexOf('. ', end);
    if (breakIdx <= start + chunkOverlap) {
      breakIdx = text.lastIndexOf(' ', end);
    }
    if (breakIdx <= start + chunkOverlap) {
      breakIdx = end;
    }

    const chunk = text.slice(start, breakIdx).trim();
    if (chunk.length > 0) {
      parts.push(chunk);
    }

    start = breakIdx - chunkOverlap;
    if (start >= end) {
      start = end;
    }
  }

  return parts.filter(p => p.length > 0);
}

module.exports = {
  createChunks,
  normalizeText: require('./normalizer').normalizeText,
};
