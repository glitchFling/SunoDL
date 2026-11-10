import ffmpeg from 'ffmpeg-static';
import {parseBuffer} from 'music-metadata';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
const run = promisify(execFile);

export async function audioPictures(bytes) {
  const metadata = await parseBuffer(bytes, {size:bytes.length});
  return metadata.common.picture || [];
}

function id3TextFrame(id, value) {
  const text = Buffer.from(String(value), 'utf16le');
  const body = Buffer.concat([Buffer.from([1, 0xff, 0xfe]), text]);
  const frame = Buffer.alloc(10);
  frame.write(id, 0, 4, 'ascii');
  frame.writeUInt32BE(body.length, 4);
  return Buffer.concat([frame, body]);
}

// WAV carries artwork and tags in an ID3 chunk. Preserve every other RIFF
// chunk, including the original PCM data, byte for byte.
function waveTags(bytes, {title, album, track} = {}, image) {
  if (bytes.toString('ascii',0,4)!=='RIFF' || bytes.toString('ascii',8,12)!=='WAVE') throw Error('Invalid WAV file.');
  const frames = [];
  if (title) frames.push(id3TextFrame('TIT2', title));
  if (album) frames.push(id3TextFrame('TALB', album));
  if (track) frames.push(id3TextFrame('TRCK', track));
  if (image) {
    const mime=Buffer.from(image.ext==='png'?'image/png\0':'image/jpeg\0');
    const picture=Buffer.concat([Buffer.from([0]),mime,Buffer.from([3,0]),image.bytes]);
    const frame=Buffer.alloc(10);frame.write('APIC');frame.writeUInt32BE(picture.length,4);
    frames.push(Buffer.concat([frame,picture]));
  }
  const payload = Buffer.concat(frames);
  const size=payload.length, header=Buffer.from([73,68,51,3,0,0,(size>>>21)&127,(size>>>14)&127,(size>>>7)&127,size&127]);
  const tag=Buffer.concat([header,payload]);
  const chunk=Buffer.alloc(8);chunk.write('id3 ');chunk.writeUInt32LE(tag.length,4);
  const pieces=[bytes.subarray(0,12)];
  for(let offset=12;offset+8<=bytes.length;) {
    const length=bytes.readUInt32LE(offset+4), end=offset+8+length+(length%2);
    if(end>bytes.length) throw Error('Invalid WAV chunk.');
    if(bytes.toString('ascii',offset,offset+4).toLowerCase()!=='id3 ') pieces.push(bytes.subarray(offset,end));
    offset=end;
  }
  pieces.push(chunk,tag);if(tag.length%2)pieces.push(Buffer.from([0]));
  const output=Buffer.concat(pieces);output.writeUInt32LE(output.length-8,4);return output;
}

export async function embedArtwork(bytes, extension, image, {folder,index,signal,title,album,track}={}) {
  const ext=extension.toLowerCase();
  let existing=[];
  try { existing=await audioPictures(bytes); }
  catch(error) {
    // Some of Suno's original M4A-Opus files are valid MP4 containers that
    // music-metadata cannot identify. FFmpeg can still remux them and attach tags.
    if(ext!=='.m4a') throw error;
  }
  if(!['.mp3','.m4a','.mp4','.flac','.wav'].includes(ext)) return {bytes,embedded:existing.length>0,tagged:false};
  if(ext==='.wav') {
    const existingImage=existing[0] ? {bytes:Buffer.from(existing[0].data),ext:/png/i.test(existing[0].format||'')?'png':'jpg'} : null;
    const tagged=waveTags(bytes,{title,album,track},image||existingImage);
    const pictures=await audioPictures(tagged);
    if(image&&!pictures.some(p=>Buffer.from(p.data).equals(image.bytes))) throw Error('Embedded cover verification failed.');
    return {bytes:tagged,embedded:image ? pictures.some(p=>Buffer.from(p.data).equals(image.bytes)) : existing.length>0,tagged:true};
  }
  const input=path.join(folder,`tag-input-${index}${ext}`);
  const cover=image ? path.join(folder,`tag-cover-${index}.${image.ext}`) : null;
  const output=path.join(folder,`tag-output-${index}${ext}`);
  const convertedCover=path.join(folder,`tag-cover-${index}.jpg`);
  try {
    await writeFile(input,bytes);
    if(image) await writeFile(cover,image.bytes);
    if(image?.ext==='webp') {
      await run(ffmpeg,['-nostdin','-v','error','-y','-i',cover,'-frames:v','1','-threads','1',convertedCover],{signal,timeout:30000,maxBuffer:262144});
      image={bytes:await readFile(convertedCover),ext:'jpg'};
    }
    const args=['-nostdin','-v','error','-y','-i',input];
    if(image) args.push('-i',image.ext==='jpg' && path.extname(cover)==='.webp'?convertedCover:cover);
    args.push('-map','0:a:0');
    if(image) args.push('-map','1:v:0');
    else if(existing.length||ext==='.m4a') args.push('-map','0:v?');
    args.push('-map_metadata','0','-c','copy');
    if(image) args.push('-disposition:v:0','attached_pic','-metadata:s:v:0','title=Album cover','-metadata:s:v:0','comment=Cover (front)');
    if(title)args.push('-metadata',`title=${title}`);
    if(album)args.push('-metadata',`album=${album}`);
    if(track)args.push('-metadata',`track=${track}`);
    if(ext==='.mp3')args.push('-id3v2_version','3');
    // The source may put Opus in an MP4 container with an .m4a suffix.
    // Use the general MP4 muxer; FFmpeg's extension-selected iPod muxer
    // rejects that codec even though the original audio is valid.
    if(ext==='.m4a'||ext==='.mp4')args.push('-f','mp4','-movflags','+faststart');
    args.push(output);
    await run(ffmpeg,args,{signal,timeout:30000,maxBuffer:262144});
    const tagged=await readFile(output);
    // Verify the bytes inside the audio metadata, not an adjacent image file.
    let pictures=[];
    try { pictures=await audioPictures(tagged); }
    catch(error) {
      if(ext!=='.m4a') throw error;
      // FFmpeg succeeded with the explicit attached_pic mapping above.
      return {bytes:tagged,embedded:Boolean(image),tagged:true};
    }
    const embedded=Boolean(image&&pictures.some(p=>Buffer.from(p.data).equals(image.bytes)));
    if(image&&!embedded) throw Error('Embedded cover verification failed.');
    return {bytes:tagged,embedded:embedded||(!image&&existing.length>0),tagged:true};
  } catch(error) {
    if(signal?.aborted)throw error;
    throw Error(`Audio tags${image?' and artwork':''} could not be applied to "${title || 'this track'}". Please retry the export.`);
  } finally {
    await Promise.all([input,cover,output,convertedCover].filter(Boolean).map(file=>rm(file,{force:true}).catch(()=>{})));
  }
}
