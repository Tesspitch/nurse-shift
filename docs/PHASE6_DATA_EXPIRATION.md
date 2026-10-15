# Phase 6 — Automatic Data Expiration Notifications

วันที่: 15 ตุลาคม 2026  
สถานะ: Implemented locally, deletion disabled, not deployed

## Policy

NurseShift แสดงเดือนปัจจุบันและสองเดือนก่อนหน้า เมื่อขึ้นเดือนใหม่ เดือนที่เก่าสุดจะพ้นช่วงแสดงผล แต่ข้อมูลจริงยังอยู่ในฐานข้อมูล

ระบบคำนวณด้วย `Asia/Bangkok` และสร้างการแจ้งเตือนเวลา 09:00 น. ล่วงหน้า 7, 3 และ 1 วัน โดยไม่ hardcode เดือนหรือปี

## Implementation

- เพิ่ม `user_settings.expiration_notifications_enabled` แยกจาก Shift Notifications
- ใช้ `notification_rules`, `notification_jobs`, `notification_deliveries`, retry และ recovery จาก Phase 5
- Recovery worker เดิมเรียก daily planner แบบ idempotent จึงไม่ต้องสร้าง Cron ใหม่
- สร้าง jobs เฉพาะผู้ใช้ที่มีเวร, OT พิเศษ, วันหยุด หรือรายการการเงินในเดือนที่กำลังพ้นช่วง
- ผู้ใช้ต้องเปิด master LINE notifications และ expiration preference และต้องมี LINE User ID
- Message เป็นภาษาไทย ไม่มีตัวเลขเงินเดือน และใช้คำว่า “พ้นช่วงแสดงผล” ไม่อ้างว่าจะลบข้อมูล
- Unique rule key และ Phase 5 idempotency ป้องกัน duplicate job/callback/delivery

## Retention Dry Run

`retention_dry_runs` เก็บเฉพาะ:

- เดือนที่กำลังพ้นช่วงและวันที่พ้นช่วง
- จำนวนเวร, OT พิเศษ, วันหยุด และรายการการเงิน
- eligibility สำหรับ notification
- เวลาที่ตรวจ

`deletion_enabled` ถูกบังคับด้วย Database constraint ให้เป็น `false` เท่านั้น ไม่มี SQL สำหรับลบข้อมูลธุรกิจ, ผู้ใช้ หรือ authentication ใน Phase นี้

## Backup and Restore Plan for Future Retention Work

ก่อนพิจารณาการลบจริงในอนาคต ต้องมีการอนุมัติใหม่และอย่างน้อย:

1. กำหนดระยะเวลาเก็บข้อมูลตามกฎหมาย/นโยบายองค์กร
2. Export snapshot ที่ตรวจ checksum และทดลอง restore ใน isolated project
3. แยกข้อมูลเงินเดือน/บัญชีที่ต้องเก็บตามข้อกำหนด
4. แจ้งและรับ consent ผู้ใช้ตามนโยบายที่อนุมัติ
5. ใช้ soft-delete หรือ quarantine ก่อน hard-delete
6. มี audit log, rollback window และ manual approval

ขั้นตอนเหล่านี้ยังไม่ได้เปิดใช้งาน

## Deployment Order

ยังไม่มีการ Deploy:

1. Apply migration `202610150007_data_expiration_notifications.sql` หลัง migration Phase 5
2. Deploy `app-api` และ `send-reminders`
3. Deploy frontend ที่มี preference ใหม่
4. คง Phase 5 Shadow Mode และ legacy delivery
5. ตรวจ `retention_dry_runs`, planned jobs และข้อความกับ controlled profile
6. เปิด V2 delivery เฉพาะเมื่อ Phase 5 cutover ได้รับอนุญาต

## Remaining Production Verification

- Connected migration execution and query plans
- Real LINE delivery for 7/3/1-day templates
- Month/year rollover against the actual Supabase clock
- CPU and query metrics during Shadow Mode

Browser E2E is intentionally disabled by the latest user instruction.

