import pg from 'pg';
import Stripe from 'stripe';
const { Client } = pg;
const base = process.env.E2E_URL || 'http://127.0.0.1:3000';
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const secret = process.env.STRIPE_WEBHOOK_SECRET;
const sessionId = `cs_test_e2e_${Date.now()}`;
const inserted = await db.query("INSERT INTO scenes(prompt,prompt_display,status,stripe_session_id,amount_cents) VALUES($1,$1,'awaiting_payment',$2,400) RETURNING id", ['A tiny friendly robot plants flowers beneath a violet moon', sessionId]);
const id = inserted.rows[0].id;
const payload = JSON.stringify({ id: `evt_test_${Date.now()}`, object: 'event', api_version: '2025-07-30.basil', created: Math.floor(Date.now()/1000), livemode: false, pending_webhooks: 1, type: 'checkout.session.completed', data: { object: { id: sessionId, object: 'checkout.session', payment_status: 'paid', amount_total: 400 } } });
const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
const hook = await fetch(`${base}/api/stripe/webhook`, { method: 'POST', headers: { 'content-type':'application/json', 'stripe-signature': signature }, body: payload });
if (!hook.ok) throw new Error(`webhook failed: ${hook.status} ${await hook.text()}`);
console.log('PASS webhook signature accepted');
let status = '', sawReady = false;
for (let i=0; i<90; i++) {
  const row = (await db.query('SELECT status,error FROM scenes WHERE id=$1',[id])).rows[0]; status=row.status; if (status === 'ready') sawReady=true;
  if (['ready','playing','played'].includes(status)) break;
  if (['failed','rejected'].includes(status)) throw new Error(`scene ${status}: ${row.error}`);
  await new Promise(r=>setTimeout(r,1000));
}
if (!['ready','playing','played'].includes(status)) throw new Error(`scene never became ready (last ${status})`);
console.log(`PASS fake generation reached ${status}${sawReady ? ' via ready' : ''}`);
let health, segments=0;
for(let i=0;i<60;i++) {
  const response=await fetch(`${base}/healthz`); health=await response.json();
  if(health.stream_up) { const playlist=await (await fetch(`${base}/hls/live/stream/main_stream.m3u8`)).text(); segments=(playlist.match(/#EXTINF/g)||[]).length; if(segments>=2) break; }
  await new Promise(r=>setTimeout(r,1000));
}
if(!health?.stream_up || segments<2) throw new Error(`stream unhealthy: ${JSON.stringify(health)}, segments=${segments}`);
console.log(`PASS HLS stream_up with ${segments} segments`);
await db.end();
