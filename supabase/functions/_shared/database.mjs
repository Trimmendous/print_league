import {APIError} from './validation.mjs';
export function database(url,key,transport=fetch,rpcName='league_rpc') {
 if(!url||!key) return null;
 return async (operation,payload={},session_hash='') => {
  let response;
  try {response=await transport(url+'/rest/v1/rpc/'+rpcName,{
   method:'POST',redirect:'error',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},
   body:JSON.stringify({operation,payload,session_hash}),signal:AbortSignal.timeout(15000)
  });} catch {throw new APIError(503,'The database is temporarily unavailable.');}
  const result=await response.json();
  if(!response.ok) {
   const match=/^(400|401|403|404|409|429)\|(.+)$/.exec(result.message||'');
   if(match) throw new APIError(Number(match[1]),match[2]);
   throw new APIError(503,'The database is temporarily unavailable.');
  }
  return result;
 };
}
