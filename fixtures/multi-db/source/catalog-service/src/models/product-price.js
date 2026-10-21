'use strict';
module.exports = (sequelize, DataTypes) => {
  const ProductPrice = sequelize.define('ProductPrice', {
    currency: DataTypes.CHAR(3),
    amountCents: { type: DataTypes.INTEGER, field: 'amount_cents' },
    validFrom: { type: DataTypes.DATE, field: 'valid_from' },
  }, { tableName: 'product_prices', underscored: true, timestamps: false });

  ProductPrice.associate = (models) => {
    ProductPrice.belongsTo(models.ProductVariant, { as: 'variant', foreignKey: 'variant_id' });
  };
  return ProductPrice;
};
