import {casefold} from './casefold.mjs';
export class APIError extends Error { constructor(status,message) {super(message);this.status=status;} }
export function field(body,key,max=160) {
 const value=body[key];
 if(typeof value!=='string'||!value.trim()||Array.from(value.trim()).length>max) throw new APIError(400,'Invalid '+key);
 return value.trim();
}
export function password(body,key='password',minimum=12) {
 const value=body[key];
 if(typeof value!=='string'||Array.from(value).length<minimum||Array.from(value).length>256) throw new APIError(400,`Use ${minimum}–256 characters for your password.`);
 return value;
}
export const normalize = name => casefold(name.trim());
// Match Python split/strip whitespace, including its additional C0 separators.
export const collapse = name => name.replace(/[\s\u001c-\u001f\u0085]+/gu,' ').trim();
export const topicKey = name => casefold(collapse(name));
export function date(value,label,optional=false) {
 if(optional && !value)return null;
 if(typeof value!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value))) throw new APIError(400,'Use a complete date and timezone for '+label);
 return new Date(value).toISOString();
}
export function printLink(body) {
 const raw=field(body,'url',2048);let url;
 try {url=new URL(raw);} catch {throw new APIError(400,'Use a complete print URL.');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||/[\x00-\x20\x7f\\]/.test(raw)) throw new APIError(400,'Use an HTTP or HTTPS URL without login details.');
 const image=body.preview_image||'';
 if(typeof image!=='string'||image.length>2048) throw new APIError(400,'Invalid preview image.');
 if(image) {
  let picture;try {picture=new URL(image);} catch {throw new APIError(400,'Use a direct provider image URL.');}
  if(picture.protocol!=='https:'||!['makerworld.bblmw.com','media.printables.com','media.prusaprinters.org'].includes(picture.hostname)||picture.username||picture.password||picture.port||/[\x00-\x20\x7f\\]/.test(image)) throw new APIError(400,'Use a direct HTTPS image from MakerWorld or Printables.');
 }
 return {url:raw,title:field({title:body.title||url.hostname},'title',120),preview_image:image};
}
