const express = require("express");
const requireAuth = require("./_require-auth.js");
const firebaseAdmin = require("./_firebase.js");
const router = express.Router();

router.get("/", requireAuth, (req, res) => {
  const user = req.user;

  return firebaseAdmin
    .auth()
    .createCustomToken(user.uid)
    .then((firebaseToken) => {
      res.send({ status: "success", data: firebaseToken });
    })
    .catch((error) => {
      console.log("auth-firebase-token error", error);

      res.send({
        status: "error",
        message: "Something went wrong acquiring a Firebase token",
      });
    });
});

module.exports = router;
