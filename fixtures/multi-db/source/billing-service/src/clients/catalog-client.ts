// HTTP client for catalog-service. Billing stores catalog product ids in
// invoice_lines.product_id and looks them up here; there is no shared database.
const CATALOG_URL = process.env.CATALOG_SERVICE_URL ?? 'http://catalog-service:3000';

export interface CatalogProduct {
  id: number;
  name: string;
  status: 'draft' | 'active' | 'retired';
}

export async function getProduct(productId: number): Promise<CatalogProduct | null> {
  const res = await fetch(`${CATALOG_URL}/internal/products/${productId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`catalog-service responded ${res.status}`);
  return (await res.json()) as CatalogProduct;
}
