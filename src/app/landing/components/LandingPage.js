"use client";

import Navigation from "./Navigation";
import HeroSection from "./HeroSection";
import FlowAnimation from "./FlowAnimation";
import HowItWorks from "./HowItWorks";
import Features from "./Features";
import GetStarted from "./GetStarted";
import Footer from "./Footer";

// Public landing page. Rendered by src/app/page.js (a server component) so the
// root can redirect live sessions to /dashboard or /account before any of this
// markup is produced.
//
// Section order is fixed: hero → what it does → how it works → features →
// get started (with the closing call to action) → footer.
export default function LandingPage() {
  return (
    <div className="min-h-screen bg-bg text-text-main antialiased">
      <Navigation />

      <main>
        <HeroSection />

        <section id="product" className="border-b border-border">
          <div className="shell py-20">
            <p className="meta text-text-muted">What it does</p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
              One proxy in front of every provider
            </h2>
            <p className="mt-3 max-w-2xl text-text-muted">
              Your tools keep speaking the OpenAI wire format. derouter resolves the model you asked for to a
              provider connection, streams the response back, and records what the request cost.
            </p>

            <FlowAnimation />
          </div>
        </section>

        <HowItWorks />
        <Features />
        <GetStarted />
      </main>

      <Footer />
    </div>
  );
}
