import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useBotStore, type RiskLimits, type StrategyParams } from "@/lib/store";

/**
 * Two-way sync of risk limits + strategy parameters with the user's profile
 * (Supabase `user_settings` table). Local Zustand persist is still the
 * source of truth for an active session — this hook only:
 *
 *  1. On sign-in, pulls the row and merges remote values into the store
 *     (remote wins, since it's the cross-device snapshot).
 *  2. On any change to risk/strategy after we've loaded, debounces a write
 *     back to the row. RLS guarantees users only ever see their own row.
 *
 * The hook is a no-op for signed-out users — local persistence still works.
 */
export function useSettingsSync() {
  const risk = useBotStore((s) => s.risk);
  const strategy = useBotStore((s) => s.strategy);
  const autoRefreshEnabled = useBotStore((s) => s.autoRefreshEnabled);
  const setRisk = useBotStore((s) => s.setRisk);
  const setStrategy = useBotStore((s) => s.setStrategy);
  const setAutoRefreshEnabled = useBotStore((s) => s.setAutoRefreshEnabled);

  const userIdRef = useRef<string | null>(null);
  const loadedRef = useRef(false);
  const writeTimerRef = useRef<number | null>(null);

  // Load remote settings once on mount + whenever auth changes.
  useEffect(() => {
    let cancelled = false;

    const loadFor = async (userId: string) => {
      const { data, error } = await supabase
        .from("user_settings")
        .select("risk, strategy, preferences")
        .eq("user_id", userId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        console.warn("user_settings load failed", error.message);
      } else if (data) {
        if (data.risk) setRisk(data.risk as Partial<RiskLimits>);
        if (data.strategy) setStrategy(data.strategy as Partial<StrategyParams>);
        const prefs = (data.preferences ?? {}) as { autoRefreshEnabled?: boolean };
        if (typeof prefs.autoRefreshEnabled === "boolean") {
          setAutoRefreshEnabled(prefs.autoRefreshEnabled);
        }
      }
      loadedRef.current = true;
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      const uid = session?.user?.id ?? null;
      userIdRef.current = uid;
      if (uid) void loadFor(uid);
      else loadedRef.current = true; // signed-out: never sync
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const uid = session?.user?.id ?? null;
      const prev = userIdRef.current;
      userIdRef.current = uid;
      if (uid && uid !== prev) {
        loadedRef.current = false;
        void loadFor(uid);
      } else if (!uid) {
        loadedRef.current = true;
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [setRisk, setStrategy, setAutoRefreshEnabled]);

  // Debounced write whenever risk/strategy/prefs change (after initial load).
  useEffect(() => {
    if (!loadedRef.current) return;
    const uid = userIdRef.current;
    if (!uid) return;
    if (writeTimerRef.current != null) window.clearTimeout(writeTimerRef.current);
    writeTimerRef.current = window.setTimeout(async () => {
      const { error } = await supabase
        .from("user_settings")
        .upsert(
          [{
            user_id: uid,
            risk: risk as never,
            strategy: strategy as never,
            preferences: { autoRefreshEnabled } as never,
          }],
          { onConflict: "user_id" },
        );
      if (error) {
        console.warn("user_settings save failed", error.message);
      }
    }, 800);
    return () => {
      if (writeTimerRef.current != null) {
        window.clearTimeout(writeTimerRef.current);
      }
    };
  }, [risk, strategy, autoRefreshEnabled]);
}
