using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Prn232.Fe.Models;
using Prn232.Fe.Services;

namespace Prn232.Fe.Pages.Products;

public class EditModel : PageModel
{
    private readonly ApiClient _api;

    public EditModel(ApiClient api)
    {
        _api = api;
    }

    public int Id { get; private set; }

    [BindProperty]
    public SaveProductDto Input { get; set; } = new();

    public string? ErrorMessage { get; set; }

    public async Task<IActionResult> OnGetAsync(int id)
    {
        if (string.IsNullOrEmpty(HttpContext.Session.GetString("accessToken")))
        {
            return RedirectToPage("/Login");
        }

        try
        {
            var product = await _api.GetProductAsync(id);
            if (product == null)
            {
                return NotFound();
            }

            Id = product.Id;
            Input = new SaveProductDto
            {
                Name = product.Name,
                Price = product.Price,
                Description = product.Description
            };
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

        Id = id;

        if (!ModelState.IsValid)
        {
            return Page();
        }

        try
        {
            var ok = await _api.UpdateAsync(id, Input);
            if (!ok)
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

        TempData["Message"] = "Đã cập nhật sản phẩm";
        return RedirectToPage("./Index");
    }
}
