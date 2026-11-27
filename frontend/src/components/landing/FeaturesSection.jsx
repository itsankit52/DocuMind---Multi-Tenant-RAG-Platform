/** Capabilities as an editorial list (not cards): numbered rows with one concrete detail each. */

import { Icon } from './LandingIcons';
import { Section, SectionHeader } from './LandingPrimitives';

const FEATURES = [
  {
    icon: 'fileText',
    title: 'Document Intelligence',
    text: 'Upload PDF and DOCX documents and make their content searchable.',
    detail: 'Text is extracted and indexed in the background. Each document shows its status until it is ready.',
  },
  {
    icon: 'messageText',
    title: 'Context-Aware Answers',
    text: 'Ask natural-language questions and receive answers based on retrieved document content.',
    detail: 'Follow-up questions keep the conversation’s context, and every answer lists its sources.',
  },
  {
    icon: 'building',
    title: 'Multi-Tenant Isolation',
    text: 'Keep each organization’s documents and knowledge separated.',
    detail: 'Every organization gets its own workspace; people can belong to several and switch between them.',
  },
  {
    icon: 'users',
    title: 'Role-Based Access',
    text: 'Control which members can upload, view and manage documents.',
    detail: 'Admins manage people and invitations, members manage documents, viewers read and ask.',
  },
];

export function FeaturesSection() {
  return (
    <Section id="features" labelledBy="features-title" alt>
      <div className="grid gap-10 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-4">
          <div className="lg:sticky lg:top-24">
            <SectionHeader id="features-title" eyebrow="Capabilities" title="Built around the way teams use documents.">
              Four capabilities, designed to work together inside one organization workspace.
            </SectionHeader>
          </div>
        </div>
        <ol className="m-0 list-none border-t border-lp-line p-0 lg:col-span-7 lg:col-start-6">
          {FEATURES.map((f, i) => (
            <li key={f.title} className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-4 border-b border-lp-line py-7 sm:grid-cols-[56px_minmax(0,1fr)_minmax(0,1fr)] sm:gap-x-8">
              <span className="font-mono text-[12px] leading-7 text-lp-muted">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <h3 className="m-0 flex items-center gap-2 text-[17px] font-semibold tracking-tight text-lp-ink">
                  <Icon name={f.icon} size={17} className="text-lp-accent" /> {f.title}
                </h3>
                <p className="m-0 mt-2 text-[15px] leading-relaxed text-lp-ink">{f.text}</p>
              </div>
              <p className="col-start-2 m-0 mt-3 text-[14px] leading-relaxed text-lp-muted sm:col-start-3 sm:mt-0 sm:pt-[3px]">{f.detail}</p>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}
