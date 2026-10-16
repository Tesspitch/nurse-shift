export function createLinePushGateway({ channelAccessToken, fetchImpl = fetch }) {
  return {
    async sendTest(lineUserId) {
      if (!channelAccessToken) throw new Error('SERVER_CONFIGURATION_ERROR');
      const response = await fetchImpl('https://api.line.me/v2/bot/message/push', {
        method: 'POST', headers: { Authorization: `Bearer ${channelAccessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text: 'ทดสอบแจ้งเตือน NurseShift สำเร็จ\nระบบพร้อมส่งการแจ้งเตือนเวรให้คุณแล้ว' }] })
      });
      if (!response.ok) throw new Error('LINE_PUSH_FAILED');
    }
  };
}
