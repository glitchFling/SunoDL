import {ZipArchive} from 'archiver';
import {once} from 'node:events';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {byteLimit, MAX_ZIP_BYTES} from './limits.js';

export function createZipWriter(file) {
  const archive = new ZipArchive({forceZip64: true, store: true});
  let failure = null;
  const completed = pipeline(archive, byteLimit(MAX_ZIP_BYTES), createWriteStream(file));
  completed.catch(error => { failure = error; });

  return {
    async append(bytes, name) {
      if (failure) throw failure;
      const written = once(archive, 'entry');
      archive.append(bytes, {name});
      await written;
      if (failure) throw failure;
    },
    async finish() {
      if (failure) throw failure;
      await archive.finalize();
      await completed;
    },
    async abort() {
      archive.abort();
      await completed.catch(() => {});
    }
  };
}
