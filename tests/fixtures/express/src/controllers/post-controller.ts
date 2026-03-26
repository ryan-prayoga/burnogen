// @ts-nocheck
export function getUserPost(req, res) {
  const userId = req.params.id;
  const { postId } = req.params;

  return res.status(200).json({
    data: {
      userId,
      postId,
    },
  });
}
