import {
  bangkokMonthRange,
  calculateBotMonthSummary,
  canShowActionInSource,
  parsePostbackAction
} from '../line-bot.js';
import { createFlexMessage } from '../presentation/line-flex-messages.js';

const UNLINKED_ACCOUNT_TEXT = 'ยังไม่พบบัญชี NurseShift กรุณาเปิดแอปและตั้งค่าให้เรียบร้อยก่อน';
const PRIVATE_DATA_TEXT = 'ข้อมูลรายได้เป็นข้อมูลส่วนตัว กรุณาเปิดแชตส่วนตัวกับ NurseShift';

function monthLabel(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    month: 'long',
    year: 'numeric'
  }).format(new Date(Date.UTC(year, month - 1, 15)));
}

function unlinkedAccountMessage(liffUrl) {
  return [{
    type: 'text',
    text: UNLINKED_ACCOUNT_TEXT,
    quickReply: {
      items: [{
        type: 'action',
        action: { type: 'uri', label: 'เปิด NurseShift', uri: liffUrl }
      }]
    }
  }];
}

export function createLineWebhookProcessor({
  webhookEventRepository,
  lineUserDataRepository,
  lineMessagingGateway,
  liffUrl,
  richMenuPage2Id,
  now = () => new Date()
}) {
  if (!webhookEventRepository?.claim || !webhookEventRepository?.complete) {
    throw new TypeError('WebhookEventRepository.claim and complete are required');
  }
  if (!lineUserDataRepository?.getProfile || !lineUserDataRepository?.getMonthData || !lineUserDataRepository?.getNextShift) {
    throw new TypeError('LineUserDataRepository methods are required');
  }
  if (!lineMessagingGateway?.reply || !lineMessagingGateway?.linkRichMenu) {
    throw new TypeError('LineMessagingGateway methods are required');
  }

  async function handlePostback(event, profile) {
    const action = parsePostbackAction(event.postback?.data);
    if (!action) return [{ type: 'text', text: 'ไม่พบคำสั่งนี้ กรุณาลองจากเมนูอีกครั้ง' }];
    if (!canShowActionInSource(action, event.source?.type)) {
      return [{ type: 'text', text: PRIVATE_DATA_TEXT }];
    }
    if (action === 'help') return [createFlexMessage(action, {}, liffUrl)];
    if (action === 'next_shift') {
      return [createFlexMessage(action, { shift: await lineUserDataRepository.getNextShift(profile.id) }, liffUrl)];
    }

    const data = await lineUserDataRepository.getMonthData(profile.id);
    const monthRange = data.range || bangkokMonthRange(now());
    const summary = calculateBotMonthSummary(data);
    return [createFlexMessage(action, {
      ...data,
      range: monthRange,
      monthLabel: monthLabel(monthRange.monthKey),
      summary
    }, liffUrl)];
  }

  async function processEvent(event) {
    const eventId = String(event.webhookEventId || '');
    if (!eventId || !event.replyToken || !(await webhookEventRepository.claim(eventId))) return;
    try {
      const lineUserId = event.source?.userId;
      if (!lineUserId) {
        await webhookEventRepository.complete(eventId, 'completed');
        return;
      }
      if (event.type === 'message' && event.message?.type === 'text' && event.message.text.trim() === 'เมนูเพิ่มเติม') {
        if (!richMenuPage2Id) throw new Error('LINE_RICH_MENU_PAGE_2_ID_MISSING');
        await lineMessagingGateway.linkRichMenu(lineUserId, richMenuPage2Id);
        await lineMessagingGateway.reply(event.replyToken, [{ type: 'text', text: 'เปิดเมนูข้อมูลด่วนแล้ว แตะเมนูด้านล่างเพื่อใช้งานได้เลย' }]);
        await webhookEventRepository.complete(eventId, 'completed');
        return;
      }
      if (event.type !== 'postback') {
        await webhookEventRepository.complete(eventId, 'completed');
        return;
      }
      const profile = await lineUserDataRepository.getProfile(lineUserId);
      const messages = profile
        ? await handlePostback(event, profile)
        : unlinkedAccountMessage(liffUrl);
      await lineMessagingGateway.reply(event.replyToken, messages);
      await webhookEventRepository.complete(eventId, 'completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
      await webhookEventRepository.complete(eventId, 'failed', message.slice(0, 200));
      console.error(JSON.stringify({ eventId, error: message }));
      throw error;
    }
  }

  return { processEvent };
}
