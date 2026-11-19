using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace Prn232.Fe.Pages;

public class IndexModel : PageModel
{
    public IActionResult OnGet()
    {
        // Chưa login -> /Login, đã login -> /Products
        return string.IsNullOrEmpty(HttpContext.Session.GetString("accessToken"))
            ? RedirectToPage("/Login")
            : RedirectToPage("/Products/Index");
    }
}
