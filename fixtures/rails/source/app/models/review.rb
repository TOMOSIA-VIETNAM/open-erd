class Review < ApplicationRecord
  belongs_to :product
  belongs_to :author, class_name: "Customer", foreign_key: :account_id
  has_many :comments, as: :commentable
end
