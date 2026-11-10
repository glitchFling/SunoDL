import test from 'node:test';
import assert from 'node:assert/strict';
import {artworkUrl, fetchArtwork} from './artwork.js';

test('artwork retrieval permits only HTTPS Suno CDN URLs',()=>{
  assert.equal(artworkUrl('https://cdn2.suno.ai/cover.jpeg'),'https://cdn2.suno.ai/cover.jpeg');
  for(const url of ['http://cdn2.suno.ai/cover.jpg','https://example.com/cover.jpg','https://cdn2.suno.ai.evil.example/cover.jpg','https://cdn2.suno.ai:8443/cover.jpg','https://user:pass@cdn2.suno.ai/cover.jpg']) assert.equal(artworkUrl(url),null);
});
test('artwork retrieval checks image signatures, bounds bytes, and forbids redirects',async()=>{
  const png=Buffer.from([137,80,78,71,13,10,26,10]);
  const image=await fetchArtwork('https://cdn2.suno.ai/image.png',{fetchImage:async(url,options)=>{assert.equal(options.redirect,'error');return new Response(png);}});
  assert.equal(image.ext,'png');assert.deepEqual(image.bytes,png);
  await assert.rejects(fetchArtwork('https://cdn2.suno.ai/image.png',{fetchImage:async()=>new Response('not an image')}),/supported image/);
  await assert.rejects(fetchArtwork('https://cdn2.suno.ai/image.png',{fetchImage:async()=>new Response(Buffer.alloc(2*1024*1024+1))}),/too large/);
});
