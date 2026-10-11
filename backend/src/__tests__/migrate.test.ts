import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(__dirname, '..', 'db');
const schemaSql = fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8');
const migrateTs = fs.readFileSync(path.join(dbDir, 'migrate.ts'), 'utf8');

/** Columnas que migrateColumns() agrega con ALTER TABLE (o sea: NO existen en bases viejas). */
function columnasAgregadasPorAlter(): { tabla: string; columna: string }[] {
  const out: { tabla: string; columna: string }[] = [];
  const re = /ensureColumn\(\s*'([^']+)'\s*,\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(migrateTs))) out.push({ tabla: m[1], columna: m[2] });
  return out;
}

/** Índices declarados en schema.sql: { tabla, columnas[] }. */
function indicesDeSchemaSql(): { tabla: string; columnas: string[]; sql: string }[] {
  const out: { tabla: string; columnas: string[]; sql: string }[] = [];
  const re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+(\w+)\s*\(([^)]*)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(schemaSql))) {
    out.push({ tabla: m[1], columnas: m[2].split(',').map((c) => c.trim().split(/\s+/)[0]), sql: m[0] });
  }
  return out;
}

describe('migraciones', () => {
  it('migrateColumns() agrega columnas con ALTER (hay bases viejas que las necesitan)', () => {
    // Si esto queda vacío, el test de abajo no estaría probando nada.
    expect(columnasAgregadasPorAlter().length).toBeGreaterThan(0);
  });

  /**
   * En una base que ya existe, `CREATE TABLE IF NOT EXISTS` es un no-op: la tabla queda
   * como estaba, sin las columnas nuevas. Pero los `CREATE INDEX` del mismo schema.sql SÍ
   * se ejecutan, y runSchema() corre ANTES que migrateColumns(). Un índice sobre una columna
   * que todavía no existe hace fallar el arranque con "no such column".
   * Esos índices tienen que crearse en migrateColumns(), después del ALTER TABLE.
   */
  it('schema.sql no indexa columnas que en bases viejas todavía no existen', () => {
    const porAlter = columnasAgregadasPorAlter();
    const conflictos = indicesDeSchemaSql().flatMap((idx) =>
      idx.columnas
        .filter((col) => porAlter.some((a) => a.tabla === idx.tabla && a.columna === col))
        .map((col) => `${idx.tabla}.${col} -> ${idx.sql}`),
    );
    expect(conflictos, 'Mové estos índices a migrateColumns(), después del ensureColumn').toEqual([]);
  });

  it('la reconstrucción de solicitudes conserva todas las columnas de la tabla', () => {
    // migrateSolicitudPersonaIdOpcional() copia columna por columna: si se agrega una
    // columna nueva a solicitudes y no se suma acá, el rebuild la borra silenciosamente.
    const rebuild = migrateTs.match(/CREATE TABLE solicitudes__new \(([\s\S]*?)\);/);
    expect(rebuild, 'no encontré el CREATE TABLE del rebuild').toBeTruthy();
    const enRebuild = new Set(
      rebuild![1]
        .split('\n')
        .map((l) => l.trim().split(/\s+/)[0])
        .filter((c) => /^[a-z_]+$/.test(c)),
    );

    const tabla = schemaSql.match(/CREATE TABLE IF NOT EXISTS solicitudes \(([\s\S]*?)\n\);/);
    expect(tabla, 'no encontré el CREATE TABLE de solicitudes').toBeTruthy();
    const enSchema = tabla![1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'))
      .map((l) => l.split(/\s+/)[0])
      .filter((c) => /^[a-z_]+$/.test(c));

    const faltantes = enSchema.filter((c) => !enRebuild.has(c));
    expect(faltantes, 'Agregá estas columnas al rebuild de migrateSolicitudPersonaIdOpcional()').toEqual([]);
  });
});
