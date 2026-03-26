exports.listAdminUsers = (_req, res) => {
  return res.status(200).json({
    data: [{
      id: 1,
      name: "Admin",
    }],
  });
};

exports.createAdminUser = (req, res) => {
  const name = req.body.name;
  const email = req.body.email;

  return res.status(201).json({
    data: {
      name,
      email,
    },
  });
};
