import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const port=Number(process.env.BUBBLE_PORT||4174);
const host=process.env.BUBBLE_HOST||'0.0.0.0';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.json':'application/json; charset=utf-8','.md':'text/plain; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)) { res.writeHead(405,{Allow:'GET, HEAD'});res.end();return; }
  try {
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(root+path.sep)) {res.writeHead(403);res.end();return;}
    const data=await readFile(file);
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:data);
  } catch { res.writeHead(404);res.end('Not found'); }
});
server.on('error',e=>{console.error(e.message);process.exitCode=1;});
server.listen(port,host,()=>{
  console.log(`Bubble: http://localhost:${port}`);
  if(host==='0.0.0.0') for(const addresses of Object.values(os.networkInterfaces())) for(const a of addresses||[]) if(a.family==='IPv4'&&!a.internal) console.log(`Same Wi-Fi: http://${a.address}:${port}`);
});
