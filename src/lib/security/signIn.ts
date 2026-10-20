import { lovable } from "@/integrations/lovable";
import { supabase } from "@/integrations/supabase/client";
import { createLovableAuth } from "@lovable.dev/cloud-auth-js";

/** The relative Lovable broker exists on the hosted service, not Vite. */
export async function signInWithGoogle() {
  const { hostname, origin } = window.location;
  const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
  if (import.meta.env.DEV && isLoopback) {
    // Managed Google credentials live behind the hosted Lovable broker.
    const localAuth = createLovableAuth({
      oauthBrokerUrl: "https://k15mamm.webpwa.io/~oauth/initiate",
    });
    const result = await localAuth.signInWithOAuth("google", { redirect_uri: `${origin}/` });
    if (result.error || result.redirected) return result;
    const { error } = await supabase.auth.setSession(result.tokens);
    return error ? { error } : result;
  }
  return lovable.auth.signInWithOAuth("google", { redirect_uri: origin });
}
