import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { passwordAdmin, relayTarget } from './policy.mjs';
export function createApp(config, fetcher=fetch) {
  const origin=new URL(config.APP_ORIGIN);
  if(origin.protocol!=='https:' && !(origin.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname))) throw new Error('HTTPS or exact loopback required');
  const auth=new URL(config.SUPABASE_URL);
  if(auth.protocol!=='https:' || auth.username || auth.password || auth.pathname!=='/' || auth.search || auth.hash) throw new Error('HTTPS Supabase origin required');
  if(!config.SUPABASE_PUBLISHABLE_KEY || !config.ALLOWED_EMAILS?.trim()) throw new Error('Missing auth configuration');
  const allowed=new Set(config.ALLOWED_EMAILS.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean));
  const publicDir=resolve(config.PUBLIC_DIR??'dist');
  function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,origin);
      if(url.pathname==='/healthz' && req.method==='GET')return json(res,200,{ok:true,liveTradingEnabled:false});
      if(!url.pathname.startsWith('/api/')){
        if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'Method not allowed'});
        let file=resolve(publicDir,'.'+decodeURIComponent(url.pathname));
        if(file!==publicDir && !file.startsWith(publicDir+sep))return json(res,404,{error:'Not found'});
        try{if(!(await stat(file)).isFile())file=resolve(publicDir,'index.html');}catch{file=resolve(publicDir,'index.html');}
        if(!(await realpath(file)).startsWith((await realpath(publicDir))+sep))return json(res,404,{error:'Not found'});
        const types={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};
        res.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream','Cache-Control':extname(file)==='.html'?'no-cache':'public, max-age=3600','X-Content-Type-Options':'nosniff'});
        return res.end(req.method==='HEAD'?undefined:await readFile(file));
      }
      if(req.method!=='GET' && req.headers.origin!==origin.origin)return json(res,403,{error:'Origin not allowed'});
      const bearer=req.headers.authorization;
      if(!bearer?.startsWith('Bearer ') || bearer.length>10000)return json(res,401,{error:'Authentication required'});
      let user;
      try{
        const response=await fetcher(auth.origin+'/auth/v1/user',{headers:{Authorization:bearer,apikey:config.SUPABASE_PUBLISHABLE_KEY},signal:AbortSignal.timeout(5000),redirect:'error'});
        if(!response.ok)throw Error('Rejected');
        user=passwordAdmin(bearer.slice(7),await response.json(),allowed);
      }catch{return json(res,401,{error:'Authentication required or account not authorized'});}
      if(url.pathname==='/api/session' && req.method==='GET')return json(res,200,user);
      if(url.pathname!=='/api/kalshi')return json(res,404,{error:'Not found'});
      if(!user.stepUp)return json(res,403,{error:'Fresh authenticator verification required'});
      let target;
      try{target=relayTarget(url.searchParams.get('env'),url.searchParams.get('path'),req.method);}catch{return json(res,403,{error:'Operation blocked: restricted DEMO access only'});}
      const headers={'Content-Type':'application/json'};
      for(const name of ['kalshi-access-key','kalshi-access-signature','kalshi-access-timestamp']){
        const value=req.headers[name];if(typeof value!=='string' || !value || value.length>4096)return json(res,400,{error:'Invalid Kalshi signature'});headers[name]=value;
      }
      let body;
      if(req.method==='POST'){
        const parts=[];let bytes=0;
        for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)return json(res,413,{error:'Request too large'});parts.push(chunk);}
        body=Buffer.concat(parts).toString('utf8');let order;
        try{order=JSON.parse(body);}catch{return json(res,400,{error:'Invalid JSON'});}
        if(typeof order.ticker!=='string' || !/^KXBTC15M-[A-Za-z0-9_-]+$/.test(order.ticker))return json(res,400,{error:'Only BTC 15-minute orders are supported'});
      }
      const upstream=await fetcher(target,{method:req.method,headers,body,signal:AbortSignal.timeout(15000),redirect:'error'});
      res.writeHead(upstream.status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(upstream.headers.has('retry-after')?{'Retry-After':upstream.headers.get('retry-after')}:{})});
      return res.end(await upstream.text());
    }catch{if(!res.headersSent)return json(res,502,{error:'Request failed; retry or contact the administrator'});res.destroy();}
  });
  server.requestTimeout=20000;server.headersTimeout=10000;server.maxHeadersCount=40;
  return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)createApp(process.env).listen(Number(process.env.PORT??3000),'0.0.0.0');
