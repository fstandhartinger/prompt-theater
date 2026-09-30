const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const SITE = 'prompt-theater.app.mintapis.com';
const PRICE_CENTS_FALLBACK = 400;
const SCENE_SECONDS_FALLBACK = 15;

const CSS = `
:root{color-scheme:dark;--bg:#080a0f;--panel:#11151d;--line:#252a35;--ink:#f4f1ea;--muted:#a2a8b4;--red:#ff675b;--accent:#ff816f;--ok:#3d6b4a;--okbg:#101c14;--focus:#ffd166}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-underline-offset:3px}
a:hover{text-decoration-color:currentColor}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:4px}
.wrap{max-width:1100px;margin:auto;padding:16px 16px 40px}
.nav{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 0 22px}
.brand{font-weight:800;letter-spacing:.08em;color:#fff;text-decoration:none;font-size:17px}
.navlinks{display:flex;gap:16px;flex-wrap:wrap}
.navlinks a{color:var(--muted);text-decoration:none;font-size:14.5px}
.navlinks a:hover{color:var(--ink);text-decoration:underline}
.muted{color:var(--muted)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px}
.skip{position:absolute;left:-999px;top:0;background:var(--accent);color:#160705;padding:8px 14px;border-radius:0 0 8px 0;font-weight:700;z-index:10}
.skip:focus{left:0}
.badge{display:inline-block;font-size:12px;font-weight:800;letter-spacing:.04em;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:4px 10px}
.badge.live{color:var(--red);border-color:transparent;background:#241012}
.badge.live::before{content:'●';margin-right:6px;animation:p 1.4s infinite}
@keyframes p{50%{opacity:.35}}
@media(prefers-reduced-motion:reduce){.badge.live::before{animation:none}}
.live{color:#ff675b;font-size:13px;font-weight:800;letter-spacing:.04em}
h1{font-size:clamp(1.6rem,1.15rem + 2.3vw,2.4rem);line-height:1.15;margin:10px 0 14px;letter-spacing:-.01em}
h2{font-size:1.35rem;margin:0 0 10px}
h3{font-size:1.05rem;margin:26px 0 8px}
p{margin:10px 0}
.lead{font-size:clamp(1rem,.95rem + .5vw,1.15rem);color:var(--muted);margin:6px 0 22px;max-width:62ch}
.video{width:100%;aspect-ratio:16/9;background:#000;border-radius:10px;display:block}
.hint{font-size:14px;margin:8px 0 0}
textarea{width:100%;min-height:120px;background:#090c12;color:#fff;border:1px solid #363d49;border-radius:8px;padding:12px;font:inherit}
textarea:focus{border-color:var(--accent)}
button[type=submit]{width:100%;margin-top:12px;padding:14px;background:var(--red);color:#160705;border:0;border-radius:8px;font-weight:800;font-size:16px;cursor:pointer}
button[type=submit]:hover{filter:brightness(1.06)}
button[type=submit]:disabled{opacity:.6;cursor:wait}
#error{color:#ff9b8f;font-size:14px;margin:8px 0 0;min-height:1em}
.meta{font-size:13.5px;color:var(--muted)}
.steps{counter-reset:step;list-style:none;padding:0;margin:16px 0}
.steps li{counter-increment:step;position:relative;padding:0 0 18px 46px}
.steps li::before{content:counter(step);position:absolute;left:0;top:0;width:32px;height:32px;border-radius:50%;background:#1a202b;border:1px solid var(--line);color:var(--accent);font-weight:800;display:flex;align-items:center;justify-content:center}
.steps li strong{display:block}
.steps li p{margin:2px 0 0;color:var(--muted);font-size:15px}
.timeline{display:flex;gap:0;margin:18px 0;flex-wrap:wrap}
.timeline div{flex:1 1 90px;min-width:86px;position:relative;padding:14px 8px 0;text-align:center;font-size:12.5px;color:var(--muted)}
.timeline div::before{content:'';position:absolute;top:4px;left:50%;transform:translateX(-50%);width:11px;height:11px;border-radius:50%;background:var(--red)}
.timeline div::after{content:'';position:absolute;top:9px;left:calc(50% + 8px);right:calc(-50% + 8px);height:2px;background:var(--line)}
.timeline div:last-child::after{display:none}
.timeline div strong{display:block;color:var(--ink);font-size:13px}
.scene{border-top:1px solid var(--line);padding:12px 0}
.scene:first-of-type{border-top:0}
.scene .status{text-transform:uppercase;font-size:11px;letter-spacing:.08em;color:var(--muted)}
details.panel>summary{cursor:pointer;font-size:20px;font-weight:700;color:#fff;list-style-position:inside}
details.panel>summary::-webkit-details-marker{display:none}
details.panel>summary::marker{content:none}
details.panel[open]>summary{margin-bottom:8px}
.legal{max-width:760px}
.legal h1{font-size:1.8rem}
.legal h2{margin-top:30px}
.notice{border-color:var(--ok);background:var(--okbg);margin-bottom:22px}
footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:14px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
footer a{color:var(--muted)}
footer a:hover{color:var(--ink)}
@media(min-width:760px){
  .wrap{padding:28px 28px 48px}
  .hero{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(300px,1fr);gap:26px;align-items:start}
  .hero .live-stack{grid-column:1;grid-row:1}
  .hero .action-stack{grid-column:2;grid-row:1}
  .stack{display:flex;flex-direction:column;gap:22px}
}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media(prefers-color-scheme:light){
  :root{color-scheme:light;--bg:#f5f4f0;--panel:#fff;--line:#d8dbe1;--ink:#191b20;--muted:#535b68;--red:#ad3027;--accent:#8f2b22;--ok:#196437;--okbg:#edf7f0;--focus:#805300}
  .brand{color:#17191f}
  .badge.live{color:#98281f;background:#fbece9}
  .live{color:#98281f}
  .skip{background:#8f2b22;color:#fff}
  textarea{background:#fff;color:#191b20;border-color:#747a85}
  button[type=submit]{color:#fff}
  #error{color:#8b1d15}
  .steps li::before{background:#f1eee9}
  details.panel>summary{color:#191b20}
}
`;

