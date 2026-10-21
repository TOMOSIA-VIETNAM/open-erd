module PaymentGateway
  def self.charge(order)
    response = Client.new.create_charge(amount: order.total_cents,
                                        customer: order.customer.email)
    order.payments.create!(amount_cents: order.total_cents, state: :captured,
                           gateway_customer_id: response.customer_id,
                           gateway_charge_id: response.id)
    order.paid!
  end
end
