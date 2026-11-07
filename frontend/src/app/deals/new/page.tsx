import { DealForm } from "@/components/deal/deal-form";
import { ParticlesBackground } from "@/components/effects/particles-background";

export default function NewDealPage() {
  return (
    <main className="page-shell" style={{ "--stage": "var(--orchid)" } as React.CSSProperties}>
      <ParticlesBackground variant="new" />
      <h1 className="page-title">Start a deal</h1>
      <p className="page-intro">
        Set each side's limits. The AI agents will negotiate inside them.
      </p>
      <DealForm />
    </main>
  );
}