const head = (opts) => {
  const price = opts.price ?? PRICE_CENTS_FALLBACK;
  const seconds = opts.sceneSeconds ?? SCENE_SECONDS_FALLBACK;
  const origin = opts.origin || `https://${SITE}`;
  const url = `${origin}${opts.path}`;
  const og = {
    title: opts.ogTitle || opts.title,
    description: opts.description,
    type: opts.type || 'website',
    image: '/brand/og-image.png',
    site: 'Prompt Theater',
  };
  const app = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Prompt Theater',
    url,
    description: opts.description,
    applicationCategory: 'EntertainmentApplication',
    operatingSystem: 'Any (web browser)',
    offers: { '@type': 'Offer', price: (price / 100).toFixed(2), priceCurrency: 'USD', description: 'One ' + seconds + '-second AI-generated scene in the live stream' },
  };
  const product = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'One live Prompt Theater scene',
    description: `A ${seconds}-second AI-generated scene from an audience prompt, screened and aired on the public Prompt Theater stream.`,
    brand: { '@type': 'Brand', name: 'Prompt Theater' },
    offers: { '@type': 'Offer', url, price: (price / 100).toFixed(2), priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  };
  const parts = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(opts.title)} — Prompt Theater</title>`,
    `<meta name="description" content="${esc(opts.description)}">`,
    `<link rel="canonical" href="${esc(url)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="Prompt Theater">`,
    `<meta property="og:locale" content="en_US">`,
    `<meta property="og:title" content="${esc(og.title)}">`,
    `<meta property="og:description" content="${esc(og.description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(`${origin}${og.image}`)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(og.title)}">`,
    `<meta name="twitter:description" content="${esc(og.description)}">`,
    `<meta name="twitter:image" content="${esc(`${origin}${og.image}`)}">`,
    '<meta name="theme-color" content="#080a0f" media="(prefers-color-scheme: dark)">',
    '<meta name="theme-color" content="#f5f4f0" media="(prefers-color-scheme: light)">',
    '<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="/brand/favicon.svg">',
    '<script type="application/ld+json">' + JSON.stringify(app) + '</script>',
    '<script defer src="/analytics.js"></script>',
  ];
  if (opts.product) parts.push('<script type="application/ld+json">' + JSON.stringify(product) + '</script>');
  if (opts.faq?.length) parts.push('<script type="application/ld+json">' + JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: opts.faq.map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  }) + '</script>');
  if (opts.noindex) parts.push('<meta name="robots" content="noindex,follow">');
  if (opts.organization) {
    parts.push('<script type="application/ld+json">' + JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'productivity-boost.com Betriebs UG (haftungsbeschränkt) & Co. KG',
      url: origin,
      logo: `${origin}/brand/logo.svg`,
      email: 'info@productivity-boost.com',
      address: { '@type': 'PostalAddress', streetAddress: 'Reichenbergerstr. 2', postalCode: '94036', addressLocality: 'Passau', addressCountry: 'DE' },
    }) + '</script>');
  }
  return parts.join('');
};

