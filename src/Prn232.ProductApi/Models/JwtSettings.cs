namespace Prn232.ProductApi.Models;

// [SỬA KHI ĐỔI ĐỀ] JWT config — phải GIỐNG HỆT ở AuthApi và ProductApi
public class JwtSettings
{
    public string Issuer { get; set; } = "";
    public string Audience { get; set; } = "";
    public string Key { get; set; } = "";
    public int ExpiryInDays { get; set; } = 1;
}
