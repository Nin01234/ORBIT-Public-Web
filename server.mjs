import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const mime = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".svg":"image/svg+xml", ".png":"image/png", ".ico":"image/x-icon", ".webmanifest":"application/manifest+json" };
const allowed = new Set(["index.html","app.js","styles.css","orbit-feature-additions.css","orbit-ui-fixes-20261109.css","orbit-mobile.css","orbit-mobile-polish.css","orbit-mobile-landing.css","public-web-overrides.css","spotify-player-frame.css","orbit-web-refresh.css","orbit-mobile-hero.svg","orbit-mobile-radio.svg","orbit-mobile-music.svg","orbit-mobile-movies.svg","orbit-mobile-offline.svg","orbit-mobile-podcasts.svg","mobile-bridge.js","manifest.webmanifest","sw.js","live-podcast.js"]);
const cache = new Map();
let ytmusicBridgeActive = 0;
function runYoutubeMusicBridge(action, values = {}) {
  if (ytmusicBridgeActive >= 3) return Promise.reject(new Error("The music service is busy. Please try again in a moment."));
  const script = path.join(root, "orbit_ytmusic_bridge.py");
  const python = process.env.ORBIT_PYTHON || (process.platform === "win32" ? "py" : "python3");
  const actionArgs = action === "search"
    ? ["search", "--query", String(values.query || "").slice(0, 120)]
    : ["stream", "--video-id", String(values.videoId || "")];
  const pythonArgs = process.platform === "win32" && !process.env.ORBIT_PYTHON
    ? ["-3", script, ...actionArgs]
    : [script, ...actionArgs];
  const pythonDeps = path.join(root, ".python-deps");
  const env = { ...process.env, PYTHONPATH: pythonDeps + path.delimiter + (process.env.PYTHONPATH || ""), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  return new Promise((resolve, reject) => {
    ytmusicBridgeActive++;
    let stdout = "", stderr = "", settled = false;
    const child = spawn(python, pythonArgs, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ytmusicBridgeActive = Math.max(0, ytmusicBridgeActive - 1);
      if (error) reject(error); else resolve(value);
    };
    const timeoutMs = Number(process.env.ORBIT_YTMUSIC_TIMEOUT_MS || 90000);
    const timer = setTimeout(() => {
      console.error("[ORBIT YouTube Music] Python bridge timeout", { action, timeoutMs, stderr: stderr.trim() });
      try { child.kill("SIGKILL"); } catch {}
      finish(new Error("YouTube Music is taking longer than expected. Please try again."));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); if (stdout.length > 2 * 1024 * 1024) { try { child.kill(); } catch {} finish(new Error("The music service returned too much data.")); } });
    child.stderr.on("data", chunk => { if (stderr.length < 12000) stderr += chunk.toString("utf8"); });
    child.once("error", error => {
      console.error("[ORBIT YouTube Music] Python process spawn error", { action, message: error.message, stderr: stderr.trim() });
      finish(new Error("Could not start the YouTube Music service: " + error.message));
    });
    child.once("close", code => {
      let payload;
      try { payload = JSON.parse(stdout.trim()); }
      catch {
        console.error("[ORBIT YouTube Music] Invalid Python bridge JSON", { action, exitCode: code, stderr: stderr.trim() || "<empty>", stdout: stdout.slice(0, 2000) });
        finish(new Error((stderr.trim() || "The music service returned an invalid response.").slice(0, 500))); return;
      }
      if (code !== 0 || payload.error) {
        console.error("[ORBIT YouTube Music] Python bridge failed", { action, exitCode: code, stderr: stderr.trim() || "<empty>", pythonError: String(payload.error || "") });
        finish(new Error(String(payload.error || stderr || "The music service failed.").slice(0, 500)));
      } else finish(null, payload);
    });
  });
}
const rate = new Map();
const rateCleanup = setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [ip, entry] of rate) if ((entry.lastSeen || entry.start || 0) < cutoff) rate.delete(ip);
  while (rate.size > 50000) rate.delete(rate.keys().next().value);
}, 60000);
rateCleanup.unref?.();
const TTL = { radio: 120000, music: 180000, podcast: 300000, countries: 86400000, channels: 21600000, films: 3600000, movies: 3600000 };
let tvCatalog = null, tvCatalogAt = 0, countryList = null, countryListAt = 0;

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","SAMEORIGIN");
  res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy","camera=(self), microphone=(self), geolocation=()");
  res.setHeader("X-DNS-Prefetch-Control","off");
  res.setHeader("X-Permitted-Cross-Domain-Policies","none");
  res.setHeader("Cross-Origin-Opener-Policy","same-origin");
  if(process.env.RENDER) res.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");
}
function send(res,status,data,cacheControl="no-store") {
  securityHeaders(res);
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":cacheControl});
  res.end(JSON.stringify(data));
}
function cached(key) { const x=cache.get(key); return x && Date.now()-x.at < x.ttl ? x.data : null; }
function store(key,data,ttl) { cache.set(key,{data,at:Date.now(),ttl}); if(cache.size>500) cache.delete(cache.keys().next().value); return data; }
async function getJson(url,ms=20000,headers={}) {
  const r=await fetch(url,{headers:{"User-Agent":"ORBIT Public Web/1.0","Accept":"application/json",...headers},signal:AbortSignal.timeout(ms)});
  if(!r.ok) throw new Error("Provider returned HTTP "+r.status);
  return r.json();
}
function safeText(v,max=100) { return String(v||"").trim().slice(0,max); }
async function loadTvCatalog() {
  if(tvCatalog && Date.now()-tvCatalogAt<TTL.channels) return tvCatalog;
  const [cr,sr]=await Promise.all([getJson("https://iptv-org.github.io/api/channels.json",60000),getJson("https://iptv-org.github.io/api/streams.json",60000)]);
  tvCatalog={channels:cr,streams:sr}; tvCatalogAt=Date.now(); return tvCatalog;
}
async function api(req,res,url) {
  const p=url.pathname;
  if(p==="/api/radio-stations") {
    const allowedParams=new Set(["name","tag","countrycode","language","limit","offset","order","reverse","hidebroken"]);
    const q=new URLSearchParams();
    for(const [k,v] of url.searchParams) if(allowedParams.has(k)&&v.length<=100) q.set(k,v);
    const limit=Math.min(100,Math.max(1,Number(q.get("limit")||60))); q.set("limit",String(limit)); q.set("hidebroken","true");
    const key="radio:"+q.toString(), old=cached(key); if(old)return send(res,200,old,"public, max-age=60");
    const data=await getJson("https://spinnradio.com/api/stations?"+q.toString(),25000);
    if(!Array.isArray(data))throw new Error("Radio directory response invalid");
    const safe=data.filter(s=>s&&s.stationuuid&&s.name&&[s.url_resolved,s.url].some(v=>{try{const u=new URL(v);return ["http:","https:"].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}}));
    return send(res,200,store(key,safe,TTL.radio),"public, max-age=60");
  }
  if(p==="/api/itunes-search") {
    const term=safeText(url.searchParams.get("term")||"top podcasts",100);
    const kind=url.searchParams.get("kind")||"podcast";
    const entity=kind==="podcast"?"podcast":kind==="music"?"song":kind==="movies"?"movie":"podcast";
    const u=new URL("https://itunes.apple.com/search");u.searchParams.set("term",term);u.searchParams.set("entity",entity);u.searchParams.set("limit","24");
    const data=await getJson(u,20000);return send(res,200,data,"public, max-age=300");
  }
  if(p==="/api/podcast-episodes") {
    const id=safeText(url.searchParams.get("id"),16);if(!/^\d{1,16}$/.test(id))return send(res,400,{error:"Invalid podcast ID"});
    const u=new URL("https://itunes.apple.com/lookup");u.searchParams.set("id",id);u.searchParams.set("entity","podcastEpisode");u.searchParams.set("limit","80");
    const payload=await getJson(u,20000);
    const episodes=(payload.results||[]).filter(x=>x.wrapperType==="podcastEpisode"&&String(x.episodeUrl||"").startsWith("https://")).map(x=>({id:String(x.trackId||""),title:x.trackName||"Podcast episode",date:x.releaseDate||"",duration:Number(x.trackTimeMillis)||0,audio:x.episodeUrl,artwork:x.artworkUrl600||x.artworkUrl160||""}));
    return send(res,200,episodes,"public, max-age=180");
  }
  if(p==="/api/audius-search"||p==="/api/music-search") {
    const query=safeText(url.searchParams.get("q")||"trending",100), trending=!query||query.toLowerCase()==="trending";
    const isCombined=p==="/api/music-search";
    const key=(isCombined?"music:":"audius:")+query.toLowerCase(),old=cached(key);if(old)return send(res,200,old,"public, max-age=90");
    const loadAudius=async()=>{
      const u=new URL("https://api.audius.co/v1/"+(trending?"tracks/trending":"tracks/search"));
      u.searchParams.set("limit","30");u.searchParams.set("app_name","ORBIT");if(!trending)u.searchParams.set("query",query);
      const payload=await getJson(u,20000);
      return (payload.data||[]).filter(t=>t&&t.track_id&&t.is_streamable===true&&t.is_available!==false&&t.is_stream_gated!==true&&t.is_unlisted!==true&&t.is_delete!==true&&t.access?.stream!==false).map(t=>({id:"audius:"+t.track_id,providerId:String(t.track_id),source:"Audius",title:t.title||"Untitled track",artist:t.user?.name||t.user?.handle||"Independent artist",duration:Number(t.duration)||0,genre:t.genre||"",artwork:t.artwork?.["480x480"]||t.artwork?.["150x150"]||"",permalink:t.permalink||"",playbackUrl:"",previewOnly:false,canDownload:t.is_downloadable===true&&t.access?.download!==false}));
    };
    if(!isCombined){
      const tracks=await loadAudius();
      return send(res,200,store(key,tracks,TTL.music),"public, max-age=90");
    }
    const [audiusResult,ytmusicResult]=await Promise.allSettled([
      loadAudius(),
      runYoutubeMusicBridge("search",{query:trending?"trending music":query})
    ]);
    if(audiusResult.status!=="fulfilled"&&ytmusicResult.status!=="fulfilled")throw new Error("All music catalogues are temporarily unavailable");
    const tracks=[
      ...(audiusResult.status==="fulfilled"?audiusResult.value:[]),
      ...(ytmusicResult.status==="fulfilled"&&Array.isArray(ytmusicResult.value.tracks)?ytmusicResult.value.tracks:[])
    ];
    const result={tracks,providers:{audius:audiusResult.status==="fulfilled",jamendo:false,ytmusic:ytmusicResult.status==="fulfilled",spotify:false,soundcloud:false,audiomack:false}};
    return send(res,200,store(key,result,TTL.music),"public, max-age=90");
  }
  if(p==="/api/youtube-music/audio") {
    const videoId=safeText(url.searchParams.get("videoId"),11);
    if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))return send(res,400,{error:"Invalid YouTube Music track identifier"});
    const payload=await runYoutubeMusicBridge("stream",{videoId});
    if(!payload.url||!["m4a","webm","mp4"].includes(String(payload.format||"").toLowerCase()))throw new Error("No supported audio stream was returned by YouTube Music.");
    let target;try{target=new URL(payload.url);}catch{return send(res,502,{error:"The audio provider returned an invalid stream URL"});}
    if(target.protocol!=="https:"||!target.hostname.toLowerCase().endsWith(".googlevideo.com"))return send(res,502,{error:"The audio provider returned an untrusted stream host"});
    const upstreamHeaders={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36","Accept":"*/*","Accept-Encoding":"identity"};
    if(req.headers.range)upstreamHeaders.Range=req.headers.range;
    if(req.headers["if-range"])upstreamHeaders["If-Range"]=req.headers["if-range"];
    const upstream=await fetch(target,{method:req.method==="HEAD"?"HEAD":"GET",headers:upstreamHeaders,redirect:"follow",signal:AbortSignal.timeout(45000)});
    if(!upstream.ok&&upstream.status!==206)throw new Error("YouTube audio host returned HTTP "+upstream.status+" ("+(upstream.statusText||"request rejected")+"). The stream URL may be expired or blocked.");
    let finalUrl;try{finalUrl=new URL(upstream.url);}catch{throw new Error("The audio provider returned an invalid stream redirect");}
    if(finalUrl.protocol!=="https:"||!finalUrl.hostname.toLowerCase().endsWith(".googlevideo.com"))throw new Error("The audio provider redirected to an untrusted host");
    const audioMime=["m4a","mp4"].includes(String(payload.format).toLowerCase())?"audio/mp4":"audio/webm";
    const headers={"Content-Type":upstream.headers.get("content-type")||audioMime,"Cache-Control":"no-store","Accept-Ranges":"bytes","X-Content-Type-Options":"nosniff"};
    for(const name of ["content-length","content-range","etag","last-modified"]){const value=upstream.headers.get(name);if(value)headers[name]=value;}
    res.writeHead(upstream.status,headers);
    if(req.method==="HEAD"){res.end();return;}
    if(!upstream.body){res.end();return;}
    const stream=Readable.fromWeb(upstream.body);
    stream.on("error",error=>{console.error("ORBIT YouTube Music audio proxy:",error.message);if(!res.destroyed)res.destroy();});
    res.on("close",()=>stream.destroy());stream.pipe(res);return;
  }
  if(p==="/api/audius-download") {
    const id=safeText(url.searchParams.get("id"),16);
    if(!/^\d{1,16}$/.test(id))return send(res,400,{error:"Invalid track ID"});
    const meta=await getJson("https://api.audius.co/v1/tracks/"+id+"?app_name=ORBIT",15000);
    const track=meta.data;
    if(!track||track.is_downloadable!==true||track.access?.download===false||track.is_download_gated===true)return send(res,403,{error:"The artist has not enabled downloads for this track."});
    const upstream=await fetch("https://api.audius.co/v1/tracks/"+id+"/download?app_name=ORBIT",{redirect:"follow",headers:{"User-Agent":"ORBIT Public Web/1.0"},signal:AbortSignal.timeout(30000)});
    if(!upstream.ok||!upstream.body)throw new Error("Audius download unavailable");
    const target=new URL(upstream.url);if(target.protocol!=="https:")throw new Error("Unsafe download redirect");
    const filename=(String(track.title||"ORBIT-audio").replace(/[<>:"/\|?*\x00-\x1f]/g," ").trim().slice(0,100)||"ORBIT-audio")+".mp3";
    res.writeHead(200,{"Content-Type":upstream.headers.get("content-type")||"audio/mpeg","Content-Disposition":"attachment; filename*=UTF-8''"+encodeURIComponent(filename),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
    const {Readable}=await import("node:stream");const dl=Readable.fromWeb(upstream.body);dl.on("error",err=>{console.error("ORBIT download stream error:",err.message);if(!res.destroyed)res.destroy();});res.on("close",()=>dl.destroy());dl.pipe(res);return;
  }
  if(p==="/api/audius-stream") {
    const id=safeText(url.searchParams.get("id"),16);if(!/^\d{1,16}$/.test(id))return send(res,400,{error:"Invalid track ID"});
    const rangeHeaders={"User-Agent":"ORBIT Public Web/1.0"};
    const range=req.headers.range,ifRange=req.headers["if-range"];
    if(range)rangeHeaders.Range=range;
    if(ifRange)rangeHeaders["If-Range"]=ifRange;
    const upstream=await fetch("https://api.audius.co/v1/tracks/"+id+"/stream?app_name=ORBIT",{method:req.method==="HEAD"?"HEAD":"GET",redirect:"follow",headers:rangeHeaders,signal:AbortSignal.timeout(20000)});
    if(!upstream.ok||(!upstream.body&&req.method!=="HEAD"))throw new Error("Audio stream unavailable");
    const target=new URL(upstream.url);if(target.protocol!=="https:")throw new Error("Unsafe stream redirect");
    const headers={"Content-Type":upstream.headers.get("content-type")||"audio/mpeg","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
    for(const name of ["content-length","content-range","accept-ranges","etag","last-modified"]){const value=upstream.headers.get(name);if(value)headers[name]=value;}
    res.writeHead(upstream.status,headers);
    if(req.method==="HEAD"){res.end();return;}
    const {Readable}=await import("node:stream");const st=Readable.fromWeb(upstream.body);st.on("error",err=>{console.error("ORBIT stream error:",err.message);if(!res.destroyed)res.destroy();});res.on("close",()=>st.destroy());st.pipe(res);return;
  }
  if(p==="/api/librivox") {
    let target;try{target=new URL(url.searchParams.get("url")||"");}catch{return send(res,400,{error:"Invalid LibriVox URL"});}
    if(target.protocol!=="https:"||target.hostname!=="librivox.org"||!/^\/api\/feed\/audiobooks\/?$/.test(target.pathname))return send(res,400,{error:"Only the LibriVox catalogue is supported"});
    const upstream=await fetch(target,{signal:AbortSignal.timeout(15000)});
    if(upstream.status===404)return send(res,200,{books:[]},"public, max-age=300");
    if(!upstream.ok)throw new Error("LibriVox unavailable");
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"public, max-age=300","X-Content-Type-Options":"nosniff"});res.end(await upstream.text());return;
  }
  if(p==="/api/rss") {
    let target;try{target=new URL(url.searchParams.get("url")||"");}catch{return send(res,400,{error:"Invalid feed URL"});}
    if(target.protocol!=="https:"||!/(^|\.)librivox\.org$/i.test(target.hostname))return send(res,400,{error:"Only LibriVox RSS feeds are supported"});
    const upstream=await fetch(target,{signal:AbortSignal.timeout(15000)});if(!upstream.ok)throw new Error("Feed unavailable");
    res.writeHead(200,{"Content-Type":"application/rss+xml; charset=utf-8","Cache-Control":"public, max-age=300","X-Content-Type-Options":"nosniff"});res.end(await upstream.text());return;
  }
  if(p==="/api/global-countries") {
    if(countryList&&Date.now()-countryListAt<TTL.countries)return send(res,200,countryList,"public, max-age=3600");
    let data;try{data=await getJson("https://dearbulut.github.io/iptv/api/v1/countries.json",25000);}catch{data=await getJson("https://iptv-org.github.io/api/countries.json",25000);}
    countryList=(data||[]).filter(x=>x&&x.code&&x.name);countryListAt=Date.now();return send(res,200,countryList,"public, max-age=3600");
  }
  if(p==="/api/global-channels") {
    const code=safeText(url.searchParams.get("country"),2).toLowerCase();if(!/^[a-z]{2}$/.test(code))return send(res,400,{error:"Choose a valid country code"});
    const key="tv:"+code,old=cached(key);if(old)return send(res,200,old,"public, max-age=1800");
    const data=await loadTvCatalog();const ids=new Set(data.channels.filter(c=>c&&c.id&&String(c.country||"").toLowerCase()===code).map(c=>c.id));
    const streams=data.streams.filter(s=>s&&s.url&&ids.has(s.channel)&&/^https?:\/\//i.test(s.url));
    const channels=data.channels.filter(c=>c&&ids.has(c.id)).map(c=>({...c,streams:streams.filter(s=>s.channel===c.id)}));
    const result={channels,streams};return send(res,200,store(key,result,TTL.channels),"public, max-age=1800");
  }
  if(p==="/api/global-search") {
    const q=safeText(url.searchParams.get("q"),80).toLowerCase();if(q.length<2)return send(res,200,{channels:[],streams:[]});
    const data=await loadTvCatalog();const matches=data.channels.filter(c=>c&&c.id&&[c.name,c.network,c.country,...(c.alt_names||[])].join(" ").toLowerCase().includes(q)).slice(0,20);
    const ids=new Set(matches.map(c=>c.id));const streams=data.streams.filter(s=>s&&s.url&&ids.has(s.channel));
    return send(res,200,{channels:matches.map(c=>({...c,streams:streams.filter(s=>s.channel===c.id)})),streams},"public, max-age=300");
  }
  if(p==="/api/films") {
    const term=safeText(url.searchParams.get("q"),80),safe=term.replace(/[^\p{L}\p{N}\s'-]/gu," ").replace(/\s+/g," ").trim();
    const license="https://creativecommons.org/publicdomain/mark/1.0/";
    let query='mediatype:movies AND collection:feature_films AND licenseurl:"'+license+'"';
    if(safe&&safe.toLowerCase()!=="popular"){const phrase=safe.replace(/["\\]/g," ");query+=' AND (title:"'+phrase+'" OR creator:"'+phrase+'" OR subject:"'+phrase+'")';}
    const u=new URL("https://archive.org/advancedsearch.php");u.searchParams.set("q",query);
    for(const f of ["identifier","title","year","creator","licenseurl","subject","description"])u.searchParams.append("fl[]",f);
    u.searchParams.set("rows","32");u.searchParams.set("page","1");u.searchParams.set("output","json");u.searchParams.append("sort[]","downloads desc");
    const payload=await getJson(u,25000);const blocked=/(sex|erotic|porn|xxx|nude|nudity|adult|hardcore|fetish|lust|orgasm|hentai|strip|playboy|pleasure|sexy|sensual|seduction)/i;
    const docs=(payload.response?.docs||[]).filter(x=>x.identifier&&x.licenseurl===license&&!blocked.test([x.title,x.creator,x.description,...(Array.isArray(x.subject)?x.subject:[x.subject||""])].join(" ")));
    return send(res,200,docs.map(x=>({id:x.identifier,title:x.title||x.identifier,year:x.year||"",creator:Array.isArray(x.creator)?x.creator.slice(0,2).join(", "):(x.creator||"Not listed"),artwork:"https://archive.org/services/img/"+encodeURIComponent(x.identifier)})),"public, max-age=1800");
  }
  if(p==="/api/film-download-url") {
    const id=safeText(url.searchParams.get("id"),180);if(!/^[A-Za-z0-9._-]{1,180}$/.test(id))return send(res,400,{error:"Invalid film ID"});
    const meta=await getJson("https://archive.org/metadata/"+encodeURIComponent(id),20000);
    const file=(meta.files||[]).filter(f=>f.name&&[".mp4",".m4v",".webm"].some(ext=>f.name.toLowerCase().endsWith(ext))).sort((a,b)=>(Number(b.size)||0)-(Number(a.size)||0))[0];
    if(!file)return send(res,404,{error:"No downloadable video file listed"});
    return send(res,200,{url:"https://archive.org/download/"+encodeURIComponent(id)+"/"+file.name.split("/").map(encodeURIComponent).join("/"),title:meta.metadata?.title||id});
  }
  if(p==="/api/spinn-movies") {
    const key="spinn-movies",old=cached(key);if(old)return send(res,200,old,"public, max-age=1800");
    const data=await getJson("https://spinnradio.com/api/movies",30000);if(!data||!Array.isArray(data.rows))throw new Error("Movie catalogue invalid");
    return send(res,200,store(key,data,TTL.movies),"public, max-age=1800");
  }
  if(p==="/api/movie-trailers") {
    try {
      const title=safeText(url.searchParams.get("title"),100);
      const year=safeText(url.searchParams.get("year"),4).replace(/[^0-9]/g,"");
      if(title.length<2)return send(res,400,{error:"A movie title is required"});
      const cleanTitle=title.replace(/[<>]/g," ").replace(/\s+/g," ").trim();
      const headers={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36","Accept-Language":"en-US,en;q=0.9"};
      const parseSearch=async query=>{
        const upstream=await fetch("https://www.youtube.com/results?search_query="+encodeURIComponent(query),{headers,signal:AbortSignal.timeout(18000)});
        if(!upstream.ok)return [];
        const html=await upstream.text();
        const match=html.match(/ytInitialData\s*=\s*(\{.*?\})\s*;\s*<\/script>/s);
        if(!match)return [];
        const data=JSON.parse(match[1]),found=[];
        const walk=value=>{
          if(!value||typeof value!=="object"||found.length>=35)return;
          if(value.videoRenderer){
            const v=value.videoRenderer;
            const videoTitle=v.title?.runs?.map(x=>x.text||"").join("")||v.title?.simpleText||"";
            const author=v.ownerText?.runs?.map(x=>x.text||"").join("")||v.shortBylineText?.runs?.map(x=>x.text||"").join("")||"YouTube";
            const thumbnails=v.thumbnail?.thumbnails||[],length=v.lengthText?.simpleText||"";
            const seconds=length.split(":").reduce((n,part)=>n*60+(Number(part)||0),0);
            if(v.videoId&&/^[A-Za-z0-9_-]{11}$/.test(v.videoId)&&seconds>=45&&/\b(trailer|teaser)\b/i.test(videoTitle)&&!/reaction|review|explained|recap|fan.?made|parody|compilation/i.test(videoTitle))
              found.push({videoId:v.videoId,title:videoTitle.slice(0,180),author:author.slice(0,100),length,thumbnail:thumbnails.at(-1)?.url||""});
            return;
          }
          if(Array.isArray(value))for(const item of value)walk(item);
          else for(const item of Object.values(value))walk(item);
        };
        walk(data);return found;
      };
      const yearPart=year?" "+year:"";
      const netflixResults=await parseSearch('"'+cleanTitle+'"'+yearPart+" official trailer Netflix");
      const netflixOnly=netflixResults.filter(v=>/^Netflix(?:\s|$|:)/i.test(v.author)||/^Netflix\b/i.test(v.author));
      let otherResults=[];
      if(netflixOnly.length<3)otherResults=await parseSearch('"'+cleanTitle+'"'+yearPart+" official trailer");
      const seen=new Set();
      const trailers=[...netflixOnly.map(v=>({...v,source:"Netflix channel"})),...otherResults.map(v=>({...v,source:"YouTube result"}))]
        .filter(v=>{
          if(seen.has(v.videoId))return false;seen.add(v.videoId);
          const lower=v.title.toLowerCase(),clean=cleanTitle.toLowerCase();
          return lower.includes(clean)||clean.split(/\s+/).filter(w=>w.length>3).some(w=>lower.includes(w));
        }).slice(0,8).map(v=>({youtubeId:v.videoId,title:v.title,thumbnail:v.thumbnail,channel:v.author,source:v.source}));
      return send(res,200,{title:cleanTitle,trailers},"public, max-age=1800");
    } catch {
      return send(res,200,{title:"",trailers:[],message:"Trailer search is temporarily unavailable."});
    }
  }
  if(p==="/api/youtube-search") {
    try {
      const query=safeText(url.searchParams.get("q"),120);
      if(!query)return send(res,400,{error:"A search term is required"});
      const upstream=await fetch("https://www.youtube.com/results?search_query="+encodeURIComponent(query),{
        headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36","Accept-Language":"en-US,en;q=0.9"},
        signal:AbortSignal.timeout(20000)
      });
      if(!upstream.ok)return send(res,upstream.status,{error:"YouTube search unavailable"});
      const html=await upstream.text();
      const match=html.match(/ytInitialData\s*=\s*(\{.*?\})\s*;\s*<\/script>/s);
      if(!match)return send(res,502,{error:"YouTube did not return searchable results"});
      const data=JSON.parse(match[1]),found=[];
      const walk=value=>{
        if(!value||typeof value!=="object"||found.length>=30)return;
        if(value.videoRenderer){
          const v=value.videoRenderer;
          const title=v.title?.runs?.map(x=>x.text||"").join("")||v.title?.simpleText||"";
          const author=v.ownerText?.runs?.map(x=>x.text||"").join("")||v.shortBylineText?.runs?.map(x=>x.text||"").join("")||"YouTube";
          const thumbnails=v.thumbnail?.thumbnails||[],length=v.lengthText?.simpleText||"";
          const seconds=length.split(":").reduce((n,part)=>n*60+(Number(part)||0),0);
          if(v.videoId&&title&&seconds>=60)found.push({videoId:v.videoId,title,author,length,thumbnail:thumbnails.at(-1)?.url||""});
          return;
        }
        if(Array.isArray(value))for(const item of value)walk(item);
        else for(const item of Object.values(value))walk(item);
      };
      walk(data);
      return send(res,200,found.slice(0,24),"public, max-age=120");
    } catch {
      return send(res,502,{error:"Could not retrieve YouTube search results"});
    }
  }
  if(p==="/api/offline-list") return send(res,200,[]);
  if(p==="/api/offline-file") return send(res,404,{error:"Downloads are stored on each visitor's own device in the public web version."});
  if(p==="/api/mobile-info"||p==="/api/mobile-qr"||p==="/api/token") return send(res,404,{error:"This endpoint is only available in the desktop/mobile test app."});
  return send(res,404,{error:"API route not found"});
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url||"/","http://localhost");
  if(url.pathname==="/healthz"){securityHeaders(res);res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"}).end('{"status":"ok"}');return;}
  if(url.pathname==="/favicon.ico"){
    securityHeaders(res);res.writeHead(302,{"Location":"/icons/orbit-192.png","Cache-Control":"public, max-age=86400"}).end();
    return;
  }
  if(url.pathname==="/download"||url.pathname==="/download/windows"){
    securityHeaders(res);res.writeHead(302,{"Location":"https://github.com/Nin01234/ORBIT-Desktop/releases/download/v1.1.28/ORBIT-Setup-1.1.28-x64.exe","Cache-Control":"no-store"}).end();
    return;
  }
  if(url.pathname.startsWith("/api/")){
    const ip=(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"unknown").toString().split(",")[0].trim();
    const now=Date.now(),entry=rate.get(ip)||{start:now,count:0,lastSeen:now};
    if(now-entry.start>60000){entry.start=now;entry.count=0;}entry.count++;entry.lastSeen=now;rate.set(ip,entry);
    if(rate.size>50000){for(let i=0;i<10000;i++){const first=rate.keys().next().value;if(first===undefined)break;rate.delete(first);}}
    if(entry.count>150){res.writeHead(429,{"Retry-After":"60","Content-Type":"application/json"}).end('{"error":"Too many requests. Please wait a minute."}');return;}
    if(req.method!=="GET"&&req.method!=="HEAD"){res.writeHead(405,{"Allow":"GET, HEAD"}).end("Method not allowed");return;}
    try{return await api(req,res,url);}catch(error){
      console.error("ORBIT public API:",url.pathname,error?.stack||error?.message||String(error));
      const isYoutubeAudio=url.pathname==="/api/youtube-music/audio";
      if(!res.headersSent)send(res,502,{error:isYoutubeAudio?(error?.message||"YouTube Music audio is temporarily unavailable."):"The requested service is temporarily unavailable."});
      else res.destroy();return;
    }
  }
  if(!["GET","HEAD"].includes(req.method||"GET")){res.writeHead(405,{"Allow":"GET, HEAD"}).end("Method not allowed");return;}
  let name;try{name=decodeURIComponent(url.pathname).replace(/^\/+/,"");}catch{res.writeHead(400).end("Bad request");return;}
  if(!name)name="index.html";
  const icon=/^icons\/[A-Za-z0-9._-]+\.png$/i.test(name);
  if(!allowed.has(name)&&!icon){res.writeHead(404).end("Not found");return;}
  const target=path.resolve(root,name);if(!target.startsWith(root+path.sep)){res.writeHead(403).end("Forbidden");return;}
  fs.readFile(target,(err,data)=>{if(err){securityHeaders(res);res.writeHead(404).end("Not found");return;}securityHeaders(res);res.writeHead(200,{"Content-Type":mime[path.extname(target)]||"application/octet-stream","Cache-Control":name==="index.html"||name==="sw.js"||/\.(js|css)$/.test(name)?"no-cache":"public, max-age=3600"});if(req.method==="HEAD")res.end();else res.end(data);});
});
const liveRooms=new Map();
const liveWss=new WebSocketServer({noServer:true,maxPayload:8192});
function wsSend(socket,payload){if(socket&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(payload));}
function closeLiveRoom(roomId,reason="The host ended this live podcast."){const room=liveRooms.get(roomId);if(!room)return;for(const listener of room.listeners.values()){wsSend(listener,{type:"ended",message:reason});try{listener.close(1000,reason.slice(0,120));}catch{}}room.listeners.clear();liveRooms.delete(roomId);}
liveWss.on("connection",(socket,request)=>{
  socket.isAlive=true;socket.on("pong",()=>{socket.isAlive=true;});socket.on("error",()=>{});
  socket.on("message",raw=>{
    let message;try{message=JSON.parse(raw.toString());}catch{return wsSend(socket,{type:"error",message:"Invalid live message."});}
    if(!message||typeof message.type!=="string")return;
    if(message.type==="create"){
      if(socket.role)return wsSend(socket,{type:"error",message:"This connection already has a role."});
      const ip=String(request.headers["x-forwarded-for"]||request.socket.remoteAddress||"unknown").split(",")[0].trim();
      if(liveRooms.size>=150||[...liveRooms.values()].filter(room=>room.ip===ip).length>=2)return wsSend(socket,{type:"error",message:"The free live-room limit has been reached for now. Try again later."});
      let roomId;do{roomId=randomBytes(5).toString("hex").toUpperCase();}while(liveRooms.has(roomId));
      socket.role="host";socket.roomId=roomId;liveRooms.set(roomId,{host:socket,listeners:new Map(),createdAt:Date.now(),ip});return wsSend(socket,{type:"created",room:roomId});
    }
    if(message.type==="join"){
      const roomId=String(message.room||"").toUpperCase();if(!/^[A-F0-9]{10}$/.test(roomId))return wsSend(socket,{type:"error",message:"Enter a valid room code."});
      const room=liveRooms.get(roomId);if(!room||room.host.readyState!==WebSocket.OPEN)return wsSend(socket,{type:"error",message:"That live room is not available. Check the code or ask the host to start again."});if(room.listeners.size>=8)return wsSend(socket,{type:"error",message:"This live room has reached its free-version limit of 8 listeners."});
      if(socket.role)return wsSend(socket,{type:"error",message:"Leave your current room first."});
      const peerId=randomBytes(8).toString("hex");socket.role="listener";socket.roomId=roomId;socket.peerId=peerId;room.listeners.set(peerId,socket);
      wsSend(socket,{type:"joined",room:roomId,peerId});wsSend(room.host,{type:"peer-joined",peerId});return;
    }
    if(message.type==="signal"){
      const room=liveRooms.get(socket.roomId);if(!room)return;
      const peerId=String(message.peerId||"");if(!message.data||typeof message.data!=="object")return;
      if(socket.role==="host"){const target=room.listeners.get(peerId);if(target)wsSend(target,{type:"signal",data:message.data});}
      else if(socket.role==="listener"&&socket.peerId===peerId){wsSend(room.host,{type:"signal",peerId,data:message.data});}
      return;
    }
    if(message.type==="leave"&&socket.role==="listener"){const room=liveRooms.get(socket.roomId);if(room){room.listeners.delete(socket.peerId);wsSend(room.host,{type:"peer-left",peerId:socket.peerId});}socket.role=null;socket.roomId=null;return;}
    if(message.type==="end"&&socket.role==="host"){closeLiveRoom(socket.roomId);socket.role=null;socket.roomId=null;return;}
  });
  socket.on("close",()=>{
    const room=liveRooms.get(socket.roomId);if(!room)return;
    if(socket.role==="host")closeLiveRoom(socket.roomId);
    else if(socket.role==="listener"){room.listeners.delete(socket.peerId);wsSend(room.host,{type:"peer-left",peerId:socket.peerId});}
  });
});
const heartbeat=setInterval(()=>{for(const socket of liveWss.clients){if(socket.isAlive===false){socket.terminate();continue;}socket.isAlive=false;socket.ping();}},30000);
liveWss.on("close",()=>clearInterval(heartbeat));
server.on("upgrade",(request,socket,head)=>{
  let pathname;try{pathname=new URL(request.url||"/","http://localhost").pathname;}catch{socket.destroy();return;}
  if(pathname!=="/signal"){socket.destroy();return;}
  const origin=request.headers.origin||"";
  if(origin){try{const u=new URL(origin),local=["localhost","127.0.0.1"].includes(u.hostname);if(!local&&u.host!==request.headers.host){socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");socket.destroy();return;}}catch{socket.destroy();return;}}
  liveWss.handleUpgrade(request,socket,head,ws=>liveWss.emit("connection",ws,request));
});
const host=process.env.RENDER?"0.0.0.0":"127.0.0.1";
server.listen(port,host,()=>{
  console.log("ORBIT public-web server listening on "+host+":"+port);
  loadTvCatalog().catch(e=>console.log("TV catalog prewarm:",e.message));
});
