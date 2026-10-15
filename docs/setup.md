# คู่มือตั้งค่า LINE, Supabase และ Vercel

## 1. สิ่งที่ต้องมี

- Supabase project
- LINE Official Account ที่เปิด Messaging API
- LINE Login channel หรือ LINE MINI App สำหรับ LIFF โดยต้องอยู่ใต้ LINE Provider เดียวกับ Messaging API channel
- Vercel project สำหรับ deploy frontend

ไม่ใส่ Channel secret, Channel access token หรือ Supabase secret key ไว้ใน frontend, Git หรือข้อความแชต

## 2. Supabase

ติดตั้ง Supabase CLI และ link project จากเครื่องของเจ้าของระบบ จากนั้นรัน:

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase functions deploy app-api
supabase functions deploy send-reminders
supabase functions deploy line-webhook
```

ตั้งค่า Edge Function secrets โดยกรอกค่าจริงจากเครื่องของเจ้าของระบบ:

```bash
supabase secrets set LINE_LOGIN_CHANNEL_ID=YOUR_LINE_LOGIN_CHANNEL_ID
supabase secrets set LINE_CHANNEL_ACCESS_TOKEN=YOUR_MESSAGING_API_CHANNEL_ACCESS_TOKEN
supabase secrets set LINE_MESSAGING_CHANNEL_SECRET=YOUR_MESSAGING_API_CHANNEL_SECRET
supabase secrets set LINE_LIFF_URL=https://liff.line.me/2012030979-CQQzGFWo
supabase secrets set LINE_RICH_MENU_PAGE_2_ID=YOUR_PAGE_2_RICH_MENU_ID
supabase secrets set REMINDER_CRON_SECRET=YOUR_RANDOM_SECRET
# ตัวเลือก: จำกัด origin เพิ่มเติม โดยคั่นแต่ละ URL ด้วย comma
supabase secrets set ALLOWED_WEB_ORIGINS=https://costnurse.vercel.app
```

`LINE_CHANNEL_ACCESS_TOKEN` และ `REMINDER_CRON_SECRET` เป็นความลับ ห้ามใส่ในไฟล์ `.env` ของ frontend

การตั้งค่า Rich Menu หน้า 2, alias และ LINE webhook อยู่ใน [PHASE4_LINE_SETUP.md](PHASE4_LINE_SETUP.md) ขั้นตอนเหล่านี้ห้ามเปลี่ยน Production ก่อนผ่านการทดสอบแบบควบคุม

หลังจากนั้นเปิด SQL Editor และปรับ placeholder ใน `supabase/cron.sql.example` ก่อนรัน เพื่อเรียก `send-reminders` ทุก 5 นาที

## 3. LINE LIFF

สร้าง LIFF app แบบ Full และเปิด scopes อย่างน้อย:

- `openid`
- `profile`

นำ URL ที่ Vercel deploy แล้วไปใส่เป็น Endpoint URL ของ LIFF จากนั้นนำ LIFF ID ไปใช้เป็น `VITE_LIFF_ID`

ระบบส่ง raw ID token ไปยัง Supabase Edge Function และให้ server ตรวจ token กับ LINE ก่อนใช้ `sub` เป็นตัวระบุผู้ใช้ ไม่เชื่อข้อมูล profile จาก browser สำหรับการยืนยันตัวตน

ผู้ใช้ต้องเพิ่ม Official Account เป็นเพื่อนก่อนจึงจะรับ push message ได้ และ LINE Login channel กับ Messaging API channel ควรอยู่ใต้ Provider เดียวกันเพื่อให้ user ID สอดคล้องกัน

## 4. Frontend environment

ตั้ง Environment Variables ใน Vercel:

```text
VITE_LIFF_ID=LIFF_ID_FROM_LINE
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
VITE_MOCK_MODE=false
```

ค่าทั้งสามรายการแรกเป็นค่าที่ browser จำเป็นต้องใช้ ห้ามนำ Supabase secret/service role key มาใส่แทน publishable key

## 5. Deploy Vercel

เชื่อม repository กับ Vercel แล้วใช้ค่าต่อไปนี้:

- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`

หลัง deploy ให้นำ production URL กลับไปตั้งเป็น LIFF Endpoint URL แล้วทดสอบจาก LIFF URL ในแอป LINE

## 6. Checklist ก่อนให้คนรู้จักใช้

- ผู้ใช้ใหม่เปิด LIFF และผ่าน onboarding ได้
- ปิดหน้าแล้วเปิดใหม่ ข้อมูลยังอยู่ใน Supabase
- เพิ่มเวรหลายรายการในวันเดียวได้ และเวลาเหลื่อมกันมีคำเตือน
- เวรข้ามคืนคิดชั่วโมงถูกต้องโดยไม่หักเวลาพัก
- OT เคสด่วนรับเฉพาะจำนวนเต็ม
- รอบวันที่ 25 ถึง 24 และค่าประเภทเวรตรงกับผู้ใช้
- LINE ส่งเตือนก่อน 1 วันและก่อน 1 ชั่วโมงเพียงครั้งเดียว
- ปุ่ม “ส่งข้อความทดสอบ” ส่งถึงผู้ใช้ได้ และหน้าแสดงว่าเพิ่ม Official Account แล้ว
- ทดลองเพิ่มเวลาแจ้งเตือนเองทั้งหน่วยนาที ชั่วโมง และวัน
- ทดสอบ Export CSV, PDF, สำรอง JSON และนำ JSON กลับเข้า
- เปิดสองอุปกรณ์พร้อมกันแล้วข้อมูลเก่าไม่เขียนทับข้อมูลใหม่โดยไม่แจ้งเตือน
- ตรวจ Edge Function logs หากมี `REMINDER_SEND_FAILED`; ระบบจะ Retry สูงสุด 3 ครั้ง
- สลิปแสดงข้อความว่าเป็นสรุปส่วนบุคคล ไม่ใช่เอกสารจากนายจ้าง
