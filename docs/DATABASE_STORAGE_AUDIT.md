# Database Storage Audit

วันที่ตรวจสอบ: 15 ตุลาคม 2569

## Production Snapshot

ฐานข้อมูลปัจจุบันมีข้อมูลน้อยมาก: ผู้ใช้ 2 คน, เวรประมาณ 25 แถว และ `notification_logs` 1 แถว ขนาดรวมของตารางและ index ที่รายงานต่ำกว่าประมาณ 1 MB. พื้นที่ส่วนใหญ่ของตาราง operational ขนาดเล็กเป็น allocation ขั้นต่ำของ PostgreSQL index จึงไม่ลดลงอย่างมีนัยสำคัญด้วยการลบหนึ่งหรือสองแถว.

## Classification

### User-owned data — ห้ามลบอัตโนมัติ

- `profiles`
- `user_settings`
- `shift_types`
- `shifts`
- `special_ot_items`
- `day_offs`
- `financial_items`
- `reminders`

ตารางเหล่านี้ใช้โดยแอป การคำนวณเงินเดือน ประวัติ 3 เดือน และการตั้งค่าผู้ใช้โดยตรง.

### Active operational state — ต้องเก็บ

- `notification_delivery_modes`: เลือก Legacy/Shadow/V2 ต่อผู้ใช้
- `notification_rules`: กฎและ generation สำหรับยกเลิกงานเก่าอย่างปลอดภัย
- `notification_jobs`: งานที่ยัง pending/retry/leased และ shadow comparison

### Disposable operational history — กำหนดอายุได้

- `notification_logs`: Legacy retry และ idempotency; เก็บ terminal state 30 วัน
- `notification_jobs`: งาน sent/cancelled/dead และ shadow ที่หมดอายุ; เก็บ 30 วัน
- `notification_deliveries`: ลบตาม job ด้วย cascade
- `line_webhook_events`: idempotency ของ webhook; เก็บ 7 วัน
- `retention_dry_runs`: เก็บถึง 30 วันหลังวันหมดอายุที่จำลอง
- `retention_planner_runs`: เก็บ 90 วัน

## Tables Not Removed

ไม่พบตารางที่ไม่มีผู้ใช้งานจริง. `notification_logs` ยังห้าม drop เพราะ worker แบบ Legacy ใช้กันการส่งซ้ำและจัดการ retry. ตาราง V2 และ retention ถูกอ้างอิงจาก worker/functions และรองรับ Notification Scheduling V2/การแจ้งเตือนข้อมูลเก่า.

## Implemented Retention

Migration `202610150009_operational_data_retention.sql` เพิ่ม cleanup ที่แตะเฉพาะ operational history และตั้ง daily job เฉพาะกรณีที่โปรเจกต์เปิด `pg_cron` อยู่แล้ว. งาน active และข้อมูลของผู้ใช้ไม่ถูกลบ และ `Automatic Data Deletion` ของข้อมูลตารางเวรยังคงปิดอยู่.

Migration นี้ยังไม่ถูก apply บน Production.
