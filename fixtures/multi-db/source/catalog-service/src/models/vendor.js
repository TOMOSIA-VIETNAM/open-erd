'use strict';
module.exports = (sequelize, DataTypes) => {
  const Vendor = sequelize.define('Vendor', {
    name: DataTypes.STRING(160),
    contactEmail: { type: DataTypes.STRING(255), field: 'contact_email' },
  }, { tableName: 'vendors', underscored: true, updatedAt: false });

  Vendor.associate = (models) => {
    Vendor.hasMany(models.Product, { foreignKey: 'vendor_id' });
  };
  return Vendor;
};
