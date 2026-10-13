// Local verification only; GitHub Pages serves production without a server.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
const root = resolve('portable-dist');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json'};
createServer(async (req,res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/sayu/')) {res.writeHead(404).end(); return;}
  const file = resolve(root, decodeURIComponent(url.pathname.slice(6)) || 'index.html');
  if (!file.startsWith(root + '/') && !file.startsWith(root + '\\')) {res.writeHead(403).end(); return;}
  try {const body = await readFile(file); res.writeHead(200, {'Content-Type':types[extname(file)] || 'application/octet-stream','Cache-Control':'no-cache'});res.end(body);}
  catch {res.writeHead(404).end();}
}).listen(4173,'127.0.0.1',()=>console.log('Preview http://127.0.0.1:4173/sayu/'));
