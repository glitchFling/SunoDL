const unauthorized = () => new Response('Sign in to use SunoDL.', {
  status: 401,
  headers: {'WWW-Authenticate': 'Basic realm="SunoDL", charset="UTF-8"'}
});

function constantTimeEqual(left, right) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function onRequest({request, env, next}) {
  if (!env.APP_PASSWORD) return new Response('SunoDL authentication is not configured.', {status: 503});
  const expected = `Basic ${btoa(`sunodlc:${env.APP_PASSWORD}`)}`;
  const supplied = request.headers.get('Authorization') || '';
  if (!constantTimeEqual(supplied, expected)) return unauthorized();
  return next();
}
