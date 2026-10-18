import { useBotStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  Activity,
  Lock,
  PauseCircle,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  XOctagon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type Tone = "success" | "warning" | "destructive" | "muted";

interface BannerSpec {
  tone: Tone;
  icon: LucideIcon;
  title: string;
  reason: string;
}

/**
 * Top-of-dashboard banner that collapses two orthogonal states — bot run
 * state and vault lock state — into a single, plainly worded status so the
 * user can tell at a glance whether the bot is trading, idle, or blocked.
 *
 * Priority (highest first):
 *   1. Killed         — kill switch was hit; everything stopped.
 *   2. Vault locked   — encrypted credentials exist but are not decrypted.
 *   3. No credentials — nothing configured at all.
 *   4. Paused         — user paused.
 *   5. Running        — bot is quoting.
 *   6. Idle/unlocked  — vault unlocked, ready to start.
 */
export function BotStatusBanner() {
  const runState = useBotStore((s) => s.runState);
  const credentials = useBotStore((s) => s.credentials);
  const encryptedCredentials = useBotStore((s) => s.encryptedCredentials);
  const vaultLocked = useBotStore((s) => s.vaultLocked);

  const spec = resolve({
    runState,
    hasMemoryCreds: !!credentials,
    hasEncryptedCreds: !!encryptedCredentials,
    vaultLocked,
  });

  const Icon = spec.icon;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-start gap-3 rounded-lg border p-4",
        TONE_CLASS[spec.tone],
      )}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="flex-1 space-y-0.5">
        <p className="text-sm font-semibold leading-tight">{spec.title}</p>
        <p className="text-xs opacity-90">{spec.reason}</p>
      </div>
    </div>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  success: "border-success/40 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/10 text-warning",
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
  muted: "border-border bg-muted/40 text-muted-foreground",
};

function resolve(args: {
  runState: "idle" | "running" | "paused" | "killed";
  hasMemoryCreds: boolean;
  hasEncryptedCreds: boolean;
  vaultLocked: boolean;
}): BannerSpec {
  const { runState, hasMemoryCreds, hasEncryptedCreds, vaultLocked } = args;

  if (runState === "killed") {
    return {
      tone: "destructive",
      icon: XOctagon,
      title: "Bot killed",
      reason: "Kill requested. Check the activity log and exchange for unresolved orders or positions before restarting.",
    };
  }

  if (vaultLocked && hasEncryptedCreds) {
    return {
      tone: "destructive",
      icon: Lock,
      title: "Vault locked — bot cannot trade",
      reason: "Your Kalshi private key is encrypted. Enter the passphrase in the unlock dialog to decrypt it into memory.",
    };
  }

  if (!hasMemoryCreds && !hasEncryptedCreds) {
    return {
      tone: "warning",
      icon: ShieldOff,
      title: "No credentials configured",
      reason: "Add your Kalshi API Key ID and RSA private key in Settings, then choose a vault passphrase.",
    };
  }

  if (runState === "paused") {
    return {
      tone: "warning",
      icon: PauseCircle,
      title: "Bot paused — vault unlocked",
      reason: "New quoting is paused. Resting exchange orders may still fill; use Kill Switch to withdraw orders.",
    };
  }

  if (runState === "running") {
    return {
      tone: "success",
      icon: Activity,
      title: "Bot running — quoting live markets",
      reason: "The Avellaneda–Stoikov loop is placing and cancelling orders on the tracked tickers.",
    };
  }

  // idle + creds in memory
  if (hasMemoryCreds) {
    return {
      tone: "success",
      icon: ShieldCheck,
      title: "Vault unlocked — ready to start",
      reason: "Credentials are decrypted in memory. Pre-start simulation will run when you press Start.",
    };
  }

  // Fallback — shouldn't normally hit this.
  return {
    tone: "muted",
    icon: ShieldAlert,
    title: "Status unknown",
    reason: "Unable to determine bot state. Try reloading the page.",
  };
}