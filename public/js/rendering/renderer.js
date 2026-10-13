// Analytic elastic membrane. Surface slopes drive the reflected studio lights;
// the same height field provides the finger dent and the collapsed creases.
import { makeMembrane } from '../core/membrane.js';
import { BUBBLE_COUNT } from '../core/layout.js';
const vertex = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() { v_uv = a_position; gl_Position = vec4(a_position,0.,1.); }
`;
const fragment = `
precision highp float;
varying vec2 v_uv;
uniform float u_seed, u_compression, u_collapse, u_dark, u_time, u_bulge, u_sheet, u_light_angle;
uniform vec2 u_touch, u_light, u_resolution, u_origin;
uniform float u_radius;
uniform vec4 u_sites[${BUBBLE_COUNT}];
uniform vec4 u_folds[5], u_foldProfile[5], u_pockets[3], u_dent;
uniform float u_air;
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
  float dome=(.48+u_seed*.09)*pow(max(0.,1.-r*r),.58+u_seed*.07);
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
  // Fine, taut stretch marks are confined to the heat-sealed shoulder.
  dome += .003*sin(a*31.+3.*sin(a*7.+u_seed)+r*15.+u_seed)*smoothstep(.88,.97,r)*edge;
  dome += .0005*sin(q.x*24.+q.y*11.+u_seed)*sin(q.y*19.-q.x*5.)*edge;
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
      // Slack plastic makes broad facets on either side of a rounded crease.
      // Mixing a roof profile with the bend avoids uniformly smooth tubes.
      float roof=max(0.,1.-sqrt(line*line+.0001)/(fold.w*4.4));
      roof*=smoothstep(0.,.10,roof);
      float ridge=mix(exp(-sq(line/fold.w)),roof,.82);
      float valley=exp(-sq((line+fold.w*1.7)/(fold.w*2.2)));
      collapsedHeight+=(ridge-valley*.16)*profile.x*taper*(1.-knead*1.6*contactFalloff);
    }
    // Supported film stops against the backing; pressing cannot push it through.
    float supportedHeight=min(collapsedHeight,.012);
    collapsedHeight=max(supportedHeight,collapsedHeight-knead*.50*contactFalloff*fixedRim);
    collapsedHeight*=edge;
  }
  float h=mix(dome,collapsedHeight,c);
  // A low welded seam stays intact after the air has escaped.
  h+=.009*exp(-sq((r-1.025)/.024))*(1.-c*.3);
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
  float exposed=1.,contact=0.,castShadow=0.,bounce=0.,nearFilm=0.,pool=0.,poolShade=0.;
  vec2 exitDirection=-keyDirection();
  for(int i=0;i<${BUBBLE_COUNT};i++) {
    vec2 q=(pixel-u_sites[i].xy)*vec2(1.,-1.)/u_sites[i].z;
    float distance=length(q), c=u_sites[i].w;
    vec2 direction=q/max(distance,.0001);
    float gutter=exp(-sq((distance-1.085)/.055));
    float shoulder=exp(-sq((distance-1.18)/.20));
    nearFilm=max(nearFilm,exp(-sq((distance-1.15)/.55)));
    float irregular=.65+.35*sin(angleOf(q)*3.+float(i)*2.3);
    // Raised welds and sagging bridges share the same light as the domes.
    slope+=direction*shoulder*.18*irregular;
    contact=max(contact,gutter*(.65+.35*max(0.,-direction.y)));
    vec2 shadowOffset=turn(vec2(.065,-.10),u_light_angle);
    float shadowDistance=length(q-shadowOffset);
    float shadowSide=.25+.75*max(0.,dot(direction,normalize(shadowOffset)));
    castShadow=max(castShadow,exp(-sq((shadowDistance-1.07)/.14))*shadowSide*(1.-c*.52));
    bounce=max(bounce,shoulder*pow(max(0.,dot(direction,exitDirection)),5.)*irregular);
    if(distance<3.) {
      vec2 transmitted=transmittedPool(q,exitDirection,c,float(i));
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
  if(u_sheet>.5) { drawSheet(); return; }
  vec2 p=v_uv*1.38;
  vec2 q=shape(p); float r=length(q);
  vec2 direction=q/max(r,.00001);
  if(r>1.30) discard;
  float c=clamp(u_collapse,0.,1.);
  float eps=.0032;
  float h=heightAt(p);
  float hxPlus=heightAt(p+vec2(eps,0.)), hxMinus=heightAt(p-vec2(eps,0.));
  float hyPlus=heightAt(p+vec2(0.,eps)), hyMinus=heightAt(p-vec2(0.,eps));
  float dx=(hxPlus-hxMinus)/(2.*eps), dy=(hyPlus-hyMinus)/(2.*eps);
  float curvature=(hxPlus+hxMinus+hyPlus+hyMinus-4.*h)/(eps*eps);
  vec3 normal=normalize(vec3(-dx,-dy,1.));
  vec3 reflected=reflect(vec3(0.,0.,-1.),normal);
  // Rotate the illumination frame, including every studio source. Surface
  // normals stay in place, so intact domes orbit while slack folds relight.
  reflected.xy=turn(reflected.xy,-u_light_angle);
  float fresnel=.047+.953*pow(1.-max(normal.z,0.),4.5);
  float body=1.-smoothstep(.993,1.012,r);
  float rim=exp(-sq((r-1.027)/.012));
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
  spec+=mix(vec3(1.),vec3(.88,.94,1.),u_dark)*rim*lipLight*mix(.10+.35*litEdge,.18+.55*litEdge,u_dark)*(1.-c*.3);
  spec+=vec3(.84,.93,1.)*outerRim*.015*litEdge*(1.-c*.35);
  float softShoulder=exp(-sq((r-.90)/.105))*body;
  spec+=vec3(.64,.76,.83)*softShoulder*(.025+.26*litEdge)*mix(.30,1.,u_dark)*(1.-c*.4);
  vec2 exitDirection=-keyDirection();
  float farSide=pow(max(0.,dot(direction,exitDirection)),mix(3.6,6.,u_dark));
  float returnLight=exp(-sq((r-mix(.78,.82,u_dark))/mix(.19,.14,u_dark)))*farSide;
  float returnEdge=exp(-sq((r-mix(.915,.955,u_dark))/mix(.070,.043,u_dark)))*farSide;
  // A directional return through the thin wall lights a wide patch inside
  // the opposite shoulder. This is an optical approximation, not ray tracing.
  spec+=vec3(1.)*(returnLight*mix(.50,.16,u_dark)+returnEdge*mix(.68,.37,u_dark))*body*(1.-c*.55);
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
  float returnShade=exp(-sq((r-.70)/.15))*farSide*body*(1.-c*.55);
  shadowA+=(1.-u_dark)*returnShade*.055;
  float alpha=clamp(specMax+(coat+shadowA)*(1.-specMax),0.,1.);
  float transmissionLight=mix(.79+shade*.25,.92+shade*.08,u_dark);
  vec3 premul=spec+bg*coat*(1.-specMax)*transmissionLight;
  gl_FragColor=vec4(min(premul,vec3(alpha)),alpha);
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
    const vs=compile(gl.VERTEX_SHADER,vertex), fs=compile(gl.FRAGMENT_SHADER,fragment);
    this.program=gl.createProgram();gl.attachShader(this.program,vs);gl.attachShader(this.program,fs);gl.linkProgram(this.program);
    gl.deleteShader(vs);gl.deleteShader(fs);
    if(!gl.getProgramParameter(this.program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    gl.useProgram(this.program);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const a=gl.getAttribLocation(this.program,'a_position');gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
    this.uniforms={};
    for(const name of ['seed','compression','collapse','dark','time','bulge','touch','light','light_angle','air','dent','sheet','resolution','origin','radius']) this.uniforms[name]=gl.getUniformLocation(this.program,'u_'+name);
    for(const name of ['folds','foldProfile','pockets']) this.uniforms[name]=gl.getUniformLocation(this.program,'u_'+name+'[0]');
    this.uniforms.sites=gl.getUniformLocation(this.program,'u_sites[0]');
    this.sites=new Float32Array(BUBBLE_COUNT*4);
    this.membranes=[];
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0,0,0,0);
  }
  resize(width,height,dpr) {
    this.width=width;this.height=height;this.dpr=dpr;
    this.canvas.width=Math.round(width*dpr);this.canvas.height=Math.round(height*dpr);
  }
  render(bubbles,layout,dark,time,light) {
    const gl=this.gl,u=this.uniforms;
    gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(this.program);
    gl.uniform1f(u.dark,dark?1:0);gl.uniform1f(u.time,time);
    gl.uniform2f(u.light,light.x,light.y);
    gl.uniform1f(u.light_angle,Number.isFinite(light.angle)?light.angle:0);
    gl.uniform2f(u.resolution,this.width,this.height);
    for(let i=0;i<layout.length;i++) this.sites.set([layout[i].x,layout[i].y,layout[i].radius,bubbles[i].collapse],i*4);
    gl.uniform4fv(u.sites,this.sites);
    gl.uniform1f(u.radius,layout[0].radius);
    gl.uniform1f(u.seed,.417);
    gl.uniform1f(u.sheet,1);
    gl.viewport(0,0,this.canvas.width,this.canvas.height);
    gl.drawArrays(gl.TRIANGLES,0,6);
    gl.uniform1f(u.sheet,0);
    for(let i=0;i<bubbles.length;i++) {
      const b=bubbles[i], pos=layout[i], extent=pos.radius*1.38;
      gl.viewport(Math.round((pos.x-extent)*this.dpr),Math.round((this.height-pos.y-extent)*this.dpr),Math.round(extent*2*this.dpr),Math.round(extent*2*this.dpr));
      gl.uniform1f(u.seed,b.seed);gl.uniform1f(u.compression,b.compression);gl.uniform1f(u.collapse,b.collapse);gl.uniform1f(u.bulge,b.bulge);
      gl.uniform2f(u.origin,pos.x,pos.y);gl.uniform1f(u.radius,pos.radius);
      let membrane=this.membranes[i];
      const popX=b.popped?b.popX:0, popY=b.popped?-b.popY:0;
      if(!membrane||membrane.seed!==b.seed||membrane.popX!==popX||membrane.popY!==popY) {
        membrane=this.membranes[i]=makeMembrane(b.seed,popX,popY);
      }
      gl.uniform1f(u.air,membrane.air);gl.uniform4fv(u.dent,membrane.dent);
      gl.uniform4fv(u.folds,membrane.folds);gl.uniform4fv(u.foldProfile,membrane.profiles);gl.uniform4fv(u.pockets,membrane.pockets);
      gl.uniform2f(u.touch,b.x,-b.y);
      gl.drawArrays(gl.TRIANGLES,0,6);
    }
  }
}
