const API_ORIGIN = 'https://sunodlc.delightfulpond-84f29b0e.westus2.azurecontainerapps.io';

export async function onRequest({request}) {
  const incoming = new URL(request.url);
  const upstream = new URL(incoming.pathname + incoming.search, API_ORIGIN);
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');

  const init = {method: request.method, headers, redirect: 'manual'};
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }
  return fetch(upstream, init);
}
