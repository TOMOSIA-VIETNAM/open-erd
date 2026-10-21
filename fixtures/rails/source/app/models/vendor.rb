# Products are linked to their vendor only from this side; Product has no
# belongs_to for it.
class Vendor < Account
  has_many :products, foreign_key: :vendor_id

  validates :tax_number, presence: true
end