const navLinks = active => `
<a href="/">Live</a>
<a href="/about" ${active === 'about' ? 'aria-current="page"' : ''}>How it works</a>
<a href="/how" ${active === 'how' ? 'aria-current="page"' : ''}>Screening &amp; refunds</a>
<a href="/your-prompt" ${active === 'prompt' ? 'aria-current="page"' : ''}>Your prompt</a>
<a href="/privacy">Privacy</a>
<a href="/imprint">Imprint</a>`;

const footer = () => `
<footer>
<span>© 2026 productivity-boost.com Betriebs UG (haftungsbeschränkt) &amp; Co. KG</span>
<span><a href="/about">How it works</a> · <a href="/how">Screening &amp; refunds</a> · <a href="/your-prompt">Your prompt</a> · <a href="/privacy">Privacy</a> · <a href="/imprint">Imprint</a></span>
</footer>`;

const shell = (opts, body) => `<!doctype html><html lang="en"><head>${head(opts)}<style>${CSS}</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<div class="wrap">
<nav class="nav" aria-label="Main"><a class="brand" href="/">PROMPT THEATER</a><span class="navlinks">${navLinks(opts.nav)}</span></nav>
<main id="main">${body}</main>
${footer()}
</div></body></html>`;

const HINT = '10–300 characters. No protected characters, sexual content, hate, harassment, or personal data.';

