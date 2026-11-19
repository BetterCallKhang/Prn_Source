using System.ComponentModel.DataAnnotations;

namespace Prn232.ProductApi.Dtos;

// DTO trả về cho FE — không trả entity trực tiếp để tránh lộ navigation property.
// [SỬA KHI ĐỔI ĐỀ] Copy đúng field của model mới.
public class ProductDto
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public decimal Price { get; set; }
    public string? Description { get; set; }
    public DateTime CreatedAt { get; set; }
}

// DTO nhận vào khi Create/Edit.
// [SỬA KHI ĐỔI ĐỀ] Thêm/bớt field + validation theo đề.
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

// Kết quả phân trang
public class ProductPageDto
{
    public List<ProductDto> Items { get; set; } = new();
    public int Page { get; set; }
    public int Size { get; set; }
    public int Total { get; set; }
}
