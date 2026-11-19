using System;
using System.Collections.Generic;

namespace Prn232.AuthApi.Models;

public partial class Product
{
    public int Id { get; set; }

    public string Name { get; set; } = null!;

    public decimal Price { get; set; }

    public string? Description { get; set; }

    public DateTime CreatedAt { get; set; }
}
