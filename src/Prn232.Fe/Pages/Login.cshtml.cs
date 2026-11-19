using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Prn232.Fe.Services;

namespace Prn232.Fe.Pages;

public class LoginModel : PageModel
{
    private readonly ApiClient _api;

    public LoginModel(ApiClient api)
    {
        _api = api;
    }

    [BindProperty]
    public LoginInput Input { get; set; } = new();

    public string? ErrorMessage { get; set; }

    public IActionResult OnGet()
    {
        // Đã có token thì không cần login lại
        if (!string.IsNullOrEmpty(HttpContext.Session.GetString("accessToken")))
        {
            return RedirectToPage("/Products/Index");
        }

        return Page();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        if (!ModelState.IsValid)
        {
            return Page();
        }

        var result = await _api.LoginAsync(Input.Username, Input.Password);
        if (result == null)
        {
            ErrorMessage = _api.ErrorMessage ?? "Đăng nhập thất bại";
            return Page();
        }

        // Lưu token vào Session — [SỬA KHI ĐỔI ĐỀ] nếu đề yêu cầu lưu cookie thì đổi ở đây
        HttpContext.Session.SetString("accessToken", result.AccessToken);
        HttpContext.Session.SetString("username", result.Username);
        HttpContext.Session.SetString("role", result.Role);

        return RedirectToPage("/Products/Index");
    }

    public class LoginInput
    {
        [Required(ErrorMessage = "Nhập username")]
        public string Username { get; set; } = "";

        [Required(ErrorMessage = "Nhập password")]
        public string Password { get; set; } = "";
    }
}
