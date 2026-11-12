import {APIError} from './validation.mjs';
export async function sanitizePhoto(raw,Image) {
 if(raw.length>2*1024*1024)throw new APIError(413,'Profile photos must be 2 MB or smaller.');
 const label=(start,end)=>String.fromCharCode(...raw.subarray(start,end));
 const png=raw[0]===137 && label(1,4)==='PNG';
 const jpeg=raw[0]===255 && raw[1]===216 && raw[2]===255;
 const webp=label(0,4)==='RIFF' && label(8,12)==='WEBP';
 if(!png&&!jpeg&&!webp)throw new APIError(400,'Choose a JPEG, PNG, or WebP photo.');
 // Reject animation containers before decoding frames, including APNG.
 const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
 for(let offset=png?8:12;(png||webp)&&offset+8<=raw.length;) {
  const type=png?label(offset+4,offset+8):label(offset,offset+4);
  const size=view.getUint32(png?offset:offset+4,webp);
  if(type==='acTL'||type==='ANIM'||type==='ANMF')throw new APIError(400,'Choose a still photo rather than an animation.');
  const step=png?size+12:8+size+(size%2);
  if(step<8||offset+step>raw.length)throw new APIError(400,'Invalid photo.');
  offset+=step;
 }
 try {
  const image=await Image.decode(raw,{maxPixels:16000000,threads:1,applyOrientation:true,gainMap:false});
  image.cover(512,512);
  // Copy pixels into a fresh image so EXIF, GPS, comments and profiles cannot survive.
  const clean=new Image(512,512);clean.bitmap=new Uint8Array(image.bitmap);
  const output=await clean.encodeJPEG({quality:85,metadata:false});
  if(output.length>262144)throw new Error('Encoded photo exceeds limit');
  return output;
 } catch(error) {
  if(error instanceof APIError)throw error;
  throw new APIError(400,'Use a valid still photo of at most 16 megapixels.');
 }
}
