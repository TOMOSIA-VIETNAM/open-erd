// A second version of test/fixtures/workspace-shop exercising every kind of
// change the diff reports, as text edits of model/shop.yaml.
//   confirmed rename    coupons -> promo_codes (renamed_from)
//   possible rename     brands removed, manufacturers added with most of its columns
//   table added         wishlists (+ relation to users)
//   table removed       password_resets (+ its relation)
//   columns             orders.currency added, products.published_at removed,
//                       reviews.body renamed to comment, price_cents integer -> bigint,
//                       sessions.user_id no longer nullable, shipments.order_id no longer unique
//   enum                orders.status: refunded added, cancelled removed, paid meaning changed
//   relations           shipments -> orders 1-1 -> n-1, sessions -> users reviewed
//   note                products note changed
export const SHOP_V2_EDITS = [
  [
    `  - id: shop.public.password_resets
    domain: Identity
    columns:
      - { name: id, type: bigint, pk: true }
      - { name: user_id, type: bigint, nullable: false }
      - { name: token_digest, type: varchar(64), unique: true }
      - { name: expires_at, type: timestamp with time zone }
`,
    `  - id: shop.public.wishlists
    domain: Identity
    note: Products a customer saved for later.
    columns:
      - { name: id, type: bigint, pk: true }
      - { name: user_id, type: bigint, nullable: false }
      - { name: product_id, type: bigint, nullable: false }
`,
  ],
  [
    `  - id: shop.public.brands
    domain: Catalog
    columns:
      - { name: id, type: bigint, pk: true }
      - { name: name, type: varchar(120) }
`,
    `  - id: shop.public.manufacturers
    domain: Catalog
    columns:
      - { name: id, type: bigint, pk: true }
      - { name: name, type: varchar(120) }
      - { name: country_code, type: char(2) }
`,
  ],
  ['    note: Sellable item shown on the storefront.', '    note: Sellable item shown on the storefront and in the app.'],
  ['      - { name: published_at, type: timestamp with time zone }\n', ''],
  ['      - { name: price_cents, type: integer }', '      - { name: price_cents, type: bigint }'],
  ['      - { name: body, type: text }', '      - { name: comment, type: text, renamed_from: body }'],
  ['      - { name: user_id, type: bigint, nullable: true }\n      - { name: expires_at', '      - { name: user_id, type: bigint, nullable: false }\n      - { name: expires_at'],
  ['  - id: shop.public.coupons\n', '  - id: shop.public.promo_codes\n    renamed_from: shop.public.coupons\n'],
  [
    `          pending: Waiting for payment
          paid: Payment captured
          shipped: Handed to carrier
          cancelled: Cancelled before shipping
      - { name: total_cents, type: integer }`,
    `          pending: Waiting for payment
          paid: Payment captured by the gateway
          shipped: Handed to carrier
          refunded: Order money returned
      - { name: total_cents, type: integer }
      - { name: currency, type: char(3) }`,
  ],
  ['      - { name: order_id, type: bigint, unique: true, nullable: false }', '      - { name: order_id, type: bigint, nullable: false }'],
  [
    `  - from: { table: shop.public.password_resets, columns: [user_id] }
    to: { table: shop.public.users, columns: [id] }`,
    `  - from: { table: shop.public.wishlists, columns: [user_id] }
    to: { table: shop.public.users, columns: [id] }`,
  ],
  ['    to: { table: shop.public.brands, columns: [id] }', '    to: { table: shop.public.manufacturers, columns: [id] }'],
  ['    to: { table: shop.public.coupons, columns: [id] }', '    to: { table: shop.public.promo_codes, columns: [id] }'],
  [
    `    kind: inferred
    evidence: ["shop-api:app/models/session.rb#Session"]
    review: pending`,
    `    kind: inferred
    evidence: ["shop-api:app/models/session.rb#Session"]
    review: reviewed`,
  ],
  [
    `  - from: { table: shop.public.shipments, columns: [order_id] }
    to: { table: shop.public.orders, columns: [id] }
    cardinality: 1-1`,
    `  - from: { table: shop.public.shipments, columns: [order_id] }
    to: { table: shop.public.orders, columns: [id] }
    cardinality: n-1`,
  ],
];

export const SHOP_V2_SUMMARY = '+2 tables · −2 tables · 1 renamed · 7 columns changed · 6 relations changed';
