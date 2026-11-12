// Standard Web Crypto PBKDF2; no custom password primitive. 600k SHA-256 rounds.
const encoder=new TextEncoder();
export const hex = bytes => Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g)||[],x=>parseInt(x,16));
export const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async value => hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
async function derive(password,salt) {
 const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
 return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:600000},key,256));
}
export async function hashPassword(password) {
 const salt=crypto.getRandomValues(new Uint8Array(16));
 return `pbkdf2-sha256-v1$600000$${hex(salt)}$${hex(await derive(password,salt))}`;
}
export async function verifyPassword(password,encoded) {
 // Always perform the expensive operation for unknown users too.
 const match=/^pbkdf2-sha256-v1\$600000\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(encoded||'');
 const actual=await derive(password,unhex(match?.[1]||'0'.repeat(32)));
 const expected=unhex(match?.[2]||'0'.repeat(64));
 // Web Crypto verifies a fixed-message HMAC to compare derived secrets without an
 // application-level, early-exit byte comparison.
 const key=await crypto.subtle.importKey('raw',actual,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const verificationKey=await crypto.subtle.importKey('raw',expected,{name:'HMAC',hash:'SHA-256'},false,['verify']);
 const message=encoder.encode('Print League password verification');
 const signature=await crypto.subtle.sign('HMAC',key,message);
 return await crypto.subtle.verify('HMAC',verificationKey,signature,message) && !!match;
}
