'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('stock_reservations', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      variant_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'product_variants', key: 'id' },
      },
      // Invoice id issued by billing-service (uuid); checked through its API.
      invoice_id: { type: Sequelize.CHAR(36), allowNull: true },
      quantity: { type: Sequelize.INTEGER, allowNull: false },
      status: {
        type: Sequelize.ENUM('held', 'committed', 'released'),
        allowNull: false,
        defaultValue: 'held',
      },
      expires_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('stock_reservations');
  },
};
