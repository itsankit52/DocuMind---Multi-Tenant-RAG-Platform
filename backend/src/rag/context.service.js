/**
 * RAG Context Builder Service
 * Formats retrieved document chunks into clean, structured context for LLM prompt injection defense.
 * Strictly bounds context size and clearly demarcates document content as untrusted reference data.
 */

const env = require('../config/env');

// Document text is untrusted: it must not be able to forge the section delimiters that tell
// the model where one source ends and instructions could begin.
const MARKER_RE = /\[\s*(END OF SOURCE|DOCUMENT SOURCE)[^\]]*\]/gi;
const neutralize = (text) => String(text || '').replace(MARKER_RE, '[marker removed]');
const singleLine = (text) => neutralize(text).replace(/[\r\n]+/g, ' ').slice(0, 255);

class ContextService {
  /**
   * Constructs a structured context block from verified document chunks.
   *
   * @param {Array<object>} chunks - List of retrieved chunks
   * @param {number} maxChars - Maximum characters allowed in context
   * @returns {{ contextText: string, sources: Array<object> }}
   */
  buildContext(chunks = [], maxChars = env.RAG_MAX_CONTEXT_CHARS || 15000) {
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return { contextText: '', sources: [] };
    }

    const formattedSources = [];
    const contextSections = [];
    let currentTotalChars = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const sourceNum = i + 1;
      const pageInfo = chunk.pageStart
        ? (chunk.pageEnd && chunk.pageEnd !== chunk.pageStart ? `${chunk.pageStart}-${chunk.pageEnd}` : `${chunk.pageStart}`)
        : 'N/A';

      // Clean chunk text
      const cleanContent = neutralize(chunk.content).trim();
      const sectionHeader = `[DOCUMENT SOURCE ${sourceNum}]\nDocument: ${singleLine(chunk.documentName) || 'Document'}\nPages: ${pageInfo}\nContent:\n`;
      const sectionFooter = `\n[END OF SOURCE ${sourceNum}]\n`;

      const candidateSection = `${sectionHeader}${cleanContent}${sectionFooter}`;
      if (currentTotalChars + candidateSection.length > maxChars && contextSections.length > 0) {
        // Exceeds max context size -> stop adding further chunks
        break;
      }

      contextSections.push(candidateSection);
      currentTotalChars += candidateSection.length;

      formattedSources.push({
        sourceNumber: sourceNum,
        documentId: chunk.documentId,
        chunkId: chunk.chunkId,
        documentName: chunk.documentName,
        chunkIndex: chunk.chunkIndex,
        pageStart: chunk.pageStart || null,
        pageEnd: chunk.pageEnd || null,
        score: chunk.score,
      });
    }

    const contextText = contextSections.join('\n');
    return {
      contextText,
      sources: formattedSources,
    };
  }
}

module.exports = require('../observability/instrument').instrumentContext(new ContextService());
