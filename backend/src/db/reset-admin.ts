// Restablece (o crea) un usuario administrador.
// Uso:  npm run reset-admin -- <email> <nueva_contraseña>
import { eq } from 'drizzle-orm';
import { db, schema } from './client.js';
import { migrate } from './migrate.js';
import { hashPassword } from '../lib/password.js';
import { nowIso } from '../lib/datetime.js';

async function main() {
  migrate();
  const email = (process.argv[2] ?? '').toLowerCase();
  const password = process.argv[3] ?? '';
  if (!email || password.length < 8) {
    console.error('Uso: npm run reset-admin -- <email> <contraseña (mín. 8)>');
    process.exit(1);
  }
  const passwordHash = await hashPassword(password);
  const existing = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  if (existing) {
    db.update(schema.users).set({ passwordHash, rol: 'ADMIN', activo: true, updatedAt: nowIso() }).where(eq(schema.users.id, existing.id)).run();
    console.log(`Contraseña restablecida para ${email} (rol ADMIN, activo).`);
  } else {
    db.insert(schema.users).values({ nombre: 'Administrador', email, passwordHash, rol: 'ADMIN', activo: true }).run();
    console.log(`Administrador creado: ${email}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
