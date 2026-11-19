using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Prn232.AuthApi.Models;
using Prn232.AuthApi.Services;

namespace Prn232.AuthApi.Controllers;

[ApiController]
[Route("api/auth")]
public class AuthController : ControllerBase
{
    private readonly Prn232Context _context;
    private readonly TokenService _tokenService;

    public AuthController(Prn232Context context, TokenService tokenService)
    {
        _context = context;
        _tokenService = tokenService;
    }

    // POST /api/auth/login
    // [SỬA KHI ĐỔI ĐỀ] Đổi bảng Account / field username-password theo model của đề.
    [HttpPost("login")]
    public async Task<IActionResult> Login([FromBody] LoginRequest request)
    {
        // Password đang so sánh plaintext cho nhanh thi (xem ghi chú trong init.sql).
        var account = await _context.Accounts
            .FirstOrDefaultAsync(a => a.Username == request.Username && a.Password == request.Password);

        if (account == null)
        {
            return Unauthorized(new { message = "Sai username hoặc password" });
        }

        var token = _tokenService.CreateToken(account);

        return Ok(new
        {
            accessToken = token,
            username = account.Username,
            role = account.Role
        });
    }

    // GET /api/auth/me
    [Authorize]
    [HttpGet("me")]
    public IActionResult Me()
    {
        return Ok(new
        {
            username = User.FindFirst("username")?.Value ?? User.Identity?.Name,
            role = User.FindFirst("role")?.Value
        });
    }
}

public class LoginRequest
{
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";
}
