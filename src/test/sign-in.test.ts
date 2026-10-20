import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signInWithGoogle } from "@/lib/security/signIn";

const auth = vi.hoisted(() => ({ setSession: vi.fn(), local: vi.fn(), create: vi.fn(), lovable: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { setSession: auth.setSession } } }));
vi.mock("@/integrations/lovable", () => ({ lovable: { auth: { signInWithOAuth: auth.lovable } } }));
vi.mock("@lovable.dev/cloud-auth-js", () => ({ createLovableAuth: auth.create }));

function location(hostname: string, origin: string) {
  vi.stubGlobal("window", { location: { hostname, origin } });
}

describe("Google OAuth routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.setSession.mockResolvedValue({ error: null });
    auth.create.mockReturnValue({ signInWithOAuth: auth.local });
    auth.local.mockResolvedValue({ error: null, redirected: true });
    auth.lovable.mockResolvedValue({ error: null, redirected: true });
    vi.stubEnv("DEV", true);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it.each([
    ["127.0.0.1", "http://127.0.0.1:8080"],
    ["localhost", "http://localhost:8080"],
    ["[::1]", "http://[::1]:8080"],
  ])("uses the hosted broker for loopback development on %s", async (hostname, origin) => {
    location(hostname, origin);
    await signInWithGoogle();
    expect(auth.create).toHaveBeenCalledWith({ oauthBrokerUrl: "https://k15mamm.webpwa.io/~oauth/initiate" });
    expect(auth.local).toHaveBeenCalledWith("google", { redirect_uri: `${origin}/` });
    expect(auth.lovable).not.toHaveBeenCalled();
  });

  it("preserves the hosted production broker", async () => {
    vi.stubEnv("DEV", false);
    location("k15mamm.webpwa.io", "https://k15mamm.webpwa.io");
    await signInWithGoogle();
    expect(auth.lovable).toHaveBeenCalledWith("google", { redirect_uri: "https://k15mamm.webpwa.io" });
    expect(auth.local).not.toHaveBeenCalled();
  });

  it("does not treat a localhost lookalike as loopback", async () => {
    location("localhost.example.com", "https://localhost.example.com");
    await signInWithGoogle();
    expect(auth.local).not.toHaveBeenCalled();
    expect(auth.lovable).toHaveBeenCalled();
  });

  it("propagates local authentication errors", async () => {
    const error = new Error("Provider configuration error");
    auth.local.mockResolvedValue({ error });
    location("127.0.0.1", "http://127.0.0.1:8080");
    expect((await signInWithGoogle()).error).toBe(error);
  });

  it("stores popup tokens and propagates session errors", async () => {
    const tokens = { access_token: "synthetic-access", refresh_token: "synthetic-refresh" };
    auth.local.mockResolvedValue({ error: null, tokens });
    const error = new Error("Session rejected");
    auth.setSession.mockResolvedValue({ error });
    location("127.0.0.1", "http://127.0.0.1:8080");
    expect((await signInWithGoogle()).error).toBe(error);
    expect(auth.setSession).toHaveBeenCalledWith(tokens);
  });
});
