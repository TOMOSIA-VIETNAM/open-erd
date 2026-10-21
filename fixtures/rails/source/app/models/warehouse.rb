class Warehouse < ApplicationRecord
  has_many :stock_levels
end
