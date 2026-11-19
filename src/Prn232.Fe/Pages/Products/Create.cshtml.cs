using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Prn232.Fe.Models;
using Prn232.Fe.Services;

namespace Prn232.Fe.Pages.Products;

public class CreateModel : PageModel
{
    private readonly ApiClient _api;

    public CreateModel(ApiClient api)
    {
        _api = api;
    }

    [BindProperty]
    public SaveProductDto Input { get; set; } = new();

    public string? ErrorMessage { get; set; }

    public IActionResult OnGet()
    {
        if (string.IsNullOrEmpty(HttpContext.Session.GetString("accessToken")))
        {
            return RedirectToPage("/Login");
        }

        return Page();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        if (string.IsNullOrEmpty(HttpContext.Session.GetString("accessToken")))
        {
            return RedirectToPage("/Login");
        }

        if (!ModelState.IsValid)
        {
            return Page();
        }

        try
        {
            var created = await _api.CreateAsync(Input);
            if (created == null)
            {
                ErrorMessage = _api.ErrorMessage;
                return Page();
            }
        }
        catch (UnauthorizedAccessException)
        {
            HttpContext.Session.Clear();
            return RedirectToPage("/Login");
        }

        TempData["Message"] = "Đã thêm sản phẩm";
        return RedirectToPage("./Index");
    }
}
