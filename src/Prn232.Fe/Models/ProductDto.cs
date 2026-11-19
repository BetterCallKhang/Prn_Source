using System.ComponentModel.DataAnnotations;

namespace Prn232.Fe.Models;

// [SỬA KHI ĐỔI ĐỀ] Copy DTO y hệt bên ProductApi/Dtos.
public class ProductDto
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public decimal Price { get; set; }
    public string? Description { get; set; }
    public DateTime CreatedAt { get; set; }
}

// Dùng cho form Create/Edit
public class SaveProductDto
{
    [Required(ErrorMessage = "Name không được để trống")]
    [StringLength(200)]
    public string Name { get; set; } = "";

    [Range(0, double.MaxValue, ErrorMessage = "Price phải >= 0")]
    public decimal Price { get; set; }

    [StringLength(500)]
    public string? Description { get; set; }
}

public class ProductPageDto
{
    public List<ProductDto> Items { get; set; } = new();
    public int Page { get; set; }
    public int Size { get; set; }
    public int Total { get; set; }

    public int TotalPages => Size <= 0 ? 1 : (int)Math.Ceiling(Total / (double)Size);
}

public class LoginResult
{
    public string AccessToken { get; set; } = "";
    public string Username { get; set; } = "";
    public string Role { get; set; } = "";
}
