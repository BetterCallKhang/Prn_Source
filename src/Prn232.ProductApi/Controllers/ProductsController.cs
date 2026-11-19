using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Prn232.ProductApi.Dtos;
using Prn232.ProductApi.Models;

namespace Prn232.ProductApi.Controllers;

[ApiController]
[Route("api/products")]
[Authorize] // mọi endpoint đều cần Bearer token
public class ProductsController : ControllerBase
{
    private readonly Prn232Context _context;

    public ProductsController(Prn232Context context)
    {
        _context = context;
    }

    // GET /api/products?page=1&size=10&search=
    // [SỬA KHI ĐỔI ĐỀ] Đổi DbSet, field filter, kiểu sắp xếp theo đề.
    [HttpGet]
    public async Task<ActionResult<ProductPageDto>> GetAll(
        [FromQuery] int page = 1,
        [FromQuery] int size = 10,
        [FromQuery] string? search = null)
    {
        if (page < 1) page = 1;
        if (size < 1) size = 10;

        var query = _context.Products.AsQueryable();

        if (!string.IsNullOrWhiteSpace(search))
        {
            query = query.Where(p => p.Name.Contains(search));
        }

        var total = await query.CountAsync();

        var items = await query
            .OrderBy(p => p.Id)
            .Skip((page - 1) * size)
            .Take(size)
            .Select(p => new ProductDto
            {
                Id = p.Id,
                Name = p.Name,
                Price = p.Price,
                Description = p.Description,
                CreatedAt = p.CreatedAt
            })
            .ToListAsync();

        return Ok(new ProductPageDto
        {
            Items = items,
            Page = page,
            Size = size,
            Total = total
        });
    }

    // GET /api/products/{id}
    [HttpGet("{id:int}")]
    public async Task<ActionResult<ProductDto>> GetById(int id)
    {
        var product = await _context.Products.FindAsync(id);
        if (product == null)
        {
            return NotFound(new { message = $"Không tìm thấy sản phẩm id = {id}" });
        }

        return Ok(ToDto(product));
    }

    // POST /api/products
    [HttpPost]
    public async Task<ActionResult<ProductDto>> Create([FromBody] SaveProductDto dto)
    {
        var product = new Product
        {
            Name = dto.Name,
            Price = dto.Price,
            Description = dto.Description,
            CreatedAt = DateTime.UtcNow
        };

        _context.Products.Add(product);
        await _context.SaveChangesAsync();

        return CreatedAtAction(nameof(GetById), new { id = product.Id }, ToDto(product));
    }

    // PUT /api/products/{id}
    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, [FromBody] SaveProductDto dto)
    {
        var product = await _context.Products.FindAsync(id);
        if (product == null)
        {
            return NotFound(new { message = $"Không tìm thấy sản phẩm id = {id}" });
        }

        product.Name = dto.Name;
        product.Price = dto.Price;
        product.Description = dto.Description;

        await _context.SaveChangesAsync();

        return Ok(ToDto(product));
    }

    // DELETE /api/products/{id}
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        var product = await _context.Products.FindAsync(id);
        if (product == null)
        {
            return NotFound(new { message = $"Không tìm thấy sản phẩm id = {id}" });
        }

        _context.Products.Remove(product);
        await _context.SaveChangesAsync();

        return Ok(new { message = "Đã xoá", id });
    }

    // Map entity -> DTO (viết tay cho dễ sửa, không cần AutoMapper)
    private static ProductDto ToDto(Product p) => new()
    {
        Id = p.Id,
        Name = p.Name,
        Price = p.Price,
        Description = p.Description,
        CreatedAt = p.CreatedAt
    };
}
