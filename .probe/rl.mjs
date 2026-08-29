import { createApp } from '../src/server.js';
import { createDb } from '../src/db.js';
const db = createDb('postgres://postgres@/postgres?host=/tmp/ptprobe/sock');
const stripe = { webhooks:{}, checkout:{ sessions:{ async create(){ return { id:'cs_x'+Math.random().toString(36).slice(2), url:'https://x' }; } } } };
const created = await createApp({
  logger: { log(){}, error(){} }, db, stripe,
  cfg: { databaseUrl:'x', compositor:false, worker:false, moderationFake:true, checkoutRateLimit:5, checkoutRateWindowMs:600000 }
});
console.log("app 'trust proxy' setting =", JSON.stringify(created.app.get('trust proxy')));
const s = created.app.listen(0); await new Promise(r=>s.once('listening',r));
const base = `http://127.0.0.1:${s.address().port}`;
const buy = ip => fetch(`${base}/api/checkout`, { method:'POST',
  headers:{'content-type':'application/json','x-forwarded-for':ip},
  body: JSON.stringify({ prompt:'A lighthouse in a storm painted in thick oils' }) });
// 6 DIFFERENT customers, each behind the same reverse proxy
for (let i=1;i<=6;i++) {
  const r = await buy(`203.0.113.${i}`);
  console.log(`customer 203.0.113.${i} -> HTTP ${r.status} ${r.status===429 ? (await r.json()).error : ''}`);
}
process.exit(0);
