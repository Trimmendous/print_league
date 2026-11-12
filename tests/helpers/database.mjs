import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {APIError} from '../../supabase/functions/_shared/validation.mjs';
export async function testDatabase() {
 const db=new PGlite();
 await db.exec('create role anon; create role authenticated; create role service_role; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
 for(const file of (await readdir('supabase/migrations')).sort())await db.exec(await readFile('supabase/migrations/'+file,'utf8'));
 const rpc=async(operation,payload={},session_hash='')=>{
  try {const result=await db.query('select public.league_rpc($1,$2::jsonb,$3) as result',[operation,JSON.stringify(payload),session_hash]);return result.rows[0].result;}
  catch(error) {
   const match=/^(\d{3})\|(.+)$/.exec(error.message);
   if(match)throw new APIError(Number(match[1]),match[2]);throw error;
  }
 };
 const otherRPC=name=>async(operation,payload={},session_hash='')=>{
  try {
   const params=name==='league_admin'?[session_hash,operation,JSON.stringify(payload)]:[operation,JSON.stringify(payload),session_hash];
   const call=name==='league_admin'?'$1,$2,$3::jsonb':'$1,$2::jsonb,$3';
   return (await db.query(`select public.${name}(${call}) as result`,params)).rows[0].result;
  }catch(error){const match=/^(\d{3})\|(.+)$/.exec(error.message);if(match)throw new APIError(Number(match[1]),match[2]);throw error;}
 };
 return {db,rpc,adminRPC:otherRPC('league_admin'),googleRPC:otherRPC('league_google')};
}
