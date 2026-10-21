# rails

Rails 7 shop: `db/schema.rb`, `app/models/`, `app/services/`. 15 tables, 20 relations, 1 polymorphic.

- `schema.rb` has no `add_foreign_key`: every relation is `declared` (from `belongs_to`/`has_many`), none is `db_fk`.
- STI: `accounts.type` holds `Customer` or `Vendor`. `products.vendor_id` is declared only on `Vendor` (`has_many :products, foreign_key: :vendor_id`), so the target is the base table `accounts`.
- `class_name`/`foreign_key`: `orders.customer_id` and `reviews.account_id` (`belongs_to :author, class_name: "Customer"`) point to `accounts`; `orders.shipping_address_id` points to `addresses`.
- Self-references: `accounts.referred_by_id` (on `Customer`) and `categories.parent_id`.
- Polymorphic `comments.commentable` with targets `products`, `orders`, `reviews`.
- `has_and_belongs_to_many` join table `products_tags` has no model file and no `id`.
- Integer-backed `enum` exists only in models (`Order#status`, `Payment#state`, `Product#visibility`).
- `shipments.warehouse_id` has no association; only `FulfillmentService#pick_warehouse` sets it (`inferred`). `payments.gateway_customer_id` looks like an FK but is a provider id: no relation (precision trap).
- Schema gap: STI is expressed only as a table `note` plus `enum` on `type`; the model has no field for subclasses.
