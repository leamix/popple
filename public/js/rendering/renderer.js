// Analytic elastic membrane. Surface slopes drive the reflected studio lights;
// the same height field provides the finger dent and the collapsed creases.
import { makeMembrane } from '../core/membrane.js';
import { MAX_SHEET_SITES, SheetState } from '../core/sheet.js';
import { BubbleBatch } from './bubble-batch.js';
import { SheetBatch } from './sheet-batch.js';
const vertex = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() { v_uv = a_position; gl_Position = vec4(a_position,0.,1.); }
`;
const batchVertex = `
attribute vec2 a_position;
attribute vec4 a_rect, a_state;
attribute vec3 a_touchRadius;
attribute vec2 a_link;
attribute float a_record;
uniform vec2 u_framebuffer;
varying vec2 v_uv;
varying vec4 v_state;
varying vec3 v_touchRadius;
varying vec2 v_link;
varying float v_record;
void main() {
  v_uv=a_position;v_state=a_state;v_touchRadius=a_touchRadius;
  v_link=a_link;v_record=a_record;
  // Reproduce each original integer viewport inside one common framebuffer.
  // This keeps subpixel placement identical, including fractional screen DPR.
  vec2 pixel=a_rect.xy+(a_position*.5+.5)*a_rect.zw;
  gl_Position=vec4(pixel/u_framebuffer*2.-1.,0.,1.);
}
`;
const sheetBatchVertex = `
attribute vec2 a_position, a_tile;
uniform vec2 u_framebuffer;
varying vec2 v_uv, v_tile;
void main() {
  vec2 clip=a_position/u_framebuffer*2.-1.;
  v_uv=clip;v_tile=a_tile;
  gl_Position=vec4(clip,0.,1.);
}
`;
const fragment = `
precision highp float;
varying vec2 v_uv;
uniform float u_dark, u_time, u_light_angle;
uniform vec2 u_light, u_resolution, u_origin;
#ifdef BATCH_PASS
varying vec4 v_state;
varying vec3 v_touchRadius;
varying vec2 v_link;
varying float v_record;
#define u_seed v_state.x
#define u_compression v_state.y
#define u_collapse v_state.z
#define u_bulge v_state.w
#define u_touch v_touchRadius.xy
#define u_radius v_touchRadius.z
#define u_link vec4(v_link,0.,0.)
uniform highp sampler2D u_membranes;
uniform float u_membrane_rows;
vec4 u_folds[5], u_foldProfile[5], u_pockets[3], u_dent;
float u_air;
vec4 membraneTexel(float column) {
  return texture2D(u_membranes,vec2((column+.5)/15.,v_record/u_membrane_rows));
}
void loadMembrane() {
  u_air=membraneTexel(0.).x;u_dent=membraneTexel(1.);
  for(int i=0;i<5;i++) {
    u_folds[i]=membraneTexel(2.+float(i));
    u_foldProfile[i]=membraneTexel(7.+float(i));
  }
  for(int i=0;i<3;i++) u_pockets[i]=membraneTexel(12.+float(i));
}
#else
uniform float u_seed, u_compression, u_collapse, u_bulge, u_radius;
uniform vec2 u_touch;
uniform vec4 u_link;
uniform vec4 u_folds[5], u_foldProfile[5], u_pockets[3], u_dent;
uniform float u_air;
#endif
// A tile only sees local pockets; shader size never depends on sheet count.
#ifdef SHEET_BATCH_PASS
varying vec2 v_tile;
uniform highp sampler2D u_sheet_sites, u_sheet_links;
uniform float u_sheet_rows;
#define u_site_count int(v_tile.y+.5)
#else
uniform vec4 u_sites[${MAX_SHEET_SITES}], u_links[${MAX_SHEET_SITES}];
uniform int u_site_count;
#endif
const float PI = 3.14159265359;
float sq(float x) { return x*x; }
float angleOf(vec2 v) { return dot(v,v)<.00000001?0.:atan(v.y,v.x); }
vec2 turn(vec2 v, float angle) {
  float c=cos(angle), s=sin(angle);
  return vec2(c*v.x-s*v.y,s*v.x+c*v.y);
}
float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7))+u_seed*81.17)*43758.5453); }
float noise(vec2 p) {
  vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);
}
vec2 shape(vec2 p) {
  float a=angleOf(p);
  float irregular=1.+.018*sin(3.*a+u_seed*6.)+.012*sin(5.*a+u_seed*8.)+.006*sin(9.*a+u_seed*13.);
  // The footprint expands a little as air is displaced away from the contact.
  vec2 shift=-u_touch*u_bulge*.065;
  // A vented pocket has no pressure to spread its sealed footprint further.
  float expansion=mix(u_compression,.06,clamp(u_collapse,0.,1.));
  vec2 oval=vec2(1.+.025*sin(u_seed*13.),1.+.035*cos(u_seed*11.));
  return (p-shift)/(oval*irregular*(1.+expansion*.055));
}
float heightAt(vec2 p) {
  vec2 q=shape(p);
  float r=length(q), a=angleOf(q), c=clamp(u_collapse,0.,1.);
  float edge=1.-smoothstep(.88,1.015,r);
  float dome=0.;
  // Once venting is complete the dome contribution is exactly zero. Avoid
  // evaluating its trigonometry/exponentials five times for every slack pixel.
  if(c<1.) {
    dome=(.48+u_seed*.09)*pow(max(0.,1.-r*r),.58+u_seed*.07);
    // An intact pocket stays taut. Gentle molding variation changes its broad
    // highlight, while visible hinges belong exclusively to the vented skin.
    vec2 stretch=turn(q,u_seed*5.7);
    float slackLine=stretch.y-(u_seed-.5)*.45-(.10+u_seed*.26)*stretch.x*stretch.x;
    float slack=exp(-sq(slackLine/(.14+u_seed*.09)));
    float slackFade=smoothstep(.12,.38,r)*(1.-smoothstep(.75,.99,r));
    dome+=(slack-.38*exp(-sq((slackLine+.14)/.27)))*(.006+u_seed*.006)*slackFade;
    dome+=(.005*sin(q.x*5.3+u_seed*15.)*sin(q.y*4.4-u_seed*9.)+.007*dot(q,turn(vec2(1.,0.),u_seed*8.)))*edge;
    float dist=length(q-u_touch*.67);
    float dent=exp(-dist*dist/ (.17+.09*u_compression));
    float opposite=exp(-dot(q+u_touch*.55,q+u_touch*.55)/.28);
    dome += u_compression*(-.53*dent+.07*opposite)*edge;
    dome += u_bulge*.22*opposite*edge;
    // Neighbour tension tilts a small patch of the cap without depressing it
    // like a second finger or changing the original pocket's hold state.
    dome += dot(q,u_link.xy*vec2(1.,-1.))*.11*edge;
    // Fine, taut stretch marks are confined to the heat-sealed shoulder.
    dome += .003*sin(a*31.+3.*sin(a*7.+u_seed)+r*15.+u_seed)*smoothstep(.88,.97,r)*edge;
    dome += .0005*sin(q.x*24.+q.y*11.+u_seed)*sin(q.y*19.-q.x*5.)*edge;
  }
  float collapsedHeight=0.;
  if(c>.001) {
    // Venting removes pressure support, not the film's molded volume. The
    // contact dent and freer opposite lobe remain in a varied, slack skin.
    float knead=clamp(u_compression-.06,0.,.18);
    vec2 contact=u_touch*.67;
    float contactFalloff=exp(-dot(q-contact,q-contact)/.115);
    float fixedRim=1.-smoothstep(.72,.99,r);
    // Slack folds slide a little under the pad of the finger. The displacement
    // fades into the welded rim and never restores the popped pocket's dome.
    vec2 drag=contact-u_dent.xy;
    drag*=min(1.,.5/max(length(drag),.0001));
    vec2 slack=q-drag*knead*.22*contactFalloff*fixedRim;
    collapsedHeight=u_air*pow(max(0.,1.-r*r),.78);
    vec2 dip=slack-u_dent.xy;
    collapsedHeight-=u_dent.z*exp(-dot(dip,dip)/u_dent.w);
    for(int i=0;i<3;i++) {
      vec2 v=slack-u_pockets[i].xy;
      collapsedHeight+=u_pockets[i].z*exp(-dot(v,v)/u_pockets[i].w);
    }
    for(int i=0;i<5;i++) {
      vec4 fold=u_folds[i], profile=u_foldProfile[i];
      float along=dot(slack,fold.xy);
      float across=dot(slack,vec2(-fold.y,fold.x));
      float line=across-fold.z-profile.y*along*along;
      float taper=smoothstep(-.96,-.55,along)*(1.-smoothstep(profile.z,.98,along));
      // A rounded ridge and adjacent concave valley bend reflections smoothly.
      // Planar shoulders would turn the slack film into broad, rigid stripes.
      float ridge=exp(-sq(line/fold.w));
      float valley=exp(-sq((line+fold.w*1.7)/(fold.w*2.2)));
      collapsedHeight+=(ridge-valley*.42)*profile.x*taper*(1.-knead*1.6*contactFalloff);
    }
    // Supported film stops against the backing; pressing cannot push it through.
    float supportedHeight=min(collapsedHeight,.012);
    collapsedHeight=max(supportedHeight,collapsedHeight-knead*.50*contactFalloff*fixedRim);
    collapsedHeight*=edge;
  }
  float h=mix(dome,collapsedHeight,c);
  // A low welded seam stays intact after the air has escaped.
  h+=(.0065+u_seed*.002)*exp(-sq((r-1.025)/(.017+u_seed*.006)))*(1.-c*.3);
  return h;
}
float box(vec2 p, vec2 halfSize, float softness) {
  vec2 d=abs(p)-halfSize;
  return 1.-smoothstep(-softness,softness,max(d.x,d.y));
}
vec2 lightCoordinates(vec3 r) {
  vec3 l=normalize(vec3(-.55,.72,.42));
  vec3 axis=normalize(cross(vec3(0.,1.,0.),l));
  vec3 up=cross(l,axis);
  return vec2(atan(dot(r,axis),dot(r,l)),atan(dot(r,up),dot(r,l)))+u_light;
}
vec2 keyDirection() {
  // Reconstruct the centre of the same window sampled by highlightMasks().
  // The far-side return and transmitted light therefore follow tilt and yaw,
  // rather than being painted permanently along the bottom of every pocket.
  vec3 l=normalize(vec3(-.55,.72,.42));
  vec3 axis=normalize(cross(vec3(0.,1.,0.),l)), up=cross(l,axis);
  vec2 source=vec2(-.17,.006)-u_light;
  vec3 ray=normalize(l+axis*tan(source.x)+up*tan(source.y));
  return normalize(turn(ray.xy,u_light_angle));
}
// A broad luminous lobe occupies the brightest region of the reflected window.
// Small contour variations belong to that source; the membrane's curved normals
// then bend the entire lobe together with the surrounding softer reflection.
vec2 highlightMasks(vec2 uv, float roughness) {
  vec2 local=uv-vec2(-.17,.006);
  local.y+=.012*sin(local.x*7.-.4)+.004*sin(local.x*16.+.8);
  vec2 scaled=local/vec2(.58,.22);
  float angle=angleOf(scaled);
  float contour=1.+.035*sin(angle*3.+.6)+.020*sin(angle*5.-.4);
  float distance=length(scaled)/contour;
  float core=1.-smoothstep(.80,1.05+roughness*.06,distance);
  // Convert the curved contour's distance back into source-angle space, so
  // the fringe has similar optical width around this one upper boundary.
  vec2 direction=scaled/max(length(scaled),.0001);
  float borderDistance=(distance-1.00)/max(length(direction/vec2(.58,.22)),.0001);
  float arc=smoothstep(.08,.45,direction.y)*(1.-smoothstep(.80,.98,abs(direction.x)));
  // Keep this soft coloured seam visible at normal phone size, around one CSS pixel.
  float fringeWidth=max(.022+roughness*.025,1.5/u_radius);
  float fringe=exp(-sq(borderDistance/fringeWidth))*arc;
  return vec2(core,fringe);
}
vec3 environment(vec3 r, float roughness) {
  vec2 uv=lightCoordinates(r);
  float key=box(uv,vec2(.73,.19),.035+roughness*.19);
  float inner=box(uv+vec2(.014,.012),vec2(.66,.143),.028+roughness*.16);
  float split=1.-.10*exp(-sq((uv.x+.12)/.012));
  vec3 side=normalize(vec3(.85,-.3,.12));
  vec3 sx=normalize(cross(vec3(0.,1.,0.),side)), sy=cross(side,sx);
  vec2 suv=vec2(atan(dot(r,sx),dot(r,side)),atan(dot(r,sy),dot(r,side)));
  // The side source has a soft cross-section and gradually narrowing ends.
  // Its reflection follows the membrane rather than reading as a drawn arc.
  vec2 sideUV=suv+u_light;
  float endFade=exp(-sq(sq(sideUV.y/(.47+roughness*.20))));
  float sideWidth=.025+.042*sqrt(endFade)+roughness*.10;
  float rim=exp(-sq(sideUV.x/sideWidth))*endFade;
  float rimBloom=exp(-sq(sideUV.x/(sideWidth+.028+roughness*.10)))*endFade*.10;
  float bottom=pow(max(0.,dot(r,normalize(vec3(-.5,-.8,.1)))),45.);
  float broad=pow(max(0.,dot(r,normalize(vec3(-.6,.8,1.)))),3.);
  // Large diffuse room reflections give the plastic silver shoulders, while
  // the directional sources retain a crisp white centre and a narrower glint.
  float room=pow(max(0.,dot(r,normalize(vec3(-.4,.35,.88)))),2.4);
  float fill=pow(max(0.,dot(r,normalize(vec3(.6,-.2,.65)))),5.);
  vec3 env=vec3(.12,.14,.16)*broad+vec3(.045,.052,.060)*room;
  env+=vec3(.085,.095,.10)*fill;
  env+=vec3(.94,.98,1.)*(key*.8+inner*2.4)*split;
  env+=vec3(1.,.95,.85)*(rim*1.6+rimBloom);
  env+=vec3(.65,.83,1.)*bottom*.5;
  // Preserve tonal detail in the larger daylight reflection. The brightest
  // lobe is added after tone mapping; the whole window should not clip white.
  float core=box(uv,vec2(.69,.145),.012+roughness*.12);
  float bloom=box(uv,vec2(.71,.16),.075+roughness*.17);
  float glint=box(suv+u_light+vec2(.01,.10),vec2(.045,.16),.014+roughness*.11);
  float glintBloom=box(suv+u_light+vec2(.01,.10),vec2(.052,.17),.065+roughness*.14);
  float sourceGradient=.70+.30*exp(-sq((uv.x+.20)/.58)-sq(uv.y/.26));
  vec3 daylight=vec3(core*1.35*sourceGradient+bloom*.10+glint*1.65+glintBloom*.04+broad*.015);
  return mix(daylight,env,u_dark);
}
float sheetMask(vec2 pixel) {
  // The connected film continues past the viewport. Clipping happens only at
  // the browser edge, never in a smaller rounded rectangle inside the scene.
  return 1.;
}
vec2 transmittedPool(vec2 q, vec2 exitDirection, float collapse, float identity) {
  float along=dot(q,exitDirection), across=dot(q,vec2(-exitDirection.y,exitDirection.x));
  float jitter=.035*sin(identity*2.4);
  // Filled light pools start at the contact itself and spread across the sheet.
  // Their broad tails are not restricted to an annulus or the pocket viewport.
  float core=exp(-sq((along-1.02+.08*across*across)/.18)-sq((across-jitter)/.52));
  float spread=exp(-sq((along-1.12)/mix(.55,.48,u_dark))-sq((across-jitter*.5)/mix(.82,.72,u_dark)));
  float light=core*mix(.30,.18,u_dark)+spread*mix(.50,.13,u_dark);
  // An offset, wider shadow supports the pocket beside the illuminated patch;
  // putting a dark stripe through its centre would cancel light on pale backing.
  float shade=exp(-sq((along-.98)/.30)-sq((across+.56)/.50))*mix(.12,.07,u_dark);
  return vec2(light,shade)*(1.-collapse*.55);
}
vec2 bridgeCrease(vec2 p, vec2 axis, float offset, float bend) {
  // Two very shallow curved pinches in the common backing. Their derivative
  // bends the existing reflection instead of painting opaque lines on plastic.
  vec2 across=vec2(-axis.y,axis.x);
  float along=dot(p,axis),line=dot(p,across)-offset-bend*along*along;
  float taper=exp(-sq(sq(along/1.7)));
  float gradient=-2.*line/(.032*.032)*exp(-sq(line/.032))*.0012*taper;
  return (across-axis*(2.*bend*along))*gradient;
}
void drawSheet() {
  vec2 pixel=(v_uv*vec2(.5,-.5)+.5)*u_resolution;
  // Coordinates follow the pocket scale rather than the viewport aspect ratio.
  // The connected skin has wide slack undulations, not drawn diagonal stripes.
  vec2 p=(pixel-u_resolution*.5)*vec2(1.,-1.)/(u_radius*2.4);
  vec2 k1=vec2(.95,1.36), k2=vec2(2.7,-1.15), k3=vec2(-1.7,4.1);
  float phase1=dot(p,k1)+.38*sin(dot(p,k2)*.53);
  vec2 slope=k1*.19*cos(phase1);
  slope+=k2*.095*cos(dot(p,k2)+.7);
  slope+=k3*.021*cos(dot(p,k3)+1.8);
  vec2 k4=vec2(7.1,9.7);
  slope+=k4*.006*cos(dot(p,k4)+.65*sin(dot(p,k2)));
  slope+=bridgeCrease(p,vec2(.8,.6),.42,.14);
  slope+=bridgeCrease(p,vec2(-.6,.8),-.68,-.11);
  float exposed=1.,contact=0.,castShadow=0.,bounce=0.,nearFilm=0.,pool=0.,poolShade=0.;
  vec2 exitDirection=-keyDirection();
  for(int i=0;i<${MAX_SHEET_SITES};i++) {
    if(i>=u_site_count) break;
#ifdef SHEET_BATCH_PASS
    vec2 sheetUV=vec2((float(i)+.5)/${MAX_SHEET_SITES}.,v_tile.x/u_sheet_rows);
    vec4 site=texture2D(u_sheet_sites,sheetUV);
    vec4 link=texture2D(u_sheet_links,sheetUV);
#else
    vec4 site=u_sites[i];
    vec4 link=u_links[i];
#endif
    vec2 q=((pixel-site.xy)/site.z-link.xy)*vec2(1.,-1.);
    float distance=length(q), c=link.w;
    if(distance>=3.) continue;
    vec2 direction=q/max(distance,.0001);
    float sealRadius=1.085+.007*sin(angleOf(q)*5.+site.w*2.3);
    float sealWidth=max(.020,1./u_radius);
    float gutter=exp(-sq((distance-sealRadius)/sealWidth));
    float shoulder=exp(-sq((distance-1.18)/.20));
    nearFilm=max(nearFilm,exp(-sq((distance-1.15)/.55)));
    float irregular=.65+.35*sin(angleOf(q)*3.+site.w*2.3);
    // Raised welds and sagging bridges share the same light as the domes.
    slope+=direction*shoulder*.18*irregular;
    // Uneven, low double-layer welds catch a thin highlight and a tiny trough.
    // No colour is added: thickness reads only through its local surface slope.
    slope+=direction*gutter*.025*irregular;
    // The contact pulls the welded shoulder and adjoining bridges. The same
    // local field relights neighbours; rupture adds one small settling pulse.
    float bridge=exp(-sq((distance-1.30)/.42));
    slope+=direction*bridge*link.z*.085;
    slope+=link.xy*vec2(1.,-1.)*bridge*1.4;
    contact=max(contact,gutter*(.65+.35*max(0.,-direction.y)));
    vec2 shadowOffset=turn(vec2(.065,-.10),u_light_angle);
    float shadowDistance=length(q-shadowOffset);
    float shadowSide=.25+.75*max(0.,dot(direction,normalize(shadowOffset)));
    castShadow=max(castShadow,exp(-sq((shadowDistance-1.07)/.14))*shadowSide*(1.-c*.52));
    bounce=max(bounce,shoulder*pow(max(0.,dot(direction,exitDirection)),5.)*irregular);
    if(distance<3.) {
      vec2 transmitted=transmittedPool(q,exitDirection,c,site.w);
      // Overlapping patches stay local instead of adding an opaque white haze.
      pool=max(pool,transmitted.x);poolShade=max(poolShade,transmitted.y);
    }
    exposed*=smoothstep(.995,1.025,distance);
  }
  vec3 normal=normalize(vec3(-slope,1.));
  vec3 reflected=reflect(vec3(0.,0.,-1.),normal);
  reflected.xy=turn(reflected.xy,-u_light_angle);
  vec3 env=environment(reflected,.12);
  // A wide overhead window catches the shallow film. Its angular boundary
  // naturally breaks into softer pools and crisp slivers as the skin slopes.
  vec2 uv=reflected.xy/max(.30,reflected.z)+u_light;
  float window=box(turn(uv-vec2(-.30,.36),-.42),vec2(.48,.22),.20);
  float windowCore=box(turn(uv-vec2(-.30,.36),-.42),vec2(.43,.16),.028);
  float texture=.80+.20*noise(p*vec2(6.,9.));
  vec3 spec=(env/(1.+env))*mix(.035,.065,u_dark);
  spec+=vec3(.88,.94,1.)*(window*.012+windowCore*mix(.08,.045,u_dark))*texture;
  spec+=vec3(.78,.88,1.)*bounce*mix(.045,.22,u_dark);
  spec+=vec3(pool);
  spec=(1.-exp(-spec*1.35))*exposed*(.25+.75*nearFilm);
  float darkReflection=box(uv+vec2(.42,-.15),vec2(.22,.65),.19)*.025;
  float shadow=(contact*mix(.05,.11,u_dark)+castShadow*mix(.030,.08,u_dark)+darkReflection+poolShade)*exposed;
  float specMax=max(spec.r,max(spec.g,spec.b));
  float alpha=specMax+shadow*(1.-specMax);
  vec3 shadowTint=mix(vec3(.24,.26,.32),vec3(.009,.014,.019),u_dark);
  vec3 premul=spec+shadowTint*shadow*(1.-specMax);
  gl_FragColor=vec4(min(premul,vec3(alpha)),alpha);
}
void main() {
#ifdef SHEET_PASS
  drawSheet();
#else
  vec2 p=v_uv*1.38-u_link.xy*vec2(1.,-1.);
  vec2 q=shape(p); float r=length(q);
  vec2 direction=q/max(r,.00001);
  if(r>1.30) discard;
  float c=clamp(u_collapse,0.,1.);
  float eps=.0032;
  float h=0.,dx=0.,dy=0.,curvature=0.;
  // Beyond the clear cap all height-dependent terms have a zero body mask.
  // Its thin rim/shadow still render, without five invisible height samples.
  if(r<1.012) {
#ifdef BATCH_PASS
    // Permanent folds are fetched once and reused by all five slope samples.
    // Intact pockets never fetch the texture.
    if(c>.001) loadMembrane();
#endif
    h=heightAt(p);
    float hxPlus=heightAt(p+vec2(eps,0.)), hxMinus=heightAt(p-vec2(eps,0.));
    float hyPlus=heightAt(p+vec2(0.,eps)), hyMinus=heightAt(p-vec2(0.,eps));
    dx=(hxPlus-hxMinus)/(2.*eps);dy=(hyPlus-hyMinus)/(2.*eps);
    curvature=(hxPlus+hxMinus+hyPlus+hyMinus-4.*h)/(eps*eps);
  }
  vec3 normal=normalize(vec3(-dx,-dy,1.));
  vec3 reflected=reflect(vec3(0.,0.,-1.),normal);
  // Rotate the illumination frame, including every studio source. Surface
  // normals stay in place, so intact domes orbit while slack folds relight.
  reflected.xy=turn(reflected.xy,-u_light_angle);
  float fresnel=.047+.953*pow(1.-max(normal.z,0.),4.5);
  float body=1.-smoothstep(.993,1.012,r);
  float sealWidth=.008+u_seed*.004;
  float rim=exp(-sq((r-1.027)/sealWidth));
  float outerRim=exp(-sq((r-1.085)/.0065));
  float shadow=exp(-sq((length(p+vec2(-.012,.025))-1.036)/.020));
  vec3 bg=mix(vec3(.78,.85,.91),vec3(.047,.065,.078),u_dark);
  float shade=dot(normal,normalize(vec3(turn(vec2(-.6,.75),u_light_angle),1.)));
  vec3 env=environment(reflected,c*mix(.11,.18,u_dark));
  float reflection=(.38+fresnel*.65)*mix(1.,.63,c);
  vec3 spec=env*reflection*body;
  // Bright daylight reflections keep a crisp core without filling the clear
  // body with white. Both themes share the same source and surface geometry.
  spec*=mix(1.9,1.,u_dark);
  float lipLight=.30+.26*sin(angleOf(q)-u_light_angle-.3)+.18*sin(angleOf(q)*9.+u_seed*13.);
  float litEdge=pow(max(0.,dot(direction,normalize(turn(vec2(-.6,.8),u_light_angle)))),3.);
  spec+=mix(vec3(1.),vec3(.88,.94,1.),u_dark)*rim*lipLight*mix(.09+.35*litEdge,.15+.55*litEdge,u_dark)*(1.-c*.3);
  spec+=vec3(.84,.93,1.)*outerRim*.015*litEdge*(1.-c*.35);
  float softShoulder=exp(-sq((r-.90)/.105))*body;
  spec+=vec3(.64,.76,.83)*softShoulder*(.025+.26*litEdge)*mix(.30,1.,u_dark)*(1.-c*.4);
  vec2 exitDirection=-keyDirection();
  float farSide=pow(max(0.,dot(direction,exitDirection)),mix(3.6,6.,u_dark));
  float returnLight=exp(-sq((r-mix(.78,.82,u_dark))/mix(.19,.14,u_dark)))*farSide;
  float returnEdge=exp(-sq((r-mix(.915,.955,u_dark))/mix(.070,.043,u_dark)))*farSide;
  float returnStrength=1.-c*.92;
  // A directional return through the thin wall lights a wide patch inside
  // the opposite shoulder. Vented film retains only a faint trace of this
  // dome-shaped glow. This is an optical approximation, not ray tracing.
  spec+=vec3(1.)*(returnLight*mix(.50,.16,u_dark)+returnEdge*mix(.68,.37,u_dark))*body*returnStrength;
  float shoulder=exp(-sq((r-.958)/.022))*body;
  float shoulderLight=pow(max(0.,dot(normalize(turn(vec2(-.7,.8),u_light_angle)),direction)),5.);
  spec+=vec3(.84,.94,1.)*shoulder*(.06+.30*shoulderLight)*(1.-c*.75)*mix(.22,1.,u_dark);
  spec+=vec3(.50,.57,.61)*pow(fresnel,1.4)*body*.10*u_dark;
  float grain=(noise(p*220.)-.5)*.006;
  spec+=grain*(body+rim)*.5;
  // Fold contrast retains the depressed shape after popping without glassy glare.
  spec+=c*body*max(0.,(-dx+dy)*.09)*u_dark;
  spec=1.-exp(-max(vec3(0.),spec)*1.4);
  vec2 sourceUV=lightCoordinates(reflected);
  vec2 highlight=highlightMasks(sourceUV,c*mix(.11,.18,u_dark));
  spec=mix(spec,vec3(1.),highlight.x*body);
  // A restrained thin-film-like optical approximation: wavelength phase varies
  // with viewing angle and local film height. Plastic is thicker than soap;
  // confining this hint to one bright border avoids an all-over rainbow skin.
  float opticalPath=930.+sourceUV.x*510.+normal.z*115.+h*48.;
  vec3 spectrum=.5+.5*cos(2.*PI*opticalPath/vec3(650.,510.,440.));
  spectrum-=vec3((spectrum.r+spectrum.g+spectrum.b)/3.);
  spec=clamp(spec+spectrum*highlight.y*body*.045,0.,1.);
  float specMax=max(spec.r,max(spec.g,spec.b));
  // Keep clear film colourless. One faint contact contour describes its seal;
  // stacked dark/white studio strips made the lower-right edge look moulded.
  float coat=body*mix(mix(.009,.015,u_dark),.020,c);
  float rimOcclusion=exp(-sq((r-1.006)/.011))*(.35+.65*sq(max(0.,-q.y)));
  // Darken local fold valleys, not every sloping face of the vented cap. A
  // broad one-sided slope mask made half a clear pocket look cut away.
  float valleyShade=smoothstep(3.,28.,max(0.,curvature))*.024+(1.-normal.z)*.018;
  float foldShade=c*mix(valleyShade,clamp((dx-dy)*.07,0.,.09),u_dark);
  float shadowA=shadow*mix(.050,.11,u_dark)+body*foldShade;
  shadowA+=(1.-u_dark)*(rimOcclusion*.10+body*pow(1.-normal.z,3.)*.025+c*body*(1.-normal.z)*.035);
  // A shallow transition leaves the full contour and volume visible beneath
  // the broad return. The background pool and its shadow are drawn separately.
  float returnShade=exp(-sq((r-.70)/.15))*farSide*body*returnStrength;
  shadowA+=(1.-u_dark)*returnShade*.055;
  float alpha=clamp(specMax+(coat+shadowA)*(1.-specMax),0.,1.);
  float transmissionLight=mix(.79+shade*.25,.92+shade*.08,u_dark);
  vec3 premul=spec+bg*coat*(1.-specMax)*transmissionLight;
  gl_FragColor=vec4(min(premul,vec3(alpha)),alpha);
#endif
}
`;

export class FilmRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', {alpha:true, antialias:false, depth:false, stencil:false, premultipliedAlpha:true, powerPreference:'low-power'});
    if (!this.gl) throw new Error('WebGL is unavailable');
    this.initialize();
  }
  initialize() {
    const gl=this.gl;
    const compile=(type,source)=>{
      const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const makeProgram=(source,vertexSource=vertex)=>{
      const vs=compile(gl.VERTEX_SHADER,vertexSource);
      const fs=compile(gl.FRAGMENT_SHADER,source),program=gl.createProgram();
      gl.attachShader(program,vs);gl.attachShader(program,fs);
      for(const [index,name] of ['a_position','a_rect','a_state','a_touchRadius','a_link','a_record'].entries()) gl.bindAttribLocation(program,index,name);
      gl.bindAttribLocation(program,1,'a_tile');
      gl.linkProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      return program;
    };
    // Distinct entry points let the linker discard cap folds from the sheet
    // program and site lists from caps. Each stays within 64 uniform vectors.
    this.legacyProgram=makeProgram(fragment);
    this.sheetProgram=makeProgram('#define SHEET_PASS\n'+fragment);
    this.sheetBatch=new SheetBatch(gl);
    this.sheetBatchProgram=this.sheetBatch.available?makeProgram('#define SHEET_PASS\n#define SHEET_BATCH_PASS\n'+fragment,sheetBatchVertex):null;
    this.sheetBatchingEnabled=true;
    this.batch=new BubbleBatch(gl);
    this.batchProgram=this.batch.available?makeProgram('#define BATCH_PASS\n'+fragment,batchVertex):null;
    this.batchingEnabled=true;
    this.program=this.batchProgram||this.legacyProgram;
    gl.useProgram(this.program);
    this.quadBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const a=gl.getAttribLocation(this.program,'a_position');gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
    const uniforms=program=>{
      const locations={};
      for(const name of ['seed','compression','collapse','dark','time','bulge','touch','light','light_angle','air','dent','resolution','origin','radius','site_count','link','framebuffer','membranes','membrane_rows','sheet_sites','sheet_links','sheet_rows']) locations[name]=gl.getUniformLocation(program,'u_'+name);
      for(const name of ['folds','foldProfile','pockets','sites','links']) locations[name]=gl.getUniformLocation(program,'u_'+name+'[0]');
      return locations;
    };
    this.legacyUniforms=uniforms(this.legacyProgram);
    this.batchUniforms=this.batchProgram?uniforms(this.batchProgram):null;
    this.uniforms=this.batchUniforms||this.legacyUniforms;
    this.sheetUniforms=uniforms(this.sheetProgram);
    this.sheetBatchUniforms=this.sheetBatchProgram?uniforms(this.sheetBatchProgram):null;
    this.sites=new Float32Array(MAX_SHEET_SITES*4);
    this.links=new Float32Array(MAX_SHEET_SITES*4);
    this.sheetState=new SheetState();
    this.layout=null;
    this.membranes=[];
    this.getMembrane=(bubble,index)=>this.membraneFor(bubble,index);
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0,0,0,0);
  }
  resize(width,height,dpr) {
    this.width=width;this.height=height;this.dpr=dpr;
    this.layout=null;
    this.canvas.width=Math.round(width*dpr);this.canvas.height=Math.round(height*dpr);
    this.geometry={width,height,dpr,framebufferWidth:this.canvas.width,framebufferHeight:this.canvas.height};
  }
  membraneFor(bubble,index) {
    let membrane=this.membranes[index];
    const popX=bubble.popX,popY=-bubble.popY;
    if(!membrane||membrane.seed!==bubble.seed||membrane.popX!==popX||membrane.popY!==popY) {
      membrane=this.membranes[index]=makeMembrane(bubble.seed,popX,popY);
    }
    return membrane;
  }
  render(bubbles,layout,dark,time,light) {
    const batched=this.batchingEnabled&&this.batchProgram;
    this.program=batched?this.batchProgram:this.legacyProgram;
    this.uniforms=batched?this.batchUniforms:this.legacyUniforms;
    const sheetBatched=this.sheetBatchingEnabled&&this.sheetBatchProgram&&this.sheetBatch.supports(layout.length);
    const gl=this.gl,s=sheetBatched?this.sheetBatchUniforms:this.sheetUniforms,u=this.uniforms;
    if(this.layout!==layout) {
      this.layout=layout;
      this.sheetState.resize(layout,this.width,this.height);
    }
    this.sheetState.update(bubbles,this.reducedMotion);
    const deformation=this.sheetState.deformation;
    gl.bindBuffer(gl.ARRAY_BUFFER,this.quadBuffer);
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    gl.disable(gl.SCISSOR_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(sheetBatched?this.sheetBatchProgram:this.sheetProgram);
    gl.uniform1f(s.dark,dark?1:0);
    gl.uniform2f(s.light,light.x,light.y);
    gl.uniform1f(s.light_angle,Number.isFinite(light.angle)?light.angle:0);
    gl.uniform2f(s.resolution,this.width,this.height);
    gl.uniform1f(s.radius,layout[0].radius);
    gl.uniform1f(s.seed,.417);
    gl.viewport(0,0,this.canvas.width,this.canvas.height);
    if(sheetBatched) {
      gl.uniform2f(s.framebuffer,this.canvas.width,this.canvas.height);
      this.sheetBatch.draw(bubbles,layout,deformation,this.sheetState.tiles,this.geometry,s);
      // Restore the shared quad before either cap submission path uses it.
      gl.bindBuffer(gl.ARRAY_BUFFER,this.quadBuffer);
      gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    } else {
    this.sheetBatch.active=false;
    gl.enable(gl.SCISSOR_TEST);
    for(const tile of this.sheetState.tiles) {
      const indices=tile.indices;
      for(let j=0;j<indices.length;j++) {
        const i=indices[j],pos=layout[i],offset=j*4,source=i*4;
        this.sites[offset]=pos.x;this.sites[offset+1]=pos.y;
        this.sites[offset+2]=pos.radius;this.sites[offset+3]=i;
        this.links[offset]=deformation[source];this.links[offset+1]=deformation[source+1];
        // Pack pulse into the slope strength; keep identity and collapse in
        // existing vec4 lanes rather than another device-limited uniform array.
        this.links[offset+2]=deformation[source+2]+deformation[source+3]*(.16/.085);
        this.links[offset+3]=bubbles[i].collapse;
      }
      gl.uniform1i(s.site_count,indices.length);
      gl.uniform4fv(s.sites,this.sites);gl.uniform4fv(s.links,this.links);
      // Shared rounded endpoints partition framebuffer pixels exactly, even
      // at fractional DPR. All tiles keep one viewport and absolute lighting.
      const left=Math.round(tile.x*this.dpr),right=Math.round((tile.x+tile.width)*this.dpr);
      const bottom=Math.round((this.height-tile.y-tile.height)*this.dpr);
      const top=Math.round((this.height-tile.y)*this.dpr);
      gl.scissor(left,bottom,right-left,top-bottom);
      gl.drawArrays(gl.TRIANGLES,0,6);
    }
    gl.disable(gl.SCISSOR_TEST);
    }
    gl.useProgram(this.program);
    gl.uniform1f(u.dark,dark?1:0);gl.uniform1f(u.time,time);
    gl.uniform2f(u.light,light.x,light.y);
    gl.uniform1f(u.light_angle,Number.isFinite(light.angle)?light.angle:0);
    if(batched) {
      gl.viewport(0,0,this.canvas.width,this.canvas.height);
      gl.uniform2f(u.framebuffer,this.canvas.width,this.canvas.height);
      this.batch.draw(bubbles,layout,deformation,this.geometry,this.getMembrane,u);
      return;
    }
    for(let i=0;i<bubbles.length;i++) {
      const b=bubbles[i], pos=layout[i], extent=pos.radius*1.38;
      if(pos.x+extent<0||pos.y+extent<0||pos.x-extent>this.width||pos.y-extent>this.height) continue;
      gl.viewport(Math.round((pos.x-extent)*this.dpr),Math.round((this.height-pos.y-extent)*this.dpr),Math.round(extent*2*this.dpr),Math.round(extent*2*this.dpr));
      gl.uniform1f(u.seed,b.seed);gl.uniform1f(u.compression,b.compression);gl.uniform1f(u.collapse,b.collapse);gl.uniform1f(u.bulge,b.bulge);
      gl.uniform2f(u.origin,pos.x,pos.y);gl.uniform1f(u.radius,pos.radius);
      const offset=i*4;
      gl.uniform4f(u.link,deformation[offset],deformation[offset+1],deformation[offset+2],deformation[offset+3]);
      // Intact caps never sample collapsed folds; avoid building/uploading
      // their permanent wrinkle data until the first rupture.
      if(b.popped) {
        const membrane=this.membraneFor(b,i);
        gl.uniform1f(u.air,membrane.air);gl.uniform4fv(u.dent,membrane.dent);
        gl.uniform4fv(u.folds,membrane.folds);gl.uniform4fv(u.foldProfile,membrane.profiles);gl.uniform4fv(u.pockets,membrane.pockets);
      }
      gl.uniform2f(u.touch,b.x,-b.y);
      gl.drawArrays(gl.TRIANGLES,0,6);
    }
  }
}
