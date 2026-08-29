import express from 'express';
for (const val of ['1', '2', 'true', 'loopback']) {
  try {
    const app = express();
    app.set('trust proxy', val);
    app.get('/', (req,res)=>res.send(String(req.ip)));
    const s = app.listen(0);
    await new Promise(r=>s.once('listening',r));
    const r = await fetch(`http://127.0.0.1:${s.address().port}/`, {headers:{'x-forwarded-for':'9.9.9.9'}});
    console.log(JSON.stringify(val), '->', r.status, await r.text());
    s.close();
  } catch (e) { console.log(JSON.stringify(val), '-> THROWS', e.message); }
}
