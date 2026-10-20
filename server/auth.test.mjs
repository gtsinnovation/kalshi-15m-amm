import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './index.mjs';
import { passwordAdmin, relayTarget } from './policy.mjs';
const now=Date.now(), seconds=Math.floor(now/1000);
const user={id:'admin-id',email:'admin@example.test',email_confirmed_at:'2026-01-01',factors:[{factor_type:'totp',status:'verified'}]};
const claims={sub:user.id,exp:seconds+7200,aal:'aal2',amr:[{method:'password',timestamp:seconds},{method:'totp',timestamp:seconds}]};
const token=(c=claims)=>'e30.'+Buffer.from(JSON.stringify(c)).toString('base64url')+'.synthetic';
const allowed=new Set([user.email]);
test('fresh password and TOTP required; stale, removed and future factors fail closed',()=>{
  assert.equal(passwordAdmin(token(),user,allowed,now).stepUp,true);
  for(const c of [{...claims,aal:'aal1'},{...claims,amr:[{method:'password'}]},{...claims,amr:[{method:'password'},{method:'totp',timestamp:seconds-3601}]},{...claims,amr:[{method:'password'},{method:'totp',timestamp:seconds+120}]}])assert.equal(passwordAdmin(token(c),user,allowed,now).stepUp,false);
  assert.equal(passwordAdmin(token(),{...user,factors:[]},allowed,now).stepUp,false);
  assert.throws(()=>passwordAdmin(token({...claims,amr:[{method:'oauth'},{method:'totp',timestamp:seconds}]}),user,allowed,now));
  assert.throws(()=>passwordAdmin(token(),user,new Set(),now));
  assert.throws(()=>passwordAdmin(token({...claims,sub:'other'}),user,allowed,now));
  assert.throws(()=>passwordAdmin(token({...claims,exp:seconds-1}),user,allowed,now));
});
test('relay restricts host, environment, method and path',()=>{
  assert.equal(relayTarget('demo','/trade-api/v2/portfolio/orders?limit=100','GET').hostname,'demo-api.kalshi.co');
  for(const [env,path,method] of [['prod','/trade-api/v2/portfolio/orders','POST'],['demo','//attacker.test/trade-api/v2/markets','GET'],['demo','/trade-api/v2/../admin','GET'],['demo','/trade-api/v2/%2e%2e/admin','GET'],['demo','/trade-api/v2/portfolio/transfers','POST'],['demo','/trade-api/v2/markets','PUT']])assert.throws(()=>relayTarget(env,path,method));
});
test('HTTP gates validate upstream identity, reject weak sessions, origin mismatch, prod and hourly orders',async t=>{
  let calls=[];let reject=false;
  const config={APP_ORIGIN:'http://127.0.0.1:8080',SUPABASE_URL:'https://auth.example.test',SUPABASE_PUBLISHABLE_KEY:'public-test-key',ALLOWED_EMAILS:user.email};
  const server=createApp(config,async(url,opts)=>{
    calls.push({url:String(url),opts});
    if(String(url).endsWith('/auth/v1/user'))return new Response(JSON.stringify(user),{status:reject?401:200});
    return new Response(JSON.stringify({orders:[]}),{headers:{'Retry-After':'2'}});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const headers={Authorization:'Bearer '+token(),'KALSHI-ACCESS-KEY':'synthetic-key','KALSHI-ACCESS-SIGNATURE':'synthetic-signature','KALSHI-ACCESS-TIMESTAMP':String(now),Origin:config.APP_ORIGIN};
  const route='/api/kalshi?env=demo&path='+encodeURIComponent('/trade-api/v2/portfolio/orders');
  assert.equal((await fetch(base+'/api/session')).status,401);
  assert.equal((await fetch(base+'/api/session',{headers})).status,200);
  const weak={...headers,Authorization:'Bearer '+token({...claims,aal:'aal1',amr:[{method:'password'}]})};
  assert.equal((await fetch(base+route,{headers:weak})).status,403);
  assert.equal((await fetch(base+route,{method:'POST',headers:{...headers,Origin:'https://attacker.test'},body:'{}'})).status,403);
  assert.equal((await fetch(base+route.replace('env=demo','env=prod'),{headers})).status,403);
  assert.equal((await fetch(base+route,{method:'POST',headers,body:JSON.stringify({ticker:'KXBTC-hourly'})})).status,400);
  const response=await fetch(base+route,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('Retry-After'),'2');
  const upstream=calls.find(c=>c.url.startsWith('https://demo-api'));assert.ok(upstream);assert.equal(upstream.opts.headers.Authorization,undefined);assert.equal(upstream.opts.redirect,'error');
  reject=true;calls=[];assert.equal((await fetch(base+route,{headers})).status,401);assert.equal(calls.length,1);
});
