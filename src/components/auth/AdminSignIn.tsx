import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { adminSession, confirmAdminMfa, signOutAdmin, clearAdminSecrets } from "@/lib/adminAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TotpSetup } from "./TotpSetup";

export function AdminSignIn({ onVerified }: { onVerified: () => void }) {
  const [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [account, setAccount] = useState<string | null>(null), [loading, setLoading] = useState(true);
  const [factors, setFactors] = useState<Array<{ id: string; friendly_name?: string }>>([]);
  const [factorId, setFactorId] = useState(""), [code, setCode] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [approved, setApproved] = useState(false);
  useEffect(() => {
    let alive = true;
    const update = (value: string | null) => { if (alive) { setAccount(value); setLoading(false); setApproved(false); setFactors([]); setFactorId(""); setCode(""); } };
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (["SIGNED_IN", "SIGNED_OUT", "INITIAL_SESSION"].includes(event)) update(session?.user.email ?? null);
    });
    void supabase.auth.getSession().then(({ data }) => update(data.session?.user.email ?? null));
    return () => { alive = false; listener.subscription.unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!account) return;
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        await adminSession(); // Only a server-approved password session can begin admin setup.
        const { data, error: failure } = await supabase.auth.mfa.listFactors();
        if (failure) throw failure;
        if (alive) { setFactors(data.totp); setFactorId(data.totp[0]?.id ?? ""); setApproved(true); setError(""); }
      } catch { if (alive) setError("Sign in with the password for an approved, confirmed admin account. Contact the administrator if access is not configured."); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [account]);
  const login = async () => {
    setBusy(true); setError("");
    try {
      const { error: failure } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (failure) throw failure;
    } catch { setError("Sign-in failed. Check your email and password, or contact the administrator."); }
    finally { setPassword(""); setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError("");
    try {
      const { error: failure } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
      if (failure) throw failure;
      await confirmAdminMfa(); setCode(""); onVerified();
    } catch { setCode(""); setError("Verification failed. Enter a current authenticator code and try again."); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true);
    try {
      if (approved) await signOutAdmin();
      else { const { error: failure } = await supabase.auth.signOut(); if (failure) throw failure; clearAdminSecrets(); }
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Sign-out failed"); }
    finally { setBusy(false); }
  };
  return <div className="space-y-5">
    <h2 className="text-2xl font-semibold">Admin sign-in</h2>
    <p className="text-sm text-muted-foreground">Use your approved email, password and authenticator app to manage Kalshi settings.</p>
    {loading ? <p role="status">Checking account…</p> : !account ? <form onSubmit={(e) => { e.preventDefault(); void login(); }} className="space-y-3">
      <Label htmlFor="login-email">Email</Label><Input id="login-email" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Label htmlFor="login-password">Password</Label><Input id="login-password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <Button className="w-full" disabled={busy}>Sign in</Button>
      <p className="text-xs text-muted-foreground">Accounts and password recovery are managed by your administrator in Supabase. Public registration is unavailable.</p>
    </form> : <>
      <p className="text-sm">{account}</p>
      {approved && (factors.length ? <form onSubmit={(e) => { e.preventDefault(); void verify(); }} className="space-y-3">
        <Label htmlFor="authenticator">Authenticator</Label><select id="authenticator" className="w-full rounded border bg-background p-2" value={factorId} onChange={(e) => setFactorId(e.target.value)}>{factors.map((f) => <option key={f.id} value={f.id}>{f.friendly_name ?? "Authenticator"}</option>)}</select>
        <Label htmlFor="login-code">Six-digit authenticator code</Label><Input id="login-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        <Button className="w-full" disabled={busy || code.length !== 6}>Verify and open dashboard</Button>
      </form> : <TotpSetup onVerified={onVerified} />)}
      <Button variant="outline" disabled={busy || loading} onClick={() => void logout()}>Sign out</Button>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
