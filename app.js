const $ = (s,root=document)=>root.querySelector(s);
const $$ = (s,root=document)=>[...root.querySelectorAll(s)];
const audio = $("#audio-player");
const SPINN_RADIO_API = "/api/radio-stations";
let orbitBaseVolume = 0.8;
let orbitSoundMode = "normal";
let stations = [];
const stationCache = new Map();
let currentStation = null;
let radioPlayToken = 0;
let radioPlayback = null;
let radioHls = null;
let radioHlsLoader = null;
let globeInstance = null;
let globeResizeObserver = null;

let toastTimer;
const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const initials = s => (s||"O").trim().slice(0,1).toUpperCase();
const notify = msg => { const t=$("#toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove("show"),2400); };
const favs = () => { try{return JSON.parse(localStorage.getItem("orbit-favourites")||"[]")}catch{return[]} };
const saveFavs = v => localStorage.setItem("orbit-favourites",JSON.stringify(v));
const isFav = id => favs().some(x=>x.stationuuid===id);
const stationName = s => s.name || "Unknown station";
const stationLocation = s => [s.country,s.language].filter(Boolean).join(" / ") || s.tags || "Live radio";
const stationCard = s => `<article class="station-card"><div class="station-card-top"><div class="station-art">${esc(initials(stationName(s)))}</div><button class="heart-button ${isFav(s.stationuuid)?"saved":""}" data-fav="${esc(s.stationuuid)}" title="Save favourite">${isFav(s.stationuuid)?"\u{1F496}":"\u{1F90D}"}</button></div><h3 title="${esc(stationName(s))}">${esc(stationName(s))}</h3><p title="${esc(stationLocation(s))}">${esc(stationLocation(s))}</p><div class="station-card-bottom"><small>${esc(s.codec||"Live")} ${s.bitrate? " / "+s.bitrate+" kbps":""}</small><button class="mini-play" data-play="${esc(s.stationuuid)}" title="Play station"><span class="play-glyph" aria-hidden="true"></span></button></div></article>`;
const stationRow = s => `<div class="station-row"><div class="station-art">${esc(initials(stationName(s)))}</div><div class="station-row-main"><b>${esc(stationName(s))}</b><small>${esc(stationLocation(s))}</small></div><button data-play="${esc(s.stationuuid)}" title="Play"><span class="play-glyph" aria-hidden="true"></span></button><button class="heart-button ${isFav(s.stationuuid)?"saved":""}" data-fav="${esc(s.stationuuid)}" title="Favourite">${isFav(s.stationuuid)?"\u{1F496}":"\u{1F90D}"}</button></div>`;
async function radioSearch(params={}){
  const q=new URLSearchParams({limit:"60",hidebroken:"true",order:"clickcount",reverse:"true",...params});
  const r=await fetch(SPINN_RADIO_API+"?"+q.toString(),{signal:AbortSignal.timeout(25000)});
  if(!r.ok)throw new Error("Spinn Radio station catalogue unavailable"); return r.json();
}
async function loadFeatured(){
  const host=$("#featured-stations");if(!host)return;
  host.innerHTML='<div class="loading-card">Finding live stations around the worldï¿½</div>';
  try{
    const q=new URLSearchParams({limit:"8",hidebroken:"true",order:"clickcount",reverse:"true"});
    const response=await fetch(SPINN_RADIO_API+"?"+q.toString(),{cache:"no-store",signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new Error("Station directory returned HTTP "+response.status);
    const data=await response.json();if(!Array.isArray(data))throw new Error("Station directory response was invalid");
    data.forEach(s=>stationCache.set(s.stationuuid,s));
    host.innerHTML=data.length?data.slice(0,8).map(stationCard).join(""):'<div class="empty-state">No live stations are available right now.</div>';
    $("#station-count").textContent=String(data.length);
  }catch(error){
    host.innerHTML='<div class="empty-state">Live stations could not be loaded. Check your connection and try again.</div><button type="button" id="featured-stations-retry">Retry stations</button>';
    $("#featured-stations-retry")?.addEventListener("click",()=>loadFeatured(),{once:true});
  }
}
async function loadStationList(){
  const country=$("#country-filter").value, term=$("#station-search").value.trim();
  const params={limit:"80"};if(country)params.countrycode=country;if(term)params.name=term;
  try{stations=await radioSearch(params);stations.forEach(s=>stationCache.set(s.stationuuid,s));renderStationResults();updateGlobe();}
  catch{$("#station-results").innerHTML='<div class="empty-state">Could not reach the radio directory. Check your connection.</div>';}
}
function renderStationResults(){ $("#station-results").innerHTML=stations.length?stations.slice(0,60).map(stationRow).join(""):'<div class="empty-state">No matching stations. Try another country or search.</div>'; }
function radioProxyUrl(url,station){
  if(!window.orbitDesktop?.isDesktop)return url;
  const params=new URLSearchParams({url});
  try{const ref=new URL(station?.homepage||"");if(ref.protocol==="http:"||ref.protocol==="https:")params.set("ref",ref.toString());}catch{}
  return "/api/radio-proxy?"+params.toString();
}
async function ensureRadioHls(){
  if(window.Hls)return;
  if(!radioHlsLoader){
    radioHlsLoader=new Promise((resolve,reject)=>{
      const existing=document.querySelector("#orbit-radio-hls-loader");
      if(existing){existing.addEventListener("load",resolve,{once:true});existing.addEventListener("error",()=>reject(Error("The HLS playback engine could not be loaded.")),{once:true});return;}
      const script=document.createElement("script");
      script.id="orbit-radio-hls-loader";
      script.src="https://cdn.jsdelivr.net/npm/hls.js@1.5.18/dist/hls.min.js";
      script.onload=resolve;
      script.onerror=()=>{radioHlsLoader=null;reject(Error("The HLS playback engine could not be loaded. Check your connection."));};
      document.head.appendChild(script);
    });
  }
  await radioHlsLoader;
  if(!window.Hls)throw Error("The HLS playback engine is unavailable.");
}
async function attemptRadioPlayback(token,index){
  const state=radioPlayback;
  if(!state||state.token!==token||token!==radioPlayToken)return;
  if(index>=state.plans.length){
    state.active=false;
    state.retrying=true;
    state.reconnectCount=(state.reconnectCount||0)+1;
    const wait=Math.min(30000,2000*Math.pow(2,Math.min(state.reconnectCount-1,4)));
    $("#player-state").textContent="Station temporarily unavailable — retrying in "+Math.round(wait/1000)+"s…";
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer=setTimeout(()=>{
      if(token!==radioPlayToken||radioPlayback!==state||!currentStation)return;
      state.retrying=false;
      attemptRadioPlayback(token,0);
    },wait);
    return;
  }
  state.index=index;state.active=true;state.retrying=false;clearTimeout(state.reconnectTimer);
  const plan=state.plans[index];
  if(radioHls){radioHls.destroy();radioHls=null;}
  audio.pause();audio.removeAttribute("src");audio.load();
  $("#player-state").textContent="Connecting to "+stationName(state.station)+"…";
  try{
    if(plan.transport==="hls"){
      await ensureRadioHls();
      if(token!==radioPlayToken)return;
      if(!Hls.isSupported())throw Error("This device cannot play this HLS radio stream.");
      await new Promise((resolve,reject)=>{
        const h=new Hls({
          enableWorker:true,lowLatencyMode:false,backBufferLength:90,maxBufferLength:30,
          manifestLoadingTimeOut:30000,manifestLoadingMaxRetry:6,manifestLoadingRetryDelay:1000,
          levelLoadingTimeOut:30000,levelLoadingMaxRetry:8,levelLoadingRetryDelay:1000,
          fragLoadingTimeOut:30000,fragLoadingMaxRetry:8,fragLoadingRetryDelay:1000
        });
        radioHls=h;let settled=false,timer;
        const finish=error=>{
          if(settled)return;settled=true;clearTimeout(timer);
          error?reject(error):resolve();
        };
        h.on(Hls.Events.MEDIA_ATTACHED,()=>{if(token===radioPlayToken)h.loadSource(radioProxyUrl(plan.url,state.station));});
        h.on(Hls.Events.MANIFEST_PARSED,()=>{
          if(token!==radioPlayToken){finish(Error("Station changed."));return;}
          Promise.resolve(audio.play()).then(()=>finish()).catch(finish);
        });
        h.on(Hls.Events.ERROR,(_event,data)=>{
          if(!data.fatal)return;
          const failure=Error("The station's HLS stream could not be decoded.");
          if(!settled)finish(failure);
          else if(token===radioPlayToken&&radioPlayback===state){
            state.active=false;
            retryRadioPlayback(token,"HLS radio connection lost");
          }
        });
        h.attachMedia(audio);
        timer=setTimeout(()=>finish(Error("The station did not start within 30 seconds.")),30000);
      });
    }else{
      audio.src=plan.transport==="proxy"?radioProxyUrl(plan.url,state.station):plan.url;
      audio.load();
      await audio.play();
    }
    if(token!==radioPlayToken)return;
    state.active=false;state.retrying=false;state.reconnectCount=0;
    setPlayer(stationName(state.station),stationLocation(state.station),"Live radio");
  }catch(error){
    if(token!==radioPlayToken)return;
    state.active=false;
    if(radioHls){radioHls.destroy();radioHls=null;}
    attemptRadioPlayback(token,index+1);
  }
}
function retryRadioPlayback(token,reason="The stream stopped"){
  const state=radioPlayback;
  if(!state||state.token!==token||token!==radioPlayToken||state.retrying||state.active)return;
  clearTimeout(state.reconnectTimer);
  state.retrying=true;
  state.active=true;
  $("#player-state").textContent=reason+" — reconnecting…";
  attemptRadioPlayback(token,state.index+1);
}
function playStation(id){
  const s=stations.find(x=>x.stationuuid===id)||stationCache.get(id)||favs().find(x=>x.stationuuid===id);
  if(!s){notify("Station is no longer in the current results.");return;}
  const token=++radioPlayToken;
  if(radioHls){radioHls.destroy();radioHls=null;}
  clearYoutubePlayer();currentOfflineAudioId=null;currentMusicTrack=null;currentStation=s;
  const urls=[...new Set([s.url_resolved,s.url].filter(x=>{try{const u=new URL(x);return u.protocol==="http:"||u.protocol==="https:";}catch{return false;}}))];
  const plans=[];
  for(const url of urls){
    const lower=url.toLowerCase(),tags=String(s.codec||"")+" "+String(s.tags||"");
    const hls=lower.includes(".m3u8")||tags.toLowerCase().includes("hls");
    if(hls)plans.push({url,transport:"hls"});
    else plans.push({url,transport:"proxy"},{url,transport:"direct"});
  }
  radioPlayback={token,station:s,plans,index:0,active:false,retrying:false,reconnectCount:0,reconnectTimer:null};
  $("#player-fav").textContent=isFav(id)?"\u{1F496}":"\u{1F90D}";
  $("#player-fav").classList.toggle("saved",isFav(id));
  $("#player-art").textContent=initials(stationName(s));
  $("#player-state").textContent="Connecting to live stream";
  attemptRadioPlayback(token,0);
}
function setPlayer(title,subtitle,state){$("#player-title").textContent=title;$("#player-subtitle").textContent=subtitle;$("#player-state").textContent=state;$("#play-button").classList.add("is-playing");}
function toggleFav(id){
  let list=favs();const found=list.some(x=>x.stationuuid===id);
  if(found)list=list.filter(x=>x.stationuuid!==id);else{const s=stations.find(x=>x.stationuuid===id)||stationCache.get(id)||currentStation;if(s)list.unshift(s);}
  saveFavs(list);notify(found?"Removed from favourites":"Saved to your favourites");refreshFavViews();
}
function refreshFavViews(){
  const ids=favs();
  $("#favorite-results").innerHTML=ids.length?ids.map(stationCard).join(""):'<div class="empty-state">Your favourite stations will appear here.</div>';
  if(currentStation)$("#player-fav").textContent=isFav(currentStation.stationuuid)?"\u{1F496}":"\u{1F90D}";
  if(currentMusicTrack){const yes=isMusicFav(currentMusicTrack.id);$("#player-fav").textContent=yes?"\u{1F496}":"\u{1F90D}";$("#player-fav").classList.toggle("saved",yes);}
  $$("[data-fav]").forEach(b=>{const yes=isFav(b.dataset.fav);b.textContent=yes?"\u{1F496}":"\u{1F90D}";b.classList.toggle("saved",yes);});
  $$("[data-audio-fav]").forEach(b=>{const yes=isMusicFav(b.dataset.audioFav);b.textContent=yes?"\u{1F496}":"\u{1F90D}";b.classList.toggle("saved",yes);});
  renderFavouriteMusic();
}
let orbitViewHistory=["discover"];
let orbitViewHistoryIndex=0;
let orbitHistoryTraversal=false;
function syncAppHistoryButtons(){
  const back=$("#app-back"),forward=$("#app-forward");
  if(back)back.disabled=orbitViewHistoryIndex<=0;
  if(forward)forward.disabled=orbitViewHistoryIndex>=orbitViewHistory.length-1;
}
function showView(name){
  if(!orbitHistoryTraversal&&orbitViewHistory[orbitViewHistoryIndex]!==name){
    orbitViewHistory=orbitViewHistory.slice(0,orbitViewHistoryIndex+1);
    orbitViewHistory.push(name);
    orbitViewHistoryIndex=orbitViewHistory.length-1;
  }
  syncAppHistoryButtons();
  $$(".view").forEach(v=>v.classList.toggle("active",v.id==="view-"+name));
  $$(".nav-link[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===name));
  const labels={discover:"Discover",search:"Search results",globe:"Radio globe",podcasts:"Podcasts",audiobooks:"Audiobooks","global-live":"Global Live",music:"Music", "music-video":"Music Video",movies:"Screen",favorites:"Favourites",downloads:"Downloads",settings:"Settings",omnisave:"OmniSave"};
  $("#page-label").textContent=labels[name]||"Discover";
  if(name==="globe"&&!globeInstance){setTimeout(initGlobe,100);loadStationList();}
  if(name==="global-live"&&!orbitLiveLoaded)loadGlobalLiveDirectory();
  if(name==="music"&&!$("#audio-music-results").dataset.loaded){loadAudioMusic("afrobeats").then(()=>$("#audio-music-results").dataset.loaded="1").catch(()=>notify("Music search unavailable."));}
  if(name==="music-video"&&!$("#music-video-results").dataset.loaded){loadYouTubeMusic("trending afrobeats").then(()=>$("#music-video-results").dataset.loaded="1").catch(()=>notify("Music video search unavailable."));}
  if(name==="movies"&&!$("#movie-results").dataset.loaded){loadArchiveFilms("trending").then(()=>$("#movie-results").dataset.loaded="1").catch(()=>$("#movie-results").innerHTML='<div class="empty-state">TMDB movie catalogue is temporarily unavailable.</div>');}
  if(name==="favorites")refreshFavViews();
  if(name==="downloads")loadOfflineLibrary();
  window.scrollTo({top:0,behavior:"smooth"});
}
function initGlobe(){
  const target=$("#globeViz");if(!target||!window.Globe)return;
  target.innerHTML="";
  try{
    globeInstance=Globe()(target).backgroundColor("rgba(0,0,0,0)").showAtmosphere(true).atmosphereColor("#91c9a9").atmosphereAltitude(.18).globeImageUrl("https://unpkg.com/three-globe/example/img/earth-night.jpg").pointsData([]).pointLat("geo_lat").pointLng("geo_long").pointColor(()=>"#c4f06a").pointAltitude(.015).pointRadius(.28).pointResolution(8).onPointClick(p=>{const s=stations.find(x=>x.stationuuid===p.stationuuid);if(s)playStation(s.stationuuid)}).width(Math.max(300,target.clientWidth)).height(Math.max(330,target.clientHeight||460));
    const controls=globeInstance.controls();
    controls.enabled=true;controls.enableRotate=true;controls.enableZoom=true;controls.enablePan=false;controls.autoRotate=false;controls.minDistance=120;controls.maxDistance=650;
    globeInstance.pointOfView({lat:15,lng:0,altitude:2.25},0);
    if(globeResizeObserver)globeResizeObserver.disconnect();
    if(typeof ResizeObserver!=="undefined"){globeResizeObserver=new ResizeObserver(()=>{if(globeInstance&&target.clientWidth)globeInstance.width(target.clientWidth).height(Math.max(330,target.clientHeight||460));});globeResizeObserver.observe(target);}
    updateGlobe();
  }catch(e){target.innerHTML='<div class="globe-fallback"><div class="globe-core">◎</div><span>Interactive globe unavailable; use the station list.</span></div>';}
}
function updateGlobe(){if(!globeInstance)return;const points=stations.filter(s=>Number.isFinite(Number(s.geo_lat))&&Number.isFinite(Number(s.geo_long))).map(s=>({geo_lat:Number(s.geo_lat),geo_long:Number(s.geo_long),stationuuid:s.stationuuid}));globeInstance.pointsData(points);}
async function loadItunes(kind,term){
  const q=encodeURIComponent(term||({podcasts:"top podcasts",music:"top songs",movies:"popular movies"}[kind]));
  let url;
  url=`/api/itunes-search?term=${q}&kind=${encodeURIComponent(kind)}`;
  const host=$("#"+kind.slice(0,-1)+"-results")||$("#"+kind+"-results");
  const r=await fetch(url);if(!r.ok)throw new Error("Catalogue unavailable");const data=await r.json();renderMedia(kind,data.results||[]);
}
function renderMedia(kind,items){
  const host=$("#"+({podcasts:"podcast-results",music:"music-results",movies:"movie-results"}[kind]));
  if(!items.length){host.innerHTML='<div class="empty-state">No results found. Try another search.</div>';return;}
  host.innerHTML=items.map((x)=>{
    const title=x.trackName||x.collectionName||x.artistName||"Untitled";
    const sub=x.artistName||x.primaryGenreName||x.releaseDate?.slice(0,4)||"Explore";
    const image=x.artworkUrl600||x.artworkUrl100||x.artworkUrl60||"";
    if(kind==="podcasts") return `<article class="media-card"><img class="media-cover" src="${esc(image)}" alt="" loading="lazy" onerror="this.style.display='none'"><h3 title="${esc(title)}">${esc(title)}</h3><p>${esc(sub)}</p><div class="media-actions"><small>Podcast</small><button data-podcast="${esc(x.collectionId||"")}" data-title="${esc(title)}">View episodes</button></div></article>`;
    const action=kind==="music"?(x.previewUrl?"data-preview":"data-open"):(x.previewUrl?"data-video":"data-open");
    const value=kind==="music"?(x.previewUrl||x.trackViewUrl):(x.previewUrl||x.trackViewUrl);
    return `<article class="media-card"><img class="media-cover" src="${esc(image)}" alt="" loading="lazy" onerror="this.style.display='none'"><h3 title="${esc(title)}">${esc(title)}</h3><p>${esc(sub)}</p><div class="media-actions"><small>${esc(kind==="music"?"Music":"Film")}</small><button ${action}="${esc(value||"")}" data-title="${esc(title)}">${kind==="music"?"Preview":"Watch preview"} </button></div></article>`;
  }).join("");
}
let currentYoutubeId = null;
let currentYoutubePaused = false;
let currentMusicTrack = null;
let musicQueue=[];let musicQueueIndex=-1;
let offlineMusicQueue=[];let currentOfflineAudioId=null;
const musicTrackCache = new Map();
const musicFavs = () => { try { return JSON.parse(localStorage.getItem("orbit-music-favourites") || "[]"); } catch { return []; } };
const isMusicFav = id => musicFavs().some(x => String(x.id) === String(id));
function clearYoutubePlayer(){
  const frame=$("#youtube-player-panel iframe");
  frame?.contentWindow?.postMessage(JSON.stringify({event:"command",func:"stopVideo",args:[]}),"*");
  currentYoutubeId=null;currentYoutubePaused=false;
  const panel=$("#youtube-player-panel");
  if(panel)panel.innerHTML='<div class="youtube-placeholder"><span>&#9835;</span><b>Choose a video to start watching</b><small>Playback is provided by YouTube.</small></div>';
}
function musicDuration(seconds){
  const n=Math.max(0,Number(seconds)||0);
  return Math.floor(n/60)+":"+String(Math.floor(n%60)).padStart(2,"0");
}
let musicSearchResults=[];
let musicProviderFilter="all";

const SPOTIFY_CLIENT_ID="4cf169a1fde343b59b3f86afc0e5ae8d";
const SPOTIFY_REDIRECT_URI="http://127.0.0.1:51731/auth/spotify/callback";
let spotifyTracks=[];
function spotifySetStatus(message){const node=$("#spotify-orbit-status");if(node)node.textContent=message;}
function spotifyShowConnected(connected){
 const c=$("#spotify-orbit-connect"),d=$("#spotify-orbit-disconnect"),s=$("#spotify-orbit-switch");
 if(c)c.hidden=connected;if(d)d.hidden=!connected;if(s)s.hidden=!connected;
}
function spotifyBase64Url(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
async function spotifyConnect(){
  if(location.hostname!=="127.0.0.1"&&location.hostname!=="localhost"){
    notify("Spotify sign-in is currently available in the ORBIT desktop app. Mobile sign-in needs a secure hosted callback.");return;
  }
  const random=new Uint8Array(64);crypto.getRandomValues(random);
  const verifier=spotifyBase64Url(random);
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier));
  const challenge=spotifyBase64Url(new Uint8Array(digest));
  const stateBytes=new Uint8Array(24);crypto.getRandomValues(stateBytes);
  const state=spotifyBase64Url(stateBytes);
  sessionStorage.setItem("orbit-spotify-verifier",verifier);
  sessionStorage.setItem("orbit-spotify-state",state);
  const params=new URLSearchParams({client_id:SPOTIFY_CLIENT_ID,response_type:"code",redirect_uri:SPOTIFY_REDIRECT_URI,code_challenge_method:"S256",code_challenge:challenge,state,scope:"user-read-private user-library-read playlist-read-private",show_dialog:"true"});
  location.assign("https://accounts.spotify.com/authorize?"+params.toString());
}
async function spotifyResponsePayload(response){
  const raw=await response.text();
  let payload;
  try{payload=raw?JSON.parse(raw):{};}
  catch{
    const detail=String(raw||"Empty response").replace(/\s+/g," ").trim().slice(0,260);
    throw new Error("Spotify returned a non-JSON response (HTTP "+response.status+"): "+detail);
  }
  if(!response.ok){
    const detail=payload.error?.message||payload.error_description||payload.error||payload.message||("HTTP "+response.status);
    throw new Error(String(detail));
  }
  return payload;
}
async function spotifyFinishAuthorization(){
  const query=new URLSearchParams(location.search);
  const code=query.get("spotify_code"),state=query.get("spotify_state"),error=query.get("spotify_error");
  if(!code&&!state&&!error)return;
  history.replaceState({},document.title,location.pathname);
  if(error){spotifySetStatus("Spotify authorization was cancelled or denied.");notify("Spotify connection was not completed.");return;}
  const expected=sessionStorage.getItem("orbit-spotify-state");
  const verifier=sessionStorage.getItem("orbit-spotify-verifier");
  sessionStorage.removeItem("orbit-spotify-state");
  if(!code||!state||!expected||state!==expected||!verifier){notify("Spotify sign-in could not be verified. Please connect again.");return;}
  try{
    const body=new URLSearchParams({client_id:SPOTIFY_CLIENT_ID,grant_type:"authorization_code",code,redirect_uri:SPOTIFY_REDIRECT_URI,code_verifier:verifier});
    const response=await fetch("https://accounts.spotify.com/api/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
    const payload=await spotifyResponsePayload(response);
    sessionStorage.setItem("orbit-spotify-access-token",payload.access_token);
    if(payload.refresh_token)sessionStorage.setItem("orbit-spotify-refresh-token",payload.refresh_token);
    sessionStorage.setItem("orbit-spotify-expires-at",String(Date.now()+Number(payload.expires_in||3600)*1000));
    sessionStorage.removeItem("orbit-spotify-verifier");
    spotifyShowConnected(true);spotifySetStatus("Connected to Spotify. Search for a track below.");notify("Spotify connected to ORBIT.");
  }catch(error){sessionStorage.removeItem("orbit-spotify-verifier");spotifyShowConnected(false);spotifySetStatus("Spotify connection failed. Please try again.");notify("Spotify sign-in failed: "+error.message);}
}
async function spotifyAccessToken(){
  let token=sessionStorage.getItem("orbit-spotify-access-token");
  const expires=Number(sessionStorage.getItem("orbit-spotify-expires-at")||0);
  if(token&&Date.now()<expires-60000)return token;
  const refresh=sessionStorage.getItem("orbit-spotify-refresh-token");
  if(!refresh){if(token)sessionStorage.removeItem("orbit-spotify-access-token");throw new Error("Your Spotify session expired. Connect Spotify again.");}
  const body=new URLSearchParams({client_id:SPOTIFY_CLIENT_ID,grant_type:"refresh_token",refresh_token:refresh});
  const response=await fetch("https://accounts.spotify.com/api/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  const payload=await spotifyResponsePayload(response);
  token=payload.access_token;sessionStorage.setItem("orbit-spotify-access-token",token);
  if(payload.refresh_token)sessionStorage.setItem("orbit-spotify-refresh-token",payload.refresh_token);
  sessionStorage.setItem("orbit-spotify-expires-at",String(Date.now()+Number(payload.expires_in||3600)*1000));
  return token;
}
function spotifyParseLink(value){
 const m=String(value||"").trim().match(/(?:open\.spotify\.com\/(?:embed\/)?(track|album|playlist)\/|spotify:(track|album|playlist):)([A-Za-z0-9]{10,64})/i);
 return m?{type:(m[1]||m[2]).toLowerCase(),id:m[3],url:"https://open.spotify.com/"+(m[1]||m[2]).toLowerCase()+"/"+m[3]}:null;
}
function spotifySavedItems(){try{return JSON.parse(localStorage.getItem("orbit-spotify-saved")||"[]")}catch{return[]}}
function spotifyRenderSaved(){
 const host=$("#spotify-orbit-saved");if(!host)return;const list=spotifySavedItems();
 host.innerHTML=list.length?list.map((v,i)=>'<article class="media-card spotify-track-card"><h3>'+esc(v.title)+'</h3><p>Spotify '+esc(v.type)+'</p><div class="media-actions"><button type="button" data-spotify-saved-play="'+i+'">Play</button><button type="button" data-spotify-saved-remove="'+i+'">Remove</button></div></article>').join(""):'<div class="empty-state">Save a Spotify track, album or playlist to keep it here.</div>';
}
function spotifyEmbed(item){
 const host=$("#spotify-orbit-player"),now=$("#spotify-orbit-now");host.innerHTML="";
 const frame=document.createElement("iframe");frame.title="Spotify official embedded player";frame.loading="eager";frame.allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";frame.setAttribute("allowfullscreen","");
 frame.src="https://open.spotify.com/embed/"+item.type+"/"+encodeURIComponent(item.id)+"?utm_source=generator&theme="+(document.documentElement.dataset.theme==="light"?"1":"0");
 frame.style.cssText="display:block;width:100%;height:"+(item.type==="track"?"152px":"352px")+";border:0;border-radius:12px;background:#121212";host.appendChild(frame);now.hidden=false;
 $("#spotify-orbit-now-title").textContent=item.title||("Spotify "+item.type);spotifySetStatus("Official Spotify "+item.type+" player loaded.");
}
function spotifyLoadLink(value){
 const item=spotifyParseLink(value);if(!item){notify("Enter a valid Spotify track, album or playlist link.");return;}
 item.title="Spotify "+item.type;spotifyEmbed(item);window.orbitCurrentSpotifyItem=item;$("#spotify-orbit-link").value=item.url;
 $("#spotify-orbit-results").innerHTML='<article class="media-card spotify-track-card"><h3>'+esc(item.title)+'</h3><p>Spotify '+esc(item.type)+'</p><div class="media-actions"><button type="button" data-spotify-save="1">Save to ORBIT</button><a class="spotify-track-link" href="'+esc(item.url)+'" target="_blank" rel="noopener noreferrer">Open on Spotify ↗</a></div></article>';
}
function spotifySaveCurrent(){
 const v=window.orbitCurrentSpotifyItem;if(!v){notify("Load a Spotify link first.");return;}
 const list=spotifySavedItems();if(list.some(x=>x.type===v.type&&x.id===v.id)){notify("This Spotify item is already saved.");return;}
 list.unshift({type:v.type,id:v.id,url:v.url,title:v.title});localStorage.setItem("orbit-spotify-saved",JSON.stringify(list));spotifyRenderSaved();notify("Saved to your ORBIT Spotify library.");
}
function spotifyPlaySaved(i){const v=spotifySavedItems()[i];if(v){window.orbitCurrentSpotifyItem=v;spotifyEmbed(v);$("#spotify-orbit-link").value=v.url;}}
function spotifyRemoveSaved(i){const list=spotifySavedItems();list.splice(i,1);localStorage.setItem("orbit-spotify-saved",JSON.stringify(list));spotifyRenderSaved();notify("Removed from saved Spotify music.");}
function renderMusicResults(){
  const host=$("#audio-music-results");
  const tracks=musicProviderFilter==="all"?musicSearchResults:musicSearchResults.filter(t=>t.source===musicProviderFilter);
  host.innerHTML=tracks.length?tracks.map(musicCard).join(""):'<div class="empty-state">No tracks from this provider were found for this search.</div>';
}
function musicCard(track){
  const saved=isMusicFav(track.id);
  const playLabel=track.previewOnly?"Play preview":"Play full track";
  const download='<button data-download-track="'+esc(track.id)+'" title="'+(track.canDownload?"Download for offline":"This artist has not enabled downloads")+'"'+(track.canDownload?"":" disabled")+'>'+(track.canDownload?"↓ Download":"↓ Unavailable")+'</button>';
  return '<article class="media-card music-audio-card"><img class="media-cover" src="'+esc(track.artwork||"") + '" alt="" loading="lazy" onerror="this.style.display=\'none\'"><h3 title="'+esc(track.title)+'">'+esc(track.title)+'</h3><p>'+esc(track.artist||"Independent artist")+'  -  '+musicDuration(track.duration)+'</p><div class="media-actions"><small>'+esc(track.source||track.genre||"Audio track")+(track.previewOnly?" · Preview":"")+'</small><div class="music-card-actions"><button data-audio-play="'+esc(track.id)+'">'+playLabel+'</button>'+download+'<button class="heart-button '+(saved?"saved":"")+'" data-audio-fav="'+esc(track.id)+'" title="Save favourite">'+(saved?"\u{1F496}":"\u{1F90D}")+'</button></div></div></article>';
}
async function loadAudioMusic(term="afrobeats"){
  const host=$("#audio-music-results");
  host.innerHTML='<div class="loading-card">Searching Audius and Jamendo…</div>';
  const q=(term||"trending").trim()||"trending";
  const response=await fetch("/api/music-search?q="+encodeURIComponent(q),{signal:AbortSignal.timeout(26000)});
  if(!response.ok)throw new Error("Music catalogue unavailable");
  const payload=await response.json();
  musicSearchResults=payload.tracks||[];
  musicSearchResults.forEach(t=>musicTrackCache.set(String(t.id),t));
  const providers=payload.providers||{};
  const connected=["Audius"];
  if(providers.jamendo)connected.push("Jamendo");
  const waiting=["Spotify","SoundCloud","Audiomack"].filter(Boolean);
  $("#music-provider-status").textContent="Connected: "+connected.join(" · ")+" | Setup needed: "+waiting.join(" · ");
  renderMusicResults();
  $("#audio-music-status").innerHTML='<span class="music-status-mark">&#9835;</span><div><b>Full-track music search</b><small>'+musicSearchResults.length+' matching tracks from '+connected.join(", ")+'. Preview-only iTunes music has been removed.</small></div>';
}
function toggleMusicFav(track){
  if(!track)return;
  let list=musicFavs();
  const exists=list.some(x=>String(x.id)===String(track.id));
  list=exists?list.filter(x=>String(x.id)!==String(track.id)):[track,...list];
  localStorage.setItem("orbit-music-favourites",JSON.stringify(list));
  notify(exists?"Removed from favourite music":"Saved to favourite music");
  refreshFavViews();
}
function playAudioTrack(id){
  const track=musicTrackCache.get(String(id))||musicFavs().find(x=>String(x.id)===String(id));
  if(!track){notify("This track is no longer available.");return;}
  clearYoutubePlayer();currentStation=null;currentOfflineAudioId=null;currentMusicTrack=track;musicQueue=[...musicTrackCache.values()];musicQueueIndex=musicQueue.findIndex(x=>String(x.id)===String(track.id));
  musicQueue=[...musicTrackCache.values()];musicQueueIndex=musicQueue.findIndex(x=>String(x.id)===String(track.id));
  audio.src=(track.source==="Audius"||!track.source)?"/api/audius-stream?id="+encodeURIComponent(String(track.providerId||track.id).replace(/^audius:/,"")):(track.playbackUrl||"");
  if(!audio.src){notify("This provider has not enabled playback for this track.");return;}
  audio.play().then(()=>{
    setPlayer(track.title,track.artist+"  -  "+(track.source||"Music"),track.previewOnly?"Preview playback":"Full audio track");
    $("#player-art").textContent="";$("#player-art").style.backgroundImage=track.artwork?"url("+JSON.stringify(track.artwork)+")":"";$("#player-art").style.backgroundSize="cover";
    $("#player-fav").textContent=isMusicFav(track.id)?"\u{1F496}":"\u{1F90D}";
    $("#player-fav").classList.toggle("saved",isMusicFav(track.id));
  }).catch(()=>notify("This track could not be streamed. Try another track."));
}
async function refreshOfflineMusicQueue(){offlineMusicQueue=(await getOfflineItems()).filter(x=>String(x.kind||"").toLowerCase()==="audio").sort((a,b)=>a.savedAt-b.savedAt);return offlineMusicQueue;}
async function playOfflineMusicAt(index){if(!offlineMusicQueue.length){notify("No downloaded music is available.");return;}if(index<0||index>=offlineMusicQueue.length){notify("There are no more downloaded music tracks.");return;}const item=offlineMusicQueue[index];await playOffline(item.id,"audio",item.title);}
async function stepMusic(direction){
  if(currentOfflineAudioId || direction>0){
    try{await refreshOfflineMusicQueue();}catch(error){if(currentOfflineAudioId){notify("Could not load your downloaded music list.");return;}}
    if(offlineMusicQueue.length){
      const currentIndex=currentOfflineAudioId?offlineMusicQueue.findIndex(x=>String(x.id)===currentOfflineAudioId):-1;
      const nextIndex=currentIndex<0?(direction>0?0:offlineMusicQueue.length-1):currentIndex+direction;
      await playOfflineMusicAt(nextIndex);return;
    }
    if(currentOfflineAudioId){notify("No downloaded music is available.");return;}
  }
  if(!musicQueue.length||musicQueueIndex<0){notify("No downloaded music or queued music is available.");return;}
  const n=musicQueueIndex+direction;if(n<0||n>=musicQueue.length){notify("No more tracks in this list.");return;}playAudioTrack(musicQueue[n].id);
}
function renderFavouriteMusic(){
  const host=$("#favorite-music-results");if(!host)return;
  const list=musicFavs();
  host.innerHTML=list.length?list.map(musicCard).join(""):'<div class="empty-state">Save a track from Music and it will appear here.</div>';
}
let tmdbMovieCatalog=null;
const tmdbMovieCache=new Map();
const TMDB_ROWS={
  trending:"trending",popular:"popular","top-rated":"top-rated",upcoming:"upcoming",
  action:"genre-28",comedy:"genre-35",drama:"genre-18",documentary:"genre-99",free:"free"
};
function tmdbMovieCard(movie){
  const id=String(movie.id||"");
  const year=String(movie.releaseDate||"").slice(0,4)||"Year not listed";
  const genres=Array.isArray(movie.genreNames)?movie.genreNames.slice(0,3).join(" · "):"";
  const rating=Number.isFinite(Number(movie.rating))?"★ "+Number(movie.rating).toFixed(1):"";
  const status=movie.isFree?"Free on Spinn Radio":"TMDB catalogue";
  return '<article class="media-card film-card tmdb-film-card">'+
    '<img class="media-cover film-cover" src="'+esc(movie.poster||"")+'" alt="" loading="lazy" onerror="this.style.display=\'none\'">'+
    '<h3 title="'+esc(movie.title||"Untitled")+'">'+esc(movie.title||"Untitled")+'</h3>'+
    '<p>'+esc(year)+(genres?' · '+esc(genres):'')+'</p>'+
    '<div class="media-actions"><small>'+esc(status)+(rating?' · '+esc(rating):'')+'</small>'+
    '<div class="music-card-actions"><button data-tmdb-open="'+esc(id)+'">'+(movie.isFree?"Open Spinn Movies":"Movie details")+'</button></div></div></article>';
}
let tmdbMovieOpenToken=0;
let mobileMovieListScrollY=0;
function closeMobileMovieDetail(){tmdbMovieOpenToken++;const panel=$("#film-player-panel");if(panel){panel.innerHTML='<div class="film-placeholder"><span>&#9635;</span><b>Choose a film to see details</b><small>Movie information is provided by TMDB. Full-film playback depends on the streaming rights holder.</small></div>';}$("#film-result-note").textContent="TMDB movie catalogue";document.body.classList.remove("mobile-film-detail-open");window.scrollTo({top:mobileMovieListScrollY,behavior:"instant"});}
async function openTmdbMovie(id){
  const movie=tmdbMovieCache.get(String(id));
  if(!movie)return;
  mobileMovieListScrollY=window.scrollY;
  document.body.classList.add("mobile-film-detail-open");
  const year=String(movie.releaseDate||"").slice(0,4)||"Release date not listed";
  const genres=Array.isArray(movie.genreNames)?movie.genreNames.join(" · "):"";
  const panel=$("#film-player-panel");
  const token=++tmdbMovieOpenToken;
  panel.innerHTML='<button type="button" class="mobile-film-back" data-film-detail-back><span aria-hidden="true">←</span> Back to films</button><div class="film-detail">'+
    '<img class="film-detail-backdrop" src="'+esc(movie.backdrop||movie.poster||"")+'" alt="" >'+
    '<div class="film-detail-copy"><h2>'+esc(movie.title||"Untitled")+'</h2>'+
    '<p>'+esc(year)+(genres?' · '+esc(genres):'')+'</p>'+
    '<p>'+(Number.isFinite(Number(movie.rating))?'TMDB rating: '+Number(movie.rating).toFixed(1)+'/10. ':'')+
    'Checking ORBIT for an authorized full-length movie stream…</p></div></div>'+
    '<div class="loading-card">Searching verified free movie sources…</div>';
  $("#film-result-note").textContent="Checking in-app playback · "+(movie.title||"Film");
  panel.scrollIntoView({behavior:"smooth",block:"nearest"});
  try{
    const [filmResponse,trailerResponse]=await Promise.all([
      fetch("/api/films?q="+encodeURIComponent(movie.title||""),{signal:AbortSignal.timeout(25000)}),
      fetch("/api/movie-trailers?title="+encodeURIComponent(movie.title||"")+"&year="+encodeURIComponent(year.slice(0,4)),{signal:AbortSignal.timeout(40000)}).catch(()=>null)
    ]);
    if(!filmResponse.ok)throw new Error("Movie sources are temporarily unavailable");
    const films=await filmResponse.json();
    let trailerData={trailers:[]};
    if(trailerResponse&&trailerResponse.ok){try{trailerData=await trailerResponse.json();}catch{}}
    if(token!==tmdbMovieOpenToken)return;
    const trailers=(Array.isArray(trailerData.trailers)?trailerData.trailers:[]).filter(v=>/^[A-Za-z0-9_-]{11}$/.test(v.youtubeId||"")).slice(0,6);
    const trailerHtml='<section class="orbit-trailer-section"><h3 class="section-title">Watch the trailer</h3><p class="section-description">Preview this film here in ORBIT. Choose another trailer below if you prefer.</p>'+
      (trailers.length?'<div id="movie-trailer-player" class="orbit-trailer-player" aria-live="polite"><iframe src="https://www.youtube-nocookie.com/embed/'+encodeURIComponent(trailers[0].youtubeId)+'?autoplay=1&playsinline=1&rel=0&modestbranding=1" title="'+esc(trailers[0].title||movie.title+" trailer")+'" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>'+
        '<button type="button" class="trailer-picker-toggle" data-trailer-toggle aria-expanded="false">Choose trailer <span>⌄</span></button>'+
        '<div class="orbit-trailer-picker" hidden><div class="orbit-trailer-picker-head"><strong>Select a trailer</strong><button type="button" data-trailer-toggle-close aria-label="Close trailer list">×</button></div>'+
        '<div class="orbit-trailer-grid">'+trailers.map((v,i)=>'<article class="orbit-trailer-card">'+
        '<img src="'+esc(v.thumbnail||("https://img.youtube.com/vi/"+v.youtubeId+"/hqdefault.jpg"))+'" alt="" loading="lazy">'+
        '<div><strong>'+esc(v.title||"Movie trailer")+'</strong><small>'+esc(v.source==="Netflix channel"?"Netflix · "+(v.channel||""):"YouTube · "+(v.channel||""))+'</small><button data-trailer-play="'+esc(v.youtubeId)+'" data-title="'+esc(v.title||movie.title+" trailer")+'">'+(i===0?'Replay trailer':'Play this trailer')+'</button></div></article>').join("")+'</div></div></div>':
        '<div class="empty-state">No matching trailer was found right now. Try again later or search another movie.</div>')+'</section>'
    const titleKey=String(movie.title||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
    const matches=(Array.isArray(films)?films:[]).map(f=>{
      const candidate=String(f.title||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
      return {...f,matchScore:candidate===titleKey?2:(candidate.includes(titleKey)||titleKey.includes(candidate)?1:0)};
    }).filter(f=>f.matchScore>0).sort((a,b)=>b.matchScore-a.matchScore).slice(0,8);
    const matchHtml=matches.map(f=>'<article class="media-card film-card">'+
      '<img class="media-cover film-cover" src="'+esc(f.artwork||"")+'" alt="" loading="lazy" >'+
      '<h3>'+esc(f.title||movie.title)+'</h3><p>'+esc(f.year||"Year not listed")+' · Public domain</p>'+
      '<div class="media-actions"><small>Verified public-domain listing</small><div class="music-card-actions">'+
      '<button data-film-play="'+esc(f.id)+'" data-title="'+esc(f.title||movie.title)+'">Watch inside ORBIT</button>'+
      '<button data-download-film="'+esc(f.id)+'" title="Download for offline viewing">Download</button>'+
      '</div></div></article>').join("");
    panel.innerHTML='<button type="button" class="mobile-film-back" data-film-detail-back><span aria-hidden="true">←</span> Back to films</button>'+trailerHtml+'<div class="film-detail">'+
      '<img class="film-detail-backdrop" src="'+esc(movie.backdrop||movie.poster||"")+'" alt="" >'+
      '<div class="film-detail-copy"><h2>'+esc(movie.title||"Untitled")+'</h2>'+
      '<p>'+esc(year)+(genres?' · '+esc(genres):'')+'</p>'+
      '<p>'+(Number.isFinite(Number(movie.rating))?'TMDB rating: '+Number(movie.rating).toFixed(1)+'/10. ':'')+
      'TMDB provides movie information. ORBIT checks authorized full-film sources separately.</p></div></div>' +

      (matches.length?'<h3 class="section-title">Available to watch inside ORBIT</h3><div class="media-grid">'+matchHtml+'</div>':
      '<div class="empty-state">A verified full-length free stream or downloadable copy was not found for this title. You can still watch the trailer above. Browse ORBIT’s free public-domain movie collection below. Commercial movies require a separate streaming licence.<div class="music-card-actions" style="margin-top:12px"><button data-browse-free-movies>Browse free full movies</button></div></div>');
    $("#film-result-note").textContent=matches.length?matches.length+" authorized free match(es) · In-app playback and download":"No authorized full-film source found for this title";
  }catch(error){
    if(token!==tmdbMovieOpenToken)return;
    panel.innerHTML='<button type="button" class="mobile-film-back" data-film-detail-back><span aria-hidden="true">←</span> Back to films</button><div class="film-detail-copy"><h2>'+esc(movie.title||"Untitled")+'</h2><p>Could not check full-film sources right now. Please try again.</p></div>';
    $("#film-result-note").textContent="Movie source check failed";
  }
}
async function loadPublicDomainFilms(term="popular"){
  const host=$("#movie-results");
  host.innerHTML='<div class="loading-card">Searching public-domain films…</div>';
  const response=await fetch("/api/films?q="+encodeURIComponent(term||"popular"),{signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw new Error("Public-domain film catalogue unavailable");
  const films=await response.json();
  host.innerHTML=films.length?films.map(f=>'<article class="media-card film-card">'+
    '<img class="media-cover film-cover" src="'+esc(f.artwork||"")+'" alt="" loading="lazy" onerror="this.style.display=\'none\'">'+
    '<h3 title="'+esc(f.title||"Film")+'">'+esc(f.title||"Film")+'</h3>'+
    '<p>'+esc(f.year||"Year not listed")+' · '+esc(f.creator||"Not listed")+'</p>'+
    '<div class="media-actions"><small>Public domain · In-app playback</small><div class="music-card-actions"><button data-film-play="'+esc(f.id)+'" data-title="'+esc(f.title)+'">Watch film</button><button data-download-film="'+esc(f.id)+'" title="Download film for offline">Download</button></div></div>'+
    '</article>').join(""):'<div class="empty-state">No matching public-domain films were found. Try another title.</div>';
  $("#film-result-note").textContent=films.length+" films · Internet Archive · In-app playback";
}
async function loadArchiveFilms(term="trending"){
  const host=$("#movie-results");
  const requested=String(term||"trending").trim().toLowerCase();
  if(requested==="public-domain"||requested.startsWith("public-domain:")){
    return loadPublicDomainFilms(requested.includes(":")?requested.slice(requested.indexOf(":")+1).trim():"popular");
  }
  host.innerHTML='<div class="loading-card">Loading TMDB movie catalogue…</div>';
  if(!tmdbMovieCatalog){
    const response=await fetch("/api/spinn-movies",{signal:AbortSignal.timeout(35000)});
    if(!response.ok)throw new Error("Spinn Radio TMDB catalogue is unavailable");
    tmdbMovieCatalog=await response.json();
    if(!Array.isArray(tmdbMovieCatalog.rows))throw new Error("TMDB movie catalogue has an invalid response");
    for(const row of tmdbMovieCatalog.rows)for(const movie of (row.movies||[]))if(movie&&movie.id)tmdbMovieCache.set(String(movie.id),movie);
  }
  let movies=[];
  if(TMDB_ROWS[requested]){
    const row=tmdbMovieCatalog.rows.find(x=>x&&x.id===TMDB_ROWS[requested]);
    movies=row?.movies||[];
  }else{
    const unique=[...tmdbMovieCache.values()];
    movies=unique.filter(movie=>{
      const haystack=[movie.title,...(Array.isArray(movie.genreNames)?movie.genreNames:[])].join(" ").toLowerCase();
      return haystack.includes(requested);
    });
  }
  movies=movies.slice(0,80);
  host.innerHTML=movies.length?movies.map(tmdbMovieCard).join(""):'<div class="empty-state">No matching films were found in this catalogue. Try another title or category.</div>';
  $("#film-result-note").textContent=movies.length+" films · TMDB";
}
function playArchiveFilm(id,title){
  if(!/^[A-Za-z0-9._-]{1,180}$/.test(id)){notify("This film identifier is not valid.");return;}
  const panel=$("#film-player-panel");
  panel.innerHTML='<button type="button" class="mobile-film-back" data-film-detail-back><span aria-hidden="true">←</span> Back to films</button><iframe class="archive-film-embed" src="https://archive.org/embed/'+encodeURIComponent(id)+'?autoplay=1" title="'+esc(title)+'" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>';
  panel.scrollIntoView({behavior:"smooth",block:"nearest"});
  $("#film-result-note").textContent="Now watching  -  "+title;
}
async function loadYouTubeMusic(term="trending music"){
  const host=$("#music-video-results");host.innerHTML='<div class="loading-card">Finding music videos...</div>';
  const query=term.trim()||"trending music";
  const response=await fetch("/api/youtube-search?q="+encodeURIComponent(query),{signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw new Error("YouTube search unavailable");
  const results=await response.json();
  if(!Array.isArray(results)||!results.length){host.innerHTML='<div class="empty-state">No music videos found. Try another search.</div>';$("#music-result-note").textContent="No results";return;}
  $("#music-result-note").textContent=results.length+" music videos found";
  host.innerHTML=results.map(x=>{
    const title=x.title||"Untitled track",artist=x.author||"Artist";
    const thumb=x.thumbnail||"";
    return '<article class="media-card music-video-card"><img class="media-cover" src="'+esc(thumb)+'" alt="" loading="lazy"><h3 title="'+esc(title)+'">'+esc(title)+'</h3><p>'+esc(artist)+' - '+esc(x.length||"")+'</p><div class="media-actions"><small>Music video</small><button data-youtube="'+esc(x.videoId)+'" data-title="'+esc(title)+'" data-artist="'+esc(artist)+'">Play video</button></div></article>';
  }).join("");
}
function playYouTubeAlternate(id,title){if(!/^[A-Za-z0-9_-]{11}$/.test(id))return;audio.pause();currentYoutubeId=null;const panel=$("#youtube-player-panel");panel.innerHTML='<iframe class="youtube-embed" src="https://inv.nadeko.net/embed/'+encodeURIComponent(id)+'?autoplay=1" title="'+esc(title)+' alternate player" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>';setPlayer(title,"Alternate community video player","Trying alternate source");panel.scrollIntoView({behavior:"smooth",block:"nearest"});}
function playYouTubeVideo(id,title,artist){
  if(!/^[A-Za-z0-9_-]{11}$/.test(id)){notify("This video could not be played.");return;}
  audio.pause();audio.removeAttribute("src");audio.load();currentStation=null;currentOfflineAudioId=null;currentMusicTrack=null;currentYoutubeId=id;currentYoutubePaused=false;
  const panel=$("#youtube-player-panel");
  panel.innerHTML='<iframe class="youtube-embed" src="https://www.youtube-nocookie.com/embed/'+encodeURIComponent(id)+'?autoplay=1&rel=0&playsinline=1&enablejsapi=1&origin='+encodeURIComponent(window.location.origin)+'" title="'+esc(title)+'" allow="autoplay; encrypted-media; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>';
  setPlayer(title,artist,"Playing music video");
  $("#player-art").textContent="\u266b";
  panel.scrollIntoView({behavior:"smooth",block:"nearest"});
}const podcastEpisodeCache = new Map();
async function loadPodcastEpisodes(id,title){
  const panel=$("#podcast-player-panel");
  if(!/^\d{1,16}$/.test(String(id))){notify("This podcast has no episode catalogue.");return;}
  panel.innerHTML='<div class="loading-card">Loading episodes for '+esc(title)+'...</div>';
  try{
    const r=await fetch("/api/podcast-episodes?id="+encodeURIComponent(id),{signal:AbortSignal.timeout(20000)});
    if(!r.ok)throw new Error("Episodes unavailable");
    const episodes=await r.json();
    episodes.forEach(ep=>podcastEpisodeCache.set(String(ep.id),ep));
    panel.innerHTML='<div class="podcast-episodes"><div class="podcast-episodes-head"><div><b>'+esc(title)+'</b><small>'+episodes.length+' episodes available</small></div></div><div class="podcast-episode-list">'+(episodes.length?episodes.map(ep=>'<div class="podcast-episode"><div class="podcast-episode-meta"><b>'+esc(ep.title)+'</b><small>'+esc(ep.date?new Date(ep.date).toLocaleDateString():"Podcast episode")+'</small></div><div class="episode-actions"><button data-podcast-play="'+esc(ep.id)+'" title="Play episode">Play</button><button data-download-url="'+esc(ep.audio)+'" data-download-title="'+esc(ep.title)+'" data-download-kind="podcast" title="Save offline">⇩</button></div></div>').join(""):'<div class="empty-state">No playable episodes were supplied by Apple for this show.</div>')+'</div></div>';
    panel.scrollIntoView({behavior:"smooth",block:"nearest"});
  }catch{panel.innerHTML='<div class="empty-state">Could not load this podcast’s episode list. Try another show.</div>';}
}
function playPodcastEpisode(id){
  const ep=podcastEpisodeCache.get(String(id));
  if(!ep||!String(ep.audio).startsWith("https://")){notify("This episode is not available for playback.");return;}
  clearYoutubePlayer();currentStation=null;currentOfflineAudioId=null;currentMusicTrack=null;audio.src=ep.audio;
  audio.play().then(()=>setPlayer(ep.title,"Podcast episode","Podcast")).catch(()=>notify("This podcast host blocked playback in ORBIT."));
}
const ORBIT_OFFLINE_DB="orbit-public-offline",ORBIT_OFFLINE_STORE="media";
function openOrbitOfflineDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(ORBIT_OFFLINE_DB,1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(ORBIT_OFFLINE_STORE))r.result.createObjectStore(ORBIT_OFFLINE_STORE,{keyPath:"id"});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function offlineDBRequest(mode,fn){const db=await openOrbitOfflineDB();return new Promise((resolve,reject)=>{const tx=db.transaction(ORBIT_OFFLINE_STORE,mode),req=fn(tx.objectStore(ORBIT_OFFLINE_STORE));if(req){req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);}tx.oncomplete=()=>{db.close();if(!req)resolve(true);};tx.onerror=()=>{db.close();reject(tx.error);};});}
async function getOfflineItems(){return (await offlineDBRequest("readonly",s=>s.getAll()))||[];}
async function getOfflineItem(id){return offlineDBRequest("readonly",s=>s.get(String(id)));}
async function downloadOffline(url,title,kind,artwork,button){const original=button?.textContent||"Download";if(button){button.disabled=true;button.textContent="Downloading…";}notify("Downloading "+(title||"media")+" to this device.");try{const r=await fetch(url,{mode:"cors",credentials:"omit",cache:"no-store"});if(!r.ok)throw new Error("The source did not allow this download ("+r.status+").");const blob=await r.blob();if(!blob.size)throw new Error("The downloaded file was empty.");const id="offline-"+Date.now()+"-"+Math.random().toString(36).slice(2,9),k=String(kind||"audio").toLowerCase()==="podcast"?"audio":String(kind||"audio").toLowerCase();await offlineDBRequest("readwrite",s=>s.put({id,title:title||"Downloaded media",kind:k,artwork:artwork||"",savedAt:Date.now(),bytes:blob.size,mime:blob.type||"application/octet-stream",blob}));notify("Saved for offline playback: "+(title||"media"));if(button)button.textContent="Downloaded";loadOfflineLibrary();return true;}catch(e){notify(e?.message||"Download failed. This source may block browser downloads.");if(button)button.textContent=original;return false;}finally{if(button){button.disabled=false;if(button.textContent==="Downloaded")setTimeout(()=>{if(button.isConnected)button.textContent=original;},2500);}}}
async function loadOfflineLibrary(){const host=$("#offline-results");if(!host)return;host.innerHTML='<div class="loading-card">Loading saved media.</div>';try{const items=await getOfflineItems();host.innerHTML=items.length?items.sort((a,b)=>b.savedAt-a.savedAt).map(x=>'<article class="media-card offline-card">'+(x.artwork?'<img class="media-cover" src="'+esc(x.artwork)+'" alt="" loading="lazy">':'<div class="media-cover offline-placeholder">ORBIT</div>')+'<h3>'+esc(x.title)+'</h3><p>'+esc(String(x.kind||"audio").toUpperCase())+' · '+(Number(x.bytes)/1048576).toFixed(1)+' MB · saved '+new Date(x.savedAt).toLocaleDateString()+'</p><div class="media-actions"><button data-offline-play="'+esc(x.id)+'" data-offline-kind="'+esc(x.kind)+'" data-offline-title="'+esc(x.title)+'">Play offline</button><button data-offline-delete="'+esc(x.id)+'">Remove</button></div></article>').join(""):'<div class="empty-state">Nothing downloaded yet. Download supported tracks or episodes and they will be saved on this device for offline playback.</div>';}catch{host.innerHTML='<div class="empty-state">Your browser could not open offline storage. Check browser storage settings.</div>';}}
async function playOffline(id,kind,title){try{const item=await getOfflineItem(id);if(!item?.blob)throw Error();const src=URL.createObjectURL(item.blob);if(kind==="film"||kind==="video"){const panel=$("#film-player-panel");showView("movies");panel.innerHTML='<video class="offline-video" src="'+src+'" controls autoplay playsinline></video>';panel.scrollIntoView({behavior:"smooth",block:"nearest"});setPlayer(title,"Saved on this device","Offline video");return;}currentOfflineAudioId=String(id);clearYoutubePlayer();currentStation=null;currentMusicTrack=null;audio.src=src;refreshOfflineMusicQueue().catch(()=>{});await audio.play();setPlayer(title,"Saved on this device","Offline music");}catch{notify("This offline file could not be found or played.");}}
async function loadBooks(term=""){
  const host=$("#book-results");host.innerHTML='<div class="loading-card">Searching the LibriVox catalogue…</div>';
  try{
    const url="https://librivox.org/api/feed/audiobooks/?format=json&limit=30"+(term?"&title="+encodeURIComponent(term):"");
    const requestUrl=window.orbitDesktop?.isDesktop?"/api/librivox?url="+encodeURIComponent(url):url;const r=await fetch(requestUrl);if(!r.ok)throw new Error("LibriVox unavailable");const data=await r.json();const books=data.books||[];
    host.innerHTML=books.length?books.map(b=>{
      const author=Array.isArray(b.authors)?b.authors.map(a=>a.first_name+" "+a.last_name).join(", "):"Public domain";
      return `<article class="media-card"><div class="media-cover book-cover">▤</div><h3 title="${esc(b.title)}">${esc(b.title)}</h3><p>${esc(author)}</p><div class="media-actions"><small>LibriVox, free</small><button data-bookplay="${esc(b.url_rss||"")}" data-title="${esc(b.title)}">Listen </button></div></article>`;
    }).join(""):'<div class="empty-state">No audiobooks found for that search.</div>';
  }catch{host.innerHTML='<div class="empty-state">LibriVox could not be reached. You can still browse the catalogue at librivox.org.</div>';}
}
async function playBook(rss,title){
  clearYoutubePlayer();currentOfflineAudioId=null;currentMusicTrack=null;currentStation=null;
  if(!rss){notify("This book has no public audio feed.");return;}
  try{const feedUrl=window.orbitDesktop?.isDesktop?"/api/rss?url="+encodeURIComponent(rss):rss;const r=await fetch(feedUrl);if(!r.ok)throw new Error();const xml=new DOMParser().parseFromString(await r.text(),"text/xml");const item=xml.querySelector("item");const enclosure=item?.querySelector("enclosure");const src=enclosure?.getAttribute("url");if(!src)throw new Error();audio.src=src;await audio.play();setPlayer(title,"LibriVox / public-domain audiobook","Audiobook");}
  catch{window.open(rss,"_blank","noopener");notify("Opened the audiobook feed in a new tab.");}
}
function searchGlobal(term){return searchEverything(term);}
async function searchEverything(term){
 const q=(term||"").trim();if(!q)return;
 showView("search");
 const host=$("#global-search-results");$("#global-search-caption").textContent='Showing matches for “'+q+'” across ORBIT.';host.innerHTML='<div class="loading-card">Searching radio, podcasts, audiobooks, music, music videos, films and available TV channels…</div>';
 const section=(name,html)=>'<section class="search-result-section"><div class="search-result-heading"><h2>'+name+'</h2></div><div class="media-grid">'+html+'</div></section>';
 const safeQ=encodeURIComponent(q);
 const tasks=await Promise.allSettled([
  radioSearch({name:q,limit:"8"}),
  fetch("/api/audius-search?q="+safeQ,{signal:AbortSignal.timeout(22000)}).then(r=>r.ok?r.json():Promise.reject()),
  fetch("/api/youtube-search?q="+safeQ,{signal:AbortSignal.timeout(25000)}).then(r=>r.ok?r.json():Promise.reject()),
  fetch("/api/spinn-movies",{signal:AbortSignal.timeout(35000)}).then(r=>r.ok?r.json():Promise.reject()),
  fetch("https://itunes.apple.com/search?term="+safeQ+"&entity=podcast&limit=8",{signal:AbortSignal.timeout(20000)}).then(r=>r.ok?r.json():Promise.reject()),
  fetch("/api/librivox?url="+encodeURIComponent("https://librivox.org/api/feed/audiobooks/?format=json&limit=8&title="+safeQ),{signal:AbortSignal.timeout(20000)}).then(r=>r.ok?r.json():Promise.reject()),
  fetch("/api/global-search?q="+safeQ,{signal:AbortSignal.timeout(75000)}).then(r=>r.ok?r.json():Promise.reject())
 ]);
 const get=i=>tasks[i].status==="fulfilled"?tasks[i].value:[];
 const radio=get(0),tracks=get(1),videos=get(2),movieCatalog=get(3),podcasts=get(4).results||[],books=get(5).books||[],tv=get(6);
 const tmdbMovies=Array.isArray(movieCatalog?.rows)?movieCatalog.rows.flatMap(row=>row.movies||[]):[];
 tmdbMovies.forEach(movie=>{if(movie?.id)tmdbMovieCache.set(String(movie.id),movie);});
 radio.forEach(x=>stationCache.set(x.stationuuid,x));tracks.forEach(x=>musicTrackCache.set(String(x.id),x));
 const blocks=[];
 if(radio.length)blocks.push(section("Radio stations",radio.map(stationCard).join("")));
 if(tracks.length)blocks.push(section("Audio music",tracks.map(musicCard).join("")));
 if(podcasts.length)blocks.push(section("Podcasts",podcasts.map(x=>{const title=x.collectionName||x.trackName||"Podcast";return '<article class="media-card"><img class="media-cover" src="'+esc(x.artworkUrl600||x.artworkUrl100||"")+'" alt=""><h3>'+esc(title)+'</h3><p>'+esc(x.artistName||"Podcast")+'</p><div class="media-actions"><small>Podcast</small><button data-podcast="'+esc(x.collectionId||"")+'" data-title="'+esc(title)+'">Episodes</button></div></article>';}).join("")));
 if(books.length)blocks.push(section("Audiobooks",books.map(b=>{const title=b.title||"Audiobook";const author=Array.isArray(b.authors)?b.authors.map(a=>a.first_name+" "+a.last_name).join(", "):"Public domain";return '<article class="media-card"><div class="media-cover book-cover">▤</div><h3>'+esc(title)+'</h3><p>'+esc(author)+'</p><div class="media-actions"><small>LibriVox</small><button data-bookplay="'+esc(b.url_rss||"")+'" data-title="'+esc(title)+'">Listen</button></div></article>';}).join("")));
 if(videos.length)blocks.push(section("Music videos",videos.slice(0,8).map(x=>'<article class="media-card music-video-card"><img class="media-cover" src="'+esc(x.thumbnail||"")+'" alt=""><h3>'+esc(x.title||"Music video")+'</h3><p>'+esc(x.author||"Artist")+'</p><div class="media-actions"><small>Video</small><button data-youtube="'+esc(x.videoId)+'" data-title="'+esc(x.title||"Music video")+'" data-artist="'+esc(x.author||"Artist")+'">Play video</button></div></article>').join("")));
 const movieMatches=tmdbMovies.filter(movie=>[movie.title,...(movie.genreNames||[])].join(" ").toLowerCase().includes(q.toLowerCase()));
 if(movieMatches.length)blocks.push(section("Movies · TMDB",movieMatches.slice(0,8).map(tmdbMovieCard).join("")));
 if(tv&&Array.isArray(tv.channels)&&tv.channels.length){
  tv.channels.forEach(c=>{if(!orbitLiveChannels.some(x=>x.id===c.id))orbitLiveChannels.push(c);});
  (Array.isArray(tv.streams)?tv.streams:[]).forEach(st=>{if(!orbitLiveStreams.some(x=>x.url===st.url))orbitLiveStreams.push(st);});
  blocks.push(section("Global TV channels",tv.channels.slice(0,8).map(c=>'<article class="media-card"><div class="media-cover book-cover">TV</div><h3>'+esc(c.name)+'</h3><p>'+esc(c.country||"Global")+'</p><div class="media-actions"><small>Global Live</small><button data-search-tv="'+esc(c.id)+'">Open channel</button></div></article>').join("")));
 }else if(orbitLiveChannels.length){
  const matches=orbitLiveChannels.filter(c=>[c.name,c.country,c.network,...(c.alt_names||[])].join(" ").toLowerCase().includes(q.toLowerCase())).slice(0,8);
  if(matches.length)blocks.push(section("TV channels currently loaded",matches.map(c=>'<article class="media-card"><div class="media-cover book-cover">TV</div><h3>'+esc(c.name)+'</h3><p>'+esc(c.country||"Global")+'</p><div class="media-actions"><small>Global Live</small><button data-search-tv="'+esc(c.id)+'">Open channel</button></div></article>').join("")));
 }
 host.innerHTML=blocks.length?blocks.join(""):'<div class="empty-state">No matches were found. Try a different title, artist, station, country or channel name. Some catalogues may be temporarily unavailable.</div>';
}

function applyOrbitTheme(theme){
  const chosen=["dark","light","system"].includes(theme)?theme:"dark";
  document.documentElement.dataset.theme=chosen;
  localStorage.setItem("orbit-theme",chosen);
}
function setupSettings(){
  const theme=$("#setting-theme"),motion=$("#setting-motion"),volume=$("#setting-volume"),volumeValue=$("#setting-volume-value"),remember=$("#setting-remember-volume"),nav=$("#setting-nav-visible");
  if(!theme)return;
  theme.value=localStorage.getItem("orbit-theme")||"dark";
  motion.checked=localStorage.getItem("orbit-reduce-motion")==="1";
  remember.checked=localStorage.getItem("orbit-remember-volume")!=="0";
  nav.checked=localStorage.getItem("orbit-nav-hidden")!=="1";
  const savedVolume=Number(localStorage.getItem("orbit-volume")||80);
  volume.value=String(Math.max(0,Math.min(100,savedVolume)));volumeValue.textContent=volume.value+"%";orbitBaseVolume=Number(volume.value)/100;audio.volume=orbitBaseVolume;
  applyOrbitTheme(theme.value);document.documentElement.classList.toggle("reduce-motion",motion.checked);setupOrbitProfile();setupOrbitPreferences();setupOrbitTransport();
  theme.addEventListener("change",()=>applyOrbitTheme(theme.value));
  motion.addEventListener("change",()=>{localStorage.setItem("orbit-reduce-motion",motion.checked?"1":"0");document.documentElement.classList.toggle("reduce-motion",motion.checked);});
  volume.addEventListener("input",()=>{orbitBaseVolume=Number(volume.value)/100;applyOrbitSound(orbitSoundMode);volumeValue.textContent=volume.value+"%";if(remember.checked)localStorage.setItem("orbit-volume",volume.value);});
  remember.addEventListener("change",()=>{localStorage.setItem("orbit-remember-volume",remember.checked?"1":"0");if(!remember.checked)localStorage.removeItem("orbit-volume");});
  nav.addEventListener("change",()=>{document.body.classList.toggle("nav-hidden",!nav.checked);localStorage.setItem("orbit-nav-hidden",nav.checked?"0":"1");$("#nav-toggle").title=nav.checked?"Hide navigation":"Show navigation";});
  $("#settings-reset").addEventListener("click",()=>{["orbit-theme","orbit-reduce-motion","orbit-volume","orbit-remember-volume","orbit-nav-hidden","orbit-sound","orbit-audiobooks","orbit-global-live"].forEach(k=>localStorage.removeItem(k));theme.value="dark";motion.checked=false;remember.checked=true;nav.checked=true;volume.value="80";volumeValue.textContent="80%";orbitBaseVolume=.8;audio.volume=.8;const soundSelect=$("#setting-sound");if(soundSelect)soundSelect.value="normal";orbitSoundMode="normal";document.documentElement.classList.remove("reduce-motion");applyOrbitSound("normal");applyOrbitTheme("dark");document.body.classList.remove("nav-hidden");$("#nav-toggle").title="Hide navigation";notify("Settings restored to defaults.");});
}


function setupOrbitProfile(){
 const read=()=>{try{return JSON.parse(localStorage.getItem("orbit-profile")||"{}")}catch{return {}}};
 const p=read(),name=$("#profile-name"),about=$("#profile-about"),img=$("#profile-image"),avatar=$("#profile-open");
 name.value=p.name||"";about.value=p.about||"";
 if(p.image){img.src=p.image;img.style.display="block";avatar.style.backgroundImage="url("+p.image+")";avatar.style.backgroundSize="cover";avatar.textContent="";}
 else if(p.name)avatar.textContent=p.name.slice(0,1).toUpperCase();
 avatar.addEventListener("click",()=>$("#profile-backdrop").classList.add("visible"));
 $("#profile-close").addEventListener("click",()=>$("#profile-backdrop").classList.remove("visible"));
 $("#profile-image-file").addEventListener("change",e=>{const f=e.target.files&&e.target.files[0];if(!f)return;if(!f.type.startsWith("image/")||f.size>3*1024*1024){notify("Choose an image smaller than 3 MB.");return;}const rd=new FileReader();rd.onload=()=>{img.src=rd.result;img.style.display="block";img.dataset.pending=rd.result;};rd.readAsDataURL(f);});
 $("#profile-save").addEventListener("click",()=>{const old=read();const v={name:name.value.trim()||"Listener",about:about.value.trim(),image:img.dataset.pending||old.image||""};localStorage.setItem("orbit-profile",JSON.stringify(v));avatar.textContent=v.image?"":v.name.slice(0,1).toUpperCase();if(v.image){avatar.style.backgroundImage="url("+v.image+")";avatar.style.backgroundSize="cover";}$("#profile-backdrop").classList.remove("visible");notify("Profile saved on this device.");});
}

let orbitLiveChannels=[],orbitLiveStreams=[],orbitLiveCountries=[];
let orbitLiveHls=null,orbitLiveLoaded=false,orbitLivePlayToken=0,orbitLiveDirectoryToken=0;
function setupOrbitPreferences(){
 const lang=$("#setting-language"),sound=$("#setting-sound");
 if(lang){lang.value=localStorage.getItem("orbit-language")||"en";lang.addEventListener("change",()=>{localStorage.setItem("orbit-language",lang.value);document.documentElement.lang=lang.value;document.documentElement.dir=lang.value==="ar"?"rtl":"ltr";notify("Language preference saved.");});}
 if(sound){sound.value=localStorage.getItem("orbit-sound")||"normal";orbitSoundMode=sound.value;sound.addEventListener("change",()=>{orbitSoundMode=sound.value;localStorage.setItem("orbit-sound",sound.value);applyOrbitSound(sound.value);notify("Sound preference saved.");});applyOrbitSound(sound.value);}

}
function applyOrbitSound(mode){orbitSoundMode=mode;audio.muted=false;audio.playbackRate=1;const factor=mode==="gentle"?0.72:mode==="quiet"?0.48:1;audio.volume=Math.max(0,Math.min(1,orbitBaseVolume*factor));const b=$("#volume-button");if(b){b.textContent="Mute";b.title="Mute audio";}}
async function loadGlobalLiveDirectory(countryCode=""){
 const host=$("#global-tv-results");if(!host)return;
 const requestToken=++orbitLiveDirectoryToken;
 try{
  if(!orbitLiveCountries.length){
   host.innerHTML='<div class="loading-card">Loading country list…</div>';
   const cr=await fetch("/api/global-countries",{signal:AbortSignal.timeout(100000)});
   if(!cr.ok)throw Error("Country list unavailable");
   const countryData=await cr.json();if(requestToken!==orbitLiveDirectoryToken)return;
   orbitLiveCountries=countryData;
   const select=$("#global-tv-country");
   select.innerHTML='<option value="">Choose a country…</option>'+orbitLiveCountries.slice().sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(c=>'<option value="'+esc(c.code)+'">'+esc(c.name)+'</option>').join("");
  }
  const q=($("#global-tv-search").value||"").trim().toLowerCase();
  if(!countryCode&&q.length>=3){
   const match=orbitLiveCountries.find(c=>(c.name||"").toLowerCase()===q)||orbitLiveCountries.find(c=>(c.name||"").toLowerCase().includes(q));
   if(match)countryCode=match.code;
  }
  if(!countryCode){
   host.innerHTML='<div class="empty-state">Choose a country to browse its available TV channels. You can also type a country name such as Ghana in the search box.</div>';
   return;
  }
  $("#global-tv-country").value=countryCode;
  host.innerHTML='<div class="loading-card">Loading channels for '+esc(orbitLiveCountries.find(c=>c.code===countryCode)?.name||countryCode)+'…</div>';
  const response=await fetch("/api/global-channels?country="+encodeURIComponent(countryCode),{signal:AbortSignal.timeout(150000),cache:"no-store"});
  if(!response.ok)throw Error("Channel list request failed ("+response.status+")");
  const data=await response.json();if(requestToken!==orbitLiveDirectoryToken)return;
  orbitLiveChannels=Array.isArray(data.channels)?data.channels:[];
  orbitLiveStreams=Array.isArray(data.streams)?data.streams.filter(x=>x.url&&/^https?:\/\//i.test(x.url)):[];
  orbitLiveLoaded=true;renderGlobalLiveChannels();
 }catch(e){
  if(requestToken!==orbitLiveDirectoryToken)return;
  orbitLiveLoaded=false;
  host.innerHTML='<div class="empty-state">The country or channel list could not be loaded. Check your connection and press Retry.</div><button id="global-tv-retry" type="button">Retry</button>';
 }
}
function renderGlobalLiveChannels(){
 const host=$("#global-tv-results");if(!host)return;
 const q=($("#global-tv-search").value||"").trim().toLowerCase(),country=$("#global-tv-country").value,category=$("#global-tv-category").value;
 const streamMap=new Map();
 for(const st of orbitLiveStreams){if(!streamMap.has(st.channel))streamMap.set(st.channel,[]);streamMap.get(st.channel).push(st);}
 const countryNames=new Map(orbitLiveCountries.map(c=>[c.code,(c.name||"").toLowerCase()]));
 const list=orbitLiveChannels.filter(ch=>{
  if(country&&ch.country!==country)return false;
  if(category==="sports"&&!(ch.categories||[]).includes("sports"))return false;
  const cn=countryNames.get(ch.country)||"";
  if(q&&![(ch.name||"").toLowerCase(),(ch.alt_names||[]).join(" ").toLowerCase(),cn,ch.network||""].join(" ").includes(q))return false;
  return (streamMap.get(ch.id)||[]).length>0;
 }).sort((a,b)=>(a.name||"").localeCompare(b.name||"")).slice(0,600);
 host.innerHTML=list.length?list.map(ch=>{
  const ss=streamMap.get(ch.id)||[],working=ss.filter(st=>st.health?.status==="online").length;
  const state=working?working+" verified stream"+(working===1?"":"s"):(ss.length?ss.length+" stream"+(ss.length===1?"":"s")+" to try":"No stream listed");
  const logo=ch.logo?'<img src="'+esc(ch.logo)+'" alt="" loading="lazy">':'<span class="channel-logo-placeholder">TV</span>';
  return '<button class="global-tv-channel" data-global-channel="'+esc(ch.id)+'" type="button">'+logo+'<span><b>'+esc(ch.name)+'</b><small>'+esc(orbitLiveCountries.find(c=>c.code===ch.country)?.name||ch.country||"Global")+' - '+state+'</small></span></button>';
 }).join(""):'<div class="empty-state">No listed streams match this search in this country. Try another channel name or country.</div>';
}
async function playGlobalChannel(id){
 const token=++orbitLivePlayToken;
 const ch=orbitLiveChannels.find(x=>x.id===id);
 const streams=orbitLiveStreams.filter(x=>x.channel===id);
 if(!ch)return;
 const video=$("#global-tv-video"),status=$("#global-tv-status");
 if(!streams.length){status.textContent=ch.name+" has no public stream URL listed. Try another channel.";return;}
 if(orbitLiveHls){orbitLiveHls.destroy();orbitLiveHls=null;}
 video.pause();video.removeAttribute("src");video.load();
 const score=x=>{
  const labels=Array.isArray(x.labels)?x.labels.join(" "):String(x.labels||x.label||"");
  return (/\.m3u8(?:$|\?)/i.test(x.url)?30:/\.(mp4|webm)(?:$|\?)/i.test(x.url)?20:0)+(x.health?.status==="online"?50:0);
 };
 const sorted=streams.slice().sort((a,b)=>score(b)-score(a));
 let lastError=null;
 for(const stream of sorted.slice(0,12)){
  if(token!==orbitLivePlayToken)return;
  try{
   const params=new URLSearchParams({url:stream.url});
   if(stream.referrer)params.set("ref",stream.referrer);
   if(stream.user_agent)params.set("ua",stream.user_agent);
   const playbackUrl=window.orbitDesktop?.isDesktop?"/api/tv-proxy?"+params.toString():stream.url;
   status.textContent="Connecting to "+ch.name+"…";
   if(orbitLiveHls){orbitLiveHls.destroy();orbitLiveHls=null;}
   video.pause();video.removeAttribute("src");video.load();
   if(/\.m3u8(?:$|\?)/i.test(stream.url)&&!video.canPlayType("application/vnd.apple.mpegurl")){
    if(!window.Hls)await new Promise((resolve,reject)=>{const sc=document.createElement("script");sc.src="https://cdn.jsdelivr.net/npm/hls.js@1.5.18/dist/hls.min.js";sc.onload=resolve;sc.onerror=()=>reject(Error("The HLS playback engine could not be loaded. Check your connection."));document.head.appendChild(sc);});
    if(token!==orbitLivePlayToken)return;
    if(!window.Hls||!Hls.isSupported())throw Error("This device does not support this channel format.");
    await new Promise((resolve,reject)=>{
     const h=new Hls({enableWorker:true,lowLatencyMode:false,manifestLoadingTimeOut:25000,levelLoadingTimeOut:25000});
     orbitLiveHls=h;let settled=false,timer;
     const done=err=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve();};
     h.on(Hls.Events.MEDIA_ATTACHED,()=>{if(token===orbitLivePlayToken)h.loadSource(playbackUrl);});
     h.on(Hls.Events.MANIFEST_PARSED,()=>{
      if(token!==orbitLivePlayToken){done(Error("Channel changed"));return;}
      Promise.resolve(video.play()).then(()=>done()).catch(done);
     });
     h.on(Hls.Events.ERROR,(_e,d)=>{if(d.fatal)done(Error("The broadcaster stream could not be decoded."));});
     h.attachMedia(video);timer=setTimeout(()=>done(Error("The broadcaster did not start playback in time.")),35000);
    });
   }else{
    video.src=playbackUrl;
    await Promise.resolve(video.play());
   }
   if(token!==orbitLivePlayToken)return;
   status.textContent="Now playing: "+ch.name+" · "+(orbitLiveCountries.find(c=>c.code===ch.country)?.name||ch.country||"Global");
   setPlayer(ch.name,"Global television","Live channel");return;
  }catch(e){
   if(token!==orbitLivePlayToken)return;
   lastError=e;
   if(orbitLiveHls){orbitLiveHls.destroy();orbitLiveHls=null;}
  }
 }
 if(token!==orbitLivePlayToken)return;
 status.textContent=(lastError?.message||"No working public stream was found.")+" Try another channel. Some broadcasters may be offline or region-restricted.";
}
function setupGlobalLive(){
 const nav=$("#global-live-nav");if(nav)nav.hidden=localStorage.getItem("orbit-global-live")!=="1";
 $("#global-tv-search").addEventListener("input",()=>{
  const q=$("#global-tv-search").value.trim().toLowerCase(),selected=$("#global-tv-country").value;
  if(selected){renderGlobalLiveChannels();return;}
  if(q.length>=3){
   const match=orbitLiveCountries.find(c=>(c.name||"").toLowerCase()===q)||orbitLiveCountries.find(c=>(c.name||"").toLowerCase().includes(q));
   if(match)loadGlobalLiveDirectory(match.code);
  }
 });
 $("#global-tv-country").addEventListener("change",e=>loadGlobalLiveDirectory(e.target.value));
 $("#global-tv-category").addEventListener("change",renderGlobalLiveChannels);
 $("#global-tv-results").addEventListener("click",e=>{
  if(e.target.closest("#global-tv-retry")){loadGlobalLiveDirectory($("#global-tv-country").value);return;}
  const b=e.target.closest("[data-global-channel]");if(b){$$("[data-global-channel]").forEach(x=>x.classList.toggle("active",x===b));playGlobalChannel(b.dataset.globalChannel);}
 });
}
function setupOrbitTransport(){
 const seek=$("#track-seek");
 const fmt=n=>Number.isFinite(n)?Math.floor(n/60)+":"+String(Math.floor(n%60)).padStart(2,"0"):"0:00";
 const update=()=>{
  const duration=audio.duration;
  if(Number.isFinite(duration)&&duration>0){
   if(document.activeElement!==seek)seek.value=String(Math.round(audio.currentTime/duration*1000));
   $("#current-time").textContent=fmt(audio.currentTime);$("#total-time").textContent=fmt(duration);
  }else{$("#current-time").textContent=fmt(0);$("#total-time").textContent="LIVE";}
 };
 audio.addEventListener("loadedmetadata",update);audio.addEventListener("durationchange",update);audio.addEventListener("timeupdate",update);
 seek.addEventListener("input",()=>{if(Number.isFinite(audio.duration)&&audio.duration>0)audio.currentTime=audio.duration*Number(seek.value)/1000;});
 seek.addEventListener("change",update);
 $("#seek-back").addEventListener("click",()=>{if(Number.isFinite(audio.duration))audio.currentTime=Math.max(0,audio.currentTime-15);});
 $("#seek-forward").addEventListener("click",()=>{if(Number.isFinite(audio.duration))audio.currentTime=Math.min(audio.duration,audio.currentTime+15);});
}

function setupEvents(){
  $("#app-back")?.addEventListener("click",()=>{
    if(orbitViewHistoryIndex<=0)return;
    orbitViewHistoryIndex--;
    orbitHistoryTraversal=true;showView(orbitViewHistory[orbitViewHistoryIndex]);orbitHistoryTraversal=false;
    syncAppHistoryButtons();
  });
  $("#app-forward")?.addEventListener("click",()=>{
    if(orbitViewHistoryIndex>=orbitViewHistory.length-1)return;
    orbitViewHistoryIndex++;
    orbitHistoryTraversal=true;showView(orbitViewHistory[orbitViewHistoryIndex]);orbitHistoryTraversal=false;
    syncAppHistoryButtons();
  });
  window.addEventListener("keydown",e=>{
    if(e.altKey&&e.key==="ArrowLeft"){e.preventDefault();$("#app-back")?.click();}
    if(e.altKey&&e.key==="ArrowRight"){e.preventDefault();$("#app-forward")?.click();}
  });
  syncAppHistoryButtons();
  $$(".nav-link[data-view]").forEach(b=>b.addEventListener("click",()=>{showView(b.dataset.view);$("#nav-discover-group")?.classList.remove("is-open");$("#discover-submenu-toggle")?.setAttribute("aria-expanded","false");}));
  const discoverGroup=$("#nav-discover-group"),discoverToggle=$("#discover-submenu-toggle");
  discoverToggle?.addEventListener("click",e=>{e.preventDefault();e.stopPropagation();const open=discoverGroup.classList.toggle("is-open");discoverToggle.setAttribute("aria-expanded",String(open));});
  document.addEventListener("click",e=>{if(discoverGroup&&!discoverGroup.contains(e.target)){discoverGroup.classList.remove("is-open");discoverToggle?.setAttribute("aria-expanded","false");}});
  window.orbitDesktop?.onOfflineUpdated?.(data=>{loadOfflineLibrary();});
  window.orbitDesktop?.onOmniDownload?.(data=>{const status=$("#omnisave-status");if(status){status.textContent=data?.message||"OmniSave download update.";status.dataset.state=data?.state||"info";}if(data?.state==="completed")notify("Saved to ORBIT Downloads: "+(data?.title||"video"));else if(data?.state==="error")notify(data.message||"Download failed.");});
  const omni=$("#omnisave-webview"),omniStatus=$("#omnisave-status");
  if(omni){
    omni.addEventListener("did-start-loading",()=>{if(omniStatus)omniStatus.textContent="Connecting to videodownloader.site?";});
    omni.addEventListener("dom-ready",()=>{if(omniStatus)omniStatus.textContent="OmniSave loaded inside ORBIT. Use the website search and controls.";});
    omni.addEventListener("did-fail-load",e=>{if(e.errorCode!==-3&&omniStatus)omniStatus.textContent="The site could not be embedded or reached. Try Reload or Open website.";});
    omni.addEventListener("did-navigate",e=>{if(omniStatus){try{omniStatus.textContent="Connected: "+new URL(e.url).hostname;}catch{}}});
    const applyOmniCleanView=()=>{try{omni.executeJavaScript("(()=>{const main=document.querySelector('main')||document.body;const apply=()=>{document.querySelector('header')?.remove();document.querySelector('footer')?.remove();document.querySelectorAll('[id^=div-gpt-ad],[data-ad]').forEach(e=>e.remove());for(const e of [...main.querySelectorAll('*')]){if(e.children.length===0&&/omnisave/i.test(e.textContent||'')&&!e.closest('form')){const p=e.closest('a,button,[role=button],section,nav')||e;p.style.setProperty('display','none','important');}}document.body.style.margin='0';document.body.style.background='#0b1117';main.style.maxWidth='1100px';main.style.margin='0 auto';main.style.padding='20px 24px 36px';};apply();if(!window.__orbitCleanViewObserver){window.__orbitCleanViewObserver=new MutationObserver(()=>{clearTimeout(window.__orbitCleanViewTimer);window.__orbitCleanViewTimer=setTimeout(apply,120);});window.__orbitCleanViewObserver.observe(main,{childList:true,subtree:true});}let n=0;const retry=setInterval(()=>{apply();if(++n>=20)clearInterval(retry);},500);})()");}catch(e){}};
    omni.addEventListener("dom-ready",applyOmniCleanView);omni.addEventListener("did-finish-load",applyOmniCleanView);
  }
  $("#omnisave-forward")?.addEventListener("click",()=>{if(omni?.canGoForward())omni.goForward();});
  $("#omnisave-reload")?.addEventListener("click",()=>omni?.reload());
  $("#omnisave-open-external")?.addEventListener("click",()=>window.open("https://videodownloader.site/","_blank"));
  $$("[data-go]").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.go)));
  document.addEventListener("click",e=>{
    const play=e.target.closest("[data-play]");if(play){playStation(play.dataset.play);return;}
    const fav=e.target.closest("[data-fav]");if(fav){toggleFav(fav.dataset.fav);return;}
    const audioPlay=e.target.closest("[data-audio-play]");if(audioPlay){playAudioTrack(audioPlay.dataset.audioPlay);return;}
    const audioFav=e.target.closest("[data-audio-fav]");if(audioFav){toggleMusicFav(musicTrackCache.get(String(audioFav.dataset.audioFav))||musicFavs().find(x=>String(x.id)===String(audioFav.dataset.audioFav)));return;}
    const film=e.target.closest("[data-film-play]");if(film){playArchiveFilm(film.dataset.filmPlay,film.dataset.title);return;}
    const trailerToggle=e.target.closest("[data-trailer-toggle],[data-trailer-toggle-close]");if(trailerToggle){const host=$("#movie-trailer-player"),picker=host?.querySelector(".orbit-trailer-picker");const open=picker?.hidden!==false;if(picker){picker.hidden=!open;const btn=host.querySelector("[data-trailer-toggle]");if(btn){btn.setAttribute("aria-expanded",String(open));btn.innerHTML=open?'Hide trailers <span>⌃</span>':'Choose trailer <span>⌄</span>';}}return;}
    const trailer=e.target.closest("[data-trailer-play]");if(trailer){const host=$("#movie-trailer-player");if(host){const picker=host.querySelector(".orbit-trailer-picker");if(picker)picker.hidden=true;const toggle=host.querySelector("[data-trailer-toggle]");if(toggle){toggle.setAttribute("aria-expanded","false");toggle.innerHTML='Choose trailer <span>⌄</span>';}const frame=host.querySelector("iframe");if(frame)frame.src="https://www.youtube-nocookie.com/embed/"+encodeURIComponent(trailer.dataset.trailerPlay)+"?autoplay=1&rel=0&modestbranding=1";host.scrollIntoView({behavior:"smooth",block:"nearest"});$("#film-result-note").textContent="Playing trailer inside ORBIT";}return;}
    const browseFree=e.target.closest("[data-browse-free-movies]");if(browseFree){loadPublicDomainFilms("popular").then(()=>{$("#movie-results").scrollIntoView({behavior:"smooth",block:"start"});}).catch(()=>notify("Free movie catalogue is temporarily unavailable."));return;}
    const filmDetailBack=e.target.closest("[data-film-detail-back]");if(filmDetailBack){closeMobileMovieDetail();return;}
    const tmdbOpen=e.target.closest("[data-tmdb-open]");if(tmdbOpen){openTmdbMovie(tmdbOpen.dataset.tmdbOpen);return;}
    const ytAlt=e.target.closest("[data-youtube-alt]");if(ytAlt){playYouTubeAlternate(ytAlt.dataset.youtubeAlt,ytAlt.dataset.title);return;}
    const yt=e.target.closest("[data-youtube]");if(yt){playYouTubeVideo(yt.dataset.youtube,yt.dataset.title,yt.dataset.artist);return;}
    const podcast=e.target.closest("[data-podcast]");if(podcast){loadPodcastEpisodes(podcast.dataset.podcast,podcast.dataset.title);return;}
    const podcastPlay=e.target.closest("[data-podcast-play]");if(podcastPlay){playPodcastEpisode(podcastPlay.dataset.podcastPlay);return;}
    const downloadTrack=e.target.closest("[data-download-track]");if(downloadTrack){const track=musicTrackCache.get(String(downloadTrack.dataset.downloadTrack));if(track&&track.source==="Audius"&&track.canDownload){const id=encodeURIComponent(track.providerId||track.id.replace(/^audius:/,""));downloadOffline("/api/audius-download?id="+id,track.title,"audio",track.artwork,downloadTrack);}else notify("The artist has not enabled downloads for this track.");return;}
    const downloadUrl=e.target.closest("[data-download-url]");if(downloadUrl){downloadOffline(downloadUrl.dataset.downloadUrl,downloadUrl.dataset.downloadTitle,downloadUrl.dataset.downloadKind,"",downloadUrl);return;}
    const downloadFilm=e.target.closest("[data-download-film]");if(downloadFilm){fetch("/api/film-download-url?id="+encodeURIComponent(downloadFilm.dataset.downloadFilm)).then(r=>{if(!r.ok)throw new Error("No downloadable file listed");return r.json();}).then(x=>downloadOffline(x.url,x.title,"film","",downloadFilm)).catch(()=>notify("This archive item has no downloadable film file."));return;}
    const offlinePlay=e.target.closest("[data-offline-play]");if(offlinePlay){playOffline(offlinePlay.dataset.offlinePlay,offlinePlay.dataset.offlineKind,offlinePlay.dataset.offlineTitle);return;}
    const offlineDelete=e.target.closest("[data-offline-delete]");if(offlineDelete){if(window.orbitDesktop?.deleteOffline){window.orbitDesktop.deleteOffline(offlineDelete.dataset.offlineDelete).then(loadOfflineLibrary).catch(()=>notify("Could not remove this download."));}else{offlineDBRequest("readwrite",s=>s.delete(String(offlineDelete.dataset.offlineDelete))).then(loadOfflineLibrary).catch(()=>notify("Could not remove this download."));}return;}
    const prev=e.target.closest("[data-preview]");if(prev){radioPlayToken++;radioPlayback=null;currentStation=null;audio.src=prev.dataset.preview;audio.play().then(()=>setPlayer(prev.dataset.title,"Music preview / iTunes","Preview")).catch(()=>notify("Preview unavailable."));return;}
    const video=e.target.closest("[data-video]");if(video){window.open(video.dataset.video,"_blank","noopener");return;}
    const open=e.target.closest("[data-open]");if(open){window.open(open.dataset.open,"_blank","noopener");return;}
    const searchTv=e.target.closest("[data-search-tv]");if(searchTv){showView("global-live");playGlobalChannel(searchTv.dataset.searchTv);return;}
    const book=e.target.closest("[data-bookplay]");if(book){playBook(book.dataset.bookplay,book.dataset.title);return;}
  });
  $("#previous-track").addEventListener("click",()=>stepMusic(-1));$("#next-track").addEventListener("click",()=>stepMusic(1));audio.addEventListener("ended",()=>stepMusic(1));
  $("#play-button").addEventListener("click",()=>{if(currentYoutubeId){const frame=$("#youtube-player-panel iframe");if(frame?.contentWindow){const command=currentYoutubePaused?"playVideo":"pauseVideo";frame.contentWindow.postMessage(JSON.stringify({event:"command",func:command,args:[]}),"*");currentYoutubePaused=!currentYoutubePaused;$("#play-button").classList.toggle("is-playing",!currentYoutubePaused);}return;}if(!audio.src){notify("Choose something to play first.");return;}if(audio.paused)audio.play().catch(()=>{});else audio.pause();$("#play-button").classList.toggle("is-playing",!audio.paused);});
  $("#stop-button").addEventListener("click",()=>{if(currentYoutubeId){const frame=$("#youtube-player-panel iframe");frame?.contentWindow?.postMessage(JSON.stringify({event:"command",func:"stopVideo",args:[]}),"*");currentYoutubePaused=true;}audio.pause();audio.currentTime=0;$("#play-button").classList.remove("is-playing");$("#player-state").textContent="Stopped";});
  $("#volume-button").addEventListener("click",()=>{audio.muted=!audio.muted;const b=$("#volume-button");b.textContent=audio.muted?"Unmute":"Mute";b.title=audio.muted?"Unmute audio":"Mute audio";b.style.color=audio.muted?"var(--lime)":"";});
  $("#player-fav").addEventListener("click",()=>{if(currentMusicTrack)toggleMusicFav(currentMusicTrack);else if(currentStation)toggleFav(currentStation.stationuuid);});
  $("#country-filter").addEventListener("change",loadStationList);
  let stationTimer;$("#station-search").addEventListener("input",()=>{clearTimeout(stationTimer);stationTimer=setTimeout(loadStationList,350);});
  const globalSearch=$("#global-search"),globalSearchButton=$("#global-search-submit");
  const runGlobalSearch=()=>{const term=globalSearch.value.trim();if(!term){globalSearch.focus();notify("Type something to search across ORBIT.");return;}searchGlobal(term).catch(()=>{const host=$("#global-search-results");if(host)host.innerHTML='<div class="empty-state">Search is temporarily unavailable. Please try again.</div>';notify("Search could not be completed. Please try again.");});};
  globalSearchButton?.addEventListener("click",runGlobalSearch);
  globalSearch.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();runGlobalSearch();}});
  globalSearch.addEventListener("search",runGlobalSearch);
  $("#podcast-search").addEventListener("keydown",e=>{if(e.key==="Enter")loadItunes("podcasts",e.target.value.trim()).catch(()=>notify("Podcast search unavailable."));});
  $("#music-video-search").addEventListener("keydown",e=>{if(e.key==="Enter")loadYouTubeMusic(e.target.value.trim()).catch(()=>notify("Music video search unavailable."));});
  $("#audio-music-search").addEventListener("keydown",e=>{if(e.key==="Enter"){$("#audio-music-results").dataset.loaded="";loadAudioMusic(e.target.value.trim()).then(()=>$("#audio-music-results").dataset.loaded="1").catch(()=>notify("Music search unavailable."));}});
  $("#movie-search").addEventListener("keydown",e=>{if(e.key==="Enter"){const q=e.target.value.trim();const active=document.querySelector("#view-movies .pill.active")?.dataset.movie;loadArchiveFilms(active==="public-domain"?"public-domain:"+q:q).then(()=>$("#movie-results").dataset.loaded="1").catch(()=>notify("Movie search is temporarily unavailable."));}});
  $("#book-search").addEventListener("keydown",e=>{if(e.key==="Enter")loadBooks(e.target.value.trim());});
  $$("[data-term]").forEach(b=>b.addEventListener("click",()=>{ $$("#view-podcasts .pill").forEach(x=>x.classList.toggle("active",x===b));loadItunes("podcasts",b.dataset.term).catch(()=>notify("Podcast catalogue unavailable."));}));
  $$("[data-music-video]").forEach(b=>b.addEventListener("click",()=>{ $$("#view-music-video .pill").forEach(x=>x.classList.toggle("active",x===b));loadYouTubeMusic(b.dataset.musicVideo).catch(()=>notify("Music search is temporarily unavailable."));}));
  document.querySelectorAll("[data-movie]").forEach(b=>b.addEventListener("click",()=>{ document.querySelectorAll("#view-movies .pill").forEach(x=>x.classList.toggle("active",x===b));loadArchiveFilms(b.dataset.movie).then(()=>document.querySelector("#movie-results").dataset.loaded="1").catch(()=>notify("Movie catalogue unavailable. Please try again."));}));
  $$("[data-book]").forEach(b=>b.addEventListener("click",()=>{ $$("#view-audiobooks .pill").forEach(x=>x.classList.toggle("active",x===b));loadBooks(b.dataset.book==="popular"?"":b.dataset.book);}));
  $$("#view-music .pill[data-audio-music]").forEach(b=>b.addEventListener("click",()=>{$$("#view-music .pill[data-audio-music]").forEach(x=>x.classList.toggle("active",x===b));$("#audio-music-results").dataset.loaded="";loadAudioMusic(b.dataset.audioMusic).then(()=>$("#audio-music-results").dataset.loaded="1").catch(()=>notify("Music catalogue unavailable."));}));
  $$("#music-provider-filters [data-music-provider]").forEach(b=>b.addEventListener("click",()=>{$$("#music-provider-filters .pill").forEach(x=>x.classList.toggle("active",x===b));musicProviderFilter=b.dataset.musicProvider;renderMusicResults();}));
  audio.addEventListener("play",()=>{$("#play-button").classList.add("is-playing");$("#player-state").textContent=currentMusicTrack?"Full audio track":"Now playing";});
  audio.addEventListener("pause",()=>{$("#play-button").classList.remove("is-playing");});
  const navToggle=$("#nav-toggle"),playerHide=$("#player-hide"),playerReveal=$("#player-reveal"),fullscreenToggle=$("#fullscreen-toggle");
  setupSettings();setupGlobalLive();
  const syncFullscreen=()=>{const active=!!document.fullscreenElement;fullscreenToggle.title=active?"Exit full screen":"Enter full screen";fullscreenToggle.setAttribute("aria-label",fullscreenToggle.title);document.body.classList.toggle("app-fullscreen",active);};
  fullscreenToggle.addEventListener("click",async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{notify("Full-screen mode is not available right now.");}});
  document.addEventListener("fullscreenchange",syncFullscreen);syncFullscreen();
  if(localStorage.getItem("orbit-nav-hidden")==="1")document.body.classList.add("nav-hidden");
  if(localStorage.getItem("orbit-player-hidden")==="1")document.body.classList.add("player-hidden");
  navToggle.addEventListener("click",()=>{const hidden=document.body.classList.toggle("nav-hidden");localStorage.setItem("orbit-nav-hidden",hidden?"1":"0");navToggle.title=hidden?"Show navigation":"Hide navigation";navToggle.setAttribute("aria-label",navToggle.title);const setting=$("#setting-nav-visible");if(setting)setting.checked=!hidden;});
  playerHide.addEventListener("click",()=>{document.body.classList.add("player-hidden");document.body.classList.remove("mobile-player-open");localStorage.setItem("orbit-player-hidden","1");});
  playerReveal.addEventListener("click",()=>{document.body.classList.remove("player-hidden");document.body.classList.add("mobile-player-open");localStorage.setItem("orbit-player-hidden","0");});
  audio.addEventListener("error",()=>{
    if(currentStation&&radioPlayback&&radioPlayback.token===radioPlayToken&&!radioPlayback.active){
      retryRadioPlayback(radioPlayToken,"Radio connection interrupted");return;
    }
    if(!currentMusicTrack)$("#player-state").textContent="Stream unavailable";
  });
  audio.addEventListener("ended",()=>{
    if(currentStation&&radioPlayback&&radioPlayback.token===radioPlayToken){
      retryRadioPlayback(radioPlayToken,"Station stream ended");
    }
  });
  audio.addEventListener("waiting",()=>{
    const token=radioPlayToken;
    if(!currentStation||!radioPlayback||radioPlayback.token!==token)return;
    setTimeout(()=>{
      if(token===radioPlayToken&&currentStation&&radioPlayback&&radioPlayback.token===token&&!audio.paused&&audio.readyState<3){
        retryRadioPlayback(token,"Radio stream stalled");
      }
    },25000);
  });
}
async function boot(){
  setupEvents();
  $("#connection-status").textContent="Spinn Radio catalogue ready";
  await loadFeatured();
  loadItunes("podcasts","top podcasts").catch(()=>$("#podcast-results").innerHTML='<div class="empty-state">Podcast catalogue unavailable.</div>');
  loadYouTubeMusic("trending afrobeats").then(()=>$("#music-video-results").dataset.loaded="1").catch(()=>$("#music-video-results").innerHTML='<div class="empty-state">Music video search unavailable. Please try again.</div>');
  loadArchiveFilms("trending").then(()=>$("#movie-results").dataset.loaded="1").catch(()=>$("#movie-results").innerHTML='<div class="empty-state">TMDB movie catalogue unavailable.</div>');
  loadBooks();
  refreshFavViews();
}
boot();
// ORBIT PWA/mobile local testing: QR + installable home-screen experience
(async()=>{try{const info=await fetch('/api/mobile-info',{cache:'no-store'}).then(r=>r.json());const entry=(info.addresses||[]).find(x=>/wi-?fi|wireless/i.test(x.iface))||(info.addresses||[])[0];const host=entry?.address||location.hostname;const url='http://'+host+':'+info.port+'/';const a=document.getElementById('orbit-mobile-url');if(a){a.href=url;a.textContent=url;}const qr=document.getElementById('orbit-mobile-qr');if(qr)qr.src='/api/mobile-qr?url='+encodeURIComponent(url);const copy=document.getElementById('mobile-test-copy');if(copy)copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(url);document.getElementById('mobile-test-copy-status').textContent='Copied '+url;copy.textContent='Copied';}catch{document.getElementById('mobile-test-copy-status').textContent=url;}});}catch(e){const a=document.getElementById('orbit-mobile-url');if(a)a.textContent='Start ORBIT in LAN test mode first.';}})();
if('serviceWorker' in navigator && location.protocol==='http:' && location.hostname!=='127.0.0.1' && location.hostname!=='localhost')navigator.serviceWorker.register('/sw.js').catch(()=>{});

// ORBIT Mobile showcase: rotating feature previews
(()=>{const root=document.querySelector('.orbit-mobile-showcase');if(!root||root.dataset.ready)return;root.dataset.ready='1';
 const img=root.querySelector('#orbit-mobile-showcase-image'),title=root.querySelector('[data-showcase-title]'),caption=root.querySelector('[data-showcase-caption]'),dots=[...root.querySelectorAll('[data-showcase-index]')],toggle=root.querySelector('[data-showcase-toggle]');
 const slides=[
  {src:'./orbit-mobile-radio.svg',alt:'ORBIT mobile global live radio interface',title:'Tune into the world.',caption:'Live radio stations from everywhere.'},
  {src:'./orbit-mobile-music.svg',alt:'ORBIT mobile music discovery and player interface',title:'Your sound. Your space.',caption:'Discover music and keep your favourites close.'},
  {src:'./orbit-mobile-movies.svg',alt:'ORBIT mobile movie and entertainment interface',title:'Your next favourite is here.',caption:'Explore movies and entertainment in one place.'},
  {src:'./orbit-mobile-offline.svg',alt:'ORBIT mobile offline downloads library interface',title:'Take it with you.',caption:'Your saved music and videos, ready offline.'},
  {src:'./orbit-mobile-podcasts.svg',alt:'ORBIT mobile podcasts and spoken audio interface',title:'Press play on something new.',caption:'Podcasts, stories and audio for every moment.'}
 ];
 let current=0,timer=null,paused=false;
 const show=(n)=>{current=(n+slides.length)%slides.length;const s=slides[current];img.classList.add('is-changing');window.setTimeout(()=>{img.src=s.src;img.alt=s.alt;title.textContent=s.title;caption.textContent=s.caption;img.classList.remove('is-changing');},180);dots.forEach((d,i)=>{d.classList.toggle('is-active',i===current);d.setAttribute('aria-pressed',i===current?'true':'false');});};
 const stop=()=>{if(timer){clearInterval(timer);timer=null;}};
 const start=()=>{stop();if(paused||document.hidden||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;timer=setInterval(()=>show(current+1),5200);};
 dots.forEach(d=>d.addEventListener('click',()=>{show(Number(d.dataset.showcaseIndex));start();}));
 toggle.addEventListener('click',()=>{paused=!paused;toggle.textContent=paused?'Play previews':'Pause previews';toggle.setAttribute('aria-pressed',paused?'true':'false');start();});
 root.addEventListener('mouseenter',stop);root.addEventListener('mouseleave',start);
 document.addEventListener('visibilitychange',start);
 const motion=document.getElementById('setting-motion');if(motion)motion.addEventListener('change',start);
 show(0);start();
})();



