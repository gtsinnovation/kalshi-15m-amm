import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { adminSession, confirmAdminMfa } from "@/lib/adminAuth";

export function TotpSetup({ onVerified, backup = false }: { onVerified: () => void; backup?: boolean }) {
  const [pending, setPending] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const enroll = async () => {
    setBusy(true); setError("");
    try {
      if (backup) await confirmAdminMfa(); else await adminSession();
      const { data, error: failure } = await supabase.auth.mfa.enroll({
        factorType: "totp", issuer: "K15M AMM", friendlyName: `K15M ${backup ? "backup" : "admin"} ${crypto.randomUUID().slice(0, 8)}`,
      });
      if (failure) throw failure;
      setPending({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    } catch (e) { setError(e instanceof Error ? e.message : "Authenticator setup failed"); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    if (!pending || !/^\d{6}$/.test(code)) return;
    setBusy(true); setError("");
    try {
      const { error: failure } = await supabase.auth.mfa.challengeAndVerify({ factorId: pending.id, code });
      if (failure) throw failure;
      await confirmAdminMfa(); setPending(null); setCode(""); onVerified();
    } catch (e) { setCode(""); setError(e instanceof Error ? e.message : "Verification failed"); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!pending) return;
    setBusy(true); setError("");
    try {
      const { error: failure } = await supabase.auth.mfa.unenroll({ factorId: pending.id });
      if (failure) throw failure;
      setPending(null); setCode("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not cancel enrollment"); }
    finally { setBusy(false); }
  };
  return <div className="space-y-4">
    {!pending ? <Button onClick={() => void enroll()} disabled={busy}>{backup ? "Add backup authenticator" : "Set up authenticator"}</Button> : <>
      <p className="text-sm">Scan this code with your authenticator app, then enter its six-digit code. Keep this setup private.</p>
      <img src={pending.qr.startsWith("data:") ? pending.qr : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pending.qr)}`} alt="Authenticator enrollment QR code" className="h-48 w-48 rounded bg-white p-2" />
      <details><summary className="cursor-pointer text-sm">Enter the setup key manually</summary><code className="block break-all p-2 select-all">{pending.secret}</code></details>
      <form onSubmit={(e) => { e.preventDefault(); void verify(); }} className="space-y-3">
        <Label htmlFor="enroll-code">Authenticator code</Label>
        <Input id="enroll-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        <div className="flex gap-2"><Button disabled={busy || code.length !== 6}>Verify authenticator</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()}>Cancel setup</Button></div>
      </form>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
