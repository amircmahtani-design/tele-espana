// netlify/functions/epg.js
// Fetches the free Spanish XMLTV guide (epgshare01), parses it server-side,
// trims to a sensible time window, and returns compact JSON for the app.
// No npm dependencies — uses only Node built-ins (fetch + zlib), so it works
// on Netlify with zero build configuration.

const zlib = require("zlib");

// ── Sources. The function MERGES every source that loads successfully:
//    programmes are combined per channel and de-duplicated by start-time.
//    Any source that fails (404, timeout, blocked) is silently skipped, so
//    adding an experimental URL can never break the app.
//
//    The free epgshare01 ES1 feed below works and carries ~2-3 days.
//    Free Spanish feeds are capped at a few days; for a guaranteed 7-day guide,
//    add a working paid XMLTV URL as a second entry here.
const FEEDS = [
  "https://epgshare01.online/epgshare01/epg_ripper_ES1.xml.gz"
  // , "https://your-extra-source/guide.xml"   // optional second source
];

// ── Channels we want, in display order. Each has match patterns (normalised),
//    a channel number and a colour. Anything not matched is simply skipped —
//    unless almost nothing matches, in which case we return everything found.
const WANTED = [
  { name:"La 1",            num:"1",  color:"#1e88c8", match:["la 1","tve la 1","la1"] },
  { name:"La 2",            num:"2",  color:"#e76f2f", match:["la 2","tve la 2","la2"] },
  { name:"Antena 3",        num:"3",  color:"#f25a2a", match:["antena 3","antena3"] },
  { name:"Cuatro",          num:"4",  color:"#d23b3b", match:["cuatro"] },
  { name:"Telecinco",       num:"5",  color:"#2db4c4", match:["telecinco"] },
  { name:"laSexta",         num:"6",  color:"#7bbf2f", match:["lasexta","la sexta"] },
  { name:"Neox",            num:"7",  color:"#8a5cf0", match:["neox"] },
  { name:"Nova",            num:"8",  color:"#d65a9a", match:["nova"] },
  { name:"Energy",          num:"9",  color:"#3a9ad6", match:["energy"] },
  { name:"FDF",             num:"10", color:"#e0463a", match:["fdf","factoria de ficcion"] },
  { name:"Divinity",        num:"11", color:"#e07ab0", match:["divinity"] },
  { name:"Boing",           num:"12", color:"#46b6c4", match:["boing"] },
  { name:"Clan",            num:"13", color:"#5fd07a", match:["clan"] },
  { name:"Mega",            num:"14", color:"#c4732f", match:["mega"] },
  { name:"Teledeporte",     num:"15", color:"#2fa05f", match:["teledeporte","tdp"] },
  { name:"24h",             num:"16", color:"#3b6fd2", match:["24h","canal 24 horas","24 horas"] },
  { name:"Atreseries",      num:"17", color:"#b06a3a", match:["atreseries"] },
  { name:"Be Mad",          num:"18", color:"#5a6cd2", match:["be mad","bemad"] },
  { name:"DMAX",            num:"19", color:"#3aa0a8", match:["dmax"] },
  { name:"Paramount Network",num:"20",color:"#6a5cd2", match:["paramount network","paramount"] },
  { name:"Trece",           num:"21", color:"#c43a3a", match:["trece","13tv","13 tv"] },
  { name:"DKISS",           num:"22", color:"#d23b86", match:["dkiss"] },
  { name:"Gol",             num:"23", color:"#3aa85a", match:["gol play","gol"] }
];

const norm = s => (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/[^a-z0-9]+/g," ").replace(/\b(hd|fhd|uhd|sd|4k|tdt|spain|es)\b/g," ")
  .replace(/\s+/g," ").trim();

const decode = s => (s||"")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1")
  .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
  .replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#3[49];/g,"'")
  .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n)).trim();

function parseTime(s){ // "20260601203000 +0200" -> epoch ms
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if(!m) return null;
  let ms = Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
  if(m[7]){ const sign = m[7][0]==="-"?-1:1; ms -= sign*((+m[7].slice(1,3))*60 + (+m[7].slice(3,5)))*60000; }
  return ms;
}
const inner = (block, tag) => { const m = block.match(new RegExp("<"+tag+"[^>]*>([\\s\\S]*?)<\\/"+tag+">")); return m ? decode(m[1]) : ""; };

async function fetchFeed(url){
  // Try https, then http (epgshare01 sometimes blocks https from cloud IPs).
  for (const u of [url, url.replace(/^https:/,"http:")]) {
    try {
      const r = await fetch(u, { headers:{ "User-Agent":"Mozilla/5.0 (EPG fetcher)" } });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      return u.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    } catch(e){ /* try next */ }
  }
  throw new Error("Could not fetch feed");
}

let CACHE = { at:0, body:null };

