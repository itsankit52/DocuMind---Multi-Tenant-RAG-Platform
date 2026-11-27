/**
 * Public landing page, shown at "/" to signed-out visitors (signed-in users get the dashboard
 * there, see ProtectedRoute). Loaded lazily, so the Inter font and this code load only here.
 * Editorial layout on a fixed light palette; product previews are the real app UI
 * (components/landing/AppPreview.jsx) with labelled sample content.
 */

import '@fontsource-variable/inter';
import { LandingNavbar } from '../components/landing/LandingNavbar';
import { HeroSection } from '../components/landing/HeroSection';
import { AnswersSection } from '../components/landing/AnswersSection';
import { FeaturesSection } from '../components/landing/FeaturesSection';
import { StepsSection } from '../components/landing/StepsSection';
import { SecuritySection } from '../components/landing/SecuritySection';
import { FinalCta } from '../components/landing/FinalCta';
import { LandingFooter } from '../components/landing/LandingFooter';

export function LandingPage() {
  return (
    <div className="landing min-h-full bg-white font-landing text-lp-ink antialiased [color-scheme:light]">
      <a href="#main" className="skip-link">Skip to content</a>
      <LandingNavbar />
      <main id="main">
        <HeroSection />
        <AnswersSection />
        <FeaturesSection />
        <StepsSection />
        <SecuritySection />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
