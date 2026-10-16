# Phase 4 — LINE Rich Menu Page 2 + LINE Bot

อัปเดตแผน: 16 ตุลาคม 2026

สถานะ: **Rich Menu v3 และ Webhook ติดตั้งบน Production แล้ว / รอผู้ใช้ยืนยันจาก LINE client**

เอกสารนี้เป็นแผนดำเนินงาน Phase 4 โดยเฉพาะ การเปลี่ยน Rich Menu, Alias, Webhook, Supabase Secrets หรือ Edge Function บน Production ต้องได้รับอนุญาตก่อนเริ่มขั้นตอนนั้น

## Production Deployment Record

| รายการ | ค่า ณ 16 ตุลาคม 2026 |
|---|---|
| Webhook endpoint | `https://wcfpubbeyihhukrsuing.supabase.co/functions/v1/line-webhook` |
| Webhook status | Active, LINE Verify HTTP 200 |
| หน้าแรกเดิมสำหรับ rollback | `richmenu-19a7913a5836af90c7dd597e80379ee5` |
| หน้าแรก v2 สำหรับ rollback | `richmenu-7dadf4b044f7246010355b8d377b50cd` |
| หน้าแรก v3 (Default) | `richmenu-c8b55ddcbd4e615542730f8f4ebaa8f1` |
| หน้า 2 | `richmenu-36fe0d0e5c16dc83404652f6606b0f7d` |
| Main alias | `nurseshift-main` → หน้าแรก v3 |
| Quick-info alias | `nurseshift-quick-info` → หน้า 2 |

หน้าแรกเดิมยังไม่ถูกลบและใช้ rollback ได้ทันที

## Objective

เพิ่ม Rich Menu หน้า 2 และ LINE Bot สำหรับเรียกดูข้อมูล NurseShift อย่างรวดเร็ว โดย:

- Rich Menu หน้าแรกยังคง 4 actions เดิม และเพิ่มปุ่ม `ข้อมูลด่วน · เมนูเพิ่มเติม` ตามการอนุมัติของผู้ใช้
- ผู้ใช้แตะปุ่มบนหน้าแรกเพื่อสลับไปหน้า 2 ได้ทันที และยังพิมพ์ `เมนูเพิ่มเติม` เป็นทางเลือกสำรองได้
- หน้า 2 แสดงข้อมูลจริงของผู้ใช้ที่เชื่อมบัญชี LINE แล้ว
- ข้อมูลรายได้ตอบเฉพาะแชตส่วนตัว
- ทุก Webhook ต้องตรวจ LINE signature และป้องกัน event ซ้ำ

## Scope

อยู่ใน Phase 4:

1. ตรวจสถานะ Messaging API, Webhook, Rich Menu หน้าแรก และ alias แบบ read-only
2. เตรียมและตรวจ Rich Menu หน้า 2 จำนวน 6 ฟังก์ชัน
3. Deploy `line-webhook` หลังได้รับอนุญาต
4. ตั้งค่า secrets ที่จำเป็นใน Supabase Edge Functions
5. สร้าง Rich Menu หน้า 2, หน้าแรก v2 และ aliases โดยคง 4 actions เดิมไว้
6. เชื่อม Webhook URL และทดสอบด้วยบัญชีควบคุม
7. บันทึกหลักฐานการตรวจรับและวิธี rollback

ไม่อยู่ใน Phase 4:

- ลบหรือเปลี่ยนพฤติกรรมของ 4 actions เดิมบนหน้าแรก
- เปลี่ยนสูตรเงินเดือน, OT, ค่าเวร หรือช่วงข้อมูลย้อนหลัง
- เปิด Notification Scheduling V2 หรือแก้ Cron
- เปิด Automatic Data Deletion
- รัน Browser E2E; ใช้ Unit/Contract tests และ controlled LINE smoke test ตามคำสั่งล่าสุด

## Repository Audit

ไฟล์ที่มีและพร้อมใช้:

