import { useEffect, useState } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useBotStore } from "@/lib/store";
import { KalshiClient, CLOUD_PROXY } from "@/lib/kalshi/client";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, CheckCircle2, Loader2, Lock, ShieldAlert, ShieldCheck, Trash2, AlertOctagon, Eye, EyeOff } from "lucide-react";
import type { KalshiEnv } from "@/lib/kalshi/types";
import {
  validatePem,
  PEM_BADGE_CLASS,
  convertPkcs1ToPkcs8,
  type PemValidationResult,
} from "@/lib/kalshi/pem";
import { encryptPem, forgetSessionPassphrase, rememberPassphraseForSession } from "@/lib/security/vault";
import { pause } from "@/lib/scheduler/loop";
import { clearTickerMismatches, clearAuditLog } from "@/lib/audit/logStore";
import { clearRiskAcceptance } from "@/components/RiskDisclaimerGate";

/**
 * Zod schema for the credentials form. Kept lenient on PEM (the dedicated
 * `validatePem` cryptographic check still runs) — this layer only catches
 * obvious shape mistakes before we hit Web Crypto.
 */
const proxySchema = z
  .string()
  .trim()
  .max(500, "Proxy URL too long")
  .refine(
    (v) => v === "" || v === CLOUD_PROXY || /^https?:\/\//i.test(v),
    "Proxy must start with http:// or https://",
  );

const credentialsSchema = z.object({
  keyId: z
    .string()
    .trim()
    .min(8, "Key ID looks too short")
    .max(128, "Key ID looks too long")
    .regex(/^[A-Za-z0-9_-]+$/, "Key ID may only contain letters, digits, _ and -"),
  env: z.enum(["demo", "prod"]),
  proxy: proxySchema,
});

