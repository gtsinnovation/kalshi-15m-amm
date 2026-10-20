import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminSignIn } from "./AdminSignIn";

const api = vi.hoisted(() => ({
  getSession: vi.fn(), onAuthStateChange: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn(),
  listFactors: vi.fn(), enroll: vi.fn(), challengeAndVerify: vi.fn(), unenroll: vi.fn(),
  adminSession: vi.fn(), confirmAdminMfa: vi.fn(), signOutAdmin: vi.fn(), clearAdminSecrets: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: {
  getSession: api.getSession, onAuthStateChange: api.onAuthStateChange,
  signInWithPassword: api.signInWithPassword, signOut: api.signOut,
  mfa: { listFactors: api.listFactors, enroll: api.enroll, challengeAndVerify: api.challengeAndVerify, unenroll: api.unenroll },
} } }));
vi.mock("@/lib/adminAuth", () => ({ adminSession: api.adminSession, confirmAdminMfa: api.confirmAdminMfa,
  signOutAdmin: api.signOutAdmin, clearAdminSecrets: api.clearAdminSecrets }));
beforeEach(() => {
  vi.resetAllMocks();
  api.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  api.getSession.mockResolvedValue({ data: { session: null } });
  api.adminSession.mockResolvedValue({ stepUp: false, role: "admin", hasTotp: true });
  api.confirmAdminMfa.mockResolvedValue({ stepUp: true, role: "admin" });
  api.listFactors.mockResolvedValue({ data: { totp: [{ id: "verified-factor", friendly_name: "Admin phone" }] }, error: null });
  api.challengeAndVerify.mockResolvedValue({ error: null });
});
afterEach(cleanup);
const signedIn = () => api.getSession.mockResolvedValue({ data: { session: { user: { email: "admin@example.test" } } } });
it("uses password login, clears the password and does not grant dashboard access at AAL1", async () => {
  api.signInWithPassword.mockResolvedValue({ error: null });
  const onVerified = vi.fn(); render(<AdminSignIn onVerified={onVerified} />);
  const input = await screen.findByLabelText("Password");
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "admin@example.test" } });
  fireEvent.change(input, { target: { value: "test-password-only" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(api.signInWithPassword).toHaveBeenCalledWith({ email: "admin@example.test", password: "test-password-only" }));
  await waitFor(() => expect(input).toHaveValue(""));
  expect(onVerified).not.toHaveBeenCalled();
});
it("requires server confirmation after Supabase TOTP verification", async () => {
  signedIn(); api.confirmAdminMfa.mockRejectedValue(new Error("AAL2 not confirmed"));
  const onVerified = vi.fn(); render(<AdminSignIn onVerified={onVerified} />);
  const input = await screen.findByLabelText("Six-digit authenticator code");
  fireEvent.change(input, { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify and open dashboard" }));
  await screen.findByRole("alert");
  expect(api.challengeAndVerify).toHaveBeenCalledWith({ factorId: "verified-factor", code: "123456" });
  expect(api.confirmAdminMfa).toHaveBeenCalled(); expect(onVerified).not.toHaveBeenCalled();
  expect(input).toHaveValue("");
});
it("opens the dashboard only after successful TOTP and server confirmation", async () => {
  signedIn(); const onVerified = vi.fn(); render(<AdminSignIn onVerified={onVerified} />);
  const input = await screen.findByLabelText("Six-digit authenticator code");
  fireEvent.change(input, { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify and open dashboard" }));
  await waitFor(() => expect(onVerified).toHaveBeenCalledOnce());
});
it("enrolls a first authenticator and discards its displayed secret after confirmation", async () => {
  signedIn(); api.listFactors.mockResolvedValue({ data: { totp: [] }, error: null });
  api.enroll.mockResolvedValue({ data: { id: "new-factor", totp: { qr_code: "<svg/>", secret: "TEST_SETUP_SECRET" } }, error: null });
  const onVerified = vi.fn(); render(<AdminSignIn onVerified={onVerified} />);
  fireEvent.click(await screen.findByRole("button", { name: "Set up authenticator" }));
  const input = await screen.findByLabelText("Authenticator code");
  expect(screen.getByAltText("Authenticator enrollment QR code")).toHaveAttribute("src", expect.stringContaining("data:image/svg"));
  fireEvent.change(input, { target: { value: "654321" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify authenticator" }));
  await waitFor(() => expect(onVerified).toHaveBeenCalledOnce());
  expect(screen.queryByText("TEST_SETUP_SECRET")).not.toBeInTheDocument();
  expect(api.challengeAndVerify).toHaveBeenCalledWith({ factorId: "new-factor", code: "654321" });
});
it("does not enroll factors for an account the server rejects", async () => {
  signedIn(); api.adminSession.mockRejectedValue(new Error("Unauthorized"));
  render(<AdminSignIn onVerified={vi.fn()} />);
  await screen.findByRole("alert");
  expect(api.listFactors).not.toHaveBeenCalled(); expect(api.enroll).not.toHaveBeenCalled();
});
