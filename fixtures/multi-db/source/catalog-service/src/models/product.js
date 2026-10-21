'use strict';
module.exports = (sequelize, DataTypes) => {
  const Product = sequelize.define('Product', {
    name: DataTypes.STRING(255),
    status: {
      type: DataTypes.ENUM('draft', 'active', 'retired'),
      defaultValue: 'draft',
    },
  }, { tableName: 'products', underscored: true, updatedAt: false });

  Product.associate = (models) => {
    Product.belongsTo(models.Category, { foreignKey: 'category_id' });
    Product.belongsTo(models.Vendor, { foreignKey: 'vendor_id' });
    Product.hasMany(models.ProductVariant, { as: 'variants', foreignKey: 'product_id' });
    Product.hasMany(models.ProductImage, { as: 'images', foreignKey: 'product_id' });
  };
  return Product;
};
