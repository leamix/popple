import { BubbleState, DEFAULT_HOLD_SECONDS } from './physics.js';
import { FilmRenderer } from './renderer.js';
import { PopAudio, BurstLayer } from './effects.js';
import { BUBBLE_COUNT, createBubbleLayout } from './layout.js';
import { DeviceLighting } from './lighting.js';

const $ = selector => document.querySelector(selector);
const storage = {
  get(key, fallback) { try { return localStorage.getItem('bubble.'+key) ?? fallback; } catch { return fallback; } },
  set(key,value) { try { localStorage.setItem('bubble.'+key,value); } catch { /* Private modes remain playable. */ } }
};
const savedHold=Number(storage.get('hold',String(DEFAULT_HOLD_SECONDS)));
const bubbles=Array.from({length:BUBBLE_COUNT},(_,i)=>new BubbleState(i,savedHold));
const audio=new PopAudio();
const effects=new BurstLayer($('#bursts'));
const pointers=new Map();
const activationTimers=new Map();
const keyboardOwners=new Map();
const reducedQuery=matchMedia('(prefers-reduced-motion: reduce)');
const burstPadding=80;
let reduced=storage.get('motion',String(reducedQuery.matches))==='true';
let dark=storage.get('theme','dark')==='dark';
let diameter=Math.min(100,Math.max(64,Number(storage.get('size','84'))||84));
let layout=[],renderer,frame=0,lastTime=0,animateUntil=0,renderDirty=true,contextLost=false;
let light={x:0,y:0}, lightTarget={x:0,y:0};
let tiltWanted=storage.get('tilt','true')==='true',tiltStatus='idle';
const deviceLighting=new DeviceLighting({
  reduced,
  onChange:vector=>{lightTarget=vector;wake(.7);},
  onStatus:status=>{tiltStatus=status;updateTilt();}
});
const buttons=bubbles.map((bubble,i)=>{
  const button=document.createElement('button');
  button.className='bubble-target';button.type='button';button.dataset.index=i;
  button.setAttribute('aria-label',`Пузырёк ${i+1}. Удерживай, чтобы лопнуть`);
  button.setAttribute('aria-keyshortcuts','Space Enter');
  button.dataset.popped='false';
  $('#targets').append(button);
  return button;
});

