const CACHE='nbl-influence-v2';
const CORE=['./','./index.html','./input.html','./province-seal.png','./pok-logo.png','./manifest.json'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  // ไม่แคชการเรียก Apps Script (ต้องได้ข้อมูลล่าสุดเสมอ)
  if(u.hostname.indexOf('script.google')>-1){return;}
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{
    const cp=resp.clone();
    if(e.request.method==='GET'&&resp.status===200){caches.open(CACHE).then(c=>c.put(e.request,cp));}
    return resp;
  }).catch(()=>caches.match('./index.html'))));
});
