import { BubbleState, DEFAULT_HOLD_SECONDS, refillBubbles } from '../core/physics.js';
import { FilmRenderer } from '../rendering/renderer.js';
import { PopAudio, BurstLayer } from '../audio/effects.js';
import { BUBBLE_COUNT, createBubbleLayout } from '../core/layout.js';
import { DeviceLighting } from '../rendering/lighting.js';
import { APP_CONFIG } from '../core/config.js';
import { advanceBrandAccent } from './brand-accent.js';

const $ = selector => document.querySelector(selector);
const markPointerInput=()=>{document.documentElement.dataset.inputModality='pointer';};
document.addEventListener('pointerdown',markPointerInput,{capture:true,passive:true});
document.addEventListener('touchstart',markPointerInput,{capture:true,passive:true});
document.addEventListener('keydown',()=>{document.documentElement.dataset.inputModality='keyboard';},{capture:true});
const storage = {
  get(key, fallback) { try { return localStorage.getItem('bubble.'+key) ?? fallback; } catch { return fallback; } },
  set(key,value) { try { localStorage.setItem('bubble.'+key,value); } catch { /* Private modes remain playable. */ } }
};
const savedHold=Number(storage.get('hold',String(DEFAULT_HOLD_SECONDS)));
const bubbles=Array.from({length:BUBBLE_COUNT},(_,i)=>new BubbleState(i,savedHold));
const audio=new PopAudio();
const effects=new BurstLayer($('#bursts'));
const playground=$('.playground');
const pointers=new Map();
const rawTouchEvents='ontouchstart' in window;
const activationTimers=new Map();
const keyboardOwners=new Map();
const reducedQuery=matchMedia('(prefers-reduced-motion: reduce)');
const burstPadding=APP_CONFIG.burstPadding;
let reduced=storage.get('motion',String(reducedQuery.matches))==='true';
let dark=storage.get('theme','dark')==='dark';
let diameter=Math.min(100,Math.max(64,Number(storage.get('size','84'))||84));
let layout=[],renderer,frame=0,lastTime=0,animateUntil=0,renderDirty=true,contextLost=false;
let poppedCount=0;
let light={x:0,y:0,angle:0}, lightTarget={x:0,y:0,angle:0};
let tiltWanted=storage.get('tilt','true')==='true',tiltStatus='idle';
const deviceLighting=new DeviceLighting({
  reduced,
  onChange:vector=>{lightTarget=vector;wake(APP_CONFIG.tiltWakeSeconds);},
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
// iOS provides native switch haptics only for trusted direct clicks. Keep
// these targets separate from the accessible hold buttons, and never .click()
// them from script. The native tick happens on release, not in the pop frame.
const nativeHaptics='switch' in document.createElement('input')&&matchMedia('(pointer: coarse)').matches;
const hapticTargets=nativeHaptics?buttons.map((_,i)=>{
  const input=document.createElement('input');
  input.type='checkbox';input.setAttribute('switch','');input.className='bubble-haptic';
  input.tabIndex=-1;input.setAttribute('aria-hidden','true');input.dataset.index=i;
  input.addEventListener('click',event=>{
    if(reduced||bubbles[i].refilling||hitBubble(event)!==i){event.preventDefault();return;}
    if(event.isTrusted)buttons[i].focus({preventScroll:true});
  });
  $('#targets').append(input);return input;
}):[];

function pulse(duration) {
  if(reduced||nativeHaptics||typeof navigator.vibrate!=='function')return;
  try { navigator.vibrate(duration); } catch { /* Haptics are optional. */ }
}

function wake(seconds=APP_CONFIG.wakeSeconds) {
  renderDirty=true;
  animateUntil=Math.max(animateUntil,performance.now()/1000+seconds);
  if(!frame&&!document.hidden&&!contextLost) {lastTime=performance.now()/1000;frame=requestAnimationFrame(tick);}
}
function updateBubbleButton(index) {
  const bubble=bubbles[index],button=buttons[index];
  button.dataset.popped=String(bubble.popped);
  if(bubble.refilling) {
    button.setAttribute('aria-busy','true');button.setAttribute('aria-disabled','true');
  } else {
    button.removeAttribute('aria-busy');button.removeAttribute('aria-disabled');
  }
  button.setAttribute('aria-label',bubble.refilling?`Пузырёк ${index+1} надувается`:
    bubble.popped?`Пузырёк ${index+1} лопнул. Можно помять плёнку`:
      `Пузырёк ${index+1}. Удерживай, чтобы лопнуть`);
  if(hapticTargets[index])hapticTargets[index].disabled=reduced||bubble.refilling;
}
function tick(ms) {
  frame=0;
  if(document.hidden||contextLost) return;
  const now=ms/1000,dt=Math.max(0,now-lastTime);lastTime=now;
  let active=false;
  for(let i=0;i<bubbles.length;i++) {
    const b=bubbles[i];
    const wasRefilling=b.refilling;
    if(b.step(dt,now)) {
      const p=layout[i];
      audio.pop();
      effects.burst(p.x+burstPadding,p.y+burstPadding,p.radius,{dark,reducedMotion:reduced});
      buttons[i].dataset.popped='true';
      buttons[i].setAttribute('aria-label',`Пузырёк ${i+1} лопнул. Можно помять плёнку`);
      poppedCount+=1;
      $('#announcement').textContent=`Хлоп! ${poppedCount} из ${bubbles.length} пузырьков лопнули.`;
      animateUntil=now+APP_CONFIG.popWakeSeconds;
      pulse(APP_CONFIG.hapticPopMilliseconds);
    }
    if(wasRefilling&&!b.refilling) {
      poppedCount-=1;updateBubbleButton(i);renderDirty=true;
      if(!bubbles.some(bubble=>bubble.refilling))$('#announcement').textContent='Плёнка готова. Можно лопать пузырьки.';
    }
    active ||= b.active||b.refilling;
  }
  const ease=1-Math.exp(-dt*8);
  light.x+=(lightTarget.x-light.x)*ease;light.y+=(lightTarget.y-light.y)*ease;
  light.angle+=(lightTarget.angle-light.angle)*ease;
  if(reduced) light={x:0,y:0,angle:0};
  if(renderer&&(renderDirty||active||now<animateUntil)) renderer.render(bubbles,layout,dark,now,light);
  renderDirty=false;
  const bursting=effects.render(now);
  if(active||bursting||now<animateUntil) frame=requestAnimationFrame(tick);
}
function cancelBubble(index) {
  for(const [pointerId,contact] of pointers) if(contact.index===index) releasePointer(pointerId);
  clearTimeout(activationTimers.get(index));activationTimers.delete(index);
  keyboardOwners.delete(index);bubbles[index].release();
}
function cancelAll() {
  bubbles.forEach((_,index)=>cancelBubble(index));
  for(const pointerId of pointers.keys())releasePointer(pointerId);
  wake();
}
function resize() {
  cancelAll();effects.clear();
  const geometry=createBubbleLayout(window.innerWidth,diameter);
  const fullViewport=matchMedia(`(max-width: ${APP_CONFIG.mobileBreakpoint}px)`).matches;
  const fieldPadding=fullViewport?0:APP_CONFIG.desktopFieldPadding;
  const width=fullViewport?window.innerWidth:geometry.width+fieldPadding*2;
  const height=fullViewport?window.innerHeight:geometry.height+fieldPadding*2;
  const offsetX=fullViewport?(width-geometry.width)/2:fieldPadding;
  const offsetY=fullViewport?(height-geometry.height)/2:fieldPadding;
  const actualDiameter=geometry.diameter;
  const stage=$('.playground');stage.style.width=width+'px';stage.style.height=height+'px';
  layout=geometry.layout.map(p=>({...p,x:p.x+offsetX,y:p.y+offsetY}));
  for(let i=0;i<buttons.length;i++) {
    const p=layout[i],button=buttons[i];
    Object.assign(button.style,{left:p.x-p.radius+'px',top:p.y-p.radius+'px',width:actualDiameter+'px',height:actualDiameter+'px'});
    if(hapticTargets[i])hapticTargets[i].style.cssText=button.style.cssText;
  }
  const dpr=Math.min(devicePixelRatio||1,APP_CONFIG.maximumDevicePixelRatio);
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
  storage.set('theme',dark?'dark':'light');wake(APP_CONFIG.themeWakeSeconds);
}
function coordinates(event,index) {
  const rect=$('.playground').getBoundingClientRect(),p=layout[index];
  return {x:(event.clientX-rect.left-p.x)/p.radius,y:(event.clientY-rect.top-p.y)/p.radius};
}
function hitBubble(event) {
  const rect=playground.getBoundingClientRect();
  const x=event.clientX-rect.left,y=event.clientY-rect.top;
  if(renderer?.layout===layout)return renderer.sheetState.hitIndex(x,y);
  // Before the first post-resize frame the new geometry has no hash yet.
  return layout.findIndex(p=>(x-p.x)*(x-p.x)+(y-p.y)*(y-p.y)<=p.radius*p.radius);
}
function releasePointer(pointerId) {
  const contact=pointers.get(pointerId);if(!contact)return;
  pointers.delete(pointerId);
  if(contact.index!==null)bubbles[contact.index].release();
  if(contact.capture?.hasPointerCapture(pointerId))contact.capture.releasePointerCapture(pointerId);
}
function movePointer(event) {
  const contact=pointers.get(event.pointerId);if(!contact)return;
  const index=hitBubble(event);
  if(contact.index!==index) {
    if(contact.index!==null)bubbles[contact.index].release();
    contact.index=null;
    if(index>=0) {
      const p=coordinates(event,index);
      if(bubbles[index].press(p.x,p.y,event.pressure,performance.now()/1000)) {
        contact.index=index;pulse(APP_CONFIG.hapticPressMilliseconds);
      }
    }
  } else if(index>=0) {
    const p=coordinates(event,index);bubbles[index].move(p.x,p.y,event.pressure);
  }
  wake();
}
playground.addEventListener('pointerdown',event=>{
  if((rawTouchEvents&&event.pointerType==='touch')||event.button!==0||pointers.has(event.pointerId))return;
  event.preventDefault();audio.unlock();
  // Capture the original target for the whole gesture, including empty film.
  // Coordinates choose the current pocket; event.target stays at the origin.
  const capture=event.target;
  pointers.set(event.pointerId,{index:null,capture});capture.setPointerCapture(event.pointerId);
  movePointer(event);
});
playground.addEventListener('pointermove',movePointer);
playground.addEventListener('pointerup',event=>{audio.unlock();releasePointer(event.pointerId);wake();});
playground.addEventListener('pointercancel',event=>{
  // Some mobile browsers dispatch pointercancel before touchcancel. Touch input
  // is keyed separately to avoid duplicate pointer and touch press handling.
  releasePointer(event.pointerType==='touch'?'touch:'+event.pointerId:event.pointerId);wake();
});
playground.addEventListener('lostpointercapture',event=>{releasePointer(event.pointerId);wake();});
buttons.forEach((button,i)=>{
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
    if(event.detail===0&&!bubbles[i].active){
      audio.unlock();if(!bubbles[i].press(0,0,.5,performance.now()/1000))return;wake();
      const timer=setTimeout(()=>{
        if(activationTimers.get(i)!==timer)return;
        bubbles[i].release();activationTimers.delete(i);wake();
      },(bubbles[i].popped?APP_CONFIG.assistivePoppedDurationSeconds:
        bubbles[i].holdDuration+APP_CONFIG.assistiveHoldGraceSeconds)*1000);
      activationTimers.set(i,timer);
    }
  });
});
document.addEventListener('touchstart',()=>audio.unlock(),{passive:true});
document.addEventListener('touchend',()=>audio.unlock(),{passive:true});
// Browsers may adjust pointer/click coordinates to a nearby control. Raw
// touches keep the actual finger location, and their target stays at the
// gesture origin even across gaps, so no per-pocket pointer capture is needed.
function touchPointer(touch) {
  return {pointerId:'touch:'+touch.identifier,clientX:touch.clientX,clientY:touch.clientY,pressure:touch.force||.5};
}
playground.addEventListener('touchstart',event=>{
  for(const touch of event.changedTouches) {
    const pointer=touchPointer(touch);
    pointers.set(pointer.pointerId,{index:null,capture:null});movePointer(pointer);
    // Cancel a browser-adjusted native switch before its default activation.
    const index=hitBubble(touch),target=touch.target.closest('.bubble-haptic');
    if(index<0||(target&&index!==Number(target.dataset.index)))event.preventDefault();
  }
},{passive:false});
playground.addEventListener('touchmove',event=>{
  event.preventDefault();
  for(const touch of event.changedTouches??[])movePointer(touchPointer(touch));
},{passive:false});
playground.addEventListener('touchend',event=>{
  for(const touch of event.changedTouches) {
    const pointer=touchPointer(touch),target=touch.target.closest('.bubble-haptic'),index=hitBubble(touch);
    if(index<0||(target&&(reduced||!pointers.has(pointer.pointerId)||index!==Number(target.dataset.index))))event.preventDefault();
    releasePointer(pointer.pointerId);
  }
  wake();
},{passive:false});
playground.addEventListener('touchcancel',event=>{
  if(event.cancelable)event.preventDefault();
  for(const touch of event.changedTouches)releasePointer(touchPointer(touch).pointerId);
  wake();
},{passive:false});
playground.addEventListener('gesturestart',event=>event.preventDefault());
playground.addEventListener('contextmenu',event=>event.preventDefault());
document.addEventListener('pointermove',event=>{
  if(event.pointerType==='touch'||reduced||deviceLighting.hasData)return;
  lightTarget={x:(event.clientX/innerWidth-.5)*APP_CONFIG.pointerLightShift,
    y:-(event.clientY/innerHeight-.5)*APP_CONFIG.pointerLightShift,angle:0};wake(APP_CONFIG.pointerLightWakeSeconds);
},{passive:true});
document.addEventListener('selectstart',event=>event.preventDefault());
document.addEventListener('dragstart',event=>event.preventDefault());
$('#theme').addEventListener('click',()=>{audio.unlock();dark=!dark;setTheme();});
$('#reset').addEventListener('click',()=>{
  audio.unlock();cancelAll();effects.clear();
  refillBubbles(bubbles,{reduced});
  poppedCount=bubbles.filter(b=>b.popped).length;
  hapticTargets.forEach(input=>{input.checked=false;});
  buttons.forEach((_,i)=>updateBubbleButton(i));
  advanceBrandAccent();
  $('#announcement').textContent=bubbles.some(b=>b.refilling)?'Пузырьки надуваются.':`Новая плёнка. ${bubbles.length} пузырьков.`;wake();
});
audio.setEnabled(storage.get('sound','true')==='true');
function updateSound(){ $('#sound').setAttribute('aria-pressed',String(audio.enabled));$('#sound').setAttribute('aria-label',audio.enabled?'Выключить звук':'Включить звук'); }
$('#sound').addEventListener('click',()=>{
  audio.setEnabled(!audio.enabled);if(audio.enabled)audio.unlock();
  storage.set('sound',String(audio.enabled));updateSound();
});
$('#size').value=diameter;
$('#size').addEventListener('input',event=>{diameter=Number(event.target.value);storage.set('size',diameter);resize();});
const holdFormat=new Intl.NumberFormat('ru-RU',{minimumFractionDigits:1,maximumFractionDigits:2});
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
  const controls=[...settings.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter(control=>control.getClientRects().length);
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
  // The switch reflects the saved choice; the status text reflects actual access.
  $('#tilt').checked=tiltWanted;
  $('#tilt').disabled=deviceLighting.pending;
  const status=deviceLighting.pending?'pending':tiltStatus;
  $('#tilt-permission').hidden=!tiltWanted||!['permission-required','denied'].includes(status);
  const messages={
    idle:'',pending:'Ждём разрешения на доступ к движению.',
    listening:'Немного наклони телефон, чтобы оживить блики.',granted:'Блики следуют за движением телефона.',
    denied:'Доступ к движению закрыт. Его можно разрешить в настройках браузера.',
    unavailable:'На этом устройстве наклон недоступен.',insecure:'Для наклона открой страницу через HTTPS.',
    'no-data':'Датчик пока не передаёт движение. Попробуй наклонить телефон.',
    'permission-required':'Настройка включена. Разреши браузеру доступ к движению.',
    reduced:'Наклон на паузе, пока включено «Меньше эффектов».',suspended:''
  };
  $('#tilt-status').textContent=tiltWanted?(messages[status]??''):'';
}
$('#tilt').addEventListener('change',event=>{
  tiltWanted=event.target.checked;
  storage.set('tilt',String(tiltWanted));
  if(tiltWanted) deviceLighting.enable({userGesture:true});
  else deviceLighting.disable();
  updateTilt();
});
$('#tilt-permission').addEventListener('click',()=>deviceLighting.enable({userGesture:true}));
$('#motion').checked=reduced;
function setReduced(value) {
  reduced=value;$('#motion').checked=reduced;document.documentElement.dataset.reduced=String(reduced);
  if(renderer)renderer.reducedMotion=reduced;
  const wasRefilling=bubbles.some(b=>b.refilling);
  if(reduced)for(const bubble of bubbles)if(bubble.refilling)bubble.reset();
  if(reduced&&wasRefilling)$('#announcement').textContent='Плёнка готова. Можно лопать пузырьки.';
  poppedCount=bubbles.filter(b=>b.popped).length;
  buttons.forEach((_,i)=>updateBubbleButton(i));
  light=lightTarget={x:0,y:0,angle:0};deviceLighting.setReduced(reduced);effects.clear();updateTilt();wake();
}
$('#motion').addEventListener('change',event=>{setReduced(event.target.checked);storage.set('motion',String(reduced));});
reducedQuery.addEventListener('change',event=>setReduced(event.matches));
window.addEventListener('resize',resize);
window.addEventListener('blur',cancelAll);
window.addEventListener('pagehide',cancelAll);
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
