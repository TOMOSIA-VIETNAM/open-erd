'use strict';
module.exports = (sequelize, DataTypes) => {
  const ProductImage = sequelize.define('ProductImage', {
    url: DataTypes.STRING(500),
    position: DataTypes.INTEGER,
  }, { tableName: 'product_images', underscored: true, timestamps: false });

  ProductImage.associate = (models) => {
    // No `references` in the migration: association exists only here.
    ProductImage.belongsTo(models.Product, { foreignKey: 'product_id' });
  };
  return ProductImage;
};
