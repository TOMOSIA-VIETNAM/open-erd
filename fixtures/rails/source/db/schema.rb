# This file is auto-generated from the current state of the database.
# Foreign key constraints are not used in this application: integrity is kept
# by the models.

ActiveRecord::Schema[7.1].define(version: 2024_06_12_090000) do
  enable_extension "plpgsql"

  create_table "accounts", force: :cascade do |t|
    t.string "type", null: false
    t.string "name", null: false
    t.string "email", null: false
    t.string "phone"
    t.bigint "referred_by_id"
    t.string "tax_number"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["email"], name: "index_accounts_on_email", unique: true
    t.index ["type"], name: "index_accounts_on_type"
  end

  create_table "addresses", force: :cascade do |t|
    t.bigint "account_id", null: false
    t.string "line1", null: false
    t.string "city", null: false
    t.string "postal_code"
    t.string "country_code", limit: 2, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["account_id"], name: "index_addresses_on_account_id"
  end

  create_table "categories", force: :cascade do |t|
    t.string "name", null: false
    t.bigint "parent_id"
    t.integer "position", default: 0, null: false
  end

  create_table "products", force: :cascade do |t|
    t.bigint "vendor_id", null: false
    t.bigint "category_id"
    t.string "name", null: false
    t.integer "price_cents", null: false
    t.integer "visibility", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["vendor_id"], name: "index_products_on_vendor_id"
  end

  create_table "tags", force: :cascade do |t|
    t.string "label", null: false
    t.index ["label"], name: "index_tags_on_label", unique: true
  end

  create_table "products_tags", id: false, force: :cascade do |t|
    t.bigint "product_id", null: false
    t.bigint "tag_id", null: false
    t.index ["product_id", "tag_id"], name: "index_products_tags_on_product_id_and_tag_id", unique: true
  end

  create_table "warehouses", force: :cascade do |t|
    t.string "code", null: false
    t.string "city", null: false
  end

  create_table "stock_levels", force: :cascade do |t|
    t.bigint "product_id", null: false
    t.bigint "warehouse_id", null: false
    t.integer "quantity", default: 0, null: false
  end

  create_table "coupons", force: :cascade do |t|
    t.string "code", null: false
    t.integer "percent_off", null: false
    t.date "expires_on"
  end

  create_table "orders", force: :cascade do |t|
    t.bigint "customer_id", null: false
    t.bigint "shipping_address_id"
    t.bigint "coupon_id"
    t.integer "status", default: 0, null: false
    t.integer "total_cents", null: false
    t.datetime "placed_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
  end

  create_table "order_items", force: :cascade do |t|
    t.bigint "order_id", null: false
    t.bigint "product_id", null: false
    t.integer "quantity", null: false
    t.integer "unit_price_cents", null: false
  end

  create_table "payments", force: :cascade do |t|
    t.bigint "order_id", null: false
    t.integer "state", default: 0, null: false
    t.integer "amount_cents", null: false
    t.string "gateway_customer_id"
    t.string "gateway_charge_id"
    t.datetime "created_at", null: false
  end

  create_table "shipments", force: :cascade do |t|
    t.bigint "order_id", null: false
    t.bigint "warehouse_id"
    t.string "tracking_number"
    t.datetime "shipped_at"
    t.index ["order_id"], name: "index_shipments_on_order_id", unique: true
  end

  create_table "reviews", force: :cascade do |t|
    t.bigint "product_id", null: false
    t.bigint "account_id", null: false
    t.integer "rating", null: false
    t.text "body"
    t.datetime "created_at", null: false
  end

  create_table "comments", force: :cascade do |t|
    t.string "commentable_type", null: false
    t.bigint "commentable_id", null: false
    t.bigint "account_id", null: false
    t.text "body", null: false
    t.datetime "created_at", null: false
    t.index ["commentable_type", "commentable_id"], name: "index_comments_on_commentable"
  end
end
