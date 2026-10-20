import { AdminSignIn } from '@/components/auth/AdminSignIn';
export default function Landing({ onAuthorized }: { onAuthorized: () => void }) {
  return <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
    <section className="w-full max-w-md space-y-6 rounded-lg border bg-card p-8">
      <h1 className="text-3xl font-bold">K15M AMM</h1>
      <p className="text-sm text-muted-foreground">Kalshi BTC 15-minute contracts · Private admin dashboard</p>
      <AdminSignIn onVerified={onAuthorized} />
      <p className="text-xs text-muted-foreground">Trading runs in your browser. Pausing or signing out can leave resting orders; verify cancellations directly with Kalshi.</p>
    </section>
  </main>;
}
