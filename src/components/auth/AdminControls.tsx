import { useState } from 'react';
import { signOutAdmin } from '@/lib/adminAuth';
import { Button } from '@/components/ui/button';
import { TotpSetup } from './TotpSetup';
export function AdminControls() {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const logout = async () => {
    setBusy(true); setError('');
    try { await signOutAdmin(); } catch { setError('Sign-out failed. The local bot has been paused; retry sign-out.'); }
    finally { setBusy(false); }
  };
  return <aside className="border-b bg-card p-3 text-sm">
    <div className="container flex flex-wrap items-center gap-3">
      <span>Private admin session · DEMO migration</span>
      <Button variant="outline" size="sm" onClick={() => setOpen(!open)}>Authenticator settings</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void logout()}>Sign out and pause</Button>
      <span className="text-xs text-muted-foreground">Resting orders may remain. Verify cancellations in Kalshi before signing out.</span>
      {error && <p role="alert">{error}</p>}
      {open && <div className="w-full"><TotpSetup backup onVerified={() => setOpen(false)} /></div>}
    </div>
  </aside>;
}
