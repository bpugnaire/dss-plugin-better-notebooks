import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const root=resolve('.');
createServer(async (req,res)=>{
  try {
    const path=resolve(root,`.${new URL(req.url,'http://localhost').pathname}`);
    if(!path.startsWith(`${root}/`)) { res.writeHead(403);res.end();return; }
    const body=await readFile(path);
    res.setHeader('Content-Type',({'.js':'application/javascript','.css':'text/css','.html':'text/html'})[extname(path)]||'application/octet-stream');res.end(body);
  } catch {res.writeHead(404);res.end();}
}).listen(4178,'127.0.0.1');
