const CACHE="orbit-mobile-v30";
const API_CACHE="orbit-api-catalogues-v1";
const ASSETS=["/","/styles.css","/orbit-feature-additions.css","/orbit-ui-fixes-20261109.css","/orbit-mobile.css","/orbit-mobile-polish.css","/orbit-mobile-landing.css","/public-web-overrides.css","/orbit-web-refresh.css","/orbit-mobile-hero.svg","/mobile-bridge.js","/live-podcast.js","/app.js","/manifest.webmanifest","/icons/orbit-192.png","/icons/orbit-512.png","/icons/apple-touch-icon.png"];
const CACHEABLE_API=/^\/api\/(?:radio-stations|music-search|audius-search|youtube-search|itunes-search|global-search|librivox|spinn-movies|global-countries|global-channels|films|podcast-episodes|movie-trailers)(?:\/|$)/;
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith("orbit-mobile-")&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET")return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  if(CACHEABLE_API.test(url.pathname)){
    event.respondWith((async()=>{
      const cache=await caches.open(API_CACHE);
      const cached=await cache.match(request);
      const network=fetch(request).then(response=>{
        const type=response.headers.get("content-type")||"";
        if(response.ok&&/application\/(?:[a-z0-9.+-]*\+)?json/i.test(type))cache.put(request,response.clone()).catch(()=>{});
        return response;
      });
      if(cached){event.waitUntil(network.catch(()=>{}));return cached;}
      try{return await network;}catch{return new Response(JSON.stringify({error:"Offline. No saved catalogue copy is available yet."}),{status:503,headers:{"Content-Type":"application/json; charset=utf-8","X-ORBIT-Offline":"1"}});}
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
