import { describe, it, expect } from 'vitest';
import { esCuilValido, interpretarDocumento, pareceNombreDePersona, findOrCreatePersona } from '../modules/personas/service.js';
import { beforeAll } from 'vitest';
import { migrate } from '../db/migrate.js';
beforeAll(() => { migrate(); });

describe('esCuilValido', () => {
  it('acepta CUIL reales (verificador módulo 11)', () => {
    // Reales, de la base de producción: uno por cada prefijo que aparece en los datos.
    for (const c of ['20145967555', '23145757142', '24316058899', '27189988112', '30590445599']) {
      expect(esCuilValido(c), c).toBe(true);
    }
  });

  it('rechaza prefijo inválido, largo distinto de 11 y verificador incorrecto', () => {
    expect(esCuilValido('00028472153')).toBe(false); // un DNI con ceros adelante
    expect(esCuilValido('11111111111')).toBe(false);
    expect(esCuilValido('2026490696')).toBe(false);  // 10 dígitos
    expect(esCuilValido('209595562041')).toBe(false); // 12 dígitos
    expect(esCuilValido('20467252369')).toBe(false); // prefijo ok, verificador mal
  });
});

/**
 * El caso que motivó esto: la planilla trae un DNI relleno con ceros en la columna del CUIL. Al
 * guardarlo como CUIL, la próxima vez que la persona llega con su DNI limpio no coincide con nada
 * y se crea una segunda ficha, cada una con su autorización. Pasó con un empleado real.
 */
describe('interpretarDocumento', () => {
  it('un DNI con ceros adelante en la columna de CUIL se guarda como DNI, no como CUIL', () => {
    expect(interpretarDocumento('00094959396', '')).toEqual({ cuil: '', dni: '94959396', dniConfiable: true });
  });

  it('el mismo empleado por CUIL-relleno o por DNI cae en el mismo documento', () => {
    const a = interpretarDocumento('00094959396', '');
    const b = interpretarDocumento('', '94959396');
    expect(a.dni).toBe(b.dni);
  });

  it('un CUIL válido se conserva y de él se deduce el DNI', () => {
    expect(interpretarDocumento('20-14596755-5', '')).toEqual({ cuil: '20145967555', dni: '14596755', dniConfiable: false });
  });

  it('un CUIL con el verificador mal se conserva igual: perderlo sería peor que tenerlo dudoso', () => {
    const r = interpretarDocumento('20467252369', '');
    expect(r.cuil).toBe('20467252369');
    expect(r.dni).toBe('46725236');
    // Deducido del medio del CUIL: no sirve para buscar a la persona.
    expect(r.dniConfiable).toBe(false);
  });

  it('dos CUIL que difieren solo en el verificador no se toman por la misma persona', () => {
    const a = interpretarDocumento('20999560309', '');
    const b = interpretarDocumento('20999560300', '');
    expect(a.dni).toBe(b.dni);            // el medio es el mismo...
    expect(a.dniConfiable).toBe(false);   // ...pero no se usa para matchear
    expect(a.cuil).not.toBe(b.cuil);
  });

  it('no le inventa un CUIL a quien solo trajo DNI', () => {
    expect(interpretarDocumento('', '28472153')).toEqual({ cuil: '', dni: '28472153', dniConfiable: true });
  });
});

/**
 * Cuando el correo no trae Excel, la lista de personas se busca en el cuerpo y el parser levanta
 * pedazos de la firma del remitente. Caso real: de la firma "Valeria Keller · Gerente Suc 10 ·
 * (+54.11) 2312-5766" salió una persona llamada "(+54.11)" con documento 23125766 — ocho dígitos,
 * o sea que pasa cualquier validación de DNI. Lo que no pasa es el nombre.
 */
describe('pareceNombreDePersona', () => {
  it('rechaza un teléfono de la firma', () => {
    expect(pareceNombreDePersona('(+54.11)', '(a completar)')).toBe(false);
    expect(pareceNombreDePersona('(a completar)', '2312-5766')).toBe(false);
    expect(pareceNombreDePersona('+54 11 4567', '')).toBe(false);
  });

  it('rechaza lo que no tiene letras', () => {
    expect(pareceNombreDePersona('(a completar)', '(a completar)')).toBe(false);
    expect(pareceNombreDePersona(':', '-')).toBe(false);
    expect(pareceNombreDePersona('', '')).toBe(false);
    expect(pareceNombreDePersona(null, undefined)).toBe(false);
  });

  it('acepta nombres reales, con acentos y con una sola parte cargada', () => {
    expect(pareceNombreDePersona('Juan', 'Pérez')).toBe(true);
    expect(pareceNombreDePersona('(a completar)', 'GONZÁLEZ')).toBe(true);
    expect(pareceNombreDePersona('Ñandú', '(a completar)')).toBe(true);
  });

  it('acepta un nombre mal cortado: se corrige a mano, no se descarta a la persona', () => {
    // Caso real de una planilla: el separador se colo en el campo del nombre.
    expect(pareceNombreDePersona(':', 'DOMINGUEZ PONCE DAMIAN')).toBe(true);
  });
});

