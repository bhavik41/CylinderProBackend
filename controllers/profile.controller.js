const asyncHandler = require('../middleware/asyncHandler');
const profileService = require('../services/profile.service');

exports.getAccount = asyncHandler(async (req, res) => {
  res.json(await profileService.getAccount(req.user.id));
});

exports.updateAccount = asyncHandler(async (req, res) => {
  res.json(await profileService.updateAccount(req.user.id, req.body));
});

exports.changePassword = asyncHandler(async (req, res) => {
  res.json(await profileService.changePassword(req.user.id, req.body));
});

exports.getBusinessProfile = asyncHandler(async (req, res) => {
  res.json(await profileService.getBusinessProfile(req.user.id));
});

exports.updateBusinessProfile = asyncHandler(async (req, res) => {
  res.json(await profileService.updateBusinessProfile(req.user.id, req.body));
});

exports.logoutAll = asyncHandler(async (req, res) => {
  res.json(await profileService.logoutAll(req.user.id));
});

exports.deleteAccount = asyncHandler(async (req, res) => {
  res.json(await profileService.deleteAccount(req.user.id, req.body.password));
});

// Streams a ZIP directly to res — keeps its own error handling (matching the original
// behavior) since headers may already be sent by the time an error occurs mid-stream.
exports.exportData = async (req, res) => {
  try {
    await profileService.exportData(req.user.id, res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
};
