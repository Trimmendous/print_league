import postgres from 'npm:postgres@3.4.9';
import * as jose from 'npm:jose@6.2.17';
import {googleVerifier} from '../_shared/google.mjs';
import {Image} from 'npm:imagescript@3.20.2';
import {createHandler} from './handler.mjs';
import {database,postgresTransaction} from '../_shared/database.mjs';
import {avatars} from '../_shared/avatars.mjs';
import {createLeague} from '../_shared/league.mjs';
const url=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const useSqlRPC=Deno.env.get('LEAGUE_RPC_MODE')==='sql';
const dbUrl=Deno.env.get('LEAGUE_DB_URL')||Deno.env.get('SUPABASE_DB_URL');
const sql=!useSqlRPC&&dbUrl?postgres(dbUrl,{max:1,prepare:false,fetch_types:false,idle_timeout:20,connect_timeout:5}):null;
const rpc=useSqlRPC?database(url,key):createLeague(postgresTransaction(sql));
Deno.serve(createHandler({
 rpc,
 photos:avatars(url,key,Image),
 adminRPC:database(url,key,fetch,'league_admin'),
 googleRPC:database(url,key,fetch,'league_google'),
 google:googleVerifier(Deno.env.get('GOOGLE_CLIENT_ID'),jose),
 scheduleRPC:database(url,key,fetch,'league_schedule'),
 shoppingRPC:database(url,key,fetch,'league_shopping'),
 signalToken:Deno.env.get('LEAGUE_SIGNAL_TOKEN')
}));
