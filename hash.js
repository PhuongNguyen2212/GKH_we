const bcrypt = require("bcrypt");
bcrypt.hash("Admin3040", 10, (err, hash) => {
    console.log(hash);
});