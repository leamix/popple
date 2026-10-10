// Analytic elastic membrane. Surface slopes drive the reflected studio lights;
// the same height field provides the finger dent and the collapsed creases.
const vertex = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() { v_uv = a_position; gl_Position = vec4(a_position,0.,1.); }
`;
const fragment = `
precision highp float;
varying vec2 v_uv;
uniform float u_seed, u_compression, u_collapse, u_dark, u_time, u_bulge;
uniform vec2 u_touch, u_light;
const float PI = 3.14159265359;
float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7))+u_seed*81.17)*43758.5453); }
float noise(vec2 p) {
  vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);
}
vec2 shape(vec2 p) {
  float a=atan(p.y,p.x);
  float irregular=1.+.012*sin(5.*a+u_seed*8.)+.006*sin(9.*a+u_seed*13.);
  // The footprint expands a little as air is displaced away from the contact.
  vec2 shift=-u_touch*u_bulge*.065;
  return (p-shift)/(irregular*(1.+u_compression*.055));
}
float heightAt(vec2 p) {
  vec2 q=shape(p);
  float r=length(q), a=atan(q.y,q.x), c=clamp(u_collapse,0.,1.);
  float edge=1.-smoothstep(.88,1.015,r);
  float dome=(.65+u_seed*.055)*pow(max(0.,1.-r*r),.63);
  float dist=length(q-u_touch*.67);
  float dent=exp(-dist*dist/ (.17+.09*u_compression));
  float opposite=exp(-dot(q+u_touch*.55,q+u_touch*.55)/.28);
  dome += u_compression*(-.53*dent+.07*opposite)*edge;
  dome += u_bulge*.22*opposite*edge;
  // Fine, taut stretch marks are confined to the heat-sealed shoulder.
  dome += .003*sin(a*31.+3.*sin(a*7.+u_seed)+r*15.+u_seed)*smoothstep(.88,.97,r)*edge;
  dome += .0005*sin(q.x*24.+q.y*11.+u_seed)*sin(q.y*19.-q.x*5.)*edge;
  float crumple=0.;
  if(c>.001) for(int i=0;i<7;i++) {
    float fi=float(i), angle=fi*2.39996+u_seed;
    vec2 axis=vec2(cos(angle),sin(angle));
    float along=dot(q,axis), across=dot(q,vec2(-axis.y,axis.x));
    float line=across-(.08+.10*sin(fi+u_seed))*sin(along*3.1+fi);
    float crease=exp(-pow(line*(18.+fi*1.3),2.));
    crumple+=crease*(.033+.015*sin(fi*2.3+u_seed))*smoothstep(-.35,.25,along);
  }
  float collapsedHeight=(-.13*exp(-r*r*3.)+.018*sin(q.x*9.+q.y*5.+u_seed)+crumple)*edge;
  float h=mix(dome,collapsedHeight,c);
  // A sealed double lip stays intact after the air has escaped.
  h+=.033*exp(-pow((r-1.025)/.030,2.))*(1.-c*.5);
  h+=.013*exp(-pow((r-1.085)/.013,2.));
  return h;
}
float box(vec2 p, vec2 halfSize, float softness) {
  vec2 d=abs(p)-halfSize;
  return 1.-smoothstep(-softness,softness,max(d.x,d.y));
}
vec3 environment(vec3 r, float roughness) {
  vec3 l=normalize(vec3(-.55,.72,.42));
  vec3 axis=normalize(cross(vec3(0.,1.,0.),l));
  vec3 up=cross(l,axis);
  vec2 uv=vec2(atan(dot(r,axis),dot(r,l)),atan(dot(r,up),dot(r,l)))+u_light;
  float key=box(uv,vec2(.73,.19),.035+roughness*.19);
  float inner=box(uv+vec2(.014,.012),vec2(.66,.143),.028+roughness*.16);
  float split=1.-.10*exp(-pow((uv.x+.12)/.012,2.));
  vec3 side=normalize(vec3(.85,-.3,.12));
  vec3 sx=normalize(cross(vec3(0.,1.,0.),side)), sy=cross(side,sx);
  vec2 suv=vec2(atan(dot(r,sx),dot(r,side)),atan(dot(r,sy),dot(r,side)));
  float rim=box(suv+u_light,vec2(.075,.58),.023+roughness*.12);
  float bottom=pow(max(0.,dot(r,normalize(vec3(-.5,-.8,.1)))),45.);
  float broad=pow(max(0.,dot(r,normalize(vec3(-.6,.8,1.)))),3.);
  vec3 env=vec3(.12,.14,.16)*broad;
  env+=vec3(.94,.98,1.)*(key*.8+inner*2.4)*split;
  env+=vec3(1.,.95,.85)*rim*1.6;
  env+=vec3(.65,.83,1.)*bottom*.5;
  return env;
}
void main() {
  vec2 p=v_uv*1.38;
  vec2 q=shape(p); float r=length(q);
  if(r>1.30) discard;
  float c=clamp(u_collapse,0.,1.);
  float eps=.0032;
  float h=heightAt(p);
  float dx=(heightAt(p+vec2(eps,0.))-heightAt(p-vec2(eps,0.)))/(2.*eps);
  float dy=(heightAt(p+vec2(0.,eps))-heightAt(p-vec2(0.,eps)))/(2.*eps);
  vec3 normal=normalize(vec3(-dx,-dy,1.));
  vec3 reflected=reflect(vec3(0.,0.,-1.),normal);
  float fresnel=.047+.953*pow(1.-max(normal.z,0.),4.5);
  float body=1.-smoothstep(.98,1.016,r);
  float rim=exp(-pow((r-1.027)/.023,2.));
  float outerRim=exp(-pow((r-1.085)/.008,2.));
  float shadow=exp(-pow((length(p+vec2(-.014,.028))-1.02)/.044,2.));
  vec3 bg=mix(vec3(.78,.85,.91),vec3(.047,.065,.078),u_dark);
  float shade=dot(normal,normalize(vec3(-.6,.75,1.)));
  vec3 env=environment(reflected,c);
  float reflection=(.38+fresnel*.65)*mix(1.,.23,c);
  // An optically thin neutral film; only a whisper of chromatic edge dispersion.
  vec3 edgeTint=.5+.5*cos(vec3(0.,2.,4.)+(1.-normal.z)*19.+h*8.);
  vec3 spec=env*reflection*body;
  spec+=edgeTint*.016*fresnel*body*(1.-c);
  float lipLight=.45+.35*sin(atan(q.y,q.x)-.3)+.20*sin(atan(q.y,q.x)*9.+u_seed);
  spec+=vec3(.88,.94,1.)*rim*lipLight*mix(.64,1.25,u_dark)*(1.-c*.5);
  spec+=vec3(.84,.93,1.)*outerRim*.32*(1.-c*.35);
  float shoulder=exp(-pow((r-.935)/.047,2.))*body;
  float shoulderLight=pow(max(0.,dot(normalize(vec2(-.7,.8)),normalize(q))),5.);
  spec+=vec3(.84,.94,1.)*shoulder*(.06+.30*shoulderLight)*(1.-c*.75);
  spec+=vec3(.50,.57,.61)*pow(fresnel,1.4)*body*.10;
  float grain=(noise(p*220.)-.5)*.010;
  spec+=grain*(body+rim)*.5;
  // Fold contrast retains the depressed shape after popping without glassy glare.
  spec+=c*body*max(0.,(-dx+dy)*.12);
  spec=1.-exp(-max(vec3(0.),spec)*1.4);
  float specMax=max(spec.r,max(spec.g,spec.b));
  float coat=body*mix(mix(.65,.06,u_dark),.22,c);
  float shadowA=shadow*mix(.11,.20,u_dark)+c*body*clamp((dx-dy)*.10,0.,.16);
  shadowA+=body*(1.-u_dark)*(1.-c)*(.012+.035*pow(1.-normal.z,2.));
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
    for(const name of ['seed','compression','collapse','dark','time','bulge','touch','light']) this.uniforms[name]=gl.getUniformLocation(this.program,'u_'+name);
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
    for(let i=0;i<bubbles.length;i++) {
      const b=bubbles[i], pos=layout[i], extent=pos.radius*1.38;
      gl.viewport(Math.round((pos.x-extent)*this.dpr),Math.round((this.height-pos.y-extent)*this.dpr),Math.round(extent*2*this.dpr),Math.round(extent*2*this.dpr));
      gl.uniform1f(u.seed,b.seed);gl.uniform1f(u.compression,b.compression);gl.uniform1f(u.collapse,b.collapse);gl.uniform1f(u.bulge,b.bulge);
      gl.uniform2f(u.touch,b.x,-b.y);
      gl.drawArrays(gl.TRIANGLES,0,6);
    }
  }
}
