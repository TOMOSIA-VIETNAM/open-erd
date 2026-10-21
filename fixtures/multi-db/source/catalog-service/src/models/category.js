'use strict';
module.exports = (sequelize, DataTypes) => {
  const Category = sequelize.define('Category', {
    name: DataTypes.STRING(120),
    slug: DataTypes.STRING(120),
  }, { tableName: 'categories', underscored: true, timestamps: false });

  Category.associate = (models) => {
    Category.belongsTo(models.Category, { as: 'parent', foreignKey: 'parent_id' });
    Category.hasMany(models.Category, { as: 'children', foreignKey: 'parent_id' });
    Category.hasMany(models.Product, { foreignKey: 'category_id' });
  };
  return Category;
};
