# Supabase Request Audit

วันที่ตรวจสอบ: 15 ตุลาคม 2569

## ขอบเขต

ตรวจเส้นทางเรียก `supabase.from(...)`, `supabase.rpc(...)`, การโหลดหน้าซ้ำ, callback, polling, Realtime, loop query และการบันทึกซ้ำ โดยไม่เปลี่ยน database schema, index, `set_config` หรือ contract ของ `replace_user_state_v2`.

## สิ่งที่พบ

- Frontend เป็น vanilla JavaScript จึงไม่มี `useEffect` หรือ dependency rerender loop.
- ไม่มี `setInterval`, polling หรือ Realtime subscription ในแอป.
- ไม่มีการอ่าน Supabase ทีละรายการใน loop; การอ่านหลายตารางที่จำเป็นทำพร้อมกันด้วย `Promise.all`.
- ประวัติรายเดือนมี cache หลังโหลดเสร็จอยู่แล้ว แต่คำขอเดือนเดียวกันที่เกิดพร้อมกันยังไม่ถูก deduplicate.
- ทุก action ของ `app-api` เดิมเรียก `ensureProfile` ซึ่งเขียน/ตรวจ `profiles`, `user_settings`, `shift_types` และ `reminders` รวม 4 database calls แม้เป็นผู้ใช้เดิม.
- การกด action ซ้ำระหว่าง save เดิมยังเปิดให้เรียก `replace_user_state_v2` พร้อมกัน ทำให้คำขอหลังชน `STATE_VERSION_CONFLICT` ได้.

## จำนวน Database Calls ต่อเหตุการณ์

ตัวเลขเป็นจำนวน calls ภายใน Edge Function ไม่รวม HTTP request จาก browser ไปยัง Edge Function หนึ่งครั้ง.

| เหตุการณ์ | ก่อนแก้ | หลังแก้ cold cache | หลังแก้ warm cache |
| --- | ---: | ---: | ---: |
| เปิดแอป / bootstrap ผู้ใช้เดิม | 11 | 8 | 7 |
| บันทึก state หนึ่งครั้ง | 5 | 2 | 1 |
| เปิดประวัติเดือนหนึ่ง | 8 | 5 | 4 |
| เปิดประวัติเดือนเดิมซ้ำ | 8 | 0 | 0 |
| ส่งข้อความทดสอบ | 5 | 2 | 1 |
| ลบบัญชี | 5 | 2 | 1 |

ผู้ใช้ใหม่ยังต้องสร้าง profile และข้อมูลเริ่มต้นหนึ่งครั้ง จึงคง calls สำหรับ initialization ไว้ตามเดิม.

## การแก้ไข

1. `ensureProfile` อ่าน profile ของผู้ใช้เดิมเพียงครั้งเดียวและ cache 5 นาทีต่อ Edge isolate; ไม่ upsert ค่าเริ่มต้นสามตารางทุก action.
2. อัปเดตชื่อหรือรูป LINE เฉพาะเมื่อข้อมูลเปลี่ยนจริง เพื่อรักษาความหมายของ `profiles.updated_at`.
3. Deduplicate bootstrap และคำขอประวัติเดือนเดียวกันที่กำลังทำงาน พร้อมใช้ month cache เดิมหลังสำเร็จ.
4. ป้องกันการเริ่ม save ครั้งที่สองระหว่าง save แรกยังไม่จบ ลด simultaneous `replace_user_state_v2` และ `STATE_VERSION_CONFLICT`.
5. ไม่ข้าม explicit save ที่เกิดหลังครั้งก่อนสำเร็จ จึงรักษาการเพิ่ม `state_version` และการเปลี่ยน `updated_at` ของ `replace_user_state_v2` ตามเดิม.

## สิ่งที่ตั้งใจไม่เปลี่ยน

- ไม่เพิ่ม index เพราะตารางยังเล็กและ join สำคัญมี index อยู่แล้ว.
- ไม่แก้ `set_config`, migration หรือ database function.
- ไม่เพิ่ม polling หรือ Realtime.
- ไม่เปลี่ยน optimistic concurrency; การแก้จากอีกอุปกรณ์ยังคงคืน `STATE_VERSION_CONFLICT` และโหลด state ล่าสุดตามเดิม.
