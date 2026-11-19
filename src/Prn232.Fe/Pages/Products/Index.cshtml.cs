using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Prn232.Fe.Models;
using Prn232.Fe.Services;

namespace Prn232.Fe.Pages.Products;

public class IndexModel : PageModel
{
    // Số dòng mỗi trang — sửa 1 chỗ này là đổi phân trang
    private const int PageSize = 5;

    private readonly ApiClient _api;

    public IndexModel(ApiClient api)
    {
        _api = api;
    }

    public List<ProductDto> Products { get; private set; } = new();
    public int PageNumber { get; private set; } = 1;
    public int TotalPages { get; private set; } = 1;
    public int Total { get; private set; }
    public string? Search { get; private set; }
    public string? ErrorMessage { get; private set; }

    [TempData]
    public string? Message { get; set; }

    public async Task<IActionResult> OnGetAsync(int page = 1, string? search = null)
    {
        if (string.IsNullOrEmpty(HttpContext.Session.GetString("accessToken")))
        {
            return RedirectToPage("/Login");
        }

        try
        {
            var result = await _api.GetProductsAsync(page, PageSize, search);
            if (result == null)
            {
                ErrorMessage = _api.ErrorMessage;
                return Page();
            }

            Products = result.Items;
            PageNumber = result.Page;
            TotalPages = Math.Max(1, result.TotalPages);
            Total = result.Total;
            Search = search;
        }
        catch (UnauthorizedAccessException)
        {
            // Token hết hạn -> xoá session, quay về login
            HttpContext.Session.Clear();
            return RedirectToPage("/Login");
        }

        return Page();
    }
}
