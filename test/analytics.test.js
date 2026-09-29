import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const cases=[['prompt',new URL('../src/analytics.js',import.meta.url),'prompt-theater.app.mintapis.com']];
for(const [name,file,host] of cases){
 const src=readFileSync(file,'utf8');
 function run({path='/',hostname=host,dnt,gpc}={}){
  const appended=[];const calls=[];
  const window={location:{hostname,pathname:path,search:'?session_id=private&prompt=private',hash:'#private'},umami:{track:x=>calls.push(x)}};
  const navigator={doNotTrack:dnt,globalPrivacyControl:gpc};
  const document={createElement:()=>({dataset:{},listeners:{},addEventListener(n,f){this.listeners[n]=f;}}),head:{appendChild:x=>appended.push(x)}};
  vm.runInNewContext(src,{window,navigator,document});
  appended[0]?.listeners.load();return {appended,calls,window};
 }
 test(name+': fixed public payload excludes query, prompt, session and referrer',()=>{
  const {appended,calls}=run();assert.equal(appended.length,1);assert.equal(calls.length,1);
  assert.deepEqual(Object.keys(calls[0]).sort(),['hostname','referrer','title','url','website']);
  assert.equal(calls[0].url,'/');assert.equal(calls[0].referrer,'');assert.equal(appended[0].dataset.autoTrack,'false');
  assert.equal(appended[0].referrerPolicy,'no-referrer');assert.doesNotMatch(JSON.stringify(calls),/private/);
 });
 test(name+': DNT and GPC stop script and event',()=>{for(const o of [{dnt:'1'},{dnt:'yes'},{gpc:true}])assert.equal(run(o).appended.length,0);});
 test(name+': private routes and foreign hosts unmeasured',()=>{for(const o of [{path:'/dashboard'},{path:'/api/checkout'},{hostname:'unlisted.example'}])assert.equal(run(o).calls.length,0);});
 test(name+': before-send rejects arbitrary data and click events',()=>{const {window,calls}=run();let f=window.publicSiteUmamiBeforeSend;assert.equal(f('event',{...calls[0],name:'click'}),false);assert.equal(f('event',{...calls[0],data:{prompt:'private'}}),false);assert.equal(f('event',{...calls[0],url:'/?session_id=private'}),false);});
 if(name==='prompt')test('prompt: scene identifiers collapsed',()=>{const {calls}=run({path:'/scene/12345'});assert.equal(calls[0].url,'/scene');assert.equal(calls[0].title,'Scene | Prompt Theater');assert.doesNotMatch(JSON.stringify(calls),/12345/);});
}
