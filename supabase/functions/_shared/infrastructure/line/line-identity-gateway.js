export function createLineIdentityGateway({ channelId, fetchImpl = fetch }) {
  return {
    async authenticate(request) {
      const idToken = request.headers.get('x-line-id-token');
      if (!idToken) throw new Error('LINE_ID_TOKEN_REQUIRED');
      if (!channelId) throw new Error('SERVER_CONFIGURATION_ERROR');
      const response = await fetchImpl('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: idToken, client_id: channelId })
      });
      if (!response.ok) throw new Error('LINE_ID_TOKEN_INVALID');
      const payload = await response.json();
      if (!payload.sub) throw new Error('LINE_USER_ID_MISSING');
      return payload;
    }
  };
}