const homeBody = ({ scenes, today, purchase, sceneSeconds, price, publicUrl }) => {
  const feed = scenes.map(s => `<div class="scene"><div>${esc(s.prompt_display)}</div><div><span class="status">${esc(s.status)}</span>${s.status === 'played' ? ` · <a href="/scene/${s.id}">watch</a>` : ''}</div></div>`).join('') || '<p class="muted">No scenes yet. The stage is yours.</p>';
  const banner = purchase
    ? `<div class="panel notice"><strong>Payment received — thank you.</strong>${purchase.id ? ` Your scene is <a href="/scene/${purchase.id}">#${purchase.id}</a> (status: ${esc(purchase.status)}).` : ' Your scene is being registered; it will appear in the feed shortly.'} We check the prompt against our content rules, generate roughly ${purchase.sceneSeconds} seconds of video and air it in the live stream — usually within a few minutes. If the prompt is rejected or generation fails, the full amount is refunded automatically to your payment method. Keep this page open or note the scene number to follow along.</div>`
    : '';
  return `${banner}
<div class="hero">
  <div class="stack action-stack">
    <section class="panel" aria-label="Create the next scene">
      <span class="badge">Pay once — ${'$' + (price / 100).toFixed(2)}</span>
      <h1>Describe a scene. Watch it air live.</h1>
      <p class="lead">A public, participatory video show: for ${'$' + (price / 100).toFixed(2)} your idea becomes a ${sceneSeconds}-second AI-generated clip, screened against our content rules, and played in this live stream — usually within a few minutes.</p>
      <form id="buy">
        <label class="visually-hidden" for="prompt" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Your prompt</label>
        <textarea id="prompt" name="prompt" minlength="10" maxlength="300" required placeholder="Describe a ${sceneSeconds}-second scene…" aria-describedby="hint error"></textarea>
        <p class="hint muted" id="hint">${HINT}</p>
        <button type="submit">Continue to payment</button>
        <p id="error" role="alert"></p>
      </form>
      <p class="meta"><strong>${today} scenes today</strong></p>
      <p class="meta">Total price ${'$' + (price / 100).toFixed(2)}, including any VAT that applies to your country; the exact amount is shown at checkout. Every scene is AI-generated. Prompts are checked against our content rules after payment and before generation — rejected prompts never air and are refunded in full, as are scenes we fail to generate or broadcast. Only scenes that have been paid for and cleared moderation appear in the feed above.</p>
      <p class="meta"><a href="/how">How screening and refunds work</a> · <a href="/your-prompt">What happens to your prompt</a> · <a href="/about">More about the show</a></p>
    </section>
  </div>
  <div class="stack live-stack">
    <section class="panel" aria-label="Live broadcast">
      <div class="badge live">LIVE</div>
      <video id="player" class="video" controls autoplay muted playsinline aria-label="Live Prompt Theater broadcast"></video>
      <p class="hint muted">Give it a moment to start.</p>
    </section>
    <details class="panel"><summary>Recent scenes</summary>${feed}</details>
  </div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.6.13/hls.min.js"></script><script>const v=document.querySelector('#player'),u=${JSON.stringify(publicUrl + '/hls/live/stream/index.m3u8')};
if(window.Hls&&Hls.isSupported()){const h=new Hls({liveDurationInfinity:true});h.loadSource(u);h.attachMedia(v);h.on(Hls.Events.ERROR,(_e,d)=>{if(!d.fatal)return;if(d.type===Hls.ErrorTypes.NETWORK_ERROR){setTimeout(()=>{h.loadSource(u);h.startLoad()},2000)}else if(d.type===Hls.ErrorTypes.MEDIA_ERROR){h.recoverMediaError()}else{setTimeout(()=>location.reload(),5000)}})}
else{v.src=u;v.addEventListener('error',()=>setTimeout(()=>{v.src=u+'?t='+Date.now();v.load()},2000))}
document.querySelector('#buy').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;const r=await fetch('/api/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:new FormData(e.target).get('prompt')})});const j=await r.json();if(r.ok)location.href=j.url;else{document.querySelector('#error').textContent=j.error;b.disabled=false}};</script>`;
};

export function home({ scenes, today, price, publicUrl, purchase = null, sceneSeconds = SCENE_SECONDS_FALLBACK, origin }) {
  const html = shell({
    title: 'Live — Watch Your Idea Become an AI Video',
    description: `Prompt Theater is a live, participatory AI video show: pay $${(price / 100).toFixed(2)}, describe a scene in 10–300 characters, and watch a ${sceneSeconds}-second AI-generated clip from your prompt air in the public stream — usually within minutes. Rejected or failed scenes are refunded in full.`,
    path: '/',
    price,
    sceneSeconds,
    organization: true,
    product: true,
    nav: null,
    origin,
  }, homeBody({ scenes, today, purchase, sceneSeconds, price, publicUrl }));
  return html;
}

export function scenePage(scene, origin, sceneSeconds = SCENE_SECONDS_FALLBACK) {
  return shell({
    title: `Scene ${scene.id}`,
    description: `Scene #${scene.id} from the Prompt Theater live stream — a ${sceneSeconds}-second AI-generated satire clip that aired in the public broadcast.`,
    path: `/scene/${scene.id}`,
    sceneSeconds,
    type: 'website',
    nav: null,
    noindex: true,
    origin,
  }, `<article>
  <p><span class="badge">Scene #${scene.id}</span></p>
  <h1>${esc(scene.prompt_display)}</h1>
  <p class="muted">Aired in the Prompt Theater live stream. AI-generated satire.</p>
  ${scene.status === 'played' ? `<video controls class="video" src="/media/scenes/${scene.id}.mp4"></video>` : `<div class="panel">Status: ${esc(scene.status)}</div>`}
  <p class="meta"><a href="/">← Back to the live stream</a></p>
</article>`);
}

