import { createHash, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest();
export function passwordGate(password) {
  return (req, res, next) => {
    if (!password || req.path === '/healthz') return next();
    const header = req.get('authorization') || '';
    const decoded = /^Basic /i.test(header) ? Buffer.from(header.slice(6), 'base64').toString('utf8') : '';
    const expected = `sunodlc:${password}`;
    if (timingSafeEqual(digest(decoded), digest(expected))) return next();
    res.set('WWW-Authenticate', 'Basic realm="SunoDL", charset="UTF-8"');
    res.status(401).send('Sign in to use SunoDL.');
  };
}
