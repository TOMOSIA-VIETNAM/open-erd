class CheckoutService
  def initialize(customer, cart_items, coupon_code: nil)
    @customer = customer
    @cart_items = cart_items
    @coupon_code = coupon_code
  end

  def call
    Order.transaction do
      order = @customer.orders.create!(
        shipping_address: @customer.addresses.first,
        coupon: Coupon.find_by(code: @coupon_code),
        total_cents: total_cents
      )
      @cart_items.each do |item|
        order.order_items.create!(product: item.product, quantity: item.quantity,
                                  unit_price_cents: item.product.price_cents)
      end
      PaymentGateway.charge(order)
      order
    end
  end

  private

  def total_cents
    @cart_items.sum { |item| item.product.price_cents * item.quantity }
  end
end
