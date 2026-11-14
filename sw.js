const CACHE="orbit-mobile-v32";
const API_CACHE="orbit-api-catalogues-v3";
const API_CACHE_TTL={
  "/api/radio-stations":2*60*1000,
  "/api/music-search":3*60*1000,
  "/api/audius-search":3*60*1000,
  "/api/youtube-search":10*60*1000,
  "/api/itunes-search":5*60*1000,
  "/api/global-search":5*60*1000,
  "/api/librivox":24*60*60*1000,
  "/api/spinn-movies":30*60*1000,
  "/api/global-countries":24*60*60*1000,
  "/api/global-channels":6*60*60*1000,
  "/api/films":60*60*1000,
  "/api/podcast-episodes":5*60*1000,
  "/api/movie-trailers":6*60*60*1000
};
const STALE_MAX_AGE=7*24*60*60*1000;
const MAX_API_ENTRIES=100;
const ASSETS=["/","/styles.css","/orbit-feature-additions.css","/orbit-ui-fixes-20261109.css","/orbit-mobile.css","/orbit-mobile-polish.css","/orbit-mobile-landing.css","/public-web-overrides.css","/orbit-web-refresh.css","/orbit-mobile-hero.svg","/mobile-bridge.js","/live-podcast.js","/app.js","/manifest.webmanifest","/icons/orbit-192.png","/icons/orbit-512.png","/icons/apple-touch-icon.png"];
const CACHEABLE_API=/^\/api\/(?:radio-stations|music-search|audius-search|youtube-search|itunes-search|global-search|librivox|spinn-movies|global-countries|global-channels|films|podcast-episodes|movie-trailers)(?:\/|$)/;
function apiMaxAge(pathname){
  const entry=Object.entries(API_CACHE_TTL).find(([path])=>pathname===path||pathname.startsWith(path+"/"));
  return entry?entry[1]:5*60*1000;
}
function withCacheMetadata(response){
  const headers=new Headers(response.headers);
  headers.set("X-ORBIT-Cached-At",String(Date.now()));
  return new Response(response.clone().body,{status:response.status,statusText:response.statusText,headers});
}
async function trimApiCache(cache){
  const keys=await cache.keys();
  const entries=await Promise.all(keys.map(async request=>{
    const response=await cache.match(request);
    return {request,at:Number(response?.headers.get("X-ORBIT-Cached-At")||0)};
  }));
  const cutoff=Date.now()-STALE_MAX_AGE;
  const keep=entries.filter(entry=>entry.at&&entry.at>=cutoff).sort((a,b)=>b.at-a.at);
  const keepSet=new Set(keep.slice(0,MAX_API_ENTRIES).map(entry=>entry.request.url));
  await Promise.all(entries.filter(entry=>!keepSet.has(entry.request.url)).map(entry=>cache.delete(entry.request)));
}
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(async keys=>{
  await Promise.all(keys.filter(key=>(key.startsWith("orbit-mobile-")&&key!==CACHE)||(key.startsWith("orbit-api-catalogues-")&&key!==API_CACHE)).map(key=>caches.delete(key)));
  const apiCache=await caches.open(API_CACHE);
  await trimApiCache(apiCache);
}).then(()=>self.clients.claim())));
self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET")return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  if(CACHEABLE_API.test(url.pathname)){
    event.respondWith((async()=>{
      const cache=await caches.open(API_CACHE);
      const cached=await cache.match(request);
      const cachedAt=Number(cached?.headers.get("X-ORBIT-Cached-At")||0);
      const age=cachedAt?Date.now()-cachedAt:Infinity;
      const maxAge=apiMaxAge(url.pathname);
      const network=fetch(request).then(async response=>{
        const type=response.headers.get("content-type")||"";
        if(response.ok&&/application\/(?:[a-z0-9.+-]*\+)?json/i.test(type)){
          await cache.put(request,withCacheMetadata(response));
          await trimApiCache(cache);
        }
        return response;
      });
      if(cached&&age<=maxAge){
        event.waitUntil(network.catch(()=>{}));
        return cached;
      }
      try{return await network;}
      catch{
        if(cached&&age<=STALE_MAX_AGE){
          const headers=new Headers(cached.headers);
          headers.set("X-ORBIT-Offline-Stale","1");
          return new Response(cached.clone().body,{status:cached.status,statusText:cached.statusText,headers});
        }
        if(cached)await cache.delete(request);
        return new Response(JSON.stringify({error:"Offline. No recent saved catalogue copy is available yet."}),{status:503,headers:{"Content-Type":"application/json; charset=utf-8","X-ORBIT-Offline":"1"}});
      }
    })());
    return;
  }
  // Do not cache any other API response, especially live streams or downloads.
  if(url.pathname.startsWith("/api/"))return;
  if(request.mode==="navigate"){
    event.respondWith(fetch(request).then(response=>{if(response.ok)caches.open(CACHE).then(cache=>cache.put("/",response.clone()));return response;}).catch(async()=>await caches.match("/")||new Response("ORBIT is offline. Reconnect to load the app.",{status:503,headers:{"Content-Type":"text/plain; charset=utf-8"}})));
    return;
  }
  event.respondWith((async()=>{
    const cached=await caches.match(request);
    const network=fetch(request).then(response=>{if(response.ok)caches.open(CACHE).then(cache=>cache.put(request,response.clone()));return response;}).catch(()=>null);
    if(cached){event.waitUntil(network);return cached;}
    return await network||new Response("",{status:504});
  })());
});