| รายการ | ไฟล์ | สถานะ |
|---|---|---|
| ภาพ Rich Menu หน้า 2 | `assets/line-rich-menu-page-2.png` | พร้อมอัปโหลด, 2500×1686, 363,627 bytes |
| ภาพ Rich Menu หน้าแรก v3 | `assets/line-rich-menu.jpg` | แถบสลับเต็มความกว้างด้านบน, 2500×1686, อัปโหลดและเปิดใช้งานแล้ว |
| Source ภาพหน้าแรก v3 | `assets/line-rich-menu.svg` | พื้นที่ภาพตรงกับ bounds ใน `docs/line-rich-menu.json` |
| Source ภาพ | `assets/line-rich-menu-page-2.svg` | พร้อมแก้ไขภายหลัง |
| Rich Menu areas/actions | `docs/line-rich-menu-page-2.json` | พร้อม, มี 6 postbacks และ 1 ปุ่มกลับหน้าหลัก |
| LINE Webhook | `supabase/functions/line-webhook/index.ts` | พร้อมสำหรับ controlled deployment |
| Duplicate-event protection | `supabase/migrations/202610150005_line_webhook_events.sql` | มี migration แล้ว; ต้องตรวจสถานะ remote ก่อนดำเนินการ |
| Unit/Contract tests | `tests/line-bot.test.mjs` | มี coverage สำหรับ bot/config |
| Supabase function config | `supabase/config.toml` | `line-webhook.verify_jwt = false` ตามการยืนยันด้วย LINE signature |

Webhook รองรับ actions ต่อไปนี้:

1. `next_shift` — เวรถัดไป
2. `monthly_income` — รายได้เดือนนี้
3. `ot_summary` — สรุป OT
4. `day_off` — วันหยุดเดือนนี้
5. `monthly_shifts` — สรุปเวรเดือนนี้
6. `help` — วิธีใช้งาน

## Navigation ที่เลือก

- ผู้ใช้แตะ `ข้อมูลด่วน · เมนูเพิ่มเติม` บนหน้าแรก หรือพิมพ์ `เมนูเพิ่มเติม` ในแชตส่วนตัว
- Bot ผูก Rich Menu หน้า 2 ให้ LINE user คนนั้น
- หน้า 2 ใช้ alias `nurseshift-quick-info`
- ปุ่ม `กลับหน้าหลัก` ใช้ `richmenuswitch` ไป alias `nurseshift-main`
- Default Rich Menu ไม่ถูกเปลี่ยน

แนวทางนี้รักษา 4 actions เดิมทั้งหมด และเพิ่มพื้นที่สลับหน้าในส่วนว่างด้านบนของการ์ดภาพรวม

## Prerequisites และข้อมูลที่ต้องยืนยัน

ก่อน Production change ต้องตรวจรายการต่อไปนี้โดยไม่แสดงค่าความลับใน log หรือเอกสาร:

| รายการ | ต้องใช้ | วิธีตรวจ |
|---|---|---|
| Messaging API Channel secret | ใช่ | ตรวจว่ามี Supabase secret `LINE_MESSAGING_CHANNEL_SECRET` |
| Channel access token | ใช่ | ตรวจว่ามี `LINE_CHANNEL_ACCESS_TOKEN` และ token ยังใช้งานได้ |
| LIFF URL | ใช่ | ใช้ `https://liff.line.me/2012030979-CQQzGFWo` และตั้ง `LINE_LIFF_URL` |
| Rich Menu หน้าแรก ID | ใช่ | อ่านจาก LINE API ก่อนสร้าง alias `nurseshift-main` |
| Rich Menu หน้า 2 ID | สร้างระหว่าง rollout | ตั้งเป็น `LINE_RICH_MENU_PAGE_2_ID` หลังสร้างสำเร็จ |
| Webhook endpoint | ใช่ | `https://wcfpubbeyihhukrsuing.supabase.co/functions/v1/line-webhook` |
| Bot friendship | ใช่ | บัญชีทดสอบต้องเพิ่ม Official Account เป็นเพื่อน |

