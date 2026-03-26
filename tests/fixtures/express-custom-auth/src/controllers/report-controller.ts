// @ts-nocheck
export function listReports(_req, res) {
  return res.json({
    data: [{ id: 1, name: "Monthly report" }],
  });
}
