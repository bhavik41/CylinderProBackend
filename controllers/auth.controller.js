const asyncHandler = require('../middleware/asyncHandler');
const authService = require('../services/auth.service');

exports.signup = asyncHandler(async (req, res) => {
  res.json(await authService.signup(req.body));
});

exports.signin = asyncHandler(async (req, res) => {
  res.json(await authService.signin(req.body));
});

exports.refresh = asyncHandler(async (req, res) => {
  res.json(await authService.refresh(req.user.id));
});

exports.clearData = asyncHandler(async (req, res) => {
  res.json(await authService.clearData(req.user.id, req.body.password));
});
