'use strict';
module.exports = (sequelize, DataTypes) => {
  const ProductVariant = sequelize.define('ProductVariant', {
    sku: DataTypes.STRING(64),
    optionLabel: { type: DataTypes.STRING(120), field: 'option_label' },
  }, { tableName: 'product_variants', underscored: true, timestamps: false });

  ProductVariant.associate = (models) => {
    ProductVariant.belongsTo(models.Product, { foreignKey: 'product_id' });
    ProductVariant.hasMany(models.ProductPrice, { as: 'prices', foreignKey: 'variant_id' });
    ProductVariant.hasMany(models.StockReservation, { foreignKey: 'variant_id' });
  };
  return ProductVariant;
};