/**
 * Caso real (ZENIT, pedido de instalación de wifi): la planilla repetía el CUIL en la columna DNI,
 * y se guardaban DNI de 11 dígitos — un número que no figura en ningún documento y que Seguridad
 * no encuentra al buscar a la persona en la puerta.
 */
describe('la columna DNI de la planilla trae el CUIL', () => {
  it('no guarda un DNI de 11 dígitos: lo saca del CUIL', () => {
    const r = interpretarDocumento('20331630781', '20331630781');
    expect(r.cuil).toBe('20331630781');
    expect(r.dni).toBe('33163078');
    // Derivado del CUIL, no leído del documento: no sirve para emparejar personas.
    expect(r.dniConfiable).toBe(false);
  });

  it('un DNI de verdad en esa columna se respeta', () => {
    const r = interpretarDocumento('20403012581', '40301258');
    expect(r.dni).toBe('40301258');
    expect(r.dniConfiable).toBe(true);
  });

  it('tampoco toma como DNI cualquier número largo que no sea el CUIL', () => {
    const r = interpretarDocumento('20403012581', '4030125870000');
    expect(r.dni).toBe('40301258');
    expect(r.dniConfiable).toBe(false);
  });

  it('con el CUIL vacío y un DNI válido no cambia nada', () => {
    const r = interpretarDocumento('', '40301258');
    expect(r).toEqual({ cuil: '', dni: '40301258', dniConfiable: true });
  });
});

/**
 * Caso real (#221, TM Paseo Central): la MISMA planilla lista a la misma persona dos veces, una
 * fila con su DNI y otra con su CUIL. La segunda fila deducía el DNI del CUIL, no lo usaba para
 * buscar —por miedo a fusionar dos personas con CUIL parecido— e intentaba insertar una ficha con
 * un DNI que ya existía: "UNIQUE constraint failed: personas.dni", y el correo quedaba trabado.
 */
describe('la misma persona dos veces en la planilla, por DNI y por CUIL', () => {
  it('la segunda fila engancha con la ficha de la primera y le completa el CUIL', () => {
    const primera = findOrCreatePersona({ dni: '40700664', nombre: 'Florencia Denis', apellido: 'Campos Toledo' });
    expect(primera.created).toBe(true);
    expect(primera.persona.cuil).toBeFalsy();

    // 27-40700664-5 es el CUIL de ese mismo DNI.
    const segunda = findOrCreatePersona({ cuil: '27407006645', nombre: 'Florencia', apellido: 'Campos' });
    expect(segunda.created, 'no puede crear una segunda ficha').toBe(false);
    expect(segunda.persona.id).toBe(primera.persona.id);
    expect(segunda.persona.cuil, 'le completa el CUIL que faltaba').toBe('27407006645');
  });

  it('no engancha si la ficha del DNI declara OTRO CUIL: son dos personas', () => {
    const otra = findOrCreatePersona({ cuil: '20331239174', dni: '33123917', nombre: 'Uno', apellido: 'Distinto' });
    expect(otra.persona.dni).toBe('33123917');
    // Un CUIL con el mismo medio pero otro prefijo y otro verificador: no se toca la ficha ajena.
    const nueva = findOrCreatePersona({ cuil: '27331239173', nombre: 'Otra', apellido: 'Persona' });
    expect(nueva.persona.id).not.toBe(otra.persona.id);
  });

  it('con el CUIL mal tipeado no se deduce nada: el verificador no confirma el medio', () => {
    const base = findOrCreatePersona({ dni: '35073305', nombre: 'Base', apellido: 'Confiable' });
    // Mismo medio, verificador inválido => no se usa para enganchar.
    const mal = findOrCreatePersona({ cuil: '20350733051', nombre: 'Mal', apellido: 'Tipeado' });
    expect(mal.persona.id).not.toBe(base.persona.id);
  });
});
