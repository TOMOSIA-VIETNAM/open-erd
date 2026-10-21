class StockLevel < ApplicationRecord
  belongs_to :product
  belongs_to :warehouse
end