const aboutBody = (price, sceneSeconds) => `
<span class="badge">The concept</span>
<h1>A live video show where the audience writes the script</h1>
<p class="lead">Prompt Theater runs around the clock. Anyone can write a short scene, pay ${'$' + (price / 100).toFixed(2)}, and see it generated into a ${sceneSeconds}-second AI video that plays on a public stream — where anyone in the world can watch.</p>
<h2>What you are watching</h2>
<p>The player on the <a href="/">home page</a> is a genuine live broadcast, not a highlight reel. It carries:</p>
<ul>
  <li><strong>Paid scenes</strong> — AI videos generated from prompts that were paid for and cleared our content screening, each labelled with the prompt it came from.</li>
  <li><strong>Replays</strong> — recently aired scenes, clearly marked, while the stage is waiting.</li>
  <li><strong>The stage interstitial</strong> — our placeholder title card between clips.</li>
</ul>
<p>Every frame is labelled “AI-generated satire” in the picture, and only scenes that have actually aired are listed in the recent-scene feed.</p>
<h2>What happens after you pay</h2>
<ol class="steps">
  <li><strong>You write a prompt</strong><p>10–300 characters describing the scene. Payment goes through a standard Stripe checkout.</p></li>
  <li><strong>We screen it</strong><p>After payment and before generation, your prompt is checked against our content rules. Rejected prompts never air and are refunded in full.</p></li>
  <li><strong>We generate a ${sceneSeconds}-second clip</strong><p>An AI video model renders the scene. If generation fails, the full amount is refunded automatically.</p></li>
  <li><strong>It airs in the live stream</strong><p>Your clip is played in the public broadcast, usually within a few minutes, and then stays watchable on its own scene page.</p></li>
</ol>
<h2>What makes it different</h2>
<p>Most AI video tools give you a private download. Here the deliverable is <em>public airtime</em>: a numbered scene in a continuous show that keeps running while you are not looking. There is no account, no waiting list and no feed of your own — just the show, your scene number, and the live player.</p>
<h2>The ground rules</h2>
<p>The show is satire, so recognisable parodies of public figures are fine. What is not fine: sexual content, hate or harassment, personal data, protected franchise characters, or anything presented as a real event. The full rules live on the <a href="/how">screening and refunds</a> page.</p>
<p><a href="/">Watch the stream and write a scene →</a></p>`;

export function about(price = PRICE_CENTS_FALLBACK, sceneSeconds = SCENE_SECONDS_FALLBACK, origin) {
  return shell({
    title: 'How Prompt Theater Works',
    description: `How Prompt Theater works: a live, participatory AI video show. Pay once ($${(price / 100).toFixed(2)}), write a 10–300 character scene, and a ${sceneSeconds}-second AI-generated clip from your prompt airs in the public stream — usually within minutes.`,
    path: '/about',
    price,
    sceneSeconds,
    nav: 'about',
    organization: true,
    origin,
  }, aboutBody(price, sceneSeconds));
}

const howFaq = price => [
  { question: 'Is Prompt Theater a subscription?', answer: `No. Each scene is one purchase at ${'$' + (price / 100).toFixed(2)}. There is no subscription or second charge for replays.` },
  { question: 'What happens if my prompt is rejected?', answer: 'A rejected prompt is not generated or aired. The full amount is refunded automatically to your payment method.' },
  { question: 'What if a scene does not generate or broadcast?', answer: 'If generation fails after retries, or the scene cannot be played on the live stage, the full amount is refunded automatically.' },
  { question: 'Can I write about a real person?', answer: 'Recognisable satire, parody or caricature of real public figures is allowed within the rules. Private individuals must not be the subject. Prompts involving sexual content, glorified violence, hate or harassment, personal data, protected franchise characters, unsupported accusations, fabricated endorsements or invented events presented as fact are rejected.' },
  { question: 'Where can people watch a scene that airs?', answer: 'A scene that passes screening and airs is shown in the public live stream and gets its own scene page.' },
];