function wake(seconds=.9) {
  renderDirty=true;
  animateUntil=Math.max(animateUntil,performance.now()/1000+seconds);
  if(!frame&&!document.hidden&&!contextLost) {lastTime=performance.now()/1000;frame=requestAnimationFrame(tick);}
}
function tick(ms) {
  frame=0;
  if(document.hidden||contextLost) return;
  const now=ms/1000,dt=Math.min(.1,Math.max(0,now-lastTime));lastTime=now;
  let active=false;
  for(let i=0;i<bubbles.length;i++) {
    const b=bubbles[i];
    if(b.step(dt,now)) {
      const p=layout[i];
      audio.pop();
      effects.burst(p.x+burstPadding,p.y+burstPadding,p.radius,{dark,reducedMotion:reduced});
      buttons[i].dataset.popped='true';
      buttons[i].setAttribute('aria-label',`Пузырёк ${i+1} лопнул`);
      buttons[i].setAttribute('aria-disabled','true');
      const count=bubbles.filter(b=>b.popped).length;
      $('#announcement').textContent=`Хлоп! ${count} из ${bubbles.length} пузырьков лопнули.`;
      $('#caption').textContent=count===bubbles.length?'Вся плёнка твоя. Возьмём ещё?':'Вот и всё. Можно ещё один.';
      animateUntil=now+1.1;
      if(navigator.vibrate&&!reduced) navigator.vibrate(12);
    }
    active ||= b.active;
  }
  const ease=1-Math.exp(-dt*8);
  light.x+=(lightTarget.x-light.x)*ease;light.y+=(lightTarget.y-light.y)*ease;
  if(reduced) light={x:0,y:0};
  if(renderer&&(renderDirty||active||now<animateUntil)) renderer.render(bubbles,layout,dark,now,light);
  renderDirty=false;
  const bursting=effects.render(now);
  if(active||bursting||now<animateUntil) frame=requestAnimationFrame(tick);
}
function cancelBubble(index) {
  for(const [pointerId,owner] of pointers) if(owner===index) {
    pointers.delete(pointerId);
    if(buttons[index].hasPointerCapture(pointerId)) buttons[index].releasePointerCapture(pointerId);
  }
  clearTimeout(activationTimers.get(index));activationTimers.delete(index);
  keyboardOwners.delete(index);bubbles[index].release();
}
function cancelAll() {
  bubbles.forEach((_,index)=>cancelBubble(index));
  wake();
}
function resize() {
  cancelAll();effects.clear();
  const geometry=createBubbleLayout(window.innerWidth,diameter);
  const {width,height,diameter:actualDiameter}=geometry;
  const stage=$('.playground');stage.style.width=width+'px';stage.style.height=height+'px';
  layout=geometry.layout;
  for(let i=0;i<buttons.length;i++) {
    const p=layout[i],button=buttons[i];
    Object.assign(button.style,{left:p.x-p.radius+'px',top:p.y-p.radius+'px',width:actualDiameter+'px',height:actualDiameter+'px'});
  }
  const dpr=Math.min(devicePixelRatio||1,2.5);
  renderer?.resize(width,height,dpr);
  effects.resize(width+burstPadding*2,height+burstPadding*2,dpr);
  $('#size-value').textContent=diameter===84?'≈ 2 см':Math.round(diameter/84*100)+'%';
  wake();
}
function setTheme() {
  document.documentElement.dataset.theme=dark?'dark':'light';
  $('#theme').setAttribute('aria-label',dark?'Включить светлую тему':'Включить тёмную тему');
  $('#theme .t-icon-swap').dataset.state=dark?'a':'b';
  $('meta[name="theme-color"]').content=dark?'#080b0e':'#dcebf4';
  storage.set('theme',dark?'dark':'light');wake(.4);
}
function coordinates(event,index) {
  const rect=$('.playground').getBoundingClientRect(),p=layout[index];
  return {x:(event.clientX-rect.left-p.x)/p.radius,y:(event.clientY-rect.top-p.y)/p.radius};
}
buttons.forEach((button,i)=>{
  button.addEventListener('contextmenu',event=>event.preventDefault());
  button.addEventListener('pointerdown',event=>{
    if(event.button!==0||bubbles[i].popped||bubbles[i].active) return;
    event.preventDefault();audio.unlock();
    const p=coordinates(event,i);
    if(Math.hypot(p.x,p.y)>1.08)return;
    pointers.set(event.pointerId,i);button.setPointerCapture(event.pointerId);
    bubbles[i].press(p.x,p.y,event.pressure,performance.now()/1000);wake();
  });
  button.addEventListener('pointermove',event=>{
    if(pointers.get(event.pointerId)!==i)return;
    const p=coordinates(event,i);
    if(Math.hypot(p.x,p.y)>1.35) {
      cancelBubble(i);wake();return;
    }
    bubbles[i].move(p.x,p.y,event.pressure);wake();
  });
  const release=event=>{
    if(pointers.get(event.pointerId)!==i)return;
    pointers.delete(event.pointerId);bubbles[i].release();wake();
  };
  button.addEventListener('pointerup',event=>{audio.unlock();release(event);});
  button.addEventListener('pointercancel',release);button.addEventListener('lostpointercapture',release);
  button.addEventListener('keydown',event=>{
    if(![' ','Enter'].includes(event.key))return;
    event.preventDefault();if(event.repeat)return;
    audio.unlock();if(bubbles[i].press(0,0,.5,performance.now()/1000)) keyboardOwners.set(i,event.key);wake();
  });
  button.addEventListener('keyup',event=>{
    if([' ','Enter'].includes(event.key)){
      event.preventDefault();if(keyboardOwners.get(i)!==event.key)return;
      keyboardOwners.delete(i);bubbles[i].release();wake();
    }
  });
  button.addEventListener('blur',()=>{cancelBubble(i);wake();});
  // Assistive-technology activation has no physical key/pointer hold.
  button.addEventListener('click',event=>{
    if(event.detail===0&&!bubbles[i].active&&!bubbles[i].popped){
      audio.unlock();bubbles[i].press(0,0,.5,performance.now()/1000);wake();
      const timer=setTimeout(()=>{
        if(activationTimers.get(i)!==timer)return;
        bubbles[i].release();activationTimers.delete(i);wake();
      },(bubbles[i].holdDuration+.2)*1000);
      activationTimers.set(i,timer);
    }
  });
});
document.addEventListener('touchstart',()=>audio.unlock(),{passive:true});
document.addEventListener('touchend',()=>audio.unlock(),{passive:true});
document.addEventListener('pointermove',event=>{
  if(event.pointerType==='touch'||reduced||deviceLighting.hasData)return;
  lightTarget={x:(event.clientX/innerWidth-.5)*.055,y:-(event.clientY/innerHeight-.5)*.055};wake(.55);
},{passive:true});
$('#theme').addEventListener('click',()=>{audio.unlock();dark=!dark;setTheme();});
$('#reset').addEventListener('click',()=>{
  audio.unlock();cancelAll();effects.clear();
  bubbles.forEach(b=>{b.reset();b.seed=Math.random();});
  buttons.forEach((button,i)=>{button.dataset.popped='false';button.removeAttribute('aria-disabled');button.setAttribute('aria-label',`Пузырёк ${i+1}. Удерживай, чтобы лопнуть`);});
  $('#caption').textContent='Свежая плёнка. Весь день впереди.';
  $('#announcement').textContent=`Новая плёнка. ${bubbles.length} пузырьков.`;wake();
});
audio.setEnabled(storage.get('sound','true')==='true');
function updateSound(){ $('#sound').setAttribute('aria-pressed',String(audio.enabled));$('#sound').setAttribute('aria-label',audio.enabled?'Выключить звук':'Включить звук'); }
$('#sound').addEventListener('click',()=>{
  audio.setEnabled(!audio.enabled);if(audio.enabled)audio.unlock();
  storage.set('sound',String(audio.enabled));updateSound();
});
$('#size').value=diameter;
$('#size').addEventListener('input',event=>{diameter=Number(event.target.value);storage.set('size',diameter);resize();});
const holdFormat=new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
function updateHold() {
  const duration=bubbles[0].holdDuration;
  $('#hold').value=duration;
  $('#hold-value').textContent=holdFormat.format(duration)+' с';
  $('#hold').setAttribute('aria-valuetext',holdFormat.format(duration)+' секунды');
}
$('#hold').addEventListener('input',event=>{
  cancelAll();bubbles.forEach(b=>b.setHoldDuration(Number(event.target.value)));
  storage.set('hold',bubbles[0].holdDuration);updateHold();
});
const settings=$('#settings');
$('#settings-open').addEventListener('click',()=>{
  cancelAll();settings.showModal();document.body.classList.add('settings-open');
});
$('#settings-close').addEventListener('click',()=>settings.close());
settings.addEventListener('keydown',event=>{
  if(event.key!=='Tab')return;
  const controls=[...settings.querySelectorAll('button:not(:disabled),input:not(:disabled)')];
  const first=controls[0],last=controls.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
});
let backdropPress=false;
settings.addEventListener('pointerdown',event=>{
  const rect=settings.getBoundingClientRect();
  backdropPress=event.target===settings&&(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom);
});
settings.addEventListener('pointerup',event=>{
  const rect=settings.getBoundingClientRect();
  if(backdropPress&&event.target===settings&&(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)) settings.close();
  backdropPress=false;
});
settings.addEventListener('close',()=>{
  document.body.classList.remove('settings-open');backdropPress=false;
  $('#settings-open').focus({preventScroll:true});
});
function updateTilt() {
  const enabled=['pending','listening','granted','no-data'].includes(tiltStatus);
  $('#tilt').setAttribute('aria-pressed',String(enabled));
  $('#tilt').disabled=reduced||tiltStatus==='pending';
  $('#tilt').textContent=enabled?'Выключить':'Включить';
  const messages={
    idle:'',pending:'Ждём разрешения на доступ к движению.',
    listening:'Немного наклони телефон, чтобы оживить блики.',granted:'Блики следуют за движением телефона.',
    denied:'Доступ к движению закрыт. Его можно разрешить в настройках браузера.',
    unavailable:'На этом устройстве наклон недоступен.',insecure:'Для наклона открой страницу через HTTPS.',
    'no-data':'Датчик пока не передаёт движение. Попробуй наклонить телефон.',
    'permission-required':'Нажми «Включить» и разреши доступ к движению.',
    reduced:'Наклон отключён, пока включено «Меньше эффектов».',suspended:''
  };
  $('#tilt-status').textContent=messages[tiltStatus]??'';
}
$('#tilt').addEventListener('click',()=>{
  if(['listening','granted','no-data'].includes(tiltStatus)) {
    tiltWanted=false;deviceLighting.disable();
  }else{
    tiltWanted=true;deviceLighting.enable({userGesture:true});
  }
  storage.set('tilt',String(tiltWanted));
});
$('#motion').checked=reduced;
function setReduced(value) {
  reduced=value;$('#motion').checked=reduced;document.documentElement.dataset.reduced=String(reduced);
  light=lightTarget={x:0,y:0};deviceLighting.setReduced(reduced);effects.clear();updateTilt();wake();
}
$('#motion').addEventListener('change',event=>{setReduced(event.target.checked);storage.set('motion',String(reduced));});
reducedQuery.addEventListener('change',event=>setReduced(event.matches));
window.addEventListener('resize',resize);
window.addEventListener('blur',cancelAll);
document.addEventListener('visibilitychange',()=>{
  cancelAll();if(document.hidden){cancelAnimationFrame(frame);frame=0;}else wake();
});
$('#film').addEventListener('webglcontextlost',event=>{event.preventDefault();cancelAll();contextLost=true;deviceLighting.setSuspended(true);cancelAnimationFrame(frame);frame=0;});
$('#film').addEventListener('webglcontextrestored',()=>{contextLost=false;deviceLighting.setSuspended(false);renderer.initialize();resize();});
try { renderer=new FilmRenderer($('#film')); } catch(error) {
  console.error(error);$('#render-error').hidden=false;$('#targets').hidden=true;
}
updateSound();updateHold();setReduced(reduced);setTheme();resize();
if(tiltWanted) deviceLighting.enable();
