import * as jose from 'npm:jose@6.2.17';
import {googleVerifier} from '../_shared/google.mjs';
import {Image} from 'npm:imagescript@3.20.2';
import {createHandler} from './handler.mjs';
import {database} from '../_shared/database.mjs';
import {avatars} from '../_shared/avatars.mjs';
const url=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
Deno.serve(createHandler({rpc:database(url,key),photos:avatars(url,key,Image),adminRPC:database(url,key,fetch,'league_admin'),googleRPC:database(url,key,fetch,'league_google'),google:googleVerifier(Deno.env.get('GOOGLE_CLIENT_ID'),jose)}));