const howBody = price => `
<span class="badge">The rules</span>
<h1>Screening, refunds and what can go wrong</h1>
<p class="lead">You pay before we generate, so every path that does not end in an aired scene ends with your money coming back.</p>
<h2>What is screened</h2>
<p>After payment and before any video is generated, each prompt is checked against content rules by a moderation model. Prompts are rejected when they contain:</p>
<ul>
  <li>sexual or sexualised content,</li>
  <li>glorification of violence,</li>
  <li>hate or harassment against a person or group,</li>
  <li>personal data such as addresses, phone numbers, account or ID numbers,</li>
  <li>characters or settings from protected franchises.</li>
</ul>
<p>Recognisable satire, parody or caricature of real public figures is allowed — that is the format of the show. A prompt about a real person is rejected only if it accuses them of a wrongdoing they have not been convicted of, is sexual, fabricates an endorsement, or presents invented events as a factual news report. Private individuals who are not public figures must not be the subject at all.</p>
<h2>The money flow</h2>
<ol class="steps">
  <li><strong>You pay ${'$' + (price / 100).toFixed(2)}</strong><p>The total price includes any VAT that applies to your country; Stripe shows the exact amount at checkout. Payment data is handled by Stripe under its own terms.</p></li>
  <li><strong>Screener says no → full refund</strong><p>A rejected prompt is never generated and never airs. The full amount is refunded automatically to your payment method.</p></li>
  <li><strong>Screener says yes → we generate</strong><p>If generation fails after retries, or the scene cannot be played on the live stage, the full amount is refunded automatically as well.</p></li>
  <li><strong>It airs</strong><p>Your scene plays in the live stream and gets its own page with the clip.</p></li>
</ol>
<h2>If the refund is delayed</h2>
<p>Refunds are retried automatically until they succeed; a temporary payment-provider error only delays the money, it does not lose it. If your scene was refunded, the amount appears on your payment method the same way the charge did.</p>
<h2>What you do not get</h2>
<p>There are no hidden fees, no subscription, no second charge for replays, and no upsell. One scene, one price.</p>
<section aria-labelledby="common-questions">
  <h2 id="common-questions">Common questions</h2>
  ${howFaq(price).map(item => `<h3>${esc(item.question)}</h3><p>${esc(item.answer)}</p>`).join('')}
</section>
<p>For details on what we store and why, see the <a href="/privacy">privacy policy</a>.</p>`;

export function how(price = PRICE_CENTS_FALLBACK, origin) {
  return shell({
    title: 'Screening & Refunds',
    description: 'How prompt screening and refunds work on Prompt Theater: prompts are checked against content rules after payment and before generation. Rejected prompts never air and are refunded in full, as are scenes that fail to generate or broadcast.',
    path: '/how',
    price,
    nav: 'how',
    organization: true,
    faq: howFaq(price),
    origin,
  }, howBody(price));
}

const promptBody = `
<span class="badge">Your data</span>
<h1>What happens to a submitted prompt</h1>
<p class="lead">A short, plain answer first — and then the details. If you want the full legal text, the <a href="/privacy">privacy policy</a> covers the same facts.</p>
<h2>In short</h2>
<ul>
  <li><strong>What we store:</strong> your prompt (trimmed), the displayed version, your payment session identifier and amount, the scene status, the generated video and timestamps.</li>
  <li><strong>Why:</strong> to perform the contract — screen, generate and air the scene — plus prevent abuse and operate the service.</li>
  <li><strong>Who sees your prompt:</strong> it is sent to the moderation model for screening, and to the video generation service so it can create the clip. Both act as processors.</li>
  <li><strong>What is public:</strong> only the scene itself, once it has paid, cleared screening and aired. Unpaid or rejected prompts never appear on the site.</li>
</ul>
<h2>The journey of a prompt</h2>
<div class="timeline">
  <div><strong>Submitted</strong>with your payment</div>
  <div><strong>Saved</strong>with the scene record</div>
  <div><strong>Screened</strong>against content rules</div>
  <div><strong>Generated</strong>into a video</div>
  <div><strong>Aired</strong>on the public stream</div>
</div>
<h2>Rejected prompts</h2>
<p>When screening rejects a prompt, the amount is refunded in full and the prompt is deleted once it is no longer needed for the refund or a dispute.</p>
<h2>Kept prompts and scenes</h2>
<p>Aired scenes stay on their scene page while the replay service needs them; payment and accounting records are kept for the statutory retention periods. After that, prompts, audit records and videos are deleted or anonymised. You may request earlier deletion where no legal obligation requires retention.</p>
<h2>Please do not</h2>
<p>Do not put personal data — yours or anyone else's — in a prompt. That includes names of private people, addresses, phone numbers and account details. Beyond the content rules on the <a href="/how">screening page</a>, we ask you to keep the stream something we can put on a public screen.</p>
<h2>Your rights</h2>
<p>You have rights of access, rectification, erasure, restriction, portability and objection under Arts. 15–21 GDPR. Contact <a href="mailto:info@productivity-boost.com">info@productivity-boost.com</a>.</p>`;

