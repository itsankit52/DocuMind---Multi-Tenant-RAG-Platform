/**
 * Product demonstration: one question and answer rendered with the real chat components
 * (PreviewMessage → MessageContent + CitationList), annotated with what each part is.
 * The citation fields are the ones the app really shows: document, page or section, match %.
 */

import { PreviewFrame, PreviewMessage } from './AppPreview';
import { Section, SectionHeader } from './LandingPrimitives';

const QUESTION = { role: 'user', content: 'What is our company’s document retention policy?', createdAt: '2026-11-27T09:41:00Z' };
const ANSWER = {
  role: 'assistant',
  createdAt: '2026-11-27T09:41:00Z',
  content: 'Records are kept for a fixed period based on their category:\n\n- **Financial records** (invoices, ledgers, tax filings): 7 years\n- **Employee records**: 6 years after employment ends\n- **Contracts**: 6 years after they expire\n\nRecords under a **legal hold** must not be deleted until Legal releases the hold, even after the retention period has passed.',
  citations: [
    { id: 'a1', documentName: 'Records Retention Policy.docx', page: null, chunkIndex: 2, relevanceScore: 0.86 },
    { id: 'a2', documentName: 'Records Retention Policy.docx', page: null, chunkIndex: 5, relevanceScore: 0.81 },
    { id: 'a3', documentName: 'Employee Handbook 2026.pdf', page: 31, chunkIndex: 44, relevanceScore: 0.73 },
  ],
};

const NOTES = [
  ['The question', 'Asked in plain language, inside your organization’s workspace — no search syntax, no folders to browse.'],
  ['A grounded answer', 'DocuMind finds the most relevant passages in your organization’s documents and writes the answer from them. The answer streams in as it is generated.'],
  ['Sources you can check', 'Every answer lists the documents it used, with the page or section and how closely each passage matched the question.'],
];

export function AnswersSection() {
  return (
    <Section id="product" labelledBy="answers-title">
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-5">
          <SectionHeader id="answers-title" eyebrow="Product" title="Answers backed by your documents.">
            Ask a question the way you would ask a colleague. The answer comes from your own documents, and tells you where it came from.
          </SectionHeader>
          <ol className="m-0 mt-10 list-none space-y-6 border-t border-lp-line p-0 pt-6">
            {NOTES.map(([title, text], i) => (
              <li key={title} className="grid grid-cols-[32px_minmax(0,1fr)] gap-2">
                <span className="font-mono text-[12px] leading-6 text-lp-accent">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <h3 className="m-0 text-[15px] font-semibold text-lp-ink">{title}</h3>
                  <p className="m-0 mt-1 text-[14.5px] leading-relaxed text-lp-muted">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <figure className="m-0 min-w-0 lg:col-span-7">
          <PreviewFrame label="Conversations — Records retention">
            <div className="message-list bg-bg">
              <PreviewMessage {...QUESTION} />
              <PreviewMessage {...ANSWER} />
            </div>
          </PreviewFrame>
          <figcaption className="mt-3 text-[13px] text-lp-muted">
            Illustrative sample — the policy and documents are examples. Rendered with DocuMind’s chat components.
          </figcaption>
        </figure>
      </div>
    </Section>
  );
}
