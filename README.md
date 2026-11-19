# PRN232 — Exam Source Code

Repo này là **source code dùng cho kỳ thi PRN232**. Mục tiêu: code chạy được ngay, khi vào thi chỉ cần sửa vài chỗ (tên model, connection string, endpoint) là nộp bài được.

> **Trạng thái hiện tại: ĐÃ CÓ CODE + TUTORIAL.**
> `src/Prn232.sln` + 3 project đã build và chạy end-to-end (login → list → create → edit → delete → logout).
> `tutorials/index.html` đã đủ 3 phần (setup / cách làm bài / tra cứu code).
> Dev DB: SQL Server 2022 chạy bằng Docker, database `Prn232Exam` (xem mục 9).

---

## Mục lục

1. [Mục tiêu & phạm vi](#1-mục-tiêu--phạm-vi)
2. [Kiến trúc](#2-kiến-trúc)
3. [Cấu trúc thư mục dự kiến](#3-cấu-trúc-thư-mục-dự-kiến)
4. [Database (DB-first)](#4-database-db-first)
5. [Auth API](#5-auth-api)
6. [Product API](#6-product-api)
7. [FE — Razor Pages](#7-fe--razor-pages)
8. [Cấu hình](#8-cấu-hình)
9. [Chạy & publish để nộp](#9-chạy--publish-để-nộp)
10. [Đổi đề thì sửa ở đâu](#10-đổi-đề-thì-sửa-ở-đâu)
11. [tutorials/index.html](#11-tutorialsindexhtml)
12. [Roadmap triển khai](#12-roadmap-triển-khai)
13. [Giả định cần xác nhận](#13-giả-định-cần-xác-nhận)
14. [Ghi chú gốc](#14-ghi-chú-gốc)

---

## 1. Mục tiêu & phạm vi

| Mục | Nội dung |
|---|---|
| Mục đích | Source code mẫu dùng trong phòng thi PRN232 |
| Công nghệ | .NET 8 (ASP.NET Core), SQL Server |
| Cách truy cập DB | **DB-first** (scaffold từ database có sẵn) |
| Mức độ hoàn thiện | Đủ login + CRUD + list, UI cơ bản nhất |
| Điều quan trọng nhất | **Dễ sửa nhanh khi đổi đề**, mọi chỗ cần sửa đều có comment đánh dấu |
| Ngoài phạm vi | Không làm đẹp UI, không thêm tính năng ngoài đề, không refactor |

**Nguyên tắc:** code thẳng, dễ đọc, ít abstraction. Thà lặp còn hơn khó sửa.

---

## 2. Kiến trúc

Một solution, **đúng 3 project con**:

```text
┌──────────────────────────────┐
│   Prn232.Fe (Razor Pages)    │  :5000
│   Login + CRUD + List        │
└───────────┬──────────────────┘
            │ HttpClient (JSON + Bearer token)
     ┌──────┴────────┐
     ▼               ▼
┌──────────────┐  ┌──────────────────┐
│ Prn232.Auth  │  │ Prn232.Product   │
│ Api  :5001   │  │ Api  :5002       │
│ POST login   │  │ CRUD /api/...    │
└──────┬───────┘  └────────┬─────────┘
       └────────┬──────────┘
                ▼
        SQL Server (1 database)
        Account ── Product
```

| Project | Vai trò | Port | Ghi chú |
|---|---|---|---|
| `Prn232.Fe` | Razor Pages: login, list, create, edit, delete | 5000 | Gọi API bằng `HttpClient`, không truy cập DB trực tiếp |
| `Prn232.AuthApi` | Cấp JWT khi login | 5001 | Chỉ 1–2 endpoint |
| `Prn232.ProductApi` | CRUD model `Product` | 5002 | Yêu cầu JWT cho mọi endpoint |

> ⚠️ Không thêm project thứ 4, không tách shared library. Nếu cần dùng chung DTO thì copy.

### Luồng login

```text
FE /Login  →  POST AuthApi /api/auth/login  →  { accessToken, username, role }
FE lưu token (Session/Cookie)  →  mọi request tới ProductApi kèm Authorization: Bearer <token>
ProductApi validate JWT (cùng Key/Issuer/Audience)  →  200
```

### Luồng CRUD

```text
FE /Products        → GET    ProductApi /api/products          → bảng danh sách
FE /Products/Create → POST   ProductApi /api/products
FE /Products/Edit   → GET 1 + PUT ProductApi /api/products/{id}
FE /Products/Delete → POST/DELETE ProductApi /api/products/{id}
```

---

## 3. Cấu trúc thư mục dự kiến

```text
Prn_Source/
├── AGENTS.md                  # quy định cách làm việc cho agent
├── README.md                  # file này
├── Cong phap PRN.txt          # ghi chú gốc (giữ nguyên, không sửa)
├── src/
│   ├── Prn232.sln
│   ├── db/init.sql            # tạo DB + bảng + seed data
│   ├── Prn232.Fe/             # Razor Pages
│   │   ├── Pages/
│   │   │   ├── Index.cshtml            # redirect → /Products
│   │   │   ├── Login.cshtml(.cs)
│   │   │   ├── Logout.cshtml.cs
│   │   │   ├── Products/
│   │   │   │   ├── Index.cshtml(.cs)   # list
│   │   │   │   ├── Create.cshtml(.cs)
│   │   │   │   ├── Edit.cshtml(.cs)
│   │   │   │   └── Delete.cshtml(.cs)
│   │   │   ├── Shared/_Layout.cshtml   # menu tối giản
│   │   │   └── _ViewImports.cshtml
│   │   ├── Services/ApiClient.cs       # 1 chỗ duy nhất chứa HttpClient + token
│   │   ├── appsettings.json            # ApiBaseUrl của 2 API
│   │   └── Program.cs
│   ├── Prn232.AuthApi/
│   │   ├── Controllers/AuthController.cs
│   │   ├── Models/                     # scaffold DB-first
│   │   ├── Services/TokenService.cs
│   │   ├── appsettings.json            # MyCnn + Jwt
│   │   └── Program.cs
│   └── Prn232.ProductApi/
│       ├── Controllers/ProductsController.cs
│       ├── Models/                     # scaffold DB-first
│       ├── Dtos/ProductDto.cs
│       ├── appsettings.json            # MyCnn + Jwt
│       └── Program.cs
└── tutorials/
    └── index.html              # 3 phần: setup / cách làm bài / tra cứu code
```

---

## 4. Database (DB-first)

### 4.1. Bảng tối thiểu

```sql
CREATE TABLE Account (
    Id          INT IDENTITY(1,1) PRIMARY KEY,
    Username    NVARCHAR(50)  NOT NULL UNIQUE,
    Password    NVARCHAR(100) NOT NULL,   -- lưu plaintext cho nhanh thi; ghi chú rõ
    Role        NVARCHAR(20)  NOT NULL DEFAULT 'User'
);

CREATE TABLE Product (
    Id          INT IDENTITY(1,1) PRIMARY KEY,
    Name        NVARCHAR(200) NOT NULL,
    Price       DECIMAL(18,2) NOT NULL,
    Description NVARCHAR(500) NULL,
    CreatedAt   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);
```

> File script sẽ nằm ở `src/db/init.sql` khi triển khai. **Người triển khai phải tạo file này.**

### 4.2. Quy trình DB-first (bắt buộc theo đúng thứ tự)

1. Chạy `init.sql` trên SQL Server để tạo database + bảng.
2. Scaffold model vào **từng API project** (mỗi project tự có `Models/`):
   ```bash
   dotnet ef dbcontext scaffold "Data Source=<server>;Initial Catalog=<db>;Integrated Security=True;Trust Server Certificate=True" \
     Microsoft.EntityFrameworkCore.SqlServer -o Models -f
   ```
3. **Xoá** method `OnConfiguring(...)` trong DbContext vừa sinh ra (nó hard-code connection string).
4. Trong `Program.cs`, đăng ký:
   ```csharp
   builder.Services.AddDbContext<Prn232Context>(opt =>
       opt.UseSqlServer(builder.Configuration.GetConnectionString("MyCnn")));
   ```
5. **Kiểm tra lại số NuGet package**: scaffold tự thêm package; khi nộp phải đảm bảo không thừa/thiếu so với danh sách chuẩn (mục 8).

### 4.3. Package cần có

```xml
<PackageReference Include="AutoMapper" Version="15.0.1" />
<PackageReference Include="Microsoft.AspNetCore.Authentication.JwtBearer" Version="8.0.23" />
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="8.0.23" />
<PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="8.0.23" />
<PackageReference Include="Microsoft.EntityFrameworkCore.Tools" Version="8.0.23" />
<PackageReference Include="Microsoft.VisualStudio.Web.CodeGeneration.Design" Version="8.0.23" />
<PackageReference Include="Swashbuckle.AspNetCore.Swagger" Version="9.0.3" />
<PackageReference Include="Swashbuckle.AspNetCore.SwaggerGen" Version="9.0.3" />
<PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="9.0.3" />
```

---

## 5. Auth API (`:5001`)

| Method | Route | Body | Trả về |
|---|---|---|---|
| POST | `/api/auth/login` | `{ "username": "...", "password": "..." }` | `{ "accessToken": "...", "username": "...", "role": "..." }` |
| GET | `/api/auth/me` | — (Bearer) | `{ "username": "...", "role": "..." }` |

- Sai tài khoản → `401`.
- `TokenService` tạo JWT với claim `username`, `role`, hạn `ExpiryInDays`.

### JWT config (giống hệt nhau ở AuthApi và ProductApi)

```json
"Jwt": {
  "Issuer": "http://fpt.edu.vn",
  "Audience": "http://localhost:5808",
  "Key": "Practical Exam - PRN231 - Summer 2824 - Computing Fundamental Department - FPT University",
  "ExpiryInDays": 1
}
```

> Key phải **giống y hệt** ở 2 API, nếu không ProductApi sẽ trả `401`.

---

## 6. Product API (`:5002`)

| Method | Route | Mô tả |
|---|---|---|
| GET | `/api/products?page=1&size=10&search=` | Danh sách có phân trang + tìm theo tên, trả `{ items, page, size, total }` |
| GET | `/api/products/{id}` | 1 sản phẩm, 404 nếu không có |
| POST | `/api/products` | Tạo mới |
| PUT | `/api/products/{id}` | Cập nhật |
| DELETE | `/api/products/{id}` | Xoá |

Tất cả đều `[Authorize]`.

Lưu ý kỹ thuật (từ `Cong phap PRN.txt`):
- Lấy dữ liệu kèm bảng liên quan:
  ```csharp
  await _context.Products.Include(p => p.Category).ToListAsync();
  ```
- Nếu gặp lỗi vòng lặp JSON khi serialize entity:
  ```csharp
  builder.Services.AddControllers().AddJsonOptions(o =>
      o.JsonSerializerOptions.ReferenceHandler =
          System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles);
  ```
- Nên map entity → DTO để tránh lộ navigation property.

Có thể dùng `dotnet aspnet-codegenerator` để sinh nhanh controller rồi sửa:
```bash
dotnet aspnet-codegenerator controller -name ProductsController -m Product -dc Prn232Context -api -outDir Controllers
```

---

## 7. FE — Razor Pages (`:5000`)

### Trang

| Trang | Route | Chức năng |
|---|---|---|
| Login | `/Login` | Form đăng nhập, gọi AuthApi, lưu token vào Session |
| Products | `/Products` | Bảng danh sách + phân trang + ô tìm kiếm + nút Create/Edit/Delete |
| Create | `/Products/Create` | Form tạo mới |
| Edit | `/Products/Edit/{id}` | Form sửa |
| Delete | `/Products/Delete/{id}` | Xác nhận xoá |
| Logout | `/Logout` | Xoá session, về `/Login` |

### UI
- HTML thuần + Bootstrap qua CDN (1 dòng `<link>`), **không** dùng theme, không JavaScript phức tạp.
- Bảng, form, nút: mặc định của Bootstrap là đủ.
- Không có trang nào được đẹp hơn mức "dùng được".

### `Services/ApiClient.cs`
Một class duy nhất bọc toàn bộ lời gọi API:
- Đọc token từ `HttpContext.Session` và gắn `Authorization: Bearer`.
- Nếu API trả `401` → redirect về `/Login`.
- Base URL lấy từ `appsettings.json` (`AuthApiBaseUrl`, `ProductApiBaseUrl`).

> Mọi chỗ cần đổi endpoint/route khi thi đều nằm trong file này + các PageModel.

### Session
- `builder.Services.AddSession()` và `app.UseSession()` trong `Program.cs`.
- Lưu: `accessToken`, `username`, `role`.

---

## 8. Cấu hình

`Prn232.AuthApi/appsettings.json` và `Prn232.ProductApi/appsettings.json`:

```json
{
  "ConnectionStrings": {
    "MyCnn": "Data Source=localhost;Initial Catalog=Prn232Exam;Integrated Security=True;Trust Server Certificate=True"
  },
  "Jwt": { "...": "như mục 5" }
}
```

`Prn232.Fe/appsettings.json`:

```json
{
  "AuthApiBaseUrl": "http://localhost:5001",
  "ProductApiBaseUrl": "http://localhost:5002"
}
```

---

## 9. Chạy & publish để nộp

### 9.1. Chuẩn bị database (dev, dùng Docker)

**Cách A (khuyến nghị) — dùng `docker-compose.yml` ở gốc repo.** Chỉ dựng SQL Server, app vẫn
`dotnet run`; đổi máy (CachyOS ↔ Windows + Docker Desktop) không phải sửa gì:

```bash
docker compose up -d            # bật SQL Server, chờ tới khi STATUS = healthy
docker compose exec db /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P 'Prn232@Exam123' -C -i /tmp/init.sql   # nạp DB lần đầu
docker compose ps               # kiểm tra (healthy)
docker compose down             # tắt, giữ data
docker compose down -v          # tắt + xoá data (reset sạch)
```

**Cách B — `docker run` thủ công** (nếu không có compose; container trùng tên `prn232-sql`
với compose nên chọn một trong hai):

```bash
# 1. Chạy SQL Server 2022 (port 1433)
docker run -d --name prn232-sql \
  -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Prn232@Exam123' -e MSSQL_PID=Developer \
  -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest

# 2. Tạo database + bảng + seed (Account: admin/123456, user/123456)
docker cp src/db/init.sql prn232-sql:/tmp/init.sql
docker exec prn232-sql /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P 'Prn232@Exam123' -C -i /tmp/init.sql
```

Connection string tương ứng (đã có trong `appsettings.json` của 2 API):

```text
Server=localhost,1433;Database=Prn232Exam;User Id=sa;Password=Prn232@Exam123;TrustServerCertificate=True
```

> ⚠️ Password `sa` ở trên chỉ dùng cho dev. Khi nộp bài, đổi `MyCnn` sang server của phòng thi
> và **không** commit password thật.

**Máy dev (Linux/CachyOS):** `docker compose up -d` rồi chạy bằng `dotnet run` — compose chỉ dựng DB.

**Máy thi (Windows, có SQL Server sẵn):** **không** chạy Docker, chỉ sửa connection string:

- Sửa `ConnectionStrings:MyCnn` trong **2 file**: `src/Prn232.AuthApi/appsettings.json` và
  `src/Prn232.ProductApi/appsettings.json` (2 chuỗi phải giống hệt nhau).
- Hoặc không sửa file, truyền qua biến môi trường (đúng key lồng nhau nên dùng `__`):

```powershell
$env:ConnectionStrings__MyCnn = "Server=localhost;Database=Prn232Exam;User Id=sa;Password=...;TrustServerCertificate=True"
dotnet run --project src/Prn232.ProductApi
```

Nhớ chạy `src/db/init.sql` trên SQL Server của máy thi trước, và giữ `TrustServerCertificate=True`
nếu server dùng certificate self-signed.

### 9.2. Chạy local (3 terminal)

```bash
dotnet run --project src/Prn232.AuthApi      # http://localhost:5001/swagger
dotnet run --project src/Prn232.ProductApi   # http://localhost:5002/swagger
dotnet run --project src/Prn232.Fe           # http://localhost:5000
```

Publish để nộp (theo `Cong phap PRN.txt`):

```bash
dotnet publish -c Release -o ./Q1_<MSSV>
dotnet publish -c Release -o ./Q2_<MSSV>
```

---

## 10. Đổi đề thì sửa ở đâu

Bảng tra nhanh — mọi chỗ dưới đây **phải có comment `// [SỬA KHI ĐỔI ĐỀ]`** trong code.

| Đề đổi gì | Sửa file |
|---|---|
| Tên model (Product → X) | `ProductApi/Models/*` (scaffold lại), `ProductApi/Dtos`, `Controllers/ProductsController.cs`, `Fe/Pages/Products/*` |
| Thêm bảng liên quan | Scaffold lại, `Include(...)` trong controller, DTO |
| Connection string / server | `appsettings.json` của cả 2 API |
| JWT Key/Issuer/Audience | `appsettings.json` của **cả 2** API (phải giống nhau) |
| Route API | `Controllers/*.cs` + `Fe/Services/ApiClient.cs` |
| Thêm field vào form | `Pages/Products/Create|Edit.cshtml` + DTO + controller |
| Đổi tên project | `.sln`, namespace, `launchSettings.json` |

---

## 11. `tutorials/index.html`

Một file HTML duy nhất, tự chứa (CSS inline, không cần build), **3 phần**:

### Phần 1 — Setup
- Cài .NET 8 SDK, SQL Server (hoặc Docker), SSMS/Azure Data Studio
- Tạo DB bằng `init.sql`
- Các lệnh: `dotnet restore`, `dotnet ef dbcontext scaffold`, `dotnet run`
- Cấu hình connection string + JWT
- Verify: swagger ở `:5001/swagger`, `:5002/swagger`, FE ở `:5000`

### Phần 2 — Cách làm bài
- Quy trình từng bước khi nhận đề (đọc đề → xác định model → scaffold → sửa controller → sửa FE → test → publish)
- Checklist trước khi nộp (đúng số NuGet, đúng tên folder `Q1_<MSSV>`, không hard-code connection string)
- Các lỗi thường gặp + cách sửa: 401 do JWT lệch key, lỗi vòng lặp JSON, CORS, port trùng, thiếu `UseSession`

### Phần 3 — Tra cứu code
Dạng "muốn làm X thì copy đoạn này":
- Đổi query / thêm `Where`, `OrderBy`, phân trang
- `Include` nhiều bảng
- Thêm route / đổi tham số
- Gọi API từ Razor Page (GET/POST/PUT/DELETE)
- Gắn Bearer token
- Đọc/ghi Session
- Tạo JWT
- Validate JWT trong `Program.cs`
- Scaffold controller bằng `aspnet-codegenerator`

> Mỗi mục: mô tả ngắn → code block copy được ngay → ghi chú chỗ cần đổi.

---

## 12. Roadmap triển khai

- [x] Tạo `src/Prn232.sln` + 3 project (.NET 8)
- [x] Viết `src/db/init.sql` (Account, Product + seed 1 account, vài product)
- [x] Scaffold model cho AuthApi và ProductApi, xoá `OnConfiguring` (dùng `--no-onconfiguring`)
- [x] AuthApi: `TokenService`, `AuthController`, cấu hình JWT
- [x] ProductApi: `ProductsController` CRUD + DTO + phân trang + `[Authorize]`
- [x] ProductApi: Swagger có nút Authorize (Bearer)
- [x] FE: `ApiClient`, Session, Login/Logout
- [x] FE: Products list/create/edit/delete (UI Bootstrap tối giản)
- [x] Thêm comment `// [SỬA KHI ĐỔI ĐỀ]` ở mọi chỗ cần sửa
- [x] `tutorials/index.html` đủ 3 phần
- [x] Chạy thử end-to-end: login → list → create → edit → delete → logout
- [x] Cập nhật README + AGENTS nếu có thay đổi so với đặc tả

---

## 13. Giả định đã xác nhận

Các điểm dưới đây **đã chốt và đang là code hiện tại**:

1. Tên solution/project: `Prn232.sln`, `Prn232.Fe`, `Prn232.AuthApi`, `Prn232.ProductApi`.
2. Port: FE 5000, Auth 5001, Product 5002 (khai báo trong `appsettings.json` + `launchSettings.json`).
3. Dùng **Session** (không phải cookie auth) để giữ token ở FE.
4. FE gọi trực tiếp 2 API qua `HttpClient` (không qua proxy/BFF).
5. AuthApi và ProductApi dùng **cùng một database** `Prn232Exam`.
6. Password lưu **plaintext** (cho nhanh thi) — ghi chú rõ trong `init.sql` và `AuthController`.
7. `Product` có các field: `Id, Name, Price, Description, CreatedAt` — **không** có `CategoryId`/ảnh.
8. **Không** có Register, chỉ có account seed sẵn (`admin/123456`, `user/123456`).
9. **Không** phân quyền theo `Role`; chỉ cần đăng nhập là dùng được mọi endpoint Product.
10. File SQL: `src/db/init.sql`.

Thay đổi nhỏ so với đặc tả ban đầu:

- `ProductApi` trả phân trang dạng object `{ items, page, size, total }` (không trả mảng trần).
  Nếu đề yêu cầu trả mảng, sửa `GetAll` trong `ProductsController.cs`.
- Bảng `Account` giữ cột `Role` (để hiển thị), nhưng **không** dùng để chặn quyền.
- `AutoMapper` có trong danh sách NuGet chuẩn nhưng **không dùng**; map tay entity → DTO.
- NuGet `AutoMapper 15.0.1` bị NuGet cảnh báo bảo mật (NU1903). Vì đề yêu cầu giữ đúng danh
  sách package nên vẫn để; nếu trường yêu cầu khác thì bỏ package này.

Tham khảo: đề mẫu nằm ở `examination/1/` (paper + script.sql + sample.html).

---

## 14. Ghi chú gốc

Toàn bộ mẹo làm bài gốc nằm trong [`Cong phap PRN.txt`](./Cong%20phap%20PRN.txt). Tóm tắt những điểm đã đưa vào đặc tả:

- Scaffold DB-first bằng `dotnet ef dbcontext scaffold ... -o Models`
- Xoá `OnConfiguring` sau khi scaffold
- Đăng ký `AddDbContext` trong `Program.cs`
- JWT config giống hệt nhau giữa các project
- `Include(...)` để lấy dữ liệu bảng liên quan
- `ReferenceHandler.IgnoreCycles` nếu lỗi vòng lặp JSON
- `dotnet aspnet-codegenerator controller -name X -m Y -dc Z -api -outDir Controllers`
- Danh sách NuGet package chuẩn (mục 4.3) — kiểm tra lại sau khi scaffold
- `dotnet publish -c Release -o ./Q1_<MSSV>`