exports.handler = async (event) => {
  const headers = {
    "Content-Type":"application/json; charset=utf-8",
    "Access-Control-Allow-Origin":"*",
    // Browser doesn't cache, but Netlify's CDN serves a cached copy for 3h,
    // so the heavy parsing only runs a few times a day.
    "Cache-Control":"public, max-age=0, s-maxage=10800"
  };
  const debugList = event && event.queryStringParameters && event.queryStringParameters.list;

  // Warm-instance memory cache (15 min)
  if (CACHE.body && Date.now()-CACHE.at < 15*60*1000 && !debugList) {
    return { statusCode:200, headers, body:CACHE.body };
  }

  try {
    // Fetch every source; keep the ones that succeed.
    const xmls = [];
    for (const url of FEEDS) {
      try { xmls.push(await fetchFeed(url)); } catch(e){ /* skip failed source */ }
    }
    if (!xmls.length) throw new Error("No sources available");

    // 1) Channels (merged across sources): id -> {name, icon}
    const chanMeta = {};
    for (const xml of xmls) {
      const cre = /<channel id="([^"]+)">([\s\S]*?)<\/channel>/g; let cm;
      while ((cm = cre.exec(xml))) {
        const id = cm[1];
        const name = inner(cm[2], "display-name");
        const iconM = cm[2].match(/<icon[^>]*src="([^"]+)"/);
        if (!chanMeta[id]) chanMeta[id] = { name, icon: iconM ? iconM[1] : "" };
        else { if(!chanMeta[id].name) chanMeta[id].name=name; if(!chanMeta[id].icon&&iconM) chanMeta[id].icon=iconM[1]; }
      }
    }

    if (debugList) {
      const list = Object.entries(chanMeta).map(([id,v])=>({ id, name:v.name })).sort((a,b)=>a.name.localeCompare(b.name));
      return { statusCode:200, headers, body: JSON.stringify({ sources:xmls.length, count:list.length, channels:list }) };
    }

    // 2) Programmes within window (earlier today .. +8 days), merged + de-duplicated.
    //    Free feeds publish only a few days ahead; we grab everything available.
    const now = Date.now(), lo = now-12*3600e3, hi = now+8*24*3600e3;
    const byChan = {}, seen = {};
    for (const xml of xmls) {
      const pre = /<programme start="([^"]+)" stop="([^"]+)" channel="([^"]+)">([\s\S]*?)<\/programme>/g; let pm;
      while ((pm = pre.exec(xml))) {
        const s = parseTime(pm[1]), e = parseTime(pm[2]);
        if (s===null || e===null || e<lo || s>hi) continue;
        const id = pm[3], blk = pm[4];
        const dedupe = id+"|"+s;            // same channel + same start = duplicate
        if (seen[dedupe]) continue; seen[dedupe] = 1;
        (byChan[id] = byChan[id] || []).push({
          s, e, t: inner(blk,"title") || "Sin título",
          g: inner(blk,"category") || "", d: (inner(blk,"desc") || "").slice(0,140)
        });
      }
    }

    // 3) Build channel objects with normalised names
    const all = Object.keys(byChan).map(id => {
      const progs = byChan[id].sort((a,b)=>a.s-b.s).slice(0,700);
      return { id, name: (chanMeta[id]&&chanMeta[id].name)||id, icon:(chanMeta[id]&&chanMeta[id].icon)||"",
               n: norm((chanMeta[id]&&chanMeta[id].name)||id), programmes: progs };
    }).filter(c => c.programmes.length);

    // 4) Match our wanted list
    const used = new Set();
    const curated = [];
    for (const w of WANTED) {
      const hit = all.find(c => !used.has(c.id) && w.match.some(p => c.n===p || c.n.startsWith(p+" ") || c.n===p.replace(/\s/g,"")));
      if (hit) { used.add(hit.id); curated.push({ name:w.name, num:w.num, color:w.color, icon:hit.icon, programmes:hit.programmes }); }
    }

    // 5) If matching basically failed, return everything so the app still shows real data
    let channels = curated;
    if (curated.length < 6) {
      const palette = ["#1e88c8","#e76f2f","#f25a2a","#d23b3b","#2db4c4","#7bbf2f","#8a5cf0","#d65a9a","#3a9ad6","#e0463a","#46b6c4","#5fd07a","#c4732f","#2fa05f","#3b6fd2"];
      channels = all.sort((a,b)=>b.programmes.length-a.programmes.length).slice(0,40)
        .map((c,i)=>({ name:c.name, num:String(i+1), color:palette[i%palette.length], icon:c.icon, programmes:c.programmes }));
    }

    const body = JSON.stringify({ tz:"Europe/Madrid", updated:now, source:"epgshare01 ES1", channels });
    CACHE = { at:Date.now(), body };
    return { statusCode:200, headers, body };

  } catch (err) {
    return { statusCode:200, headers, body: JSON.stringify({ error:String(err.message||err), channels:[] }) };
  }
};
