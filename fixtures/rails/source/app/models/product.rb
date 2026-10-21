class Product < ApplicationRecord
  belongs_to :category, optional: true
  has_and_belongs_to_many :tags
  has_many :stock_levels
  has_many :reviews
  has_many :comments, as: :commentable

  enum :visibility, { draft: 0, listed: 1, archived: 2 }
end
