(()=>{"use strict";
const $=s=>document.querySelector(s);
const state={socket:null,role:null,room:"",stream:null,peers:new Map(),listenerPeer:null,pendingCandidates:new Map(),closed:false};
const roomHost=$("#live-podcast-room-code"),status=$("#live-podcast-room-status"),hostBtn=$("#live-podcast-start"),joinBtn=$("#live-podcast-join"),stopBtn=$("#live-podcast-stop"),joinInput=$("#live-podcast-code"),copyBtn=$("#live-podcast-copy"),remoteAudio=$("#live-podcast-audio");
const rtcConfig={iceServers:[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun1.l.google.com:19302"}]};
function say(message){if(status)status.textContent=message;}
function socketUrl(){if(window.orbitDesktop?.isDesktop)return "wss://orbit-public-web.onrender.com/signal";return (location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+"/signal";}
function send(message){if(state.socket?.readyState===WebSocket.OPEN)state.socket.send(JSON.stringify(message));}
function sendPeerSignal(id,data){send({type:"signal",peerId:state.role==="host"?id:state.listenerPeer,data});}
function setControls(){if(hostBtn)hostBtn.disabled=!!state.role;if(joinBtn)joinBtn.disabled=!!state.role;if(stopBtn)stopBtn.hidden=!state.role;if(joinInput)joinInput.disabled=!!state.role;}
function cleanupPeer(id){const pc=state.peers.get(id);if(pc){pc.onicecandidate=null;pc.ontrack=null;pc.close();state.peers.delete(id);}state.pendingCandidates.delete(id);}
async function flushCandidates(id,pc){const queued=state.pendingCandidates.get(id)||[];state.pendingCandidates.delete(id);for(const candidate of queued){try{await pc.addIceCandidate(candidate);}catch{}}}
function cleanup(message="Broadcast ended."){state.closed=true;for(const id of [...state.peers.keys()])cleanupPeer(id);if(state.stream)state.stream.getTracks().forEach(t=>t.stop());state.stream=null;if(remoteAudio){remoteAudio.pause();remoteAudio.srcObject=null;}if(state.socket){const s=state.socket;state.socket=null;s.onclose=null;s.close();}state.role=null;state.room="";state.listenerPeer=null;if(roomHost)roomHost.textContent="—";setControls();say(message);}
function connect(){return new Promise((resolve,reject)=>{const ws=new WebSocket(socketUrl());state.socket=ws;const timer=setTimeout(()=>{if(ws.readyState!==WebSocket.OPEN){ws.close();reject(Error("Live connection timed out. The ORBIT signalling service may not be deployed yet."));}},12000);ws.onopen=()=>{clearTimeout(timer);resolve();};ws.onerror=()=>{clearTimeout(timer);reject(Error("Could not reach ORBIT live signalling. Check the hosted service and internet connection."));};ws.onclose=()=>{clearTimeout(timer);if(!state.closed)cleanup("Connection closed. Reconnect to start or join again.");};ws.onmessage=e=>{let m;try{m=JSON.parse(e.data);}catch{return;}handleMessage(m).catch(err=>say(err.message||"Live connection error."));};});}
async function makePeer(id,hostSide){const pc=new RTCPeerConnection(rtcConfig);state.peers.set(id,pc);pc.onicecandidate=e=>{if(e.candidate)sendPeerSignal(id,{type:"candidate",candidate:e.candidate});};pc.onconnectionstatechange=()=>{if(["failed","closed"].includes(pc.connectionState)){cleanupPeer(id);if(hostSide)say("A listener disconnected. Other listeners can stay connected.");else say("The live connection failed. Check your network and try joining again.");}};if(hostSide){state.stream.getTracks().forEach(t=>pc.addTrack(t,state.stream));}else{pc.ontrack=e=>{const stream=e.streams?.[0];if(stream&&remoteAudio){remoteAudio.srcObject=stream;remoteAudio.play().then(()=>say("Connected — listening live.")).catch(()=>say("Connected. Tap the audio player to start listening."));}};}return pc;}
async function handleMessage(m){
 if(m.type==="created"){state.room=m.room;roomHost.textContent=m.room;say("You're live. Share this room code with listeners.");return;}
 if(m.type==="joined"){state.listenerPeer=m.peerId;state.room=m.room;roomHost.textContent=m.room;say("Joined the room. Waiting for the host to connect…");return;}
 if(m.type==="peer-joined"&&state.role==="host"){const id=m.peerId;const pc=await makePeer(id,true);const offer=await pc.createOffer();await pc.setLocalDescription(offer);sendPeerSignal(id,{type:"offer",description:pc.localDescription});say("Live — "+state.peers.size+" listener connection(s).");return;}
 if(m.type==="peer-left"){cleanupPeer(m.peerId);say("A listener left. "+state.peers.size+" listener connection(s) remain.");return;}
 if(m.type==="ended"){cleanup(m.message||"The host ended this live podcast.");return;}
 if(m.type==="error"){cleanup(m.message||"Live room error.");return;}
 if(m.type==="signal"){
  const id=state.role==="host"?m.peerId:"host";let pc=state.peers.get(id);
  if(m.data?.type==="offer"&&!pc)pc=await makePeer(id,false);
  if(!pc)return;
  if(m.data.type==="offer"){await pc.setRemoteDescription(m.data.description);await flushCandidates(id,pc);const answer=await pc.createAnswer();await pc.setLocalDescription(answer);sendPeerSignal(id,{type:"answer",description:pc.localDescription});}
  else if(m.data.type==="answer"&&state.role==="host"){await pc.setRemoteDescription(m.data.description);await flushCandidates(id,pc);}
  else if(m.data.type==="candidate"&&m.data.candidate){if(!pc.remoteDescription){const q=state.pendingCandidates.get(id)||[];q.push(m.data.candidate);state.pendingCandidates.set(id,q);}else{try{await pc.addIceCandidate(m.data.candidate);}catch{}}}
 }
}
async function startBroadcast(){if(!navigator.mediaDevices?.getUserMedia){say("Microphone broadcasting requires HTTPS and a browser that supports microphone access.");return;}try{state.closed=false;say("Requesting microphone permission…");state.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});state.role="host";setControls();say("Connecting to ORBIT live service…");await connect();send({type:"create"});}catch(e){cleanup(e.message||"Could not start the live podcast.");}}
async function joinBroadcast(){const code=(joinInput?.value||"").trim().toUpperCase();if(!/^[A-F0-9]{10}$/.test(code)){say("Enter the 10-character room code shared by the host.");return;}try{state.closed=false;state.role="listener";setControls();say("Joining live room…");await connect();send({type:"join",room:code});}catch(e){cleanup(e.message||"Could not join the live room.");}}
function stopBroadcast(){if(state.role==="host")send({type:"end"});else send({type:"leave"});cleanup("You left the live podcast.");}
hostBtn?.addEventListener("click",startBroadcast);joinBtn?.addEventListener("click",joinBroadcast);stopBtn?.addEventListener("click",stopBroadcast);
joinInput?.addEventListener("keydown",e=>{if(e.key==="Enter")joinBroadcast();});
copyBtn?.addEventListener("click",async()=>{if(!state.room)return;try{await navigator.clipboard.writeText(state.room);say("Room code copied. Share it with your listeners.");}catch{say("Select and copy the room code shown above.");}});
window.addEventListener("beforeunload",()=>{if(state.socket?.readyState===WebSocket.OPEN)send({type:state.role==="host"?"end":"leave"});});
setControls();
})();