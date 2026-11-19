# AGENTS.md — Prn_Source (PRN232 exam source)

## Mục tiêu repo

Source code mẫu để **dùng trong phòng thi PRN232**. Tiêu chí thành công: code chạy được ngay,
khi vào thi chỉ sửa vài chỗ (model, connection string, route) là nộp được.
**Không** thêm tính năng ngoài đề, không làm đẹp UI.

Đặc tả đầy đủ: xem [`README.md`](./README.md). README là nguồn sự thật; nếu code khác README
thì sửa code, trừ khi người dùng nói ngược lại.

## Trạng thái hiện tại

- Đã có solution: `src/Prn232.sln` + 3 project, build OK, chạy end-to-end được.
- DB dev: SQL Server 2022 chạy Docker (`prn232-sql`), database `Prn232Exam`, tạo bằng `src/db/init.sql`.
- Models đã scaffold thật (DB-first) bằng `dotnet ef dbcontext scaffold ... --no-onconfiguring`.
- Seed account: `admin/123456` (Role=Admin), `user/123456` (Role=User). Password plaintext.
- **Đã làm**: `tutorials/index.html` (3 phần: setup / cách làm bài / tra cứu code).
- `examination/1/` là đề mẫu tham khảo (paper.pdf, script.sql, sample.html) — không sửa.
- Mục 13 README đã chốt thành "giả định đã xác nhận".

## Kiến trúc bắt buộc (đổi phải hỏi trước)

- .NET 8, ASP.NET Core, SQL Server, **DB-first** (không dùng migration, không code-first).
- `src/Prn232.sln` gồm **đúng 3 project**:
  1. `Prn232.Fe` — Razor Pages: login, list, create, edit, delete. UI tối giản (Bootstrap CDN).
  2. `Prn232.AuthApi` — cấp JWT (`/api/auth/login`, `/api/auth/me`).
  3. `Prn232.ProductApi` — CRUD `Product`, mọi endpoint `[Authorize]`.
- Không thêm project thứ 4, không tách shared library (copy DTO nếu cần).
- Port: Fe `5000`, AuthApi `5001`, ProductApi `5002`.
- FE **không** truy cập DB; chỉ gọi API qua `HttpClient` trong `Services/ApiClient.cs`.

## Nguyên tắc code

- Comment và trao đổi bằng tiếng Việt; tên class/biến/method bằng tiếng Anh.
- Mọi chỗ phải sửa khi đổi đề phải có comment: `// [SỬA KHI ĐỔI ĐỀ]` (kèm ghi chú sửa gì).
- Code thẳng, dễ đọc, ưu tiên lặp lại hơn abstraction. Không dùng pattern phức tạp.
- JWT `Key`/`Issuer`/`Audience` phải **giống hệt** ở AuthApi và ProductApi.
- Sau khi scaffold: xoá `OnConfiguring` trong DbContext, đăng ký `AddDbContext` trong `Program.cs`.
- Không commit secret (`appsettings` chứa mật khẩu thật, `.env`, token).

## Commands (dùng khi đã có code)

```bash
dotnet restore src/Prn232.sln
dotnet build   src/Prn232.sln
dotnet run --project src/Prn232.AuthApi      # :5001
dotnet run --project src/Prn232.ProductApi   # :5002
dotnet run --project src/Prn232.Fe           # :5000
```

DB-first:

```bash
dotnet ef dbcontext scaffold "<connection-string>" Microsoft.EntityFrameworkCore.SqlServer -o Models -f
dotnet aspnet-codegenerator controller -name ProductsController -m Product -dc Prn232Context -api -outDir Controllers
```

Publish để nộp:

```bash
dotnet publish -c Release -o ./Q1_<MSSV>
dotnet publish -c Release -o ./Q2_<MSSV>
```

## Không được làm

- Không đổi kiến trúc 3 project, không đổi DB-first sang migration.
- Không thêm NuGet package ngoài danh sách chuẩn trong README mục 4.3 (trừ khi được yêu cầu).
- Không xoá/đổi tên/move file có sẵn khi chưa hỏi.
- Không tự ý `git push`, force-push, rewrite history.
- Không sửa `Cong phap PRN.txt` (đó là ghi chú gốc).
- Không viết code vào `tutorials/` ngoài `index.html`.

## Khi không chắc → hỏi

Nếu đề bài/đặc tả mơ hồ (tên model, field, quyền, có Register hay không, cách lưu token…),
**dừng lại và hỏi** người dùng. Không tự chọn rồi làm bừa.

## Graphify

- Nếu `graphify-out/graph.json` tồn tại, ưu tiên `graphify query "<câu hỏi>"` thay vì grep nhiều file.
- Rebuild: `graphify extract . --code-only` (local, không tốn token).
- Không commit `graphify-out/cache/`.

## Trước khi kết thúc task

- Liệt kê file đã tạo/sửa.
- Nêu lệnh đã chạy và kết quả (build/test).
- Nêu giả định và việc còn dang dở.

## Git

- Nhánh chính: `main`.
- Commit: `type(scope): mô tả` (vd: `feat(product-api): thêm CRUD Product`).
