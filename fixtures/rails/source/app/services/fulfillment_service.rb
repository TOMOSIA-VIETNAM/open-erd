class FulfillmentService
  def initialize(order)
    @order = order
  end

  def ship!
    shipment = @order.shipment || @order.build_shipment
    shipment.warehouse_id = pick_warehouse.id
    shipment.shipped_at = Time.current
    shipment.save!
    @order.shipped!
  end

  private

  # Shipment has no association to Warehouse; the id is set here only.
  def pick_warehouse
    product_ids = @order.order_items.pluck(:product_id)
    Warehouse
      .joins(:stock_levels)
      .where(stock_levels: { product_id: product_ids })
      .group("warehouses.id")
      .order(Arel.sql("SUM(stock_levels.quantity) DESC"))
      .first!
  end
end
