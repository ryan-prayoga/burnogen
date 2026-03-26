// @ts-nocheck
export function login(req, res) {
  const { email, password } = req.body;

  return res.status(200).json({
    token: "secret-token",
    email,
    password,
  });
}

export const register = (req, res) => {
  const email = req.body["email"];
  const password = req.body.password;

  return res.status(201).json({
    message: "registered",
    email,
    password,
  });
};

export const logout = (_req, res) => res.sendStatus(204);
