import { z } from 'zod';
const userSchema = z.object({ id:z.string(), email:z.string().email(), email_confirmed_at:z.string().min(1), factors:z.array(z.object({factor_type:z.string(),status:z.string()})).optional() });
const claimsSchema = z.object({sub:z.string(),exp:z.number().finite(),aal:z.enum(['aal1','aal2']),amr:z.array(z.object({method:z.string(),timestamp:z.number().finite().optional()}))});
// Call only AFTER the exact token has been validated by Supabase /auth/v1/user.
export function passwordAdmin(token, verifiedUser, allowed, now=Date.now()) {
  const user=userSchema.parse(verifiedUser);
  const claims=claimsSchema.parse(JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8')));
  if(!allowed.has(user.email.toLowerCase()) || claims.sub!==user.id || claims.exp*1000<=now || !claims.amr.some(a=>a.method==='password')) throw new Error('Unauthorized');
  const hasTotp=!!user.factors?.some(f=>f.factor_type==='totp' && f.status==='verified');
  const times=claims.amr.filter(a=>['totp','mfa/totp'].includes(a.method) && a.timestamp!=null && a.timestamp*1000<=now+30000).map(a=>a.timestamp*1000);
  const until=claims.aal==='aal2' && hasTotp && times.length ? Math.min(claims.exp*1000,Math.max(...times)+3600000):0;
  return {role:'admin',email:user.email,hasTotp,stepUp:until>now,expiresAt:until>now?until:0};
}
export function relayTarget(env,target,method) {
  // Deliberately no live-enabling switch in this migration release.
  if(env!=='demo' || !target || /[%\\#\s]/.test(target)) throw new Error('Restricted DEMO access only');
  const url=new URL(target,'https://demo-api.kalshi.co');
  if(url.origin!=='https://demo-api.kalshi.co' || !target.startsWith('/trade-api/v2/')) throw new Error('Invalid target');
  const read=['/portfolio/balance','/portfolio/orders','/portfolio/positions','/portfolio/fills','/markets','/exchange/status'];
  const permitted=method==='GET' && (read.some(p=>url.pathname==='/trade-api/v2'+p) || /^\/trade-api\/v2\/markets\/[A-Za-z0-9_-]+(?:\/orderbook)?$/.test(url.pathname))
    || method==='POST' && url.pathname==='/trade-api/v2/portfolio/orders'
    || method==='DELETE' && /^\/trade-api\/v2\/portfolio\/orders\/[A-Za-z0-9_-]+$/.test(url.pathname);
  if(!permitted) throw new Error('Operation not permitted');
  return url;
}
