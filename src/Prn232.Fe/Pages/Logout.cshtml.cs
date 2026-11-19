using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace Prn232.Fe.Pages;

public class LogoutModel : PageModel
{
    // /Logout -> xoá session -> về /Login
    public IActionResult OnGet()
    {
        HttpContext.Session.Clear();
        return RedirectToPage("/Login");
    }
}
