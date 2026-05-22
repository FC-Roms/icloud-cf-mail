# iCloud Cloudflare Mail Worker

Worker này nhận email từ Cloudflare Email Routing, parse nội dung bằng `postal-mime`, lưu mail vào D1, forward bản gốc về email đích, và cung cấp web/API để tra cứu mail theo đúng alias `@icloud.com`.

Repo này hỗ trợ 2 kiểu chạy local:

- `npm run dev`: code local + D1 local.
- `npm run dev:remote-db`: code local + dùng chung D1 remote đang chạy trên Cloudflare.

Nếu mục tiêu là local app nhưng dùng chung DB với production, dùng:

```bash
npm run dev:remote-db
```

Lệnh này sẽ chạy Worker ở `http://localhost:8787`, nhưng binding `MAIL_DB` trỏ vào D1 remote thật. Mọi ghi/xóa từ local sẽ tác động trực tiếp lên dữ liệu production.

## File chính

- `worker.js`: Email handler, web UI `/` và `/mail`, API `/logs` và `/messages`, health check `/health`.
- `migrations/0001_icloud_mail.sql`: migration schema D1.
- `scripts/create-d1.js`: tạo D1 remote mới và cập nhật `wrangler.toml`.
- `scripts/test-worker.js`: test local cho parse mail, auth, privacy, query và pagination.
- `.dev.vars.example`: mẫu env local.
- `wrangler.toml`: config Worker, D1 binding, và environment `remote`.

## Cách hoạt động

Worker index recipient từ các nguồn nhận mail như:

- header `To`
- `Delivered-To`
- `X-Original-To`
- `Envelope-To`
- envelope `message.to`

Ví dụ:

```txt
To: Hide My Email <farrago.mull-1u@icloud.com>
```

recipient được lưu là `farrago.mull-1u@icloud.com`, không lưu cả display name. API không index `From` hoặc `Reply-To`, nên sẽ không query nhầm sender cũng là địa chỉ `@icloud.com`.

## Yêu cầu

- Node.js
- npm
- tài khoản Cloudflare đã login bằng `wrangler login`

## Cài đặt

```bash
npm install
```

## Chạy local

Tạo file env local:

```bash
cp .dev.vars.example .dev.vars
```

Sửa `.dev.vars` nếu cần:

```dotenv
WORKER_ID=icloud-cf-mail
WORKER_URL=http://localhost:8787
ADMIN_EMAIL=your-forward-destination@icloud.com
VIEW_TOKEN=change-this-view-token
BLOCKED_DOMAINS=spam.com,fake-mailer.com
SPAM_WORDS=casino,crypto bonus,buy now,loan approved
MAX_MESSAGE_SIZE_BYTES=10485760
```

`VIEW_TOKEN` trong `.dev.vars` dùng cho local dev. `WORKER_URL` nên giữ là `http://localhost:8787` để UI local gọi đúng API local.

### Mode 1: code local + D1 local

```bash
npm run dev
```

Mode này an toàn hơn khi test vì không đụng dữ liệu remote.

### Mode 2: code local + D1 remote đang chạy trên Cloudflare

```bash
npm run dev:remote-db
```

Mode này dùng environment `remote` trong `wrangler.toml`, nơi `MAIL_DB` được cấu hình `remote = true`. Đây là mode bạn dùng khi muốn app local và worker production cùng nhìn vào một database.

Lưu ý:

- Worker vẫn chạy local ở `http://localhost:8787`
- D1 là DB thật trên Cloudflare
- insert/update/delete từ local sẽ ghi thẳng vào DB production

## D1

Tạo D1 remote mới và cập nhật `wrangler.toml`:

```bash
npm run d1:create
```

Apply migration vào D1 local:

```bash
npm run d1:migrate:local
```

Apply migration vào D1 remote trên Cloudflare:

```bash
npm run d1:migrate
```

Liệt kê D1:

```bash
npm run d1:list
```

## Test

```bash
npm test
```

Kiểm tra tổng hợp:

```bash
npm run check
```

`npm run check` chạy test local và `wrangler deploy --dry-run`.

## Cấu hình production

