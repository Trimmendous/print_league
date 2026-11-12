import {mkdir, readFile, writeFile, copyFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export const publicFiles = ['app.js','api.js','theme.js','style.css','responsive.css','assets/benchy.svg','assets/benchy-trophy.png','assets/example-benchy-trophy.webp'];
export async function buildPages(output = new URL('../dist/', import.meta.url), options = {}) {
  const basePath = options.basePath || '/print_league/';
  const apiBase = options.apiBase || 'https://narfsxgtbvfvvxwdusss.supabase.co/functions/v1/league-api/';
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath)) throw Error('Invalid Pages base path');
  const api = new URL(apiBase);
  if (api.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(api.hostname) || api.pathname !== '/functions/v1/league-api/' || api.username || api.password || api.search || api.hash || api.port) throw Error('Expected Supabase league-api URL');
  await rm(output,{recursive:true,force:true});
  await mkdir(new URL('static/assets/',output),{recursive:true});
  const rewrite = text => text.replaceAll('/static/',basePath+'static/').replaceAll('href="/"',`href="${basePath}"`);
  for (const file of publicFiles) {
    const source=new URL('../static/'+file,import.meta.url), dest=new URL('static/'+file,output);
    if (/\.(js|css)$/.test(file)) await writeFile(dest,rewrite(await readFile(source,'utf8')));
    else await copyFile(source,dest);
  }
  await writeFile(new URL('static/config.js',output),`window.LEAGUE_CONFIG = ${JSON.stringify({apiBase,basePath})};\n`);
  const csp=`default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' https://accounts.google.com/gsi/style; frame-src https://accounts.google.com/gsi/; connect-src 'self' ${api.origin} https://accounts.google.com/gsi/; img-src 'self' blob: https://makerworld.bblmw.com https://media.printables.com https://media.prusaprinters.org; base-uri 'self'; form-action 'self'; object-src 'none'`;
  for (const file of ['index.html','404.html']) {
    let html=rewrite(await readFile(new URL('../static/'+file,import.meta.url),'utf8'));
    html=html.replace('<head>','<head><meta http-equiv="Content-Security-Policy" content="'+csp+'">');
    html=html.replace(`<script src="${basePath}static/api.js">`,`<script src="${basePath}static/config.js"></script><script src="${basePath}static/api.js">`);
    await writeFile(new URL(file,output),html);
  }
  await copyFile(new URL('../CHANGELOG.json',import.meta.url),new URL('releases.json',output));
  await writeFile(new URL('.nojekyll',output),'');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 await buildPages();console.log('Built GitHub Pages site in dist/');
}
