# Phase 4 — LINE Rich Menu Page 2 และ LINE Bot

เอกสารนี้เป็นขั้นตอนเตรียม deployment เท่านั้น การเพิ่ม Rich Menu, Alias, Webhook, Migration หรือ Edge Function ใน Production ต้องได้รับอนุญาตก่อนเสมอ

## แนวทาง Navigation ที่เลือก

Rich Menu หน้าแรกมีพื้นที่ใช้งานครบทั้ง 4 ส่วน จึงไม่แก้ภาพหรือ action เดิมตาม requirement

- ผู้ใช้พิมพ์ `เมนูเพิ่มเติม` ในแชตส่วนตัวเพื่อให้ Bot ผูก Rich Menu หน้า 2 กับบัญชี LINE คนนั้น
- หน้า 2 มีปุ่ม `กลับหน้าหลัก` ซึ่งใช้ `richmenuswitch` ไปยัง alias `nurseshift-main`
- สร้าง alias `nurseshift-quick-info` ไว้สำหรับหน้า 2 โดยไม่เปลี่ยน Default Rich Menu

## ไฟล์ที่พร้อมใช้

- `assets/line-rich-menu-page-2.png` — ภาพ PNG ขนาด 2500×1686 และต่ำกว่า 1 MB
- `assets/line-rich-menu-page-2.svg` — source สำหรับแก้ไขภายหลัง
- `docs/line-rich-menu-page-2.json` — Rich Menu areas และ actions
- `supabase/functions/line-webhook/index.ts` — LINE webhook
- `supabase/migrations/202610150005_line_webhook_events.sql` — idempotency log และ atomic claim

## Secrets ของ Supabase Edge Function

ตั้งค่าผ่าน Supabase Secrets เท่านั้น ห้ามใส่ใน frontend หรือ commit ค่าจริงลง Git

```text
LINE_MESSAGING_CHANNEL_SECRET=<Channel secret จาก Messaging API>
LINE_CHANNEL_ACCESS_TOKEN=<Channel access token จาก Messaging API>
LINE_LIFF_URL=https://liff.line.me/2012030979-CQQzGFWo
LINE_RICH_MENU_PAGE_2_ID=<กำหนดหลังสร้าง Rich Menu หน้า 2>
```

`SUPABASE_URL` และ service-role secret เป็น environment ที่ Supabase จัดให้ Edge Function อยู่แล้ว ระบบรองรับรูปแบบ secret เดิมของโปรเจกต์ด้วย

## ลำดับ Deployment หลังได้รับอนุญาต

1. สำรอง Rich Menu ID, areas, aliases และ Default Rich Menu ปัจจุบันจาก LINE Console/API
2. Apply migration `202610150005_line_webhook_events.sql`
3. Deploy Edge Function `line-webhook` โดยปิด Supabase JWT verification ตาม `supabase/config.toml` เพราะ webhook ใช้ LINE signature แทน
4. ตั้ง secrets ด้านบน
5. สร้าง Rich Menu จาก `docs/line-rich-menu-page-2.json` แล้วอัปโหลด PNG
6. สร้าง alias `nurseshift-main` ให้ชี้ Rich Menu หน้าแรกเดิม และ `nurseshift-quick-info` ให้ชี้หน้า 2
7. นำ Rich Menu ID หน้า 2 ไปตั้งเป็น `LINE_RICH_MENU_PAGE_2_ID`
8. ตั้ง Webhook URL เป็น `https://<PROJECT_REF>.supabase.co/functions/v1/line-webhook`
9. กด Verify ใน LINE Developers แล้วเปิด Use webhook
10. ทดสอบกับบัญชีควบคุมก่อน โดยยังไม่เปลี่ยน Default Rich Menu

## API Payload สำหรับ Alias

ส่งไปที่ `POST https://api.line.me/v2/bot/richmenu/alias` พร้อม Messaging API access token

```json
{
  "richMenuAliasId": "nurseshift-main",
  "richMenuId": "<EXISTING_MAIN_RICH_MENU_ID>"
}
```

```json
{
  "richMenuAliasId": "nurseshift-quick-info",
  "richMenuId": "<NEW_PAGE_2_RICH_MENU_ID>"
}
```

หาก alias มีอยู่แล้วให้ใช้ endpoint update ของ LINE แทนการสร้างซ้ำ

## Checklist ทดสอบแบบควบคุม

- Rich Menu หน้าแรกและ 4 actions เดิมไม่เปลี่ยน
- พิมพ์ `เมนูเพิ่มเติม` แล้วเห็นหน้า 2
- ปุ่มกลับหน้าหลักสลับกลับได้
- Postback ทั้ง 6 รายการตอบเพียงครั้งเดียว
- รายได้เดือนนี้ตอบเฉพาะแชตส่วนตัว
- ผู้ใช้ที่ยังไม่เชื่อม NurseShift ได้ข้อความให้เปิด LIFF
- เวรถัดไป, วันหยุด, OT และรายได้ตรงกับข้อมูล Supabase ของผู้กด
- LINE Verify ผ่านและ invalid signature ได้ HTTP 401

## Rollback

- ยกเลิกการผูก Rich Menu หน้า 2 จากผู้ใช้ทดสอบ แล้วผูก Rich Menu หน้าแรกเดิมกลับ
- ปิด Use webhook หรือคืน Webhook URL เดิม หากระบบเดิมใช้ endpoint อื่น
- ไม่ต้องลบหน้าแรกหรือเปลี่ยน Default Rich Menu
- Migration เป็นแบบเพิ่มอย่างเดียว ตาราง event log สามารถคงไว้ได้โดยไม่กระทบแอปเดิม
