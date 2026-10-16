export function createLineMessagingGateway({ channelAccessToken, fetchImpl = fetch }) {
  async function post(url, body, errorCode) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${channelAccessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) throw new Error(`${errorCode}_${response.status}`);
  }

  return {
    async reply(replyToken, messages) {
      await post('https://api.line.me/v2/bot/message/reply', { replyToken, messages }, 'LINE_REPLY_FAILED');
    },

    async linkRichMenu(lineUserId, richMenuId) {
      await post(
        `https://api.line.me/v2/bot/user/${encodeURIComponent(lineUserId)}/richmenu/${encodeURIComponent(richMenuId)}`,
        undefined,
        'LINE_RICH_MENU_LINK_FAILED'
      );
    }
  };
}
