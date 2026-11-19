using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Prn232.Fe.Models;

namespace Prn232.Fe.Services;

/// <summary>
/// Nơi DUY NHẤT chứa HttpClient + Bearer token.
/// [SỬA KHI ĐỔI ĐỀ] Đổi route API ở đây (và trong Controller tương ứng).
/// </summary>
public class ApiClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly HttpClient _http;
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly string _authApiBaseUrl;
    private readonly string _productApiBaseUrl;

    // Lỗi gần nhất để Page hiển thị (đọc sau khi gọi method trả null/false)
    public string? ErrorMessage { get; private set; }

    public ApiClient(HttpClient http, IHttpContextAccessor httpContextAccessor, IConfiguration configuration)
    {
        _http = http;
        _httpContextAccessor = httpContextAccessor;
        _authApiBaseUrl = configuration["AuthApiBaseUrl"] ?? "http://localhost:5001";
        _productApiBaseUrl = configuration["ProductApiBaseUrl"] ?? "http://localhost:5002";
    }

    // ---------- AUTH ----------

    // POST {AuthApi}/api/auth/login
    public async Task<LoginResult?> LoginAsync(string username, string password)
    {
        var response = await _http.PostAsJsonAsync($"{_authApiBaseUrl}/api/auth/login",
            new { username, password });

        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            ErrorMessage = "Sai username hoặc password";
            return null;
        }

        if (!response.IsSuccessStatusCode)
        {
            ErrorMessage = $"Auth API lỗi {(int)response.StatusCode}";
            return null;
        }

        return await response.Content.ReadFromJsonAsync<LoginResult>(JsonOptions);
    }

    // ---------- PRODUCT ----------

    // GET {ProductApi}/api/products?page=&size=&search=
    public async Task<ProductPageDto?> GetProductsAsync(int page, int size, string? search)
    {
        var url = $"{_productApiBaseUrl}/api/products?page={page}&size={size}&search={Uri.EscapeDataString(search ?? "")}";
        var response = await SendAuthorizedAsync(HttpMethod.Get, url);

        if (!response.IsSuccessStatusCode)
        {
            ErrorMessage = await ReadErrorAsync(response);
            return null;
        }

        return await response.Content.ReadFromJsonAsync<ProductPageDto>(JsonOptions);
    }

    // GET {ProductApi}/api/products/{id}
    public async Task<ProductDto?> GetProductAsync(int id)
    {
        var response = await SendAuthorizedAsync(HttpMethod.Get, $"{_productApiBaseUrl}/api/products/{id}");

        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        if (!response.IsSuccessStatusCode)
        {
            ErrorMessage = await ReadErrorAsync(response);
            return null;
        }

        return await response.Content.ReadFromJsonAsync<ProductDto>(JsonOptions);
    }

    // POST {ProductApi}/api/products
    public async Task<ProductDto?> CreateAsync(SaveProductDto dto)
    {
        var response = await SendAuthorizedAsync(HttpMethod.Post, $"{_productApiBaseUrl}/api/products", dto);

        if (!response.IsSuccessStatusCode)
        {
            ErrorMessage = await ReadErrorAsync(response);
            return null;
        }

        return await response.Content.ReadFromJsonAsync<ProductDto>(JsonOptions);
    }

    // PUT {ProductApi}/api/products/{id}
    public async Task<bool> UpdateAsync(int id, SaveProductDto dto)
    {
        var response = await SendAuthorizedAsync(HttpMethod.Put, $"{_productApiBaseUrl}/api/products/{id}", dto);

        if (!response.IsSuccessStatusCode)
        {
            ErrorMessage = await ReadErrorAsync(response);
            return false;
        }

        return true;
    }

    // DELETE {ProductApi}/api/products/{id}
    public async Task<bool> DeleteAsync(int id)
    {
        var response = await SendAuthorizedAsync(HttpMethod.Delete, $"{_productApiBaseUrl}/api/products/{id}");

        if (!response.IsSuccessStatusCode)
        {
            ErrorMessage = await ReadErrorAsync(response);
            return false;
        }

        return true;
    }

    // ---------- HELPER ----------

    // Gắn Bearer token từ Session. API trả 401 -> ném UnauthorizedAccessException
    // để PageModel redirect về /Login.
    private async Task<HttpResponseMessage> SendAuthorizedAsync(HttpMethod method, string url, object? body = null)
    {
        var token = _httpContextAccessor.HttpContext?.Session.GetString("accessToken");

        using var request = new HttpRequestMessage(method, url);
        if (!string.IsNullOrEmpty(token))
        {
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        }

        if (body != null)
        {
            request.Content = JsonContent.Create(body);
        }

        var response = await _http.SendAsync(request);

        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            throw new UnauthorizedAccessException("Token hết hạn hoặc không hợp lệ");
        }

        return response;
    }

    private static async Task<string> ReadErrorAsync(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        return string.IsNullOrWhiteSpace(body)
            ? $"API lỗi {(int)response.StatusCode}"
            : $"API lỗi {(int)response.StatusCode}: {body}";
    }
}
