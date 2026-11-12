import {APIError} from './validation.mjs';
export function googleVerifier(clientID,{jwtVerify,createRemoteJWKSet},keys) {
 if(!clientID)return null;
 if(!/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientID))throw Error('Invalid Google client configuration');
 const jwks=keys||createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
 return {clientID,async verify(credential){
  try {
   const {payload}=await jwtVerify(credential,jwks,{
    algorithms:['RS256'],issuer:['https://accounts.google.com','accounts.google.com'],audience:clientID,
    requiredClaims:['sub','exp','iat','nonce'],maxTokenAge:'10m',clockTolerance:5
   });
   if(typeof payload.sub!=='string'||!payload.sub||payload.sub.length>255||typeof payload.nonce!=='string'||!/^[a-f0-9]{64}$/.test(payload.nonce))throw Error('Invalid identity');
   // Identity uses only the stable subject. A verified Gmail local part is an
   // optional username seed; the email itself is never stored or used for merging.
   const gmailName=payload.email_verified===true&&typeof payload.email==='string'&&/^[^@]+@(gmail\.com|googlemail\.com)$/i.test(payload.email)?payload.email.split('@')[0].replace(/[^a-zA-Z0-9._-]/g,'').slice(0,32):null;
   return {subject:payload.sub,nonce:payload.nonce,gmailName};
  } catch {throw new APIError(403,'Google sign-in could not be verified. Please try again.');}
 }};
}