ห้ามใส่ Channel secret หรือ access token ใน frontend, `.env.local` ที่ถูก bundle ไป browser, เอกสาร หรือ Git

## Execution Plan

### Step 4.1 — Read-only Production Audit

1. อ่าน Messaging API status และ Webhook URL ปัจจุบัน
2. สำรองค่า Rich Menu หน้าแรก: ID, JSON areas, image reference, alias และสถานะ Default
3. ตรวจว่า alias `nurseshift-main` และ `nurseshift-quick-info` มีอยู่แล้วหรือไม่
4. ตรวจเฉพาะรายชื่อ Supabase secrets ที่จำเป็น โดยไม่อ่านหรือพิมพ์ค่าจริง
5. ตรวจว่า migration `202610150005` และ `line-webhook` ถูก deploy แล้วหรือยัง
6. บันทึกผล audit และหยุดหากพบ endpoint/Rich Menu เดิมที่อาจชนกับระบบอื่น

ผลลัพธ์: current-state inventory และ rollback baseline

### Step 4.2 — Local Verification

1. ตรวจ JSON schema และ bounds ของ Rich Menu หน้า 2
2. รัน Unit/Contract tests สำหรับ signature, privacy, idempotency, Flex payload และ page-1 preservation
3. รัน production build เพื่อจับ import/type/bundle errors
4. ไม่รัน Browser E2E

ผลลัพธ์: test report ที่ไม่มี Production mutation

### Step 4.3 — Backend Preparation

ดำเนินการเมื่อได้รับอนุญาต Production เท่านั้น:

1. Apply migration `202610150005_line_webhook_events.sql` เฉพาะเมื่อ remote ยังไม่มี
2. ตั้งหรือยืนยัน secrets:

```text
LINE_MESSAGING_CHANNEL_SECRET=<Messaging API Channel secret>
LINE_CHANNEL_ACCESS_TOKEN=<Messaging API Channel access token>
LINE_LIFF_URL=https://liff.line.me/2012030979-CQQzGFWo
```

3. Deploy `line-webhook` โดยไม่ใช้ Supabase JWT verification เพราะ Function ตรวจ `x-line-signature` จาก raw body
4. ตรวจ health response และยืนยันว่า invalid signature ได้ HTTP 401

ผลลัพธ์: backend พร้อมรับ LINE events แต่ยังไม่เปิด Use webhook

### Step 4.4 — Rich Menu Navigation

หมายเหตุ: Production ปัจจุบันใช้หน้าแรก v3 ตาม Deployment Record ด้านบน และเก็บหน้าแรก v2 ไว้ rollback

1. สร้าง Rich Menu หน้า 2 จาก `docs/line-rich-menu-page-2.json` และอัปโหลดภาพหน้า 2
2. สร้าง Rich Menu หน้าแรก v3 จาก `docs/line-rich-menu.json` และอัปโหลด `assets/line-rich-menu.jpg`
3. เก็บ Rich Menu ID หน้า 2 แล้วตั้ง `LINE_RICH_MENU_PAGE_2_ID`
4. สร้างหรือ update alias แบบ idempotent:
   - `nurseshift-main` → Rich Menu หน้าแรก v3
   - `nurseshift-quick-info` → Rich Menu หน้า 2
5. ตั้งหน้าแรก v3 เป็น Default Rich Menu และเก็บหน้าแรก v2 ไว้สำหรับ rollback

ผลลัพธ์: ผู้ใช้แตะสลับหน้า 1 ↔ หน้า 2 ได้ โดย 4 actions เดิมยังทำงาน

### Step 4.5 — Webhook Cutover แบบควบคุม

1. ตั้ง Webhook URL เป็น `https://wcfpubbeyihhukrsuing.supabase.co/functions/v1/line-webhook`
2. กด Verify ใน LINE Developers
3. เปิด Use webhook เมื่อ Verify ผ่านเท่านั้น
4. ทดสอบกับบัญชีควบคุมหนึ่งบัญชีก่อน
5. ตรวจ Edge Function logs เฉพาะช่วงทดสอบ และยืนยันว่าไม่มี event loop หรือ reply ซ้ำ

