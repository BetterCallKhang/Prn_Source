using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using Prn232.AuthApi.Models;

namespace Prn232.AuthApi.Services;

// Tạo JWT từ thông tin Account.
// [SỬA KHI ĐỔI ĐỀ] Nếu đề yêu cầu claim khác (email, id...) thì thêm claim ở đây.
public class TokenService
{
    private readonly JwtSettings _jwt;

    public TokenService(IOptions<JwtSettings> jwt)
    {
        _jwt = jwt.Value;
    }

    public string CreateToken(Account account)
    {
        // [SỬA KHI ĐỔI ĐỀ] Thêm claim mới ở đây nếu đề yêu cầu (email, id, ...)
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, account.Id.ToString()),
            new("username", account.Username),
            new("role", account.Role),
        };

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_jwt.Key));
        var credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var token = new JwtSecurityToken(
            issuer: _jwt.Issuer,
            audience: _jwt.Audience,
            claims: claims,
            expires: DateTime.UtcNow.AddDays(_jwt.ExpiryInDays),
            signingCredentials: credentials);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}
