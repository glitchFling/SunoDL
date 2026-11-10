const API_VERSION = '2026-07-01';
const PAGE_ORIGIN = 'https://sunodl-55q.pages.dev';
let cachedToken = null;
let tokenExpiresAt = 0;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}
});

function config(env) {
  const {AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SUBSCRIPTION_ID} = env;
  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET || !AZURE_SUBSCRIPTION_ID) {
    throw Error('Azure server controls are not configured.');
  }
  return {
    tenantId: AZURE_TENANT_ID,
    clientId: AZURE_CLIENT_ID,
    clientSecret: AZURE_CLIENT_SECRET,
    resourceId: `/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/UltraPlaysCode/providers/Microsoft.App/containerApps/sunodlc`
  };
}

async function accessToken(env) {
  const values = config(env);
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return {token: cachedToken, ...values};

  const body = new URLSearchParams({
    client_id: values.clientId,
    client_secret: values.clientSecret,
    grant_type: 'client_credentials',
    scope: 'https://management.azure.com/.default'
  });
  const response = await fetch(`https://login.microsoftonline.com/${values.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body
  });
  if (!response.ok) throw Error('Azure authentication failed.');
  const result = await response.json();
  cachedToken = result.access_token;
  tokenExpiresAt = Date.now() + Number(result.expires_in || 3600) * 1000;
  return {token: cachedToken, ...values};
}

async function managementRequest(token, resourceId, action = '') {
  const suffix = action ? `/${action}?api-version=${API_VERSION}` : `?api-version=${API_VERSION}`;
  return fetch(`https://management.azure.com${resourceId}${suffix}`, {
    method: action ? 'POST' : 'GET',
    headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'}
  });
}

export async function onRequestGet({env}) {
  try {
    const {token, resourceId} = await accessToken(env);
    const response = await managementRequest(token, resourceId);
    if (!response.ok) return json({error: 'Azure server status is unavailable.'}, 502);
    const resource = await response.json();
    return json({status: resource.properties?.runningStatus || 'Unknown'});
  } catch {
    return json({error: 'Azure server status is unavailable.'}, 502);
  }
}

export async function onRequestPost({request, env}) {
  if (request.headers.get('Origin') !== PAGE_ORIGIN) return json({error: 'This control request is not allowed.'}, 403);
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return json({error: 'Send a JSON server action.'}, 415);
  }

  let action;
  try { ({action} = await request.json()); }
  catch { return json({error: 'The server action is invalid.'}, 400); }
  if (action !== 'start' && action !== 'stop') return json({error: 'Choose start or stop.'}, 400);

  try {
    const {token, resourceId} = await accessToken(env);
    const response = await managementRequest(token, resourceId, action);
    if (!response.ok) return json({error: action === 'stop' ? 'Azure could not pause the server.' : 'Azure could not start the server.'}, 502);
    return json({accepted: true, status: action === 'stop' ? 'Stopping' : 'Starting'});
  } catch {
    return json({error: 'Azure could not change the server state.'}, 502);
  }
}
