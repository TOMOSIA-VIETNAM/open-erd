class Payment < ApplicationRecord
  belongs_to :order

  # gateway_customer_id / gateway_charge_id are identifiers at the payment
  # provider, not rows in this database.
  enum :state, { authorized: 0, captured: 1, refunded: 2, failed: 3 }
end
