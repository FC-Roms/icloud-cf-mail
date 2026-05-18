# iCloud Cloudflare Mail Worker

Cloudflare Email Worker này nhận mail từ Email Routing, lưu metadata + HTML body vào D1, forward về email đích và cung cấp web tra cứu theo đúng địa chỉ iCloud.

Điểm quan trọng: Worker index recipient từ các header người nhận như `To`, `Delivered-To`, `X-Original-To`, `Envelope-To` và envelope `message.to`. Vì vậy header dạng:

```txt
To: Hide My Email <farrago.mull-1u@icloud.com>
```

sẽ được lưu recipient là `farrago.mull-1u@icloud.com`, không lưu nguyên chuỗi display name. API không index `From` hoặc `Reply-To` làm recipient để tránh query nhầm khi sender cũng là địa chỉ `@icloud.com`.

## File chính

- `worker.js`: Email Worker, API `/logs`, web `/` và `/mail`.
- `migrations/0001_icloud_mail.sql`: schema D1.
- `scripts/create-d1.js`: tạo D1 và cập nhật `wrangler.toml`.
- `scripts/test-worker.js`: test local cho recipient parsing, HTML lưu/render và pagination.

## Cấu hình

Sửa `wrangler.toml`:

```toml
[vars]
WORKER_ID = "icloud-cf-mail"
WORKER_URL = "https://icloud-cf-mail.n5pskgzs9g.workers.dev"
ADMIN_EMAIL = "tall-9rex@icloud.com"
```

`ADMIN_EMAIL` phải là destination address đã verify trong Cloudflare Email Routing.
`VIEW_TOKEN` là mã bắt buộc để web/API đọc mail. Set bằng Wrangler secret, không commit vào `wrangler.toml`:

```bash
wrangler secret put VIEW_TOKEN
```

## Cài đặt

```bash
npm install
npm run d1:create
npm run d1:migrate
wrangler secret put VIEW_TOKEN
npm run check
npm run deploy
```

Web tra cứu nằm ở:

```txt
https://icloud-cf-mail.n5pskgzs9g.workers.dev/
```

Nhập email iCloud cần tra cứu, ví dụ `farrago.mull-1u@icloud.com`.

## API

Tra cứu theo đúng mailbox `@icloud.com`:

```txt
GET /logs?mail=farrago.mull-1u@icloud.com
Authorization: Bearer <VIEW_TOKEN>
```

Endpoint không cho query domain khác và không có chế độ list toàn bộ mail qua web/API.

```txt
GET /logs?mail=route@linhtd.com
# 400 Only @icloud.com email can be queried
```

Response trả về cả `messages` và alias `logs` để dễ tương thích:

```json
{
  "messages": [
    {
      "id": "message-id",
      "subject": "A new security key or passkey was added to your account",
      "date": "Sun, 17 May 2026 13:38:00 +0700",
      "receivedAt": "2026-05-17T06:38:00.000Z",
      "htmlBody": "<!doctype html>..."
    }
  ],
  "pagination": {
    "limit": 10,
    "hasMore": false,
    "nextCursor": null
  }
}
```

API không trả metadata người gửi/người nhận như `from`, `to`, `reply-to`, `envelope-to`, `message-id`, dung lượng, attachment hay recipient tags. Các trường đó chỉ nằm nội bộ trong D1.

## Cloudflare Email Routing

Worker hiện đã deploy tại `https://icloud-cf-mail.n5pskgzs9g.workers.dev` và Email Routing catch-all của `bbigservices.help` đang trỏ tới `worker:icloud-cf-mail`.

Nếu cần cấu hình lại trong Cloudflare dashboard của domain:

1. Bật Email Routing cho domain.
2. Verify `ADMIN_EMAIL` trong Destination addresses.
3. Tạo rule hoặc catch-all route mail tới Worker `icloud-cf-mail`.
4. Deploy Worker.

Worker sẽ lưu mail vào D1 trước rồi mới forward về `ADMIN_EMAIL`.
