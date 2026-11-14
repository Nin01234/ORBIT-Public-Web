import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

async function freePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>server.once("error",reject).listen(0,"127.0.0.1",resolve));
  const port=server.address().port;
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  return port;
}

test("all ordinary HTTP response paths include security headers",async t=>{
  const port=await freePort();
  const cwd=fileURLToPath(new URL("../",import.meta.url));
  const child=spawn(process.execPath,["server.mjs"],{
    cwd,
    env:{...process.env,PORT:String(port),RENDER:""},
    stdio:["ignore","ignore","pipe"]
  });
  let stderr="";
  child.stderr.on("data",chunk=>{stderr+=chunk.toString().slice(0,4000);});
  t.after(()=>{if(!child.killed)child.kill();});

  let ready=false;
  for(let attempt=0;attempt<60;attempt++){
    if(child.exitCode!==null)throw new Error("Server exited before listening: "+stderr);
    try{
      const response=await fetch("http://127.0.0.1:"+port+"/healthz");
      if(response.status===200){ready=true;break;}
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(ready,true,"server should become ready");

  const cases=[
    ["GET","/healthz",200],
    ["GET","/missing-static-file",404],
    ["POST","/",405],
    ["POST","/api/unknown",405]
  ];
  for(const [method,path,status] of cases){
    const response=await fetch("http://127.0.0.1:"+port+path,{method});
    assert.equal(response.status,status,method+" "+path);
    assert.equal(response.headers.get("x-content-type-options"),"nosniff",method+" "+path+" security header");
    assert.ok(response.headers.get("content-security-policy"),method+" "+path+" CSP header");
  }
});