export function yourPrompt(origin) {
  return shell({
    title: 'Your Prompt',
    description: 'What happens to a submitted prompt on Prompt Theater: what is stored, who processes it, what is public, and what is deleted when a prompt is rejected or a scene has aired.',
    path: '/your-prompt',
    nav: 'prompt',
    organization: true,
    origin,
  }, promptBody);
}

export function privacy(origin) {
  return shell({
    title: 'Privacy Policy',
    description: 'Privacy Policy of Prompt Theater: what personal data is processed when you buy a scene, the roles of Stripe, fal and the moderation provider, retention, and your GDPR rights.',
    path: '/privacy',
    nav: null,
    organization: true,
    origin,
  }, `<article class="legal"><h1>Privacy Policy</h1><p class="muted">Prompt Theater · Last updated: 29 September 2026</p><p>This policy describes what personal data Prompt Theater processes.</p><h2>Who is responsible</h2><p>The controller within the meaning of Art. 4(7) GDPR is:<br>productivity-boost.com Betriebs UG (haftungsbeschränkt) &amp; Co. KG<br>Reichenbergerstr. 2, 94036 Passau, Germany<br>Represented by Florian Standhartinger · Email: <a href="mailto:info@productivity-boost.com">info@productivity-boost.com</a></p><p>We have not appointed a data protection officer, as we are not required to under Art. 37 GDPR. You may lodge a complaint with the Bayerisches Landesamt für Datenschutzaufsicht (BayLDA), Ansbach, Germany.</p><h2>What we process</h2><p>When you purchase a scene, we process your prompt, payment-session identifiers, payment amount, scene status, generation output and technical timestamps to perform the contract (Art. 6(1)(b) GDPR), prevent abuse and operate the service (Art. 6(1)(f) GDPR). We do not use advertising trackers. Our hosting provider may process IP addresses in rotating security logs.</p><h2>Website visit counts</h2><p>We use Umami, a self-hosted, cookieless analytics tool on our Hetzner server in Germany, to count visits to these public website pages. Only a fixed page name and website hostname are sent; query strings, referrers, form contents and account information are excluded. Umami derives daily anonymous visitor counts from the request IP address and browser type, without retaining the raw IP address or setting tracking cookies. Analytics data remains in our self-hosted service until deleted. Do Not Track and Global Privacy Control stop this measurement. Scene pages are grouped under one page name, so no scene identifier or prompt is sent.</p><h2>Payment and generation providers</h2><p>Stripe acts as payment service provider and processes payment and checkout data under its own terms. We transmit your prompt to fal as our generation processor so that fal can create the requested video. Do not put personal data in a prompt. OpenRouter and the selected moderation model process prompts to check compliance before generation.</p><h2>Storage duration</h2><p>Payment and accounting records are retained for statutory retention periods. Audit records, prompts and generated scenes are retained while needed to operate the replay service, resolve disputes and prevent abuse, then deleted or anonymized. Rejected prompts and operational errors are deleted when no longer needed for refunds or dispute handling. You may request earlier deletion where no legal obligation requires retention.</p><h2>If you email us</h2><p>We process your email address and message to answer your request (Art. 6(1)(b) GDPR) and retain correspondence only as long as needed.</p><h2>Your rights</h2><p>You have rights of access, rectification, erasure, restriction, portability and objection under Arts. 15–21 GDPR. Contact <a href="mailto:info@productivity-boost.com">info@productivity-boost.com</a>.</p></article>`);
}

