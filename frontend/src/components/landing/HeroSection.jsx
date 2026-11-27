import { Icon } from './LandingIcons';
import { CONTAINER, Eyebrow, LandingButton } from './LandingPrimitives';
import { ChatScreen, DocumentsScreen, PreviewFrame, SAMPLE_DOCUMENTS } from './AppPreview';

const CONVERSATIONS = [
  { title: 'Vendor onboarding requirements', updatedAt: '2026-11-27T10:24:00Z' },
  { title: 'Travel reimbursement limits', updatedAt: '2026-11-26T16:03:00Z' },
  { title: 'Parental leave policy', updatedAt: '2026-11-25T11:47:00Z' },
];

const MESSAGES = [
  { role: 'user', content: 'Which vendors need a security review before onboarding?', createdAt: '2026-11-27T10:23:00Z' },
  {
    role: 'assistant',
    createdAt: '2026-11-27T10:24:00Z',
    content: 'Any vendor that will **store or process company data** must pass a security review before a contract is signed. The review covers:\n\n- where data is stored and who can access it\n- incident notification within 72 hours\n- a yearly re-assessment for critical vendors',
    citations: [
      { id: 'h1', documentName: 'Vendor Security Standard.pdf', page: 4, chunkIndex: 6, relevanceScore: 0.84 },
      { id: 'h2', documentName: 'Vendor Security Standard.pdf', page: 5, chunkIndex: 8, relevanceScore: 0.77 },
    ],
  },
];

export function HeroSection() {
  return (
    <section aria-labelledby="hero-title" className="bg-white">
      <div className={`${CONTAINER} pt-16 pb-14 sm:pt-24 sm:pb-16`}>
        <div className="grid gap-8 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-8">
            <Eyebrow>Document intelligence platform</Eyebrow>
            <h1 id="hero-title" className="m-0 mt-5 max-w-[14ch] text-[22px] leading-[1.08] font-semibold tracking-[-0.025em] text-lp-ink sm:text-[38px]">
              Your organization’s knowledge, finally searchable.
            </h1>
          </div>
          <div className="lg:col-span-4 lg:self-end">
            <p className="m-0 text-[16.5px] leading-relaxed text-lp-muted">
              Bring your documents together, ask questions in natural language, and get answers grounded in your
              organization’s knowledge.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
              <LandingButton to="/register" className="h-10 px-4">Get Started</LandingButton>
              <a href="#product" className="inline-flex items-center gap-1.5 text-sm font-medium text-lp-ink no-underline hover:text-lp-accent">
                Explore the product <Icon name="arrowRight" size={15} />
              </a>
            </div>
          </div>
        </div>
      </div>

      <figure className="m-0 border-t border-lp-line bg-lp-alt">
        <div className={`${CONTAINER} py-8 sm:py-12`}>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
            <PreviewFrame label="Conversations — Acme Corp">
              <ChatScreen title="Vendor onboarding requirements" conversations={CONVERSATIONS} messages={MESSAGES} height={540} />
            </PreviewFrame>
            <PreviewFrame label="Documents — Acme Corp" className="self-start">
              <DocumentsScreen documents={SAMPLE_DOCUMENTS} columns={['name', 'status']} shell={false} />
            </PreviewFrame>
          </div>
          <figcaption className="mt-4 max-w-2xl text-[13px] leading-relaxed text-lp-muted">
            The DocuMind interface, rendered with the application’s own components: an organization workspace, its
            uploaded documents, and a question answered with sources. Workspace, documents and conversation are sample content.
          </figcaption>
        </div>
      </figure>
    </section>
  );
}
