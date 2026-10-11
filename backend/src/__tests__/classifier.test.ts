import { describe, it, expect } from 'vitest';
import { classifyDocument, extractDni, extractVencimiento, extractEmision, detectCategoria, extractNombreApellido, extractPeople } from '../modules/ai/classifier.js';

describe('clasificación y extracción', () => {
  it('extrae DNI con y sin puntos', () => {
    expect(extractDni('Documento 32.361.606 emitido')).toBe('32361606');
    expect(extractDni('DNI 30640882')).toBe('30640882');
    expect(extractDni('sin numeros de documento')).toBeNull();
  });

  it('clasifica ART, Seguro de vida, Monotributo y Cláusula', () => {
    expect(classifyDocument('Aseguradora de Riesgos del Trabajo - certificado de afiliacion', 'art.pdf').codigo).toBe('ART');
    expect(classifyDocument('Poliza de seguro de vida colectivo - suma asegurada beneficiario', 'seguro.pdf').codigo).toBe('SEGURO_VIDA');
    expect(classifyDocument('Constancia de pago de Monotributo - regimen simplificado', 'mono.pdf').codigo).toBe('MONOTRIBUTO');
    expect(classifyDocument('Clausula de no repeticion a favor de Cencosud', 'clausula.pdf').codigo).toBe('CLAUSULA_NO_REPETICION');
  });

  it('no confunde "art" adentro de otra palabra (cuarto, departamento, partida, carta)', () => {
    // Con match por substring, este texto se clasificaba como ART con 99% de confianza.
    expect(classifyDocument('El cuarto departamento envia la partida', 'reporte.pdf').codigo).toBeNull();
    expect(classifyDocument('Carta de cobertura general', 'CertificadoCarta144965.pdf').codigo).not.toBe('ART');
    // Y "ART" como palabra sigue contando.
    expect(classifyDocument('Certificado de afiliacion ART Experta', 'nomina.pdf').codigo).toBe('ART');
  });

  it('clasifica Formulario 931 y Pago de ARCA, que antes no existian', () => {
    const f931 = 'Formulario 931 declaracion jurada determinativa de aportes y contribuciones - cargas sociales';
    expect(classifyDocument(f931, 'F931 AGOSTO 2026.pdf').codigo).toBe('FORM_931');
    const arca = 'ARCA Agencia de Recaudacion y Control Aduanero - volante electronico de pago';
    expect(classifyDocument(arca, 'pago arca.pdf').codigo).toBe('PAGO_ARCA');
  });

  it('una frase larga pesa mas que una palabra suelta', () => {
    // "nomina" sola (ART) contra la frase completa del seguro: gana el seguro.
    const t = 'Poliza de seguro de vida colectivo - nomina de asegurados - suma asegurada';
    expect(classifyDocument(t, 'poliza.pdf').codigo).toBe('SEGURO_VIDA');
  });

  it('detecta categoría Empresa vs Monotributista', () => {
    expect(detectCategoria('Formulario 931 cargas sociales nomina')).toBe('EMPRESA');
    expect(detectCategoria('constancia de monotributo regimen simplificado')).toBe('MONOTRIBUTISTA');
    expect(detectCategoria('un texto neutro')).toBeNull();
  });

  it('extrae fecha de emisión', () => {
    expect(extractEmision('Comprobante de pago - Fecha de emision 05/08/2026')).toBe('2026-08-05');
    expect(extractEmision('documento sin fecha')).toBeNull();
  });

  it('no inventa clasificación cuando no hay señales', () => {
    const r = classifyDocument('texto sin relación alguna', 'archivo.pdf');
    expect(r.codigo).toBeNull();
  });

  it('extrae apellido y nombre desde el texto del DNI (sin invertirlos)', () => {
    const texto = 'REPUBLICA ARGENTINA DOCUMENTO NACIONAL DE IDENTIDAD Apellido: PEREZ Nombre: JUAN CARLOS DNI 35.837.051 Sexo: M';
    const r = extractNombreApellido(texto);
    expect(r).not.toBeNull();
    expect(r!.apellido).toBe('Perez');
    expect(r!.nombre).toBe('Juan Carlos');
  });

  it('devuelve null si no encuentra las etiquetas', () => {
    expect(extractNombreApellido('texto cualquiera sin datos')).toBeNull();
  });

  it('extrae varias personas de una planilla sin mezclar los nombres', () => {
    const planilla = 'PLANILLA DE PERSONAL - LOCAL ELECTRO ' +
      '1) PEREZ, JUAN CARLOS - DNI 35.837.051 ' +
      '2) GOMEZ, PEDRO - DNI 30.640.882 ' +
      '3) RODRIGUEZ, ANA MARIA - DNI 28.325.473';
    const people = extractPeople(planilla);
    expect(people).toHaveLength(3);
    expect(people[0]).toMatchObject({ dni: '35837051', apellido: 'Perez', nombre: 'Juan Carlos' });
    expect(people[1]).toMatchObject({ dni: '30640882', apellido: 'Gomez', nombre: 'Pedro' });
    expect(people[2]).toMatchObject({ dni: '28325473', apellido: 'Rodriguez', nombre: 'Ana Maria' });
  });

  it('extrae empleados de una nómina ART por CUIL (nombre después del número)', () => {
    const nomina = 'CUIT: 30714032433 Razon Social: GMRA S.A.U. Tipo Documento Nombre del Empleado ' +
      'C.U.I.L. 20298901960 BUSTOS MAXIMILIANO ' +
      'C.U.I.L. 27367921221 FIGUEROA SONIA ELENA ' +
      'C.U.I.L. 20360786685 VARGAS JAVIER LEONARDO';
    const people = extractPeople(nomina);
    expect(people).toHaveLength(3); // no incluye el CUIT de la empresa (30...)
    expect(people[0]).toMatchObject({ dni: '29890196', apellido: 'Bustos', nombre: 'Maximiliano' });
    expect(people[1]).toMatchObject({ dni: '36792122', apellido: 'Figueroa', nombre: 'Sonia Elena' });
    expect(people[2]).toMatchObject({ dni: '36078668', apellido: 'Vargas', nombre: 'Javier Leonardo' });
  });

  it('no le pone a una fila el nombre de la fila anterior', () => {
    // Caso real (certificado de Serena ART): el PDF corta un nombre ("SANCHEZ ANAH-") y esa fila
    // terminaba con el nombre del empleado anterior. Un nombre vacio se completa a mano; uno de
    // otra persona no se nota.
    const nomina = 'CUIL Apellido y Nombres ' +
      '23233789461 PAREDES LEONARDO GABRIEL ' +
      '23414348505 SANCHEZ ANAH- ' +
      '27377344133 SUAREZ DANIELA BEATRIZ';
    const people = extractPeople(nomina);
    expect(people).toHaveLength(3);
    expect(people[0]).toMatchObject({ dni: '23378946', apellido: 'Paredes' });
    expect(people[1]).toMatchObject({ dni: '41434850', apellido: null, nombre: null });
    expect(people[2]).toMatchObject({ dni: '37734413', apellido: 'Suarez' });
  });

  it('no confunde los importes de un F931 con documentos', () => {
    // Caso real (OA-2026-0214): el importador ofrecio 22 "personas" que eran los totales del
    // formulario. De "2.375.330.846,84" se recortaba "2.375.330" y quedaba como DNI 2375330.
    const f931 = 'Suma de Rem. 1: 2.375.330.846,84 Suma de Rem. 4: 2.715.223.178,91 ' +
      'a1 - Total de aportes S.S. 345.582.637,67 Cantidad de CUILES con ART 2982 5.680.710,00 ' +
      'S.C.V.O. a Pagar: 1.266.216,84 Ley 27.430 - Monto Total Detraido: 16.660.709,38';
    expect(extractPeople(f931)).toHaveLength(0);
  });

  it('no le pega a un numero el nombre que esta al otro extremo del documento', () => {
    // En el F931 de OA-2026-0214 el unico "nombre" del papel era el usuario logueado en ARCA, en el
    // encabezado, y se lo llevaba un numero que estaba en la ultima hoja.
    const relleno = 'texto intermedio que no dice nada '.repeat(20);
    const doc = `Usuario: SEBASTIAN DANIEL BARRIOS ${relleno} Nro. de transaccion 33.062.657`;
    const p = extractPeople(doc);
    if (p.length > 0) {
      expect(p[0].nombre).toBeNull();
      expect(p[0].apellido).toBeNull();
    }
  });

  it('lee la tabla de una constancia de seguro sin confundir telefono ni importe', () => {
    // Caso real (OA-2026-0236, SEPTIEMBRE-TG44.pdf). Antes daba vuelta el resultado: se traia el
    // telefono "0800 555 9998" y el importe "$ 12.625.850", y NO encontraba a las 3 personas,
    // porque la fila de una tabla real no lleva puntos ni la palabra DNI al lado.
    const constancia = 'SEGUROS GALICIA S.A. Tel + 54 11 0800 555 9998 www.galiciaseguros.com.ar ' +
      'Constancia de coberturas - Accidentes Personales Actividad DECORADORES DE VIDRIERAS Cant. personas 3 ' +
      'Nombre/s   Apellido/s   D.N.I.   Fecha Nacimiento   Fecha de alta ' +
      'JULIAN DAVID   CORTES   46325229   15/02/2000   13/08/2026 ' +
      'LEANDRO GERMAN   CORTES   40103944   23/09/1991   13/08/2026 ' +
      'PATRICIO GUILLERMO   MORALES   34264446   27/12/1988   13/08/2026 ' +
      'Suma Asegurada Muerte Accidental $ 120.000.000 Reembolso de gastos $ 12.625.850 Franquicia $ 200';

    const p = extractPeople(constancia);
    expect(p.map((x) => x.dni)).toEqual(['46325229', '40103944', '34264446']);
    // El encabezado dice "Nombre/s  Apellido/s": el apellido es el ultimo, no el primero.
    expect(p[0]).toMatchObject({ apellido: 'Cortes', nombre: 'Julian David' });
    expect(p[2]).toMatchObject({ apellido: 'Morales', nombre: 'Patricio Guillermo' });
  });

  it('la razon social del encabezado no corre los nombres una fila', () => {
    // Caso real (OA-2026-0236, certificado de EXPERTA ART). "ON MARCA SA" esta justo antes del
    // primer CUIL y hacia creer que los nombres van ANTES del numero: con eso cada CUIL se quedaba
    // con el nombre de la persona SIGUIENTE, y el primero con el de la empresa.
    const cert = 'EMPLEADOS DECLARADOS EN EL CONTRATO N 318746 CUIT: 30717685756   Razon Social: ON MARCA SA ' +
      'Tipo   Documento   Nombre del Empleado ' +
      'C.U.I.L.   27267570294   CORDOBA MARIA SOLEDAD ' +
      'C.U.I.L.   27457547264   ESCOBAR CAMILA MAGDALENA ' +
      'C.U.I.L.   27284855529   HERRERA ROMINA PAULA';

    const p = extractPeople(cert);
    expect(p).toHaveLength(3);
    expect(p[0]).toMatchObject({ dni: '26757029', apellido: 'Cordoba', nombre: 'Maria Soledad' });
    expect(p[1]).toMatchObject({ dni: '45754726', apellido: 'Escobar', nombre: 'Camila Magdalena' });
    expect(p[2]).toMatchObject({ dni: '28485552', apellido: 'Herrera', nombre: 'Romina Paula' });
  });

  it('sigue poniendo el apellido primero cuando el papel lo escribe asi', () => {
    // Nomina de ART: "Apellido y Nombres", al reves que la constancia de arriba.
    const nomina = 'CUIL   Apellido y Nombres  20337916512   LOPEZ DIEGO EMILIANO  27301105318   HERNANDEZ GABRIELA SABRINA';
    const p = extractPeople(nomina);
    expect(p[0]).toMatchObject({ apellido: 'Lopez', nombre: 'Diego Emiliano' });
    expect(p[1]).toMatchObject({ apellido: 'Hernandez', nombre: 'Gabriela Sabrina' });
  });

  it('sigue leyendo un DNI de verdad escrito con puntos', () => {
    const p = extractPeople('PEREZ, JUAN CARLOS - DNI 35.837.051');
    expect(p).toHaveLength(1);
    expect(p[0].dni).toBe('35837051');
  });

  it('no toma folios ni números sueltos sin contexto como DNI', () => {
    expect(extractPeople('N° de folio: 18373059 Contrato 558059')).toHaveLength(0);
  });

  it('no toma la fecha de INICIO como vencimiento', () => {
    // Un certificado que solo dice desde cuando rige no tiene vencimiento: devolver el inicio hacia
    // atras hacia que documentos de 2026 aparecieran "vencidos" en 2017.
    expect(extractVencimiento('Contrato con vigencia desde el 20/09/2017')).toBeNull();
    expect(extractVencimiento('Cobertura a partir de 01/09/2026')).toBeNull();
    // Con las dos fechas, gana la de fin.
    expect(extractVencimiento('Vigencia desde 01/09/2026 hasta 30/11/2026')).toBe('2026-11-30');
  });

  it('no acepta un ano de 3 digitos (PDF cortado)', () => {
    expect(extractVencimiento('Vence el 14/08/202')).toBeNull();
    expect(extractVencimiento('Vence el 14/08/26')).toBe('2026-08-14');
  });

  it('extrae fecha de vencimiento', () => {
    expect(extractVencimiento('Vigencia hasta 24/08/2026')).toBe('2026-08-24');
    expect(extractVencimiento('sin fecha')).toBeNull();
  });
});
