# Base class of a single-table-inheritance hierarchy: see Customer and Vendor.
class Account < ApplicationRecord
  has_many :addresses, dependent: :destroy
  has_many :comments

  validates :email, presence: true, uniqueness: true
end
