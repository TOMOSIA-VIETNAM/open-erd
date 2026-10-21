class Customer < Account
  belongs_to :referrer, class_name: "Customer", foreign_key: :referred_by_id, optional: true
  has_many :referrals, class_name: "Customer", foreign_key: :referred_by_id

  has_many :orders, foreign_key: :customer_id
  has_many :reviews, foreign_key: :account_id, inverse_of: :author
end
