'use strict';
module.exports = (sequelize, DataTypes) => {
  const StockReservation = sequelize.define('StockReservation', {
    invoiceId: { type: DataTypes.CHAR(36), field: 'invoice_id' },
    quantity: DataTypes.INTEGER,
    status: {
      type: DataTypes.ENUM('held', 'committed', 'released'),
      defaultValue: 'held',
    },
    expiresAt: { type: DataTypes.DATE, field: 'expires_at' },
  }, { tableName: 'stock_reservations', underscored: true, timestamps: false });

  StockReservation.associate = (models) => {
    StockReservation.belongsTo(models.ProductVariant, { as: 'variant', foreignKey: 'variant_id' });
  };
  return StockReservation;
};
