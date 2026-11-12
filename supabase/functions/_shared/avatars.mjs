import {APIError} from './validation.mjs';
import {sanitizePhoto} from './photos.mjs';
import {token} from './passwords.mjs';
export function avatars(url,key,Image,transport=fetch) {
 if(!url||!key)return null;
 const auth={apikey:key,Authorization:'Bearer '+key};
 async function metadata(session_hash,operation,target=null,version='') {
  const response=await transport(url+'/rest/v1/rpc/league_avatar',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({session_hash,operation,target,version}),redirect:'error'});
  const body=await response.json();if(!response.ok){const m=/^(401|403|404)\|(.+)$/.exec(body.message||'');throw new APIError(m?Number(m[1]):503,m?m[2]:'Photo storage is unavailable.');}return body;
 }
 return {
  async upload(request,sessionHash) {
   const actor=await metadata(sessionHash,'self');
   const reader=request.body?.getReader();if(!reader)throw new APIError(400,'Choose a photo.');
   const chunks=[];let length=0;
   while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>2*1024*1024+65536){await reader.cancel();throw new APIError(413,'Profile photos must be 2 MB or smaller.');}chunks.push(value);}
   let data;try{data=await new Response(new Blob(chunks),{headers:{'Content-Type':request.headers.get('Content-Type')||''}}).formData();}catch{throw new APIError(400,'Choose a photo.');}
   const file=data.get('file');if(!file||typeof file.arrayBuffer!=='function')throw new APIError(400,'Choose a photo.');
   const bytes=await sanitizePhoto(new Uint8Array(await file.arrayBuffer()),Image);
   const response=await transport(url+'/storage/v1/object/league-avatars/'+actor.key,{method:'POST',headers:{...auth,'Content-Type':'image/jpeg','x-upsert':'true'},body:bytes,redirect:'error'});
   if(!response.ok)throw new APIError(503,'Photo storage is unavailable.');
   await metadata(sessionHash,'save',null,token());return {ok:true};
  },
  async get(id,sessionHash) {
   const item=await metadata(sessionHash,'get',id);
   const response=await transport(url+'/storage/v1/object/authenticated/league-avatars/'+item.key,{headers:auth,redirect:'error'});
   if(!response.ok)throw new APIError(404,'Photo not found.');
   return new Uint8Array(await response.arrayBuffer());
  }
 };
}