Luồng production khuyến nghị:

```txt
iCloud Hide My Email alias
  -> forward về địa chỉ trên domain đã bật Cloudflare Email Routing
  -> Cloudflare Email Routing gọi Worker
  -> Worker lưu mail vào D1
  -> Worker forward bản gốc về ADMIN_EMAIL
```

Các bước cấu hình:

1. Cài Worker và D1 trên Cloudflare:
   - chạy `npm install`
   - tạo D1 nếu chưa có bằng `npm run d1:create`
   - apply schema lên D1 remote bằng `npm run d1:migrate`
   - kiểm tra `WORKER_ID`, `WORKER_URL`, `ADMIN_EMAIL` và D1 binding trong `wrangler.toml`
2. Set token đọc mail cho production:

   ```bash
   wrangler secret put VIEW_TOKEN
   ```

3. Deploy Worker:

   ```bash
   npm run deploy
   ```

4. Bật Cloudflare Email Routing cho domain nhận mail:
   - thêm domain vào Cloudflare và để Cloudflare quản lý DNS/MX theo hướng dẫn Email Routing
   - verify `ADMIN_EMAIL` trong Destination addresses
   - tạo routing rule hoặc catch-all rule cho địa chỉ trên domain đó
   - chọn action gửi mail tới Worker này
5. Trong iCloud Hide My Email, cấu hình alias ẩn forward về địa chỉ thuộc domain đang route qua Cloudflare.

Sau khi xong, mail gửi tới alias `@icloud.com` sẽ đi qua địa chỉ domain route, Worker sẽ index đúng alias `@icloud.com` từ header/envelope, lưu vào D1, rồi forward bản gốc về `ADMIN_EMAIL`.

## Deploy

Set secret cho môi trường remote:

```bash
wrangler secret put VIEW_TOKEN
```

Rồi deploy:

```bash
npm run deploy
```

## API

### Web UI

- `GET /`
- `GET /mail`

### Health

```txt
GET /health
```

Ví dụ:

```bash
curl http://localhost:8787/health
```

### Query mail

```txt
GET /logs?mail=farrago.mull-1u@icloud.com
Authorization: Bearer <VIEW_TOKEN>
```

Alias tương thích:

```txt
GET /messages?mail=farrago.mull-1u@icloud.com
```

Ví dụ local:

```bash
curl -H 'Authorization: Bearer <VIEW_TOKEN>' \
  'http://localhost:8787/logs?mail=farrago.mull-1u@icloud.com'
```

Endpoint `/logs` được giữ để phục vụ tool đăng ký GPT account [`6c696e68/gpt_signup_hybrid`](https://github.com/6c696e68/gpt_signup_hybrid). Tool chỉ cần gọi API bằng alias iCloud cần đọc mail:

```txt
GET <WORKER_URL>/logs?mail=<alias@icloud.com>
Authorization: Bearer <VIEW_TOKEN>
```

Có thể truyền nhiều email bằng nhiều tham số `mail`, hoặc ngăn cách bằng dấu phẩy/xuống dòng. API trả cả `messages` và `logs`; `logs` là alias tương thích cho client cũ.

Chỉ cho query địa chỉ `@icloud.com`. Ví dụ sau sẽ bị reject:

```txt
GET /logs?mail=route@linhtd.com
# 400 Only @icloud.com email can be queried
```

Response mẫu:

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
  "logs": [
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

API cố ý không trả các metadata nội bộ như:

- `from`
- `to`
- `reply-to`
- `envelope-to`
- `message-id`
- `raw headers`
- dung lượng
- attachment count
- recipient tags

Các trường đó chỉ nằm trong D1 nội bộ.

## Ghi chú cấu hình

Trong `wrangler.toml` hiện có:

- config mặc định cho production/local thường
- environment `remote` để chạy local nhưng dùng D1 remote

`ADMIN_EMAIL` phải là destination address đã verify trong Cloudflare Email Routing.

`VIEW_TOKEN` không nên commit vào `wrangler.toml`. Với production dùng:

```bash
wrangler secret put VIEW_TOKEN
```

Với local dev thì để trong `.dev.vars`.
