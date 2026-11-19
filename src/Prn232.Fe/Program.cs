using Prn232.Fe.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorPages();

// Session lưu token đăng nhập (accessToken / username / role)
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession(options =>
{
    options.IdleTimeout = TimeSpan.FromHours(2);
    options.Cookie.HttpOnly = true;
    options.Cookie.IsEssential = true;
});

// ApiClient cần đọc Session -> cần IHttpContextAccessor
builder.Services.AddHttpContextAccessor();
builder.Services.AddHttpClient<ApiClient>();

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
}

app.UseStaticFiles();
app.UseRouting();

// UseSession phải đứng trước MapRazorPages
app.UseSession();
app.UseAuthorization();

app.MapRazorPages();

app.Run();
