using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Prn232.Fe.Models;
using Prn232.Fe.Services;

namespace Prn232.Fe.Pages.Products;

public class DeleteModel : PageModel
{
    private readonly ApiClient _api;

    public DeleteModel(ApiClient api)
    {
        _api = api;
    }

    public ProductDto? Product { get; private set; }

    public string? ErrorMessage { get; set; }

    public async Task<IActionResult> OnGetAsync(int id)
    {
        if (string.IsNullOrEmpty(HttpContext.Session.GetString("accessToken")))
        {
            return RedirectToPage("/Login");
        }

        try
        {
            Product = await _api.GetProductAsync(id);
        }
        catch (UnauthorizedAccessException)
        {
            HttpContext.Session.Clear();
            return RedirectToPage("/Login");
        }

        return Page();
    }

    public async Task<IActionResult> OnPostAsync(int id)
    {
        if (string.IsNullOrEmpty(HttpContext.Session.GetString("accessToken")))
        {
            return RedirectToPage("/Login");
        }

        try
        {
            var ok = await _api.DeleteAsync(id);
            if (!ok)
            {
                Product = await _api.GetProductAsync(id);
                ErrorMessage = _api.ErrorMessage;
                return Page();
            }
        }
        catch (UnauthorizedAccessException)
        {
            HttpContext.Session.Clear();
            return RedirectToPage("/Login");
        }

        TempData["Message"] = "Đã xoá sản phẩm";
        return RedirectToPage("./Index");
    }
}
