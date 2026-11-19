-- ============================================================
-- PRN232 exam source — script tạo database + bảng + seed data
-- Chạy script này TRƯỚC khi scaffold model (DB-first).
-- [SỬA KHI ĐỔI ĐỀ] Đổi tên database/bảng/field ở đây rồi scaffold lại.
-- ============================================================

IF DB_ID('Prn232Exam') IS NULL
BEGIN
    CREATE DATABASE Prn232Exam;
END
GO

USE Prn232Exam;
GO

-- Xoá bảng cũ nếu chạy lại script (thứ tự: con trước, cha sau)
IF OBJECT_ID('dbo.Product', 'U') IS NOT NULL DROP TABLE dbo.Product;
IF OBJECT_ID('dbo.Account', 'U') IS NOT NULL DROP TABLE dbo.Account;
GO

-- ============================================================
-- Account: tài khoản đăng nhập
-- Lưu ý: password lưu plaintext CHO NHANH THI (không dùng cho production).
-- [SỬA KHI ĐỔI ĐỀ] Đổi tên bảng/field nếu đề yêu cầu (User, Employee...).
-- ============================================================
CREATE TABLE Account (
    Id          INT IDENTITY(1,1) PRIMARY KEY,
    Username    NVARCHAR(50)  NOT NULL UNIQUE,
    Password    NVARCHAR(100) NOT NULL,
    Role        NVARCHAR(20)  NOT NULL DEFAULT 'User'
);
GO

-- ============================================================
-- Product: model chính của đề mẫu
-- [SỬA KHI ĐỔI ĐỀ] Đổi tên bảng/field theo đề (Book, Movie, Student...).
-- ============================================================
CREATE TABLE Product (
    Id          INT IDENTITY(1,1) PRIMARY KEY,
    Name        NVARCHAR(200) NOT NULL,
    Price       DECIMAL(18,2) NOT NULL,
    Description NVARCHAR(500) NULL,
    CreatedAt   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- ============================================================
-- Seed data
-- ============================================================
INSERT INTO Account (Username, Password, Role) VALUES ('admin', '123456', 'Admin');
INSERT INTO Account (Username, Password, Role) VALUES ('user',  '123456', 'User');
GO

INSERT INTO Product (Name, Price, Description) VALUES (N'Laptop Dell',      15000000, N'Laptop văn phòng 15 inch');
INSERT INTO Product (Name, Price, Description) VALUES (N'Chuột Logitech',     250000, N'Chuột không dây');
INSERT INTO Product (Name, Price, Description) VALUES (N'Bàn phím cơ',        800000, N'Bàn phím cơ giá rẻ');
INSERT INTO Product (Name, Price, Description) VALUES (N'Màn hình LG 24"',   3200000, N'Màn hình Full HD');
INSERT INTO Product (Name, Price, Description) VALUES (N'Tai nghe Sony',     2100000, N'Tai nghe chống ồn');
GO
