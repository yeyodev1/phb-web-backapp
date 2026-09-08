/**
 * Crea o promueve un usuario administrador del panel de blogs.
 *
 *   npx ts-node src/scripts/createAdmin.ts <email> <password> [nombre]
 *
 * Usa DB_URI del .env (o del entorno). Si el email ya existe, lo convierte en
 * admin y actualiza la contraseña; si no existe, lo crea.
 */
import dotenv from "dotenv";
dotenv.config({ path: process.env.ENV_FILE || ".env" });

import mongoose from "mongoose";
import { User } from "../models/User";

async function main() {
  const [email, password, ...nameParts] = process.argv.slice(2);
  if (!email || !password) {
    console.error("Uso: npx ts-node src/scripts/createAdmin.ts <email> <password> [nombre]");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("La contraseña debe tener al menos 8 caracteres");
    process.exit(1);
  }
  const DB_URI = process.env.DB_URI;
  if (!DB_URI) throw new Error("DB_URI no definido");

  await mongoose.connect(DB_URI);

  const name = nameParts.join(" ") || "Administrador";
  let user = await User.findOne({ email: email.toLowerCase() });
  if (user) {
    user.password = password; // el pre-save hashea
    user.accountType = "admin";
    user.isActive = true;
    if (!user.name) user.name = name;
    await user.save();
    console.log(`Usuario existente promovido a admin: ${user.email}`);
  } else {
    user = await User.create({ name, email, password, accountType: "admin" });
    console.log(`Admin creado: ${user.email}`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
