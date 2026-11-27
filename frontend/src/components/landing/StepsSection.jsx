/** How it works: four numbered steps on a single rule (horizontal on desktop, stacked on mobile). */

import { Section, SectionHeader } from './LandingPrimitives';

const STEPS = [
  ['Create your organization.', 'Set up a workspace for your team and invite people with the role they need.'],
  ['Upload your documents.', 'Add PDF and DOCX files — policies, handbooks, contracts, reports.'],
  ['Process and index content.', 'DocuMind extracts the text, splits it into passages and indexes them for search, in the background.'],
  ['Ask questions and explore cited answers.', 'Ask in plain language, then open the sources behind every answer.'],
];

export function StepsSection() {
  return (
    <Section id="how-it-works" labelledBy="steps-title">
      <SectionHeader id="steps-title" eyebrow="How it works" title="From documents to useful answers." />
      <ol className="m-0 mt-12 grid list-none gap-0 border-t border-lp-line p-0 md:grid-cols-2 lg:grid-cols-4">
        {STEPS.map(([title, text], i) => (
          <li key={title} className={`relative border-b border-lp-line py-6 md:pr-8 lg:border-b-0 lg:pt-8 ${i % 2 === 1 ? 'md:pl-8 lg:pl-0' : ''} ${i > 0 ? 'lg:pl-8' : ''}`}>
            {/* tick on the rule marking each step */}
            <span aria-hidden="true" className="absolute -top-[3.5px] left-0 hidden h-[7px] w-[7px] rounded-full bg-lp-accent lg:block" style={i > 0 ? { left: '2rem' } : undefined} />
            <span className="font-mono text-[12px] text-lp-accent">{String(i + 1).padStart(2, '0')}</span>
            <h3 className="m-0 mt-3 text-[16px] font-semibold tracking-tight text-lp-ink">{title}</h3>
            <p className="m-0 mt-2 text-[14.5px] leading-relaxed text-lp-muted">{text}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