export function SettingsPanel() {
  const credentials = useBotStore((s) => s.credentials);
  const setCredentials = useBotStore((s) => s.setCredentials);
  const encryptedCredentials = useBotStore((s) => s.encryptedCredentials);
  const setEncryptedCredentials = useBotStore((s) => s.setEncryptedCredentials);
  const setVaultLocked = useBotStore((s) => s.setVaultLocked);
  const idleLockMinutes = useBotStore((s) => s.idleLockMinutes);
  const setIdleLockMinutes = useBotStore((s) => s.setIdleLockMinutes);
  const marketReloadMinutes = useBotStore((s) => s.marketReloadMinutes);
  const setMarketReloadMinutes = useBotStore((s) => s.setMarketReloadMinutes);
  const [reloadMinutesInput, setReloadMinutesInput] = useState(
    (marketReloadMinutes ?? [0, 16, 31, 45]).join(", "),
  );
  useEffect(() => {
    setReloadMinutesInput((marketReloadMinutes ?? [0, 16, 31, 45]).join(", "));
  }, [marketReloadMinutes]);
  const [keyId, setKeyId] = useState(credentials?.keyId ?? "");
  const [pem, setPem] = useState("");
  const proxy = CLOUD_PROXY;
  const [env, setEnv] = useState<KalshiEnv>(credentials?.env ?? encryptedCredentials?.env ?? "demo");
  const [testing, setTesting] = useState(false);
  const [pemCheck, setPemCheck] = useState<PemValidationResult | null>(null);
  const [pemChecking, setPemChecking] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [passphrase2, setPassphrase2] = useState("");
  const [showPass1, setShowPass1] = useState(false);
  const [showPass2, setShowPass2] = useState(false);
  const [saving, setSaving] = useState(false);

  // Pre-fill keyId from vault even when locked, so the user knows what's stored.
  useEffect(() => {
    if (!keyId && encryptedCredentials?.keyId) setKeyId(encryptedCredentials.keyId);
  }, [encryptedCredentials, keyId]);

  // Live PEM validation, debounced.
  useEffect(() => {
    let cancelled = false;
    if (!pem.trim()) {
      setPemCheck(null);
      return;
    }
    setPemChecking(true);
    const handle = window.setTimeout(async () => {
      const result = await validatePem(pem);
      if (!cancelled) {
        setPemCheck(result);
        setPemChecking(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
      setPemChecking(false);
    };
  }, [pem]);

  // True when the user is only updating non-secret metadata (keyId / env /
  // proxy) on an existing vault — they don't need to re-paste the PEM or
  // re-enter the passphrase in that case.
  const metadataOnlyUpdate =
    !pem.trim() && !!encryptedCredentials && !!credentials;

  const save = async () => {
    if (useBotStore.getState().runState === "running") {
      toast.error("Stop the bot before changing credentials or environment");
      return;
    }
    const parsed = credentialsSchema.safeParse({ keyId, env, proxy });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }

    // Path A — metadata-only update against an existing unlocked vault.
    if (metadataOnlyUpdate && credentials && encryptedCredentials) {
      setSaving(true);
      try {
        setEncryptedCredentials({
          ...encryptedCredentials,
          keyId: keyId.trim(),
          env,
          corsProxy: proxy.trim(),
        });
        setCredentials({
          keyId: keyId.trim(),
          privateKeyPem: credentials.privateKeyPem,
          env,
          corsProxy: proxy.trim(),
        });
        toast.success("Credentials updated (PEM unchanged)");
      } catch (e) {
        toast.error(`Save failed: ${(e as Error).message}`);
      } finally {
        setSaving(false);
      }
      return;
    }

    // Path B — full (re-)encryption: requires PEM + passphrase.
    if (!pem.trim()) {
      toast.error("Paste your RSA private key (PEM) to (re-)encrypt the vault");
      return;
    }
    const pemSnapshot = pem.trim();
    const checkedPem = await validatePem(pemSnapshot);
    if (!checkedPem.ok) {
      toast.error(`PEM invalid: ${checkedPem.label}`, { description: checkedPem.detail });
      return;
    }
    const passResult = z
      .string()
      .min(8, "Passphrase must be at least 8 characters")
      .max(256, "Passphrase too long")
      .safeParse(passphrase);
    if (!passResult.success) {
      toast.error(passResult.error.issues[0]?.message ?? "Invalid passphrase");
      return;
    }
    if (passphrase !== passphrase2) {
      toast.error("Passphrases do not match");
      return;
    }
    setSaving(true);
    try {
      const cipher = await encryptPem(pemSnapshot, passphrase);
      setEncryptedCredentials({
        v: 1,
        keyId: keyId.trim(),
        env,
        corsProxy: proxy.trim(),
        pemCipher: cipher,
      });
      setCredentials({ keyId: keyId.trim(), privateKeyPem: pemSnapshot, env, corsProxy: proxy.trim() });
      rememberPassphraseForSession(passphrase);
      setVaultLocked(false);
      setPassphrase("");
      setPassphrase2("");
      setPem("");
      toast.success("Credentials encrypted and saved");
    } catch (e) {
      toast.error(`Encryption failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const lockNow = () => {
    setPem("");
    setPassphrase("");
    setPassphrase2("");
    pause();
    forgetSessionPassphrase();
    setCredentials(null);
    setVaultLocked(true);
    toast.success("Vault locked");
  };

  const forgetVault = () => {
    if (!confirm("Permanently delete the encrypted credentials from this browser? You'll need to paste the PEM again to use the bot.")) return;
    pause();
    forgetSessionPassphrase();
    setCredentials(null);
    setEncryptedCredentials(null);
    setVaultLocked(false);
    setPem("");
    setPassphrase("");
    setPassphrase2("");
    toast.success("Vault forgotten");
  };

  const test = async () => {
    const parsed = credentialsSchema.safeParse({ keyId, env, proxy });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    // Use the textarea PEM if provided; otherwise fall back to the in-memory
    // (already-decrypted) PEM from the unlocked vault.
    const effectivePem = pem.trim() || credentials?.privateKeyPem || "";
    if (!effectivePem) {
      toast.error("No PEM available — paste your key or unlock the vault first");
      return;
    }
    if (pem.trim()) {
      const pemResult = await validatePem(pem);
      setPemCheck(pemResult);
      if (!pemResult.ok) {
        toast.error(`PEM invalid: ${pemResult.label}`, { description: pemResult.detail });
        return;
      }
    }
    setTesting(true);
    try {
      const client = new KalshiClient({ keyId: keyId.trim(), privateKeyPem: effectivePem, env, corsProxy: proxy.trim() });
      const bal = await client.getBalance();
      toast.success(`Connected — balance $${(bal.balance / 100).toFixed(2)}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  /**
   * Nuclear option for GDPR / shared-device cases: forgets the vault, the
   * persisted Zustand store, the audit log, the risk acknowledgement, and
   * signs the user out. After this the app returns to the landing page.
   */
  const wipeEverything = async () => {
    if (
      !confirm(
        "Permanently delete ALL local data?\n\n" +
          "This wipes:\n" +
          "  • the encrypted credential vault\n" +
          "  • all settings, strategy, risk caps, tracked tickers\n" +
          "  • the activity log and order ledger\n" +
          "  • the risk acknowledgement\n" +
          "  • your authentication session\n\n" +
          "This cannot be undone.",
      )
    ) {
      return;
    }
    pause();
    forgetSessionPassphrase();
    try { await supabase.auth.signOut(); } catch { /* ignore */ }
    try { await clearAuditLog(); await clearTickerMismatches(); } catch { /* ignore */ }
    clearRiskAcceptance();
    try {
      localStorage.removeItem("kalshi-mm-store");
      sessionStorage.clear();
    } catch { /* ignore */ }
    toast.success("All local data deleted. Reloading…");
    setTimeout(() => window.location.reload(), 600);
  };

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div>
        <h2 className="text-lg font-semibold">Kalshi credentials</h2>
        <p className="text-sm text-muted-foreground">
          Stored only in your browser (localStorage). Choose environment carefully — prod places real-money orders.
        </p>
      </div>
      <div className="flex items-center justify-between rounded-md border border-border bg-background/40 p-3">
        <div className="space-y-0.5">
          <Label htmlFor="env">Environment</Label>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{env === "prod" ? "https://api.elections.kalshi.com" : "https://demo-api.kalshi.co"}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={env === "demo" ? "text-sm font-semibold text-warning" : "text-sm text-muted-foreground"}>DEMO</span>
          <Switch id="env" checked={env === "prod"} onCheckedChange={(c) => setEnv(c ? "prod" : "demo")} />
          <span className={env === "prod" ? "text-sm font-semibold text-destructive" : "text-sm text-muted-foreground"}>PROD</span>
        </div>
      </div>
      {env === "prod" && (
        <div className="flex items-start gap-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5" />
          <div>
            <strong>Production mode.</strong> Orders are real money. Make sure risk caps + kill switch are set before starting.
          </div>
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="keyId">API Key ID</Label>
        <Input id="keyId" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="UUID from Kalshi" className="font-mono" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="pem">RSA Private Key (PEM)</Label>
        {encryptedCredentials && (
          <p className="text-xs text-muted-foreground">
            Vault already contains an encrypted PEM. Leave this blank to update only the
            Key ID, environment, or proxy — your stored key won't be touched. Paste a new
            PEM to re-encrypt the vault with a new passphrase.
          </p>
        )}
        <Textarea
          id="pem"
          value={pem}
          onChange={(e) => setPem(e.target.value)}
          placeholder={
            encryptedCredentials
              ? "(optional — leave blank to keep the existing encrypted PEM)"
              : "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
          }
          rows={8}
          className="font-mono text-xs"
        />
        <PemStatusBadge
          checking={pemChecking}
          result={pemCheck}
          onConvert={() => {
            const r = convertPkcs1ToPkcs8(pem);
            if (r.ok === false) {
              toast.error(`Conversion failed: ${r.error}`);
              return;
            }
            setPem(r.pem);
            toast.success("Converted PKCS#1 → PKCS#8 in your browser");
          }}
        />
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">Authenticated server connection</p>
        <p className="text-xs text-muted-foreground">Signed requests use this app's server. Saving settings replaces any old proxy selection. Your private key stays in your browser. This migration release supports DEMO only.</p>
      </div>
      <div className="space-y-3 rounded-md border border-border bg-background/40 p-3">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 text-success" />
          <div className="flex-1">
            <Label className="text-sm font-semibold">Vault passphrase</Label>
            <p className="text-xs text-muted-foreground">
              Encrypts your RSA private key with AES-GCM (PBKDF2-SHA256, 250k iters). Required to save.
              You'll be asked for it once per browser session. Store it somewhere safe — it isn't recoverable.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="vault-pp1" className="text-xs">Passphrase</Label>
            <div className="relative">
              <Input
                id="vault-pp1"
                type={showPass1 ? "text" : "password"}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="pr-9"
              />
              <button
                type="button"
                aria-label={showPass1 ? "Hide passphrase" : "Show passphrase"}
                onClick={() => setShowPass1((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPass1 ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vault-pp2" className="text-xs">Confirm</Label>
            <div className="relative">
              <Input
                id="vault-pp2"
                type={showPass2 ? "text" : "password"}
                value={passphrase2}
                onChange={(e) => setPassphrase2(e.target.value)}
                className="pr-9"
              />
              <button
                type="button"
                aria-label={showPass2 ? "Hide passphrase" : "Show passphrase"}
                onClick={() => setShowPass2((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPass2 ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-border pt-3">
          <div className="space-y-0.5">
            <Label htmlFor="idle-min" className="text-sm">Auto-lock after idle (minutes)</Label>
            <p className="text-xs text-muted-foreground">
              Wipes the in-memory PEM and pauses the bot. Set to 0 to disable.
            </p>
          </div>
          <Input
            id="idle-min"
            type="number"
            min={0}
            max={240}
            value={idleLockMinutes}
            onChange={(e) => setIdleLockMinutes(Math.max(0, Math.min(240, Number(e.target.value) || 0)))}
            className="w-20"
          />
        </div>
        <div className="flex items-start justify-between gap-4 border-t border-border pt-3">
          <div className="space-y-0.5">
            <Label htmlFor="reload-mins" className="text-sm">Market reload minute marks</Label>
            <p className="text-xs text-muted-foreground">
              Comma-separated minutes (0–59) of every hour when the BTC 15-min markets list is reloaded.
              Default: <code className="font-mono">0, 16, 31, 45</code>.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Input
              id="reload-mins"
              value={reloadMinutesInput}
              onChange={(e) => setReloadMinutesInput(e.target.value)}
              onBlur={() => {
                const parsed = reloadMinutesInput
                  .split(/[,\s]+/)
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((s) => Number(s))
                  .filter((n) => Number.isFinite(n));
                if (!parsed.length) {
                  setMarketReloadMinutes([0, 16, 31, 45]);
                  toast.info("Reset reload marks to default 0, 16, 31, 45");
                  return;
                }
                const bad = parsed.find((n) => n < 0 || n > 59 || !Number.isInteger(n));
                if (bad !== undefined) {
                  toast.error(`Invalid minute "${bad}". Use integers 0–59.`);
                  setReloadMinutesInput((marketReloadMinutes ?? [0, 16, 31, 45]).join(", "));
                  return;
                }
                setMarketReloadMinutes(parsed);
              }}
              placeholder="0, 16, 31, 45"
              className="w-48 font-mono"
            />
            <span className="text-[10px] text-muted-foreground">
              Active: {(marketReloadMinutes ?? []).map((m) => `:${m.toString().padStart(2, "0")}`).join(" ")}
            </span>
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <Button onClick={save} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {metadataOnlyUpdate
            ? "Update settings"
            : encryptedCredentials
            ? "Re-encrypt & save"
            : "Encrypt & save"}
        </Button>
        <Button variant="outline" onClick={test} disabled={testing}>
          {testing ? "Testing…" : "Test connection"}
        </Button>
        {credentials && (
          <Button variant="ghost" size="sm" onClick={lockNow}>
            <Lock className="mr-2 h-4 w-4" /> Lock vault now
          </Button>
        )}
        {encryptedCredentials && (
          <Button variant="ghost" size="sm" onClick={forgetVault} className="text-destructive">
            <Trash2 className="mr-2 h-4 w-4" /> Forget vault
          </Button>
        )}
      </div>
      <div className="mt-2 flex items-start justify-between gap-4 rounded-md border border-destructive/40 bg-destructive/5 p-3">
        <div className="space-y-0.5">
          <Label className="flex items-center gap-1.5 text-sm font-semibold text-destructive">
            <AlertOctagon className="h-4 w-4" /> Delete all local data
          </Label>
          <p className="text-xs text-muted-foreground">
            Forgets the vault, settings, audit log, order ledger, risk acknowledgement,
            and signs you out. Use this on a shared device or before recycling the browser profile.
          </p>
        </div>
        <Button variant="destructive" size="sm" onClick={wipeEverything}>
          <Trash2 className="mr-2 h-4 w-4" /> Delete all
        </Button>
      </div>
    </div>
  );
}

function PemStatusBadge({
  checking,
  result,
  onConvert,
}: {
  checking: boolean;
  result: PemValidationResult | null;
  onConvert: () => void;
}) {
  if (checking) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Validating PEM…
      </div>
    );
  }
  if (!result) return null;
  const Icon =
    result.status === "ok"
      ? CheckCircle2
      : result.status === "empty" || result.status === "wrong-header"
      ? AlertTriangle
      : ShieldAlert;
  return (
    <div
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${PEM_BADGE_CLASS[result.status]}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1 space-y-1.5">
        <div className="font-semibold">{result.label}</div>
        <div className="opacity-90">{result.detail}</div>
        {result.status === "rsa-pkcs1" && (
          <Button type="button" size="sm" variant="outline" onClick={onConvert}>
            Convert to PKCS#8
          </Button>
        )}
      </div>
    </div>
  );
}
