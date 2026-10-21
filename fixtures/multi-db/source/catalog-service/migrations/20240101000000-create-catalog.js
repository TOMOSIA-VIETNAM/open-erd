'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('vendors', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      name: { type: Sequelize.STRING(160), allowNull: false },
      contact_email: { type: Sequelize.STRING(255), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('categories', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      parent_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'categories', key: 'id' },
        onDelete: 'SET NULL',
      },
      name: { type: Sequelize.STRING(120), allowNull: false },
      slug: { type: Sequelize.STRING(120), allowNull: false, unique: true },
    });

    await queryInterface.createTable('products', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      category_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'categories', key: 'id' },
      },
      vendor_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'vendors', key: 'id' },
      },
      name: { type: Sequelize.STRING(255), allowNull: false },
      status: {
        type: Sequelize.ENUM('draft', 'active', 'retired'),
        allowNull: false,
        defaultValue: 'draft',
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('product_variants', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      product_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'products', key: 'id' },
        onDelete: 'CASCADE',
      },
      sku: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      option_label: { type: Sequelize.STRING(120), allowNull: true },
    });

    await queryInterface.createTable('product_prices', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      variant_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'product_variants', key: 'id' },
      },
      currency: { type: Sequelize.CHAR(3), allowNull: false },
      amount_cents: { type: Sequelize.INTEGER, allowNull: false },
      valid_from: { type: Sequelize.DATE, allowNull: false },
    });

    // Images were added by a bulk import job; the column never got a constraint.
    await queryInterface.createTable('product_images', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      product_id: { type: Sequelize.BIGINT, allowNull: false },
      url: { type: Sequelize.STRING(500), allowNull: false },
      position: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
    });
  },

  async down(queryInterface) {
    for (const t of ['product_images', 'product_prices', 'product_variants', 'products', 'categories', 'vendors']) {
      await queryInterface.dropTable(t);
    }
  },
};
