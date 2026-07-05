const mongoose = require('mongoose');
const logger = require('../logger');

// MongoDB connection URI — provided via the environment (see .env.example).
// Falls back to a local instance for non-containerized development only.
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management';

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI);

    logger.info(`MongoDB connected (db: ${mongoose.connection.name}, host: ${mongoose.connection.host})`);

    // Initialize default data
    await initializeDefaultData();

  } catch (error) {
    logger.error('MongoDB connection error: ' + error.message);
    process.exit(1);
  }
};

// Initialize default data (gas types and cylinder sizes)
const initializeDefaultData = async () => {
  const GasType = require('../models/GasType');
  const CylinderSize = require('../models/CylinderSize');
  
  try {
    // Gas type -> valid capacities (single backend source; mirrors GAS_CAPACITIES in frontend/app.js)
    const { GAS_CAPACITIES } = require('./gasCapacities');

    for (const gasType of Object.keys(GAS_CAPACITIES)) {
      await GasType.findOneAndUpdate(
        { gas_type_name: gasType },
        { gas_type_name: gasType, is_active: true },
        { upsert: true, new: true }
      );
    }

    // Prune gas types no longer in the canonical list (e.g. the old
    // 'Industrial Oxygen' / 'Medical Oxygen' split, now merged into 'Oxygen').
    await GasType.deleteMany({ gas_type_name: { $nin: Object.keys(GAS_CAPACITIES) } });

    // All distinct capacities across every gas type
    const sizes = [...new Set(Object.values(GAS_CAPACITIES).flat())];

    for (const size of sizes) {
      await CylinderSize.findOneAndUpdate(
        { size_label: size },
        { size_label: size, is_active: true },
        { upsert: true, new: true }
      );
    }

    logger.info('Default data initialized (gas types & cylinder sizes)');
  } catch (error) {
    logger.error('Error initializing default data: ' + error.message);
  }
};

// Connection lifecycle logging (shutdown is handled centrally in server.js).
mongoose.connection.on('error', (err) => {
  logger.error('Mongoose connection error: ' + err.message);
});
mongoose.connection.on('disconnected', () => {
  logger.warn('Mongoose disconnected from MongoDB');
});

module.exports = connectDB;
