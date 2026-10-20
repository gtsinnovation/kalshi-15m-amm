import { supabase } from '@/integrations/supabase/client';
import { pause } from '@/lib/scheduler/loop';
import { useBotStore } from '@/lib/store';
import { forgetSessionPassphrase } from '@/lib/security/vault';
export interface AdminSession { stepUp: boolean; role: 'admin'; email: string; hasTotp: boolean; expiresAt: number }
export async function adminSession(): Promise<AdminSession> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error('Authentication required');
  const response = await fetch('/api/session', { headers: { Authorization: 'Bearer '+data.session.access_token }, cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Admin session rejected');
  return response.json();
}
export async function confirmAdminMfa() {
  const session = await adminSession();
  if (!session.stepUp || session.role !== 'admin' || session.expiresAt <= Date.now()) throw new Error('Fresh authenticator verification required');
  return session;
}
export function clearAdminSecrets() {
  pause(); forgetSessionPassphrase();
  const state = useBotStore.getState(); state.setCredentials(null); state.setVaultLocked(!!state.encryptedCredentials);
}
export async function signOutAdmin() {
  clearAdminSecrets();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
