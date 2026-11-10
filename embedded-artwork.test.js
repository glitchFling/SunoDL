import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import ffmpeg from 'ffmpeg-static';
import {embedArtwork,audioPictures} from './embedded-artwork.js';
const run=promisify(execFile);

test('embeds the matching image and preserves audio packets in MP3, AAC/Opus MP4, FLAC and WAV',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'sunodl-tags-'));
  const hash=async file=>(await run(ffmpeg,['-v','error','-i',file,'-map','0:a:0','-c:a','copy','-f','hash','-hash','sha256','-'])).stdout.trim();
  try {
    const cover=path.join(folder,'cover.jpg');
    await run(ffmpeg,['-v','error','-f','lavfi','-i','color=c=red:s=32x32','-frames:v','1','-threads','1',cover]);
    const image={bytes:await readFile(cover),ext:'jpg'};
    for(const [label,ext,codec,extra] of [
      ['mp3','.mp3','libmp3lame',[]],['aac','.m4a','aac',[]],
      ['opus','.m4a','libopus',['-f','mp4']],['flac','.flac','flac',[]],['wav','.wav','pcm_s16le',[]]
    ]) {
      const source=path.join(folder,label+ext);
      await run(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.25','-c:a',codec,...extra,source]);
      const original=await readFile(source);
      const result=await embedArtwork(original,ext,image,{folder,index:label,title:'Track',album:'Playlist'});
      assert.equal(result.embedded,true,label);
      const pictures=await audioPictures(result.bytes);
      assert.ok(pictures.some(p=>Buffer.from(p.data).equals(image.bytes)),label+' cover bytes');
      const {writeFile}=await import('node:fs/promises');
      const tagged=path.join(folder,label+'-tagged'+ext);await writeFile(tagged,result.bytes);
      assert.equal(await hash(tagged),await hash(source),label+' audio packets');
    }
  } finally {await rm(folder,{recursive:true,force:true});}
});
