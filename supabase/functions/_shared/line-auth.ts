export type VerifiedLineUser = {
  sub: string;
  name?: string;
  picture?: string;
};

export async function verifyLineIdToken(idToken: string): Promise<VerifiedLineUser> {
  const channelId = Deno.env.get('LINE_LOGIN_CHANNEL_ID');
  if (!channelId) throw new Error('LINE_LOGIN_CHANNEL_ID is not configured');

  const response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId })
  });
  if (!response.ok) throw new Error('LINE_ID_TOKEN_INVALID');
  const payload = await response.json();
  if (!payload.sub) throw new Error('LINE_USER_ID_MISSING');
  return payload as VerifiedLineUser;
}
