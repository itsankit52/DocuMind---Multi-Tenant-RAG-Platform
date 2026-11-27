import { CONTAINER, LandingButton } from './LandingPrimitives';

export function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="border-t border-lp-line bg-white">
      <div className={`${CONTAINER} grid gap-6 py-20 sm:py-24 lg:grid-cols-12 lg:items-end lg:gap-10`}>
        <div className="lg:col-span-7">
          <h2 id="cta-title" className="m-0 max-w-[22ch] text-[28px] leading-[1.15] font-semibold tracking-tight text-lp-ink sm:text-[34px]">
            Make your organization’s knowledge easier to access.
          </h2>
        </div>
        <div className="lg:col-span-4 lg:col-start-9">
          <p className="m-0 text-base leading-relaxed text-lp-muted">
            Give your team one place to find answers across organizational documents.
          </p>
          <LandingButton to="/register" className="mt-6 h-10 px-4">Get Started</LandingButton>
        </div>
      </div>
    </section>
  );
}