export function imprint(origin) {
  return shell({
    title: 'Imprint',
    description: 'Imprint (legal notice) of Prompt Theater: provider, responsible person, contact, commercial register entry and VAT ID.',
    path: '/imprint',
    nav: null,
    organization: true,
    origin,
  }, `<article class="legal"><h1>Imprint</h1><p>Information in accordance with § 5 DDG (Digitale-Dienste-Gesetz).</p><h2>Provider</h2><p>productivity-boost.com Betriebs UG (haftungsbeschränkt) &amp; Co. KG<br>Reichenbergerstr. 2<br>94036 Passau<br>Germany</p><h2>Represented by</h2><p>Florian Standhartinger</p><h2>Contact</h2><p>Email: <a href="mailto:info@productivity-boost.com">info@productivity-boost.com</a><br>Telephone: +49 178 1981631</p><h2>Register entry</h2><p>Registered in the commercial register.<br>Register court: Amtsgericht Passau<br>Register number: HRB 8453</p><h2>VAT identification number</h2><p>VAT ID under § 27a UStG: DE296812612</p><h2>Responsible for editorial content</h2><p>Under § 18 Abs. 2 MStV: Florian Standhartinger, address as above.</p><h2>Online dispute resolution</h2><p>The European Commission provides a platform for online dispute resolution at <a href="https://ec.europa.eu/consumers/odr">ec.europa.eu/consumers/odr</a>. We are neither obliged nor willing to take part in dispute resolution proceedings before a consumer arbitration board.</p></article>`);
}

// ---------------------------------------------------------------------------
// Machine-readable files. The dynamic /scene/:id pages are intentionally absent
// from the sitemap and noindex'd; checkout/webhook/api paths are disallowed.
// ---------------------------------------------------------------------------

export function robotsTxt() {
  return `User-agent: *
Allow: /
Disallow: /api/
Disallow: /hls/
Disallow: /media/

Sitemap: https://${SITE}/sitemap.xml
`;
}

const SITEMAP_PAGES = [
  { path: '/', lastmod: '2026-09-30', priority: '1.0' },
  { path: '/about', lastmod: '2026-09-30', priority: '0.8' },
  { path: '/how', lastmod: '2026-09-30', priority: '0.8' },
  { path: '/your-prompt', lastmod: '2026-09-30', priority: '0.7' },
  { path: '/privacy', lastmod: '2026-09-30', priority: '0.3' },
  { path: '/imprint', lastmod: '2026-09-30', priority: '0.3' },
];

export function sitemapXml() {
  const urls = SITEMAP_PAGES.map(p =>
    `  <url>\n    <loc>https://${SITE}${p.path}</loc>\n    <lastmod>${p.lastmod}</lastmod>\n    <priority>${p.priority}</priority>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function llmsTxt(price = PRICE_CENTS_FALLBACK, sceneSeconds = SCENE_SECONDS_FALLBACK) {
  const usd = (price / 100).toFixed(2);
  return `# Prompt Theater

Prompt Theater is a live, participatory AI video show. Anyone can write a short
scene, pay ${'$' + usd}, and watch a ${sceneSeconds}-second AI-generated clip from their prompt air
in a continuous public stream — usually within a few minutes.

## How it works
- A visitor submits a prompt of 10–300 characters and pays ${'$' + usd} (gross, including any applicable VAT) via Stripe checkout.
- After payment and before generation, the prompt is screened against content rules; rejected prompts never air and are refunded in full.
- Approved prompts are rendered into a ${sceneSeconds}-second AI video and played in the live stream, labelled "AI-generated satire".
- Scenes that fail to generate or broadcast are refunded in full automatically.
- Only paid, screened and aired scenes are public; unpaid or rejected prompts are never shown.

## Pages
- [Live stream and prompt form](https://${SITE}/) — the broadcast, recent scenes and the "buy the next scene" form.
- [How it works](https://${SITE}/about) — the concept and the journey from prompt to airtime.
- [Screening & refunds](https://${SITE}/how) — the content rules and every refund path.
- [Your prompt](https://${SITE}/your-prompt) — what is stored, who processes it, what is deleted.
- [Privacy Policy](https://${SITE}/privacy)
- [Imprint](https://${SITE}/imprint)

## Machine-readable files
- robots.txt: https://${SITE}/robots.txt
- sitemap.xml: https://${SITE}/sitemap.xml

## IndexNow
Verification key file: https://${SITE}/fc30d6f5bd66213395ee6edc0ba8e755.txt
`;
}