ผลลัพธ์: LINE Bot รับ event จริงโดยยังไม่เปลี่ยน Default Rich Menu

### Step 4.6 — Controlled Smoke Test

ทดสอบผ่านแชตส่วนตัว:

1. หน้าแรกและ 4 actions เดิมยังทำงาน
2. แตะ `ข้อมูลด่วน · เมนูเพิ่มเติม` แล้วสลับไปหน้า 2
3. ปุ่ม `กลับหน้าหลัก` กลับหน้าแรกได้
4. กด postback ทั้ง 6 ปุ่มและได้รับคำตอบเพียงครั้งเดียว
5. เวรถัดไป, วันหยุด, OT, รายได้ และสรุปเวรตรงกับข้อมูล Supabase ของผู้ทดสอบ
6. รายได้ไม่ตอบใน group chat
7. ผู้ใช้ที่ยังไม่เชื่อม NurseShift ได้ข้อความให้เปิด LIFF
8. ส่ง event ID ซ้ำในการทดสอบ contract แล้วประมวลผลเพียงครั้งเดียว

ผลลัพธ์: evidence checklist พร้อมเวลา, test account และผลแต่ละกรณี โดยไม่เก็บข้อมูลเงินเดือนจริงลงเอกสาร

### Step 4.7 — Closeout

1. บันทึก Rich Menu IDs, aliases และ Webhook status โดยไม่บันทึก secrets
2. อัปเดตสถานะ Phase 4 ใน `docs/IMPLEMENTATION_PLAN.md`
3. สรุป test evidence, ปัญหาคงค้าง และ rollback readiness
4. หยุดรอคำสั่งก่อนเริ่ม Phase 5 หรือเปลี่ยน Production ส่วนอื่น

## Acceptance Criteria

- Rich Menu หน้าแรกมีปุ่มสลับหน้า และ 4 actions เดิมยังทำงานเหมือนเดิม
- ผู้ใช้เปิดหน้า 2 และกลับหน้าแรกได้
- ทั้ง 6 postbacks ใช้ข้อมูลจริงของผู้ใช้ที่ผ่าน authorization
- รายได้ตอบเฉพาะแชตส่วนตัว
- LINE signature ที่ไม่ถูกต้องถูกปฏิเสธด้วย HTTP 401
- event เดิมไม่ถูกประมวลผลซ้ำ
- ผู้ใช้ที่ไม่เชื่อมบัญชีได้รับทางเข้า LIFF โดยไม่เห็นข้อมูลผู้อื่น
- Unit/Contract tests และ production build ผ่าน
- Controlled LINE smoke test ผ่านโดยไม่มีข้อความซ้ำหรือ request loop
- มี baseline และขั้นตอน rollback ก่อนเปิด Use webhook

## Rollback

หากทดสอบไม่ผ่าน:

1. ปิด Use webhook หรือคืน Webhook URL เดิม
2. ยกเลิกการผูก Rich Menu หน้า 2 จากบัญชีทดสอบ และผูกหน้าแรกเดิมกลับ
3. คืน Default Rich Menu และ alias `nurseshift-main` ไปยัง Rich Menu ID เดิมที่สำรองไว้
4. ลบ alias/page 2 ใหม่ได้เมื่อยืนยันว่าไม่มีผู้ใช้ถูกผูกอยู่
5. คง migration แบบ additive ไว้ได้ เพราะไม่เปลี่ยนข้อมูลตารางเวรหรือการเงิน
6. ห้ามลบ Rich Menu หน้าแรก

## Phase 4 Gate

Production rollout เสร็จแล้ว: Webhook รุ่นล่าสุด active, หน้าแรก v3 เป็น Default, aliases เชื่อมสองทิศทาง และ endpoint ปฏิเสธ unsigned request ด้วย HTTP 401 เหลือ controlled smoke test จาก LINE client ของผู้ใช้เพื่อยืนยันการสลับหน้าและคำตอบทั้ง 6 รายการ ก่อนปิด Phase 4
