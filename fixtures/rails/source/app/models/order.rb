class Order < ApplicationRecord
  belongs_to :customer
  belongs_to :shipping_address, class_name: "Address", optional: true
  belongs_to :coupon, optional: true
  has_many :order_items, dependent: :destroy
  has_many :payments
  has_one :shipment
  has_many :comments, as: :commentable

  enum :status, { pending: 0, paid: 1, shipped: 2, cancelled: 3 }
end
