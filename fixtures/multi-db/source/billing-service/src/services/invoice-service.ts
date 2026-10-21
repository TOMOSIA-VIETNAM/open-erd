import { EntityManager } from 'typeorm';
import { getProduct } from '../clients/catalog-client';
import { Invoice } from '../entities/invoice.entity';
import { InvoiceLine } from '../entities/invoice-line.entity';

export async function addProductLine(
  manager: EntityManager,
  invoice: Invoice,
  productId: number,
  quantity: number,
  unitPriceCents: number,
): Promise<InvoiceLine> {
  const product = await getProduct(productId);
  if (!product || product.status !== 'active') throw new Error(`product ${productId} not sellable`);
  const line = manager.create(InvoiceLine, {
    invoice,
    productId: String(product.id),
    description: product.name,
    quantity,
    unitPriceCents,
  });
  return manager.save(line);
}
